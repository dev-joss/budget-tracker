import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_STATUSES,
  EXPENSIFY_ELIGIBLE_REPORT_STATES,
  EXPENSIFY_MATCH_STATES,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
} from '@bt/shared/types';
import Accounts from '@models/accounts.model';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import ExpensifyMatchCandidates from '@models/expensify-match-candidates.model';
import { findTransactions } from '@models/transactions-query';
import { Op } from 'sequelize';

import { classifyCandidateGraph, scoreCandidate, type CandidateEdge } from './matching';
import { isUpstreamCurrentlyMissing } from './review-baseline';
import { buildLocalMatchSnapshot } from './transaction-match-data';

const MAX_MATCHABLE_EXPENSES = 5_000;
const MAX_MATCHABLE_TRANSACTIONS = 20_000;

export async function rebuildUnconfirmedCandidates({ userId }: { userId: number }): Promise<{
  matchedCount: number;
}> {
  const eligibleRows = await ExpensifyExpenses.findAll({
    where: {
      userId,
      isReimbursable: true,
      reportState: { [Op.in]: [...EXPENSIFY_ELIGIBLE_REPORT_STATES] },
      [Op.or]: [
        {
          linkedTransactionId: null,
          matchState: { [Op.ne]: EXPENSIFY_MATCH_STATES.review },
        },
        { matchState: EXPENSIFY_MATCH_STATES.review },
      ],
    },
    order: [['id', 'ASC']],
    limit: MAX_MATCHABLE_EXPENSES,
  });
  const expenses = eligibleRows.filter(
    ({ reviewBaseline }) => !isUpstreamCurrentlyMissing({ baseline: reviewBaseline }),
  );

  if (!expenses.length) return { matchedCount: 0 };
  const reviewExpenseIds = new Set(
    expenses.filter(({ matchState }) => matchState === EXPENSIFY_MATCH_STATES.review).map(({ id }) => id),
  );
  await ExpensifyMatchCandidates.destroy({
    where: { userId, expenseId: { [Op.in]: expenses.map((expense) => expense.id) } },
  });

  const linkedRows = await ExpensifyExpenses.findAll({
    where: { userId, linkedTransactionId: { [Op.not]: null } },
    attributes: ['id', 'linkedTransactionId'],
  });
  const linkedExpenseByTransactionId = new Map(
    linkedRows.flatMap((expense) =>
      expense.linkedTransactionId ? [[expense.linkedTransactionId, expense.id] as const] : [],
    ),
  );

  const expenseTimes = expenses.map((expense) => Date.parse(`${expense.expenseDate}T00:00:00.000Z`));
  const from = new Date(Math.min(...expenseTimes) - 3 * 86_400_000);
  const to = new Date(Math.max(...expenseTimes) + 4 * 86_400_000 - 1);

  const transactions = await findTransactions({
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
    transfers: 'include',
    completeness: { cap: { limit: MAX_MATCHABLE_TRANSACTIONS, onTruncated: 'log', context: { userId } } },
    where: {
      transactionType: TRANSACTION_TYPES.expense,
      transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
      isPlanned: false,
      time: { [Op.between]: [from, to] },
    },
    include: [
      {
        model: Accounts,
        as: 'account',
        required: true,
        where: {
          userId,
          status: ACCOUNT_STATUSES.active,
          accountCategory: ACCOUNT_CATEGORIES.creditCard,
        },
      },
    ],
    order: [['id', 'ASC']],
  });

  const localSnapshots = await Promise.all(
    transactions
      .filter((transaction) => transaction.externalData?.balanceAdjustment !== true)
      .map((transaction) => buildLocalMatchSnapshot({ transaction })),
  );

  const edges: CandidateEdge[] = [];
  for (const expense of expenses) {
    const matchableExpense = {
      id: expense.id,
      amountCents: expense.originalAmount.toCents(),
      currencyCode: expense.originalCurrencyCode,
      date: expense.expenseDate,
      merchant: expense.modifiedMerchant?.trim() || expense.originalMerchant,
    };
    for (const transaction of localSnapshots) {
      const linkedExpenseId = linkedExpenseByTransactionId.get(transaction.transactionId);
      if (linkedExpenseId && linkedExpenseId !== expense.id) continue;
      const score = scoreCandidate({
        expense: matchableExpense,
        transaction: {
          id: transaction.transactionId,
          amountCents: transaction.amountCents,
          currencyCode: transaction.currencyCode,
          date: transaction.date,
          merchant: transaction.merchant,
        },
      });
      if (score) {
        edges.push({
          expenseId: expense.id,
          transactionId: transaction.transactionId,
          ...score,
        });
      }
    }
  }

  const classifications = classifyCandidateGraph({ edges });
  const classificationByExpense = new Map(
    classifications.map((classification) => [classification.expenseId, classification]),
  );

  for (const expense of expenses) {
    const classification = classificationByExpense.get(expense.id);
    if (expense.matchState !== EXPENSIFY_MATCH_STATES.review) {
      await expense.update({ matchState: classification?.state ?? EXPENSIFY_MATCH_STATES.unmatched });
    }
    if (classification?.candidates.length) {
      await ExpensifyMatchCandidates.bulkCreate(
        classification.candidates.map((candidate) => ({
          userId,
          expenseId: expense.id,
          transactionId: candidate.transactionId,
          rank: candidate.rank,
          compositeScoreBps: candidate.compositeScoreBps,
          merchantSimilarityBps: candidate.merchantSimilarityBps,
          dateDistance: candidate.dateDistance,
          isReciprocalTop: candidate.isReciprocalTop,
        })),
      );
    }
  }

  return {
    matchedCount: classifications.filter(
      ({ expenseId, state }) => !reviewExpenseIds.has(expenseId) && state !== EXPENSIFY_MATCH_STATES.unmatched,
    ).length,
  };
}
