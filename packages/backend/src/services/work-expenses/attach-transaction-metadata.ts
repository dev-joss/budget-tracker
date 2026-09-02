import type { RecordId } from '@bt/shared/types';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import { Op } from 'sequelize';

export async function attachWorkExpenseMetadata<T extends { id: RecordId }>({
  transactions,
}: {
  transactions: T[];
}): Promise<T[]> {
  if (!transactions.length) return transactions;
  const linked = await ExpensifyExpenses.findAll({
    where: { linkedTransactionId: { [Op.in]: transactions.map(({ id }) => id) } },
    attributes: ['linkedTransactionId', 'matchState', 'reviewReasons'],
  });
  const byTransactionId = new Map(linked.map((expense) => [expense.linkedTransactionId, expense]));
  return transactions.map((transaction) => {
    const expense = byTransactionId.get(transaction.id);
    Object.assign(transaction, {
      workExpenseMatchState: expense?.matchState ?? null,
      workExpenseReviewReasons: expense?.reviewReasons ?? [],
    });
    return transaction;
  });
}
