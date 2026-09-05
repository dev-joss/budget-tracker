import { ACCOUNT_TYPES, TRANSACTION_TRANSFER_NATURE } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';
import { findOneTransaction } from '@models/transactions-query';
import { getUserDefaultCategory } from '@models/users.model';
import { withTransaction } from '@services/common/with-transaction';
import { lockPayeeNamespace } from '@services/payees/payee-namespace';
import { createTransaction } from '@services/transactions';
import type { AccountBase, PlaidApi, RemovedTransaction, Transaction } from 'plaid';

import { writeBankBalanceWithHistory } from '../utils/write-bank-balance-with-history';
import { createPlaidApiClient, normalizePlaidError } from './api-client';
import { resolvePlaidConfig } from './config';
import { mapPlaidAccount, mapPlaidTransaction } from './transaction-mapper';
import type { PlaidConnectionMetadata, PlaidCredentials } from './types';

interface PlaidSyncChanges {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  nextCursor: string;
  requestIds: string[];
}

const MAX_PAGE_SEQUENCE_ATTEMPTS = 3;

const isRetryableSyncError = ({ error }: { error: unknown }): boolean => {
  const normalized = normalizePlaidError({ error });
  return (
    normalized.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' ||
    normalized.type === 'RATE_LIMIT_EXCEEDED' ||
    normalized.type === 'API_ERROR' ||
    normalized.type === 'INSTITUTION_ERROR'
  );
};

export const fetchPlaidSyncChanges = async ({
  apiClient,
  accessToken,
  startingCursor,
}: {
  apiClient: PlaidApi;
  accessToken: string;
  startingCursor: string | null;
}): Promise<PlaidSyncChanges> => {
  for (let attempt = 1; attempt <= MAX_PAGE_SEQUENCE_ATTEMPTS; attempt += 1) {
    const added: Transaction[] = [];
    const modified: Transaction[] = [];
    const removed: RemovedTransaction[] = [];
    const requestIds: string[] = [];
    let cursor = startingCursor || undefined;
    let hasMore = true;

    try {
      while (hasMore) {
        const response = await apiClient.transactionsSync({ access_token: accessToken, cursor, count: 500 });
        added.push(...response.data.added);
        modified.push(...response.data.modified);
        removed.push(...response.data.removed);
        requestIds.push(response.data.request_id);
        cursor = response.data.next_cursor;
        hasMore = response.data.has_more;
      }

      return { added, modified, removed, nextCursor: cursor!, requestIds };
    } catch (error) {
      if (!isRetryableSyncError({ error }) || attempt === MAX_PAGE_SEQUENCE_ATTEMPTS) throw error;
    }
  }

  throw new Error('Plaid Sync page sequence exhausted');
};

