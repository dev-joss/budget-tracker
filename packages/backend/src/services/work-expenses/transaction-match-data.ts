import type { RecordId } from '@bt/shared/types';
import Payees from '@models/payees.model';
import type Transactions from '@models/transactions.model';

const PROVIDER_MERCHANT_FIELDS = [
  'rawMerchantName',
  'merchantName',
  'merchant',
  'payee',
  'counterName',
  'creditorName',
  'debtorName',
] as const;

export interface LocalMatchSnapshot {
  transactionId: RecordId;
  accountId: RecordId;
  amountCents: number;
  currencyCode: string;
  date: string;
  merchant: string;
  transactionType: string;
  transferNature: string;
  isPlanned: boolean;
  isBalanceAdjustment: boolean;
}

function providerMerchant({ externalData }: { externalData: Record<string, unknown> | null }): string | null {
  for (const field of PROVIDER_MERCHANT_FIELDS) {
    const value = externalData?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export async function buildLocalMatchSnapshot({
  transaction,
}: {
  transaction: Transactions;
}): Promise<LocalMatchSnapshot> {
  const payee = transaction.payeeId
    ? await Payees.findOne({ where: { id: transaction.payeeId, userId: transaction.userId }, attributes: ['name'] })
    : null;
  const usesOriginal = transaction.originalAmount !== null && transaction.originalCurrencyCode !== null;
  const externalData = transaction.externalData as Record<string, unknown> | null;

  return {
    transactionId: transaction.id,
    accountId: transaction.accountId,
    amountCents: (usesOriginal ? transaction.originalAmount! : transaction.amount).toCents(),
    currencyCode: usesOriginal ? transaction.originalCurrencyCode! : transaction.currencyCode,
    date: transaction.time.toISOString().slice(0, 10),
    merchant: payee?.name ?? providerMerchant({ externalData }) ?? transaction.note ?? '',
    transactionType: transaction.transactionType,
    transferNature: transaction.transferNature,
    isPlanned: transaction.isPlanned,
    isBalanceAdjustment: externalData?.balanceAdjustment === true,
  };
}
