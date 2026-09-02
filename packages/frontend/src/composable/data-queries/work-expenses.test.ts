import type { RecordId } from '@bt/shared/types';

import { exactMatchForItem } from './work-expenses';

const EXPENSE_ID = 'expense-1' as RecordId;
const TRANSACTION_ONE_ID = 'transaction-1' as RecordId;
const TRANSACTION_TWO_ID = 'transaction-2' as RecordId;

describe('exactMatchForItem', () => {
  it('returns the reciprocal first candidate for an exact expense', () => {
    expect(
      exactMatchForItem({
        expenseId: EXPENSE_ID,
        matchState: 'exact',
        candidates: [
          { transactionId: TRANSACTION_TWO_ID, rank: 2, isReciprocalTop: false },
          { transactionId: TRANSACTION_ONE_ID, rank: 1, isReciprocalTop: true },
        ],
      }),
    ).toEqual({ expenseId: EXPENSE_ID, transactionId: TRANSACTION_ONE_ID });
  });

  it('rejects non-exact and non-reciprocal candidates', () => {
    expect(
      exactMatchForItem({
        expenseId: EXPENSE_ID,
        matchState: 'likely',
        candidates: [{ transactionId: TRANSACTION_ONE_ID, rank: 1, isReciprocalTop: true }],
      }),
    ).toBeNull();
    expect(
      exactMatchForItem({
        expenseId: EXPENSE_ID,
        matchState: 'exact',
        candidates: [{ transactionId: TRANSACTION_ONE_ID, rank: 1, isReciprocalTop: false }],
      }),
    ).toBeNull();
  });
});
