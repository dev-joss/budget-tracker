import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_STATUSES,
  EXPENSIFY_ELIGIBLE_REPORT_STATES,
  EXPENSIFY_MATCH_STATES,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
  WORK_EXPENSE_SOURCES,
  type RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError } from '@js/errors';
import Accounts from '@models/accounts.model';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import { findOneTransaction } from '@models/transactions-query';
import Transactions from '@models/transactions.model';

import { MATCHING_BOUNDS, scoreCandidate } from './matching';
import { buildLocalMatchSnapshot } from './transaction-match-data';

export function isExpenseCurrentlyEligible({ expense }: { expense: ExpensifyExpenses }): boolean {
  return (
    expense.isReimbursable &&
    EXPENSIFY_ELIGIBLE_REPORT_STATES.includes(expense.reportState as (typeof EXPENSIFY_ELIGIBLE_REPORT_STATES)[number])
  );
}

export async function loadEligibleCardTransaction({
  userId,
  transactionId,
  lock = false,
}: {
  userId: number;
  transactionId: RecordId;
  lock?: boolean;
}): Promise<Transactions> {
  const transaction = await findOneTransaction({
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
    transfers: 'include',
    where: {
      id: transactionId,
      transactionType: TRANSACTION_TYPES.expense,
      transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
      isPlanned: false,
    },
    include: [
      {
        model: Accounts,
        as: 'account',
        required: true,
        where: { userId, status: ACCOUNT_STATUSES.active, accountCategory: ACCOUNT_CATEGORIES.creditCard },
      },
    ],
    lock,
  });
  if (!transaction || transaction.externalData?.balanceAdjustment === true) {
    throw new ConflictError({ message: t({ key: 'workExpenses.staleMatch' }) });
  }
  return transaction;
}

export async function validateCurrentMatch({
  expense,
  transaction,
}: {
  expense: ExpensifyExpenses;
  transaction: Transactions;
}) {
  const local = await buildLocalMatchSnapshot({ transaction });
  const score = scoreCandidate({
    expense: {
      id: expense.id,
      amountCents: expense.originalAmount.toCents(),
      currencyCode: expense.originalCurrencyCode,
      date: expense.expenseDate,
      merchant: expense.modifiedMerchant?.trim() || expense.originalMerchant,
    },
    transaction: {
      id: local.transactionId,
      amountCents: local.amountCents,
      currencyCode: local.currencyCode,
      date: local.date,
      merchant: local.merchant,
    },
  });
  if (!score || score.merchantSimilarityBps < MATCHING_BOUNDS.plausibleMerchantBps) {
    throw new ConflictError({ message: t({ key: 'workExpenses.staleMatch' }) });
  }
  return { local, score };
}

export function assertNoManualDecision({ transaction }: { transaction: Transactions }): void {
  if (transaction.workExpenseSource === WORK_EXPENSE_SOURCES.manual) {
    throw new ConflictError({ message: t({ key: 'workExpenses.manualDecisionWins' }) });
  }
}

export async function assertTransactionNotLinked({
  userId,
  transactionId,
  exceptExpenseId,
}: {
  userId: number;
  transactionId: RecordId;
  exceptExpenseId?: RecordId;
}): Promise<void> {
  const existing = await ExpensifyExpenses.findOne({ where: { userId, linkedTransactionId: transactionId } });
  if (existing && existing.id !== exceptExpenseId) {
    throw new ConflictError({ message: t({ key: 'workExpenses.transactionAlreadyLinked' }) });
  }
}

export function baselineForConfirmation({
  expense,
  local,
}: {
  expense: ExpensifyExpenses;
  local: Awaited<ReturnType<typeof buildLocalMatchSnapshot>>;
}) {
  return {
    upstreamAtConfirmation: {
      fingerprint: expense.upstreamFingerprint,
      amountCents: expense.originalAmount.toCents(),
      currencyCode: expense.originalCurrencyCode,
      date: expense.expenseDate,
      merchant: expense.modifiedMerchant?.trim() || expense.originalMerchant,
    },
    localAtConfirmation: local,
  };
}

export const CONFIRMABLE_STATES = [
  EXPENSIFY_MATCH_STATES.exact,
  EXPENSIFY_MATCH_STATES.likely,
  EXPENSIFY_MATCH_STATES.ambiguous,
] as const;
