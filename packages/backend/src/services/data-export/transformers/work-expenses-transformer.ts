import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import Accounts from '@models/accounts.model';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import { findTransactions } from '@models/transactions-query';
import Transactions from '@models/transactions.model';
import { Op } from 'sequelize';

import type { WorkExpenseRow } from '../types';

function linkedDescription({ transaction, accountName }: { transaction: Transactions; accountName: string }): string {
  const date = transaction.time.toISOString().slice(0, 10);
  const amount = transaction.amount.toNumber().toFixed(2);
  const signed = transaction.transactionType === TRANSACTION_TYPES.income ? amount : `-${amount}`;
  return `${date} ${accountName} ${signed} ${transaction.currencyCode}`;
}

export async function transformWorkExpenses({ userId }: { userId: number }): Promise<WorkExpenseRow[]> {
  const expenses = await ExpensifyExpenses.findAll({
    where: { userId },
    order: [
      ['expenseDate', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  if (!expenses.length) return [];
  const transactionIds = expenses
    .map(({ linkedTransactionId }) => linkedTransactionId)
    .filter((id): id is RecordId => Boolean(id));
  const transactions = transactionIds.length
    ? await findTransactions({
        planned: 'include',
        access: { creator: userId },
        balanceAdjustments: 'include',
        transfers: 'include',
        completeness: 'all',
        where: { id: { [Op.in]: transactionIds } },
      })
    : [];
  const accountIds = [...new Set(transactions.map(({ accountId }) => accountId))];
  const accounts = accountIds.length
    ? await Accounts.findAll({ where: { userId, id: { [Op.in]: accountIds } }, attributes: ['id', 'name'] })
    : [];
  const accountNameById = new Map(accounts.map(({ id, name }) => [id, name]));
  const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));

  return expenses.map((expense) => {
    const transaction = expense.linkedTransactionId ? transactionById.get(expense.linkedTransactionId) : undefined;
    return {
      externalExpenseId: expense.externalExpenseId,
      externalReportId: expense.externalReportId,
      reportState: expense.reportState,
      amount: expense.originalAmount.toNumber(),
      currency: expense.originalCurrencyCode,
      expenseDate: expense.expenseDate,
      originalMerchant: expense.originalMerchant,
      modifiedMerchant: expense.modifiedMerchant ?? '',
      reimbursable: expense.isReimbursable,
      matchState: expense.matchState,
      linkedTransaction: transaction
        ? linkedDescription({
            transaction,
            accountName: accountNameById.get(transaction.accountId) ?? '(unresolved account)',
          })
        : '',
      confirmedAt: expense.confirmedAt?.toISOString() ?? '',
      reviewReasons: expense.reviewReasons,
    };
  });
}
