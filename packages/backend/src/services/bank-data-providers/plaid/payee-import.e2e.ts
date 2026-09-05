import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { until } from '@common/helpers';
import Transactions from '@models/transactions.model';
import * as helpers from '@tests/helpers';
import { http, HttpResponse } from 'msw';

const ACCOUNT_ID = 'plaid-account-1';

const account = {
  account_id: ACCOUNT_ID,
  balances: {
    available: 987.66,
    current: 1000,
    iso_currency_code: 'AED',
    limit: null,
    unofficial_currency_code: null,
  },
  mask: '1234',
  name: 'Checking',
  official_name: 'Primary Checking',
  persistent_account_id: 'persistent-account-1',
  subtype: 'checking',
  type: 'depository',
  verification_status: null,
};

const configurePlaid = () => {
  process.env.PLAID_CLIENT_ID = 'client-id';
  process.env.PLAID_SECRET = 'secret';
  process.env.PLAID_ENV = 'sandbox';
};

const plaidTransaction = ({
  transactionId,
  date,
  name,
  merchantName,
}: {
  transactionId: string;
  date: string;
  name: string;
  merchantName: string | null;
}) => ({
  account_id: ACCOUNT_ID,
  account_owner: null,
  amount: 12.34,
  authorized_date: date,
  authorized_datetime: null,
  date,
  datetime: null,
  iso_currency_code: 'AED',
  location: {},
  merchant_name: merchantName,
  name,
  payment_channel: 'in store',
  payment_meta: {},
  pending: false,
  pending_transaction_id: null,
  transaction_code: null,
  transaction_id: transactionId,
  unofficial_currency_code: null,
});

describe('Plaid payee import', () => {
  it.each([
    { merchantName: 'Amazon', expectedLinked: true },
    { merchantName: null, expectedLinked: false },
  ])('respects dedicated merchant provenance ($merchantName)', async ({ merchantName, expectedLinked }) => {
    configurePlaid();
    global.mswMockServer.use(
      http.post('https://sandbox.plaid.com/item/public_token/exchange', () =>
        HttpResponse.json({ access_token: 'access-token', item_id: 'item-1', request_id: 'request-1' }),
      ),
      http.post('https://sandbox.plaid.com/item/get', () =>
        HttpResponse.json({
          item: {
            available_products: [],
            billed_products: ['transactions'],
            consent_expiration_time: null,
            error: null,
            institution_id: 'institution-1',
            item_id: 'item-1',
            products: ['transactions'],
            update_type: 'background',
            webhook: '',
          },
          request_id: 'request-2',
          status: null,
        }),
      ),
      http.post('https://sandbox.plaid.com/institutions/get_by_id', () =>
        HttpResponse.json({
          institution: { institution_id: 'institution-1', name: 'Test Bank' },
          request_id: 'request-3',
        }),
      ),
      http.post('https://sandbox.plaid.com/accounts/get', () =>
        HttpResponse.json({ accounts: [account], item: { item_id: 'item-1' }, request_id: 'request-4' }),
      ),
      http.post('https://sandbox.plaid.com/transactions/sync', () =>
        HttpResponse.json({
          added: [
            plaidTransaction({
              merchantName,
              transactionId: 'plaid-transaction-1',
              date: '2026-08-30',
              name: 'AMAZON MKTPL*ORDER123',
            }),
            plaidTransaction({
              merchantName,
              transactionId: 'plaid-transaction-2',
              date: '2026-08-31',
              name: merchantName ? 'Amazon.com*ORDER456' : 'AMAZON MKTPL*ORDER123',
            }),
          ],
          has_more: false,
          modified: [],
          next_cursor: 'cursor-1',
          removed: [],
          request_id: 'request-5',
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
        }),
      ),
    );

    const { connectionId } = await helpers.bankDataProviders.connectProvider({
      providerType: BANK_PROVIDER_TYPE.PLAID,
      credentials: { publicToken: 'public-token' },
      raw: true,
    });
    const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
      connectionId,
      accountExternalIds: [ACCOUNT_ID],
      raw: true,
    });

    await until(async () => Boolean(await Transactions.findOne({ where: { originalId: 'plaid-transaction-1' } })), {
      timeout: 10_000,
      interval: 100,
    });
    const imported = await Transactions.findAll({ where: { accountId: syncedAccounts[0]!.id } });

    expect(imported).toHaveLength(2);
    expect(imported.every((transaction) => transaction.payeeId !== null)).toBe(expectedLinked);
    if (!expectedLinked) expect(imported.every((transaction) => transaction.payeeId === null)).toBe(true);
    expect(new Set(imported.map((transaction) => transaction.payeeId)).size).toBe(1);
  });
});
