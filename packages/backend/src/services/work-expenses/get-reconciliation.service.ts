import {
  type ExpensifyMatchState,
  type ExpensifyReconciliationItem,
  type ExpensifyReconciliationResponse,
  type RecordId,
} from '@bt/shared/types';
import Accounts from '@models/accounts.model';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import ExpensifyMatchCandidates from '@models/expensify-match-candidates.model';
import Payees from '@models/payees.model';
import { findTransactions } from '@models/transactions-query';
import { Op } from 'sequelize';

function serializeExpense({ expense }: { expense: ExpensifyExpenses }) {
  return {
    id: expense.id,
    externalExpenseId: expense.externalExpenseId,
    externalReportId: expense.externalReportId,
    reportState: expense.reportState,
    originalAmount: expense.originalAmount.toNumber(),
    originalCurrencyCode: expense.originalCurrencyCode,
    expenseDate: expense.expenseDate,
    originalMerchant: expense.originalMerchant,
    modifiedMerchant: expense.modifiedMerchant,
    isReimbursable: expense.isReimbursable,
    matchState: expense.matchState,
    linkedTransactionId: expense.linkedTransactionId,
    confirmationTier: expense.confirmationTier,
    confirmedAt: expense.confirmedAt?.toISOString() ?? null,
    reviewReasons: expense.reviewReasons,
  };
}

async function buildReconciliationItems({
  userId,
  expenses,
}: {
  userId: number;
  expenses: ExpensifyExpenses[];
}): Promise<ExpensifyReconciliationItem[]> {
  if (!expenses.length) return [];
  const candidates = await ExpensifyMatchCandidates.findAll({
    where: { userId, expenseId: { [Op.in]: expenses.map(({ id }) => id) } },
    order: [
      ['expenseId', 'ASC'],
      ['rank', 'ASC'],
    ],
  });
  const transactionIds = [...new Set(candidates.map(({ transactionId }) => transactionId))];
  const transactions = transactionIds.length
    ? await findTransactions({
        planned: 'include',
        access: { creator: userId },
        balanceAdjustments: 'include',
        transfers: 'include',
        completeness: 'all',
        where: { id: { [Op.in]: transactionIds } },
        include: [
          { model: Accounts, as: 'account', required: true, attributes: ['name'] },
          { model: Payees, as: 'payee', required: false, attributes: ['name'] },
        ],
      })
    : [];
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const candidatesByExpense = new Map<RecordId, ExpensifyMatchCandidates[]>();
  for (const candidate of candidates) {
    const grouped = candidatesByExpense.get(candidate.expenseId) ?? [];
    grouped.push(candidate);
    candidatesByExpense.set(candidate.expenseId, grouped);
  }

  return expenses.map((expense) => ({
    expense: serializeExpense({ expense }),
    candidates: (candidatesByExpense.get(expense.id) ?? []).flatMap((candidate) => {
      const transaction = transactionById.get(candidate.transactionId);
      if (!transaction) return [];
      return [
        {
          transactionId: candidate.transactionId,
          rank: candidate.rank,
          compositeScoreBps: candidate.compositeScoreBps,
          merchantSimilarityBps: candidate.merchantSimilarityBps,
          dateDistance: candidate.dateDistance,
          isReciprocalTop: candidate.isReciprocalTop,
          transaction: {
            id: transaction.id,
            amount: transaction.amount.toNumber(),
            originalAmount: transaction.originalAmount?.toNumber() ?? null,
            currencyCode: transaction.currencyCode,
            originalCurrencyCode: transaction.originalCurrencyCode,
            time: transaction.time.toISOString(),
            note: transaction.note ?? '',
            payeeName: transaction.payee?.name ?? null,
            accountName: transaction.account.name,
          },
        },
      ];
    }),
  }));
}

export async function getReconciliation({
  userId,
  state,
  limit,
  offset,
}: {
  userId: number;
  state?: ExpensifyMatchState;
  limit: number;
  offset: number;
}): Promise<ExpensifyReconciliationResponse> {
  const where = { userId, ...(state ? { matchState: state } : {}) };
  const { rows, count } = await ExpensifyExpenses.findAndCountAll({
    where,
    order: [
      ['expenseDate', 'DESC'],
      ['id', 'ASC'],
    ],
    limit,
    offset,
  });
  return {
    items: await buildReconciliationItems({ userId, expenses: rows }),
    total: count,
    limit,
    offset,
  };
}

export async function getReconciliationItem({
  userId,
  expenseId,
}: {
  userId: number;
  expenseId: RecordId;
}): Promise<ExpensifyReconciliationItem | null> {
  const expense = await ExpensifyExpenses.findOne({ where: { id: expenseId, userId } });
  if (!expense) return null;
  return (await buildReconciliationItems({ userId, expenses: [expense] }))[0] ?? null;
}
