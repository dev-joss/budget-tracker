import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { ConflictError, ValidationError } from '@js/errors';
import Accounts from '@models/accounts.model';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';
import { unlinkAccountFromBankConnection } from '@services/accounts/unlink-from-bank-connection';
import {
  BaseBankDataProvider,
  type DateRange,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderMetadata,
  type ProviderTransaction,
} from '@services/bank-data-providers';
import { encryptCredentials } from '@services/bank-data-providers/utils/credential-encryption';
import { writeBankBalanceWithHistory } from '@services/bank-data-providers/utils/write-bank-balance-with-history';
import { AccountSubtype, AccountType, type AccountBase, type PlaidApi } from 'plaid';

import { createPlaidApiClient } from './api-client';
import { plaidClientUserId } from './client-user-id';
import { resolvePlaidConfig, type PlaidConfig } from './config';
import { mapPlaidAccount } from './transaction-mapper';
import { enqueuePlaidSync } from './transaction-sync-queue';
import type { PlaidConnectionMetadata, PlaidCredentials } from './types';

interface PlaidConnectInput {
  publicToken: string;
  linkMetadata?: {
    institution?: { institutionId?: string; name?: string };
    accounts?: Array<{ id?: string; mask?: string | null; name?: string }>;
  };
}

const isSupportedAccount = ({ account }: { account: AccountBase }): boolean =>
  account.type === AccountType.Depository ||
  account.type === AccountType.Credit ||
  (account.type === AccountType.Loan &&
    (account.subtype === AccountSubtype.Mortgage || account.subtype === AccountSubtype.Student));

const accountFingerprint = ({ account }: { account: AccountBase }): string =>
  `${account.name.trim().toLowerCase()}|${account.mask || ''}`;

export class PlaidProvider extends BaseBankDataProvider {
  readonly metadata: ProviderMetadata = {
    type: BANK_PROVIDER_TYPE.PLAID,
    name: 'Plaid',
    description: 'Connect US and Canadian financial accounts through Plaid.',
    documentationUrl: 'https://plaid.com/docs/',
    features: {
      supportsWebhooks: true,
      supportsRealtime: false,
      requiresReauth: true,
      supportsManualSync: true,
      supportsAutoSync: true,
      queuedSync: true,
      defaultSyncInterval: 4 * 60 * 60 * 1000,
      minSyncInterval: 60 * 1000,
    },
  };

  private async requireConfig(): Promise<PlaidConfig> {
    const config = await resolvePlaidConfig();
    if (!config) throw new Error(t({ key: 'bankDataProviders.plaid.notConfigured' }));
    return config;
  }

  private async client(): Promise<PlaidApi> {
    return createPlaidApiClient({ config: await this.requireConfig() });
  }

  async connect({ userId, credentials }: { userId: number; credentials: unknown }): Promise<string> {
    if (!this.isConnectInput(credentials)) {
      throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.invalidConnectionCredentials' }) });
    }

    const apiClient = await this.client();
    let accessToken: string | undefined;
    try {
      const exchange = await apiClient.itemPublicTokenExchange({ public_token: credentials.publicToken });
      const exchangedAccessToken = exchange.data.access_token;
      accessToken = exchangedAccessToken;
      const [itemResponse, accountsResponse] = await Promise.all([
        apiClient.itemGet({ access_token: exchangedAccessToken }),
        apiClient.accountsGet({ access_token: exchangedAccessToken }),
      ]);
      const item = itemResponse.data.item;
      const institution = item.institution_id
        ? (
            await apiClient.institutionsGetById({
              institution_id: item.institution_id,
              country_codes: (await this.requireConfig()).countryCodes,
            })
          ).data.institution
        : null;
      const supportedAccounts = accountsResponse.data.accounts.filter((account) => isSupportedAccount({ account }));
      if (supportedAccounts.length === 0) {
        throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.noSupportedAccounts' }) });
      }

      await this.assertUniqueItem({ userId, itemId: item.item_id });
      await this.assertUniqueLogin({
        userId,
        institutionId: item.institution_id,
        fingerprints: supportedAccounts.map((account) => accountFingerprint({ account })),
      });

      const connection = await BankDataProviderConnections.create({
        userId,
        providerType: BANK_PROVIDER_TYPE.PLAID,
        providerName: institution?.name || credentials.linkMetadata?.institution?.name || 'Plaid',
        isActive: true,
        credentials: encryptCredentials({ accessToken: exchangedAccessToken } satisfies PlaidCredentials),
        metadata: {
          itemId: item.item_id,
          institutionId: item.institution_id,
          institutionName: institution?.name || 'Unknown institution',
          cursor: null,
          accountFingerprints: supportedAccounts.map((account) => accountFingerprint({ account })),
          repairWarning: null,
          deactivationReason: null,
        },
      } as never);

      return connection.id;
    } catch (error) {
      if (accessToken) await apiClient.itemRemove({ access_token: accessToken }).catch(() => undefined);
      throw error;
    }
  }

