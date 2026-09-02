import { t } from '@i18n/index';
import { Products, type PlaidApi } from 'plaid';

import { createPlaidApiClient } from './api-client';
import { plaidClientUserId } from './client-user-id';
import { resolvePlaidConfig } from './config';

export const createPlaidLinkToken = async ({
  userId,
  clientName = 'MoneyMatter',
  apiClient,
}: {
  userId: number;
  clientName?: string;
  apiClient?: PlaidApi;
}): Promise<{ linkToken: string; expiration: string }> => {
  const config = await resolvePlaidConfig();
  if (!config) throw new Error(t({ key: 'bankDataProviders.plaid.notConfigured' }));

  const clientUserId = plaidClientUserId({ userId, secret: config.secret });
  const response = await (apiClient || createPlaidApiClient({ config })).linkTokenCreate({
    client_name: clientName,
    country_codes: config.countryCodes,
    language: 'en',
    products: [Products.Transactions],
    user: { client_user_id: clientUserId },
    transactions: { days_requested: config.transactionsDaysRequested },
    ...(config.redirectUri && { redirect_uri: config.redirectUri }),
    ...(config.webhookUrl && { webhook: config.webhookUrl }),
  });

  return { linkToken: response.data.link_token, expiration: response.data.expiration };
};
