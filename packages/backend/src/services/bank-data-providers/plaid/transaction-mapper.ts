import { PAYMENT_TYPES, TRANSACTION_TYPES } from '@bt/shared/types';
import { Money } from '@common/types/money';
import type { AccountBase, Transaction } from 'plaid';

export interface MappedPlaidTransaction {
  originalId: string;
  accountExternalId: string;
  amount: Money;
  transactionType: TRANSACTION_TYPES;
  paymentType: PAYMENT_TYPES;
  time: Date;
  note: string;
  rawMerchantName: string | null;
  sourceData: Record<string, unknown>;
}

const dateOnlyToUtc = ({ value }: { value: string }): Date => new Date(`${value}T00:00:00.000Z`);

export const activityTimeForPlaidTransaction = ({ transaction }: { transaction: Transaction }): Date => {
  if (transaction.authorized_datetime) return new Date(transaction.authorized_datetime);
  if (transaction.authorized_date) return dateOnlyToUtc({ value: transaction.authorized_date });
  if (transaction.datetime) return new Date(transaction.datetime);
  return dateOnlyToUtc({ value: transaction.date });
};

const paymentTypeForChannel = ({ channel }: { channel: Transaction['payment_channel'] }): PAYMENT_TYPES => {
  if (channel === 'online') return PAYMENT_TYPES.webPayment;
  if (channel === 'in store') return PAYMENT_TYPES.debitCard;
  return PAYMENT_TYPES.bankTransfer;
};

export const mapPlaidTransaction = ({
  transaction,
  accountCurrency,
}: {
  transaction: Transaction;
  accountCurrency: string;
}): MappedPlaidTransaction => {
  const sourceCurrency = transaction.iso_currency_code || transaction.unofficial_currency_code;
  if (transaction.iso_currency_code && transaction.iso_currency_code.toUpperCase() !== accountCurrency.toUpperCase()) {
    throw new Error(`Plaid transaction currency does not match account currency for ${transaction.transaction_id}`);
  }

  return {
    originalId: transaction.transaction_id,
    accountExternalId: transaction.account_id,
    amount: Money.fromDecimal(transaction.amount).abs(),
    transactionType: transaction.amount >= 0 ? TRANSACTION_TYPES.expense : TRANSACTION_TYPES.income,
    paymentType: paymentTypeForChannel({ channel: transaction.payment_channel }),
    time: activityTimeForPlaidTransaction({ transaction }),
    note: transaction.name,
    rawMerchantName: transaction.merchant_name?.trim() || null,
    sourceData: {
      accountId: transaction.account_id,
      pending: transaction.pending,
      pendingTransactionId: transaction.pending_transaction_id,
      authorizedDate: transaction.authorized_date,
      authorizedDatetime: transaction.authorized_datetime,
      datetime: transaction.datetime,
      date: transaction.date,
      paymentChannel: transaction.payment_channel,
      personalFinanceCategory: transaction.personal_finance_category,
      isoCurrencyCode: transaction.iso_currency_code,
      unofficialCurrencyCode: transaction.unofficial_currency_code,
      sourceCurrency,
      sourceNote: transaction.name,
      merchantName: transaction.merchant_name,
      merchantEntityId: transaction.merchant_entity_id,
      requestContext: null,
    },
  };
};

export const mapPlaidAccount = ({ account }: { account: AccountBase }) => {
  const currency = account.balances.iso_currency_code || account.balances.unofficial_currency_code;
  if (!currency) throw new Error(`Plaid account ${account.account_id} has no currency`);

  return {
    externalId: account.account_id,
    name: account.official_name || account.name,
    type: account.subtype || account.type,
    balance: Money.fromDecimal(account.balances.current ?? 0).toCents(),
    currency: currency.toUpperCase(),
    metadata: {
      mask: account.mask,
      name: account.name,
      officialName: account.official_name,
      plaidType: account.type,
      plaidSubtype: account.subtype,
      availableBalance: account.balances.available,
      limit: account.balances.limit,
    },
  };
};