  async disconnect({ connectionId }: { connectionId: string }): Promise<void> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);
    const { accessToken } = connection.getDecryptedCredentials() as unknown as PlaidCredentials;
    await (await this.client()).itemRemove({ access_token: accessToken }).catch(() => undefined);
    await connection.destroy();
  }

  async validateCredentials({ credentials }: { credentials: unknown }): Promise<boolean> {
    if (!this.isStoredCredentials(credentials)) return false;
    try {
      await (await this.client()).itemGet({ access_token: credentials.accessToken });
      return true;
    } catch {
      return false;
    }
  }

  async refreshCredentials(): Promise<void> {
    throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.credentialRepairRequiresUpdateMode' }) });
  }

  async reauthorize({ connectionId }: { connectionId: string }): Promise<{ linkToken: string }> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);
    const { accessToken } = connection.getDecryptedCredentials() as unknown as PlaidCredentials;
    const config = await this.requireConfig();
    const response = await (
      await this.client()
    ).linkTokenCreate({
      client_name: 'MoneyMatter',
      country_codes: config.countryCodes,
      language: 'en',
      access_token: accessToken,
      user: { client_user_id: plaidClientUserId({ userId: connection.userId, secret: config.secret }) },
      ...(config.redirectUri && { redirect_uri: config.redirectUri }),
    });
    return { linkToken: response.data.link_token };
  }

  async completeUpdate({ connectionId, userId }: { connectionId: string; userId: number }): Promise<void> {
    const connection = await BankDataProviderConnections.findOne({ where: { id: connectionId, userId } });
    if (!connection) throw new ValidationError({ message: t({ key: 'errors.connectionNotFound' }) });
    this.validateProviderType(connection);
    const { accessToken } = connection.getDecryptedCredentials() as unknown as PlaidCredentials;
    const [itemResponse, accountsResponse, localAccounts] = await Promise.all([
      (await this.client()).itemGet({ access_token: accessToken }),
      (await this.client()).accountsGet({ access_token: accessToken }),
      Accounts.findAll({ where: { userId, bankDataProviderConnectionId: connectionId } }),
    ]);
    const authorizedIds = new Set(accountsResponse.data.accounts.map((account) => account.account_id));
    for (const account of localAccounts) {
      if (account.externalId && !authorizedIds.has(account.externalId)) {
        await unlinkAccountFromBankConnection({ accountId: account.id, userId });
      }
    }
    const metadata = connection.metadata as PlaidConnectionMetadata;
    connection.isActive = true;
    connection.metadata = {
      ...metadata,
      itemId: itemResponse.data.item.item_id,
      repairWarning: null,
      deactivationReason: null,
    };
    await connection.save();
  }

  async fetchAccounts({ connectionId }: { connectionId: string }): Promise<ProviderAccount[]> {
    const credentials = await this.credentialsForConnection({ connectionId });
    const response = await (await this.client()).accountsGet({ access_token: credentials.accessToken });
    return response.data.accounts
      .filter((account) => isSupportedAccount({ account }))
      .map((account) => mapPlaidAccount({ account }));
  }

  async fetchTransactions(_args: {
    connectionId: string;
    accountExternalId: string;
    dateRange?: DateRange;
  }): Promise<ProviderTransaction[]> {
    return [];
  }

  async syncTransactions({
    connectionId,
    systemAccountId,
    userId,
  }: {
    connectionId: string;
    systemAccountId: string;
    userId: number;
  }): Promise<void> {
    await this.syncConnectionAccounts({ connectionId, userId, systemAccountIds: [systemAccountId] });
  }

  async syncConnectionAccounts({
    connectionId,
    userId,
    systemAccountIds,
  }: {
    connectionId: string;
    userId: number;
    systemAccountIds: string[];
  }): Promise<void> {
    await enqueuePlaidSync({ connectionId, userId, systemAccountIds });
  }

  async fetchBalance({
    connectionId,
    accountExternalId,
  }: {
    connectionId: string;
    accountExternalId: string;
  }): Promise<ProviderBalance> {
    const credentials = await this.credentialsForConnection({ connectionId });
    const response = await (await this.client()).accountsGet({ access_token: credentials.accessToken });
    const account = response.data.accounts.find((candidate) => candidate.account_id === accountExternalId);
    if (!account) throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.accountNotFound' }) });
    const mapped = mapPlaidAccount({ account });
    return { amount: mapped.balance, currency: mapped.currency, asOf: new Date() };
  }

  async refreshBalance({
    connectionId,
    systemAccountId,
  }: {
    connectionId: string;
    systemAccountId: string;
  }): Promise<void> {
    const account = await Accounts.findByPk(systemAccountId);
    if (!account?.externalId) {
      throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.accountNotFound' }) });
    }
    const balance = await this.fetchBalance({ connectionId, accountExternalId: account.externalId });
    await writeBankBalanceWithHistory({ account, balance: Money.fromCents(balance.amount) });
  }

  private async credentialsForConnection({ connectionId }: { connectionId: string }): Promise<PlaidCredentials> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);
    return connection.getDecryptedCredentials() as unknown as PlaidCredentials;
  }

  private async assertUniqueItem({ userId, itemId }: { userId: number; itemId: string }): Promise<void> {
    const duplicate = await BankDataProviderConnections.findOne({
      where: { userId, providerType: BANK_PROVIDER_TYPE.PLAID, metadata: { itemId } },
    });
    if (duplicate) throw new ConflictError({ message: t({ key: 'bankDataProviders.plaid.itemAlreadyConnected' }) });
  }

  private async assertUniqueLogin({
    userId,
    institutionId,
    fingerprints,
  }: {
    userId: number;
    institutionId: string | null;
    fingerprints: string[];
  }): Promise<void> {
    if (!institutionId) return;
    const connections = await BankDataProviderConnections.findAll({
      where: { userId, providerType: BANK_PROVIDER_TYPE.PLAID },
    });
    const duplicate = connections.some((connection) => {
      const metadata = connection.metadata as PlaidConnectionMetadata & { accountFingerprints?: string[] };
      return (
        metadata.institutionId === institutionId &&
        metadata.accountFingerprints?.some((value) => fingerprints.includes(value))
      );
    });
    if (duplicate) {
      throw new ConflictError({ message: t({ key: 'bankDataProviders.plaid.bankLoginAlreadyConnected' }) });
    }
  }

  private isConnectInput(value: unknown): value is PlaidConnectInput {
    return Boolean(value && typeof value === 'object' && typeof (value as PlaidConnectInput).publicToken === 'string');
  }

  private isStoredCredentials(value: unknown): value is PlaidCredentials {
    return Boolean(value && typeof value === 'object' && typeof (value as PlaidCredentials).accessToken === 'string');
  }
}
