import { PAYMENT_TYPES, TRANSACTION_TYPES } from '@bt/shared/types';
import { AccountSubtype, AccountType, TransactionPaymentChannelEnum, type AccountBase, type Transaction } from 'plaid';

import { activityTimeForPlaidTransaction, mapPlaidAccount, mapPlaidTransaction } from './transaction-mapper';

const buildTransaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    account_id: 'account-1',
    amount: 12.34,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: '2026-08-30',
    name: 'SOURCE DESCRIPTION',
    merchant_name: 'Merchant',
    payment_meta: {},
    pending: false,
    pending_transaction_id: null,
    account_owner: null,
    transaction_id: 'transaction-1',
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    payment_channel: 'online',
    location: {},
    transaction_code: null,
    ...overrides,
  }) as Transaction;

describe('mapPlaidTransaction', () => {
  it('converts Plaid money-out signs to an expense with an absolute amount', () => {
    const mapped = mapPlaidTransaction({ transaction: buildTransaction(), accountCurrency: 'USD' });

    expect(mapped.amount.toNumber()).toBe(12.34);
    expect(mapped.transactionType).toBe(TRANSACTION_TYPES.expense);
    expect(mapped.paymentType).toBe(PAYMENT_TYPES.webPayment);
    expect(mapped.rawMerchantName).toBe('Merchant');
    expect(mapped.sourceData.personalFinanceCategory).toBeUndefined();
  });

  it('converts negative Plaid amounts to income', () => {
    const mapped = mapPlaidTransaction({
      transaction: buildTransaction({ amount: -100, payment_channel: TransactionPaymentChannelEnum.Other }),
      accountCurrency: 'USD',
    });

    expect(mapped.amount.toNumber()).toBe(100);
    expect(mapped.transactionType).toBe(TRANSACTION_TYPES.income);
    expect(mapped.paymentType).toBe(PAYMENT_TYPES.bankTransfer);
  });

  it('uses the documented activity-time precedence', () => {
    expect(
      activityTimeForPlaidTransaction({
        transaction: buildTransaction({
          authorized_datetime: '2026-08-27T14:30:00Z',
          authorized_date: '2026-08-28',
          datetime: '2026-08-29T15:30:00Z',
          date: '2026-08-30',
        }),
      }).toISOString(),
    ).toBe('2026-08-27T14:30:00.000Z');

    expect(
      activityTimeForPlaidTransaction({
        transaction: buildTransaction({ authorized_date: '2026-08-28', datetime: '2026-08-29T15:30:00Z' }),
      }).toISOString(),
    ).toBe('2026-08-28T00:00:00.000Z');
  });

  it('rejects a material ISO currency mismatch', () => {
    expect(() =>
      mapPlaidTransaction({ transaction: buildTransaction({ iso_currency_code: 'CAD' }), accountCurrency: 'USD' }),
    ).toThrow('does not match');
  });
});

describe('mapPlaidAccount', () => {
  it('maps the authoritative account currency and balance', () => {
    const account = {
      account_id: 'account-1',
      balances: {
        available: 900,
        current: 1000,
        iso_currency_code: 'usd',
        limit: null,
        unofficial_currency_code: null,
      },
      mask: '1234',
      name: 'Checking',
      official_name: 'Primary Checking',
      type: AccountType.Depository,
      subtype: AccountSubtype.Checking,
    } as AccountBase;

    expect(mapPlaidAccount({ account })).toMatchObject({
      externalId: 'account-1',
      name: 'Primary Checking',
      balance: 100000,
      currency: 'USD',
    });
  });
});
