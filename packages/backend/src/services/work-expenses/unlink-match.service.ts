import { EXPENSIFY_MATCH_STATES } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError, NotFoundError } from '@js/errors';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import ExpensifyMatchCandidates from '@models/expensify-match-candidates.model';
import { withTransaction } from '@services/common/with-transaction';

export const unlinkMatch = withTransaction(async ({ userId, expenseId }: { userId: number; expenseId: string }) => {
  const expense = await ExpensifyExpenses.findOne({ where: { id: expenseId, userId }, lock: true });
  if (!expense) throw new NotFoundError({ message: t({ key: 'workExpenses.expenseNotFound' }) });
  if (!expense.linkedTransactionId) {
    throw new ConflictError({ message: t({ key: 'workExpenses.matchNotLinked' }) });
  }
  const unlinkedTransactionId = expense.linkedTransactionId;
  await expense.update({
    linkedTransactionId: null,
    confirmationTier: null,
    confirmedAt: null,
    confirmationFingerprint: null,
    matchState: EXPENSIFY_MATCH_STATES.unmatched,
    reviewReasons: [],
    reviewBaseline: {
      ...expense.reviewBaseline,
      unlinkedTransactionId,
      unlinkedAt: new Date().toISOString(),
    },
  });
  await ExpensifyMatchCandidates.destroy({ where: { userId, expenseId } });
  return { expenseId: expense.id };
});
