import {
  EXPENSIFY_CONFIRMATION_TIERS,
  EXPENSIFY_MATCH_STATES,
  WORK_EXPENSE_SOURCES,
  type RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError, NotFoundError } from '@js/errors';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import ExpensifyMatchCandidates from '@models/expensify-match-candidates.model';
import { findOneTransaction } from '@models/transactions-query';
import { withTransaction } from '@services/common/with-transaction';

import {
  assertNoManualDecision,
  assertTransactionNotLinked,
  baselineForConfirmation,
  isExpenseCurrentlyEligible,
  loadEligibleCardTransaction,
  validateCurrentMatch,
} from './confirmation';
import { getReconciliationItem } from './get-reconciliation.service';
import { acknowledgeReviewConditions } from './review-baseline';

const resolveReviewImpl = async ({
  userId,
  expenseId,
  action,
  transactionId,
}: {
  userId: number;
  expenseId: RecordId;
  action: 'keep' | 'relink';
  transactionId?: RecordId;
}) => {
  const expense = await ExpensifyExpenses.findOne({ where: { id: expenseId, userId }, lock: true });
  if (!expense) throw new NotFoundError({ message: t({ key: 'workExpenses.expenseNotFound' }) });
  if (expense.matchState !== EXPENSIFY_MATCH_STATES.review) {
    throw new ConflictError({ message: t({ key: 'workExpenses.reviewAlreadyResolved' }) });
  }

  if (action === 'keep') {
    if (!expense.linkedTransactionId) throw new ConflictError({ message: t({ key: 'workExpenses.matchNotLinked' }) });
    const transaction = await findOneTransaction({
      planned: 'include',
      access: { creator: userId },
      balanceAdjustments: 'include',
      transfers: 'include',
      where: { id: expense.linkedTransactionId },
      lock: true,
    });
    if (!transaction) throw new ConflictError({ message: t({ key: 'workExpenses.matchNotLinked' }) });
    if (transaction.workExpenseSource !== WORK_EXPENSE_SOURCES.manual) {
      await transaction.update({ isWorkExpense: true, workExpenseSource: WORK_EXPENSE_SOURCES.expensify });
    }
    const reviewBaseline = acknowledgeReviewConditions({
      baseline: expense.reviewBaseline,
      reasons: expense.reviewReasons,
      upstreamFingerprint: expense.upstreamFingerprint,
      resolvedAt: new Date().toISOString(),
    });
    await expense.update({
      matchState: expense.confirmationTier ?? EXPENSIFY_MATCH_STATES.likely,
      reviewReasons: [],
      confirmationFingerprint: expense.upstreamFingerprint,
      reviewBaseline,
    });
  } else {
    if (!transactionId) throw new ConflictError({ message: t({ key: 'workExpenses.transactionRequired' }) });
    if (!isExpenseCurrentlyEligible({ expense })) {
      throw new ConflictError({ message: t({ key: 'workExpenses.staleMatch' }) });
    }
    const candidate = await ExpensifyMatchCandidates.findOne({
      where: { userId, expenseId: expense.id, transactionId },
      lock: true,
    });
    if (!candidate) throw new ConflictError({ message: t({ key: 'workExpenses.staleMatch' }) });
    const transaction = await loadEligibleCardTransaction({ userId, transactionId, lock: true });
    assertNoManualDecision({ transaction });
    await assertTransactionNotLinked({ userId, transactionId, exceptExpenseId: expense.id });
    const { local, score } = await validateCurrentMatch({ expense, transaction });
    if (
      score.compositeScoreBps !== candidate.compositeScoreBps ||
      score.merchantSimilarityBps !== candidate.merchantSimilarityBps ||
      score.dateDistance !== candidate.dateDistance
    ) {
      throw new ConflictError({ message: t({ key: 'workExpenses.staleMatch' }) });
    }

    if (expense.linkedTransactionId && expense.linkedTransactionId !== transaction.id) {
      const prior = await findOneTransaction({
        planned: 'include',
        access: { creator: userId },
        balanceAdjustments: 'include',
        transfers: 'include',
        where: { id: expense.linkedTransactionId },
        lock: true,
      });
      if (prior?.workExpenseSource === WORK_EXPENSE_SOURCES.expensify) {
        await prior.update({ isWorkExpense: false, workExpenseSource: null });
      }
    }
    await transaction.update({ isWorkExpense: true, workExpenseSource: WORK_EXPENSE_SOURCES.expensify });
    await expense.update({
      linkedTransactionId: transaction.id,
      confirmationTier: EXPENSIFY_CONFIRMATION_TIERS.ambiguous,
      confirmedAt: new Date(),
      confirmationFingerprint: expense.upstreamFingerprint,
      matchState: EXPENSIFY_MATCH_STATES.ambiguous,
      reviewReasons: [],
      reviewBaseline: baselineForConfirmation({ expense, local }),
    });
  }

  return getReconciliationItem({ userId, expenseId });
};

export const resolveReview = withTransaction(resolveReviewImpl);