const applyPlaidChanges = withTransaction(
  async ({
    connectionId,
    userId,
    startingCursor,
    changes,
    plaidAccounts,
  }: {
    connectionId: string;
    userId: number;
    startingCursor: string | null;
    changes: PlaidSyncChanges;
    plaidAccounts: AccountBase[];
  }): Promise<{ createdIds: string[]; extractionTransactionIds: string[] }> => {
    await lockPayeeNamespace({ userId });
    const connection = await BankDataProviderConnections.findByPk(connectionId, { lock: true });
    if (!connection || connection.userId !== userId) throw new Error('Plaid connection was not found');
    const metadata = connection.metadata as PlaidConnectionMetadata;
    if ((metadata.cursor || null) !== startingCursor) throw new Error('Plaid cursor changed during sync');

    const accounts = await Accounts.findAll({ where: { userId, bankDataProviderConnectionId: connectionId } });
    const accountsByExternalId = new Map(
      accounts.filter((account) => account.externalId).map((account) => [account.externalId!, account]),
    );
    const defaultCategoryId = await getUserDefaultCategory({ id: userId });
    const createdIds: string[] = [];
    const extractionTransactionIds: string[] = [];

    for (const transaction of changes.added) {
      if (transaction.pending) continue;
      const account = accountsByExternalId.get(transaction.account_id);
      if (!account) continue;
      const existing = await findOneTransaction({
        planned: 'exclude',
        access: 'unscoped-internal',
        balanceAdjustments: 'include',
        where: { accountId: account.id, originalId: transaction.transaction_id },
      });
      if (existing) continue;
      const mapped = mapPlaidTransaction({ transaction, accountCurrency: account.currencyCode });
      const created = await createTransaction({
        originalId: mapped.originalId,
        note: mapped.note,
        amount: mapped.amount,
        time: mapped.time,
        externalData: { plaid: mapped.sourceData },
        commissionRate: Money.zero(),
        cashbackAmount: Money.zero(),
        accountId: account.id,
        userId,
        transactionType: mapped.transactionType,
        paymentType: mapped.paymentType,
        categoryId: defaultCategoryId,
        transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
        accountType: ACCOUNT_TYPES.plaid,
        rawMerchantName: mapped.rawMerchantName,
        matchPlanned: true,
      });
      if (created.mergedIntoPlanned) extractionTransactionIds.push(created[0].id);
      if (!created.mergedIntoPlanned) createdIds.push(created[0].id);
    }

    for (const transaction of changes.modified) {
      if (transaction.pending) continue;
      const account = accountsByExternalId.get(transaction.account_id);
      if (!account) continue;
      const existing = await findOneTransaction({
        planned: 'exclude',
        access: 'unscoped-internal',
        balanceAdjustments: 'include',
        where: { accountId: account.id, originalId: transaction.transaction_id },
      });
      if (!existing) continue;
      const mapped = mapPlaidTransaction({ transaction, accountCurrency: account.currencyCode });
      const previousPlaid = (existing.externalData?.plaid || {}) as Record<string, unknown>;
      await existing.update({
        amount: mapped.amount,
        transactionType: mapped.transactionType,
        paymentType: mapped.paymentType,
        time: mapped.time,
        note: existing.note === previousPlaid.sourceNote ? mapped.note : existing.note,
        externalData: { ...existing.externalData, plaid: mapped.sourceData },
      });
      extractionTransactionIds.push(existing.id);
    }

    for (const removed of changes.removed) {
      const existing = await findOneTransaction({
        planned: 'exclude',
        access: 'unscoped-internal',
        balanceAdjustments: 'include',
        where: { userId, originalId: removed.transaction_id },
      });
      if (!existing) continue;
      const plaid = (existing.externalData?.plaid || {}) as Record<string, unknown>;
      await existing.update({
        externalData: { ...existing.externalData, plaid: { ...plaid, removedAt: new Date().toISOString() } },
      });
    }

    const balancesByExternalId = new Map(
      plaidAccounts.map((plaidAccount) => [plaidAccount.account_id, mapPlaidAccount({ account: plaidAccount })]),
    );
    for (const account of accounts) {
      if (!account.externalId) continue;
      const balance = balancesByExternalId.get(account.externalId);
      if (!balance) continue;
      await writeBankBalanceWithHistory({ account, balance: Money.fromCents(balance.balance) });
    }

    connection.metadata = { ...metadata, cursor: changes.nextCursor };
    connection.lastSyncAt = new Date();
    await connection.save();
    return { createdIds, extractionTransactionIds };
  },
);

export const syncPlaidItem = async ({ connectionId, userId }: { connectionId: string; userId: number }) => {
  const connection = await BankDataProviderConnections.findOne({ where: { id: connectionId, userId } });
  if (!connection) throw new Error('Plaid connection was not found');
  const metadata = connection.metadata as PlaidConnectionMetadata;
  const { accessToken } = connection.getDecryptedCredentials() as unknown as PlaidCredentials;
  const config = await resolvePlaidConfig();
  if (!config) throw new Error('Plaid is not configured');
  const changes = await fetchPlaidSyncChanges({
    apiClient: createPlaidApiClient({ config }),
    accessToken,
    startingCursor: metadata.cursor || null,
  });
  const accountsResponse = await createPlaidApiClient({ config }).accountsGet({ access_token: accessToken });
  const { createdIds, extractionTransactionIds } = await applyPlaidChanges({
    connectionId,
    userId,
    startingCursor: metadata.cursor || null,
    changes,
    plaidAccounts: accountsResponse.data.accounts,
  });
  logger.info('[Plaid] Item sync completed', {
    connectionId,
    added: changes.added.length,
    modified: changes.modified.length,
    removed: changes.removed.length,
    requestIds: changes.requestIds,
  });
  return { createdIds, extractionTransactionIds };
};
