import { EXPENSIFY_MATCH_STATES, EXPENSIFY_REVIEW_REASONS } from '@bt/shared/types';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import type Transactions from '@models/transactions.model';
import { normalizePayeeName } from '@services/payees/normalize-name';

import { buildLocalMatchSnapshot, type LocalMatchSnapshot } from './transaction-match-data';

interface CapturedLinkedExpense {
  expenseId: string;
  before: LocalMatchSnapshot;
}

export async function captureLinkedExpenseBeforeEdit({
  transaction,
}: {
  transaction: Transactions;
}): Promise<CapturedLinkedExpense | null> {
  const expense = await ExpensifyExpenses.findOne({
    where: { userId: transaction.userId, linkedTransactionId: transaction.id },
    attributes: ['id'],
  });
  if (!expense) return null;
  return { expenseId: expense.id, before: await buildLocalMatchSnapshot({ transaction }) };
}

function hasMaterialLocalChange({ before, after }: { before: LocalMatchSnapshot; after: LocalMatchSnapshot }): boolean {
  return (
    before.accountId !== after.accountId ||
    before.amountCents !== after.amountCents ||
    before.currencyCode !== after.currencyCode ||
    before.date !== after.date ||
    normalizePayeeName({ raw: before.merchant }) !== normalizePayeeName({ raw: after.merchant }) ||
    before.transactionType !== after.transactionType ||
    before.transferNature !== after.transferNature ||
    before.isPlanned !== after.isPlanned ||
    before.isBalanceAdjustment !== after.isBalanceAdjustment
  );
}

export async function flagLinkedExpenseAfterEdit({
  captured,
  transaction,
}: {
  captured: CapturedLinkedExpense | null;
  transaction: Transactions;
}): Promise<void> {
  if (!captured) return;
  const after = await buildLocalMatchSnapshot({ transaction });
  if (!hasMaterialLocalChange({ before: captured.before, after })) return;
  const expense = await ExpensifyExpenses.findOne({ where: { id: captured.expenseId, userId: transaction.userId } });
  if (!expense) return;
  await expense.update({
    matchState: EXPENSIFY_MATCH_STATES.review,
    reviewReasons: [...new Set([...expense.reviewReasons, EXPENSIFY_REVIEW_REASONS.localTransactionChanged])],
    reviewBaseline: {
      ...expense.reviewBaseline,
      currentLocal: after,
    },
  });
}
