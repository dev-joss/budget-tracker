import {
  EXPENSIFY_MATCH_STATES,
  WORK_EXPENSE_SOURCES,
  type ExpensifyConfirmationTier,
  type RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError } from '@js/errors';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import ExpensifyMatchCandidates from '@models/expensify-match-candidates.model';
import { withTransaction } from '@services/common/with-transaction';
import { UniqueConstraintError } from 'sequelize';

import {
  CONFIRMABLE_STATES,
  assertNoManualDecision,
  assertTransactionNotLinked,
  baselineForConfirmation,
  isExpenseCurrentlyEligible,
  loadEligibleCardTransaction,
  validateCurrentMatch,
} from './confirmation';
import { rebuildUnconfirmedCandidates } from './rebuild-candidates.service';

interface RequestedMatch {
  expenseId: RecordId;
  transactionId: RecordId;
}

const confirmMatchesImpl = async ({ userId, matches }: { userId: number; matches: RequestedMatch[] }) => {
  const expenseIds = matches.map(({ expenseId }) => expenseId);
  const transactionIds = matches.map(({ transactionId }) => transactionId);
  if (new Set(expenseIds).size !== matches.length || new Set(transactionIds).size !== matches.length) {
    throw new ConflictError({ message: t({ key: 'workExpenses.duplicateConfirmation' }) });
  }

  await rebuildUnconfirmedCandidates({ userId });
  for (const requested of matches) {
    const expense = await ExpensifyExpenses.findOne({ where: { id: requested.expenseId, userId }, lock: true });
    if (
      !expense ||
      expense.linkedTransactionId ||
      !isExpenseCurrentlyEligible({ expense }) ||
      !CONFIRMABLE_STATES.includes(expense.matchState as (typeof CONFIRMABLE_STATES)[number])
    ) {
      throw new ConflictError({ message: t({ key: 'workExpenses.staleMatch' }) });
    }

    const candidate = await ExpensifyMatchCandidates.findOne({
      where: { userId, expenseId: expense.id, transactionId: requested.transactionId },
      lock: true,
    });
    if (!candidate) throw new ConflictError({ message: t({ key: 'workExpenses.staleMatch' }) });
    if (matches.length > 1 && (expense.matchState !== EXPENSIFY_MATCH_STATES.exact || !candidate.isReciprocalTop)) {
      throw new ConflictError({ message: t({ key: 'workExpenses.bulkExactOnly' }) });
    }

    const transaction = await loadEligibleCardTransaction({
      userId,
      transactionId: requested.transactionId,
      lock: true,
    });
    assertNoManualDecision({ transaction });
    await assertTransactionNotLinked({ userId, transactionId: transaction.id });
    const { local, score } = await validateCurrentMatch({ expense, transaction });
    if (
      score.compositeScoreBps !== candidate.compositeScoreBps ||
      score.merchantSimilarityBps !== candidate.merchantSimilarityBps ||
      score.dateDistance !== candidate.dateDistance
    ) {
      throw new ConflictError({ message: t({ key: 'workExpenses.staleMatch' }) });
    }

    await transaction.update({ isWorkExpense: true, workExpenseSource: WORK_EXPENSE_SOURCES.expensify });
    await expense.update({
      linkedTransactionId: transaction.id,
      confirmationTier: expense.matchState as ExpensifyConfirmationTier,
      confirmedAt: new Date(),
      confirmationFingerprint: expense.upstreamFingerprint,
      reviewReasons: [],
      reviewBaseline: baselineForConfirmation({ expense, local }),
    });
  }
  return { confirmedCount: matches.length };
};

const confirmMatchesInTransaction = withTransaction(confirmMatchesImpl);

export async function confirmMatches({ userId, matches }: { userId: number; matches: RequestedMatch[] }) {
  try {
    return await confirmMatchesInTransaction({ userId, matches });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      throw new ConflictError({ message: t({ key: 'workExpenses.transactionAlreadyLinked' }) });
    }
    throw error;
  }
}
