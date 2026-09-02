import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES, WORK_EXPENSE_SOURCES } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import { withTransaction } from '@services/common/with-transaction';
import { getWritableTransactionById } from '@services/transactions/get-by-id';

import { attachWorkExpenseMetadata } from './attach-transaction-metadata';

export const setManualWorkExpense = withTransaction(
  async ({
    userId,
    transactionId,
    isWorkExpense,
  }: {
    userId: number;
    transactionId: string;
    isWorkExpense: boolean;
  }) => {
    const { tx } = await getWritableTransactionById({ id: transactionId, userId });
    if (
      tx.transactionType !== TRANSACTION_TYPES.expense ||
      tx.transferNature !== TRANSACTION_TRANSFER_NATURE.not_transfer ||
      tx.isPlanned ||
      tx.externalData?.balanceAdjustment === true
    ) {
      throw new ValidationError({ message: t({ key: 'workExpenses.transactionIneligible' }) });
    }

    await tx.update({ isWorkExpense, workExpenseSource: WORK_EXPENSE_SOURCES.manual });
    const [enriched] = await attachWorkExpenseMetadata({ transactions: [tx] });
    return enriched!;
  },
);
