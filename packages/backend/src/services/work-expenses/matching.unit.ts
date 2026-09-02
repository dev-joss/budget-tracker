import { EXPENSIFY_MATCH_STATES, type RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import {
  classifyCandidateGraph,
  merchantSimilarityBps,
  scoreCandidate,
  utcDateDistance,
  type MatchableExpense,
  type MatchableTransaction,
} from './matching';

const expense: MatchableExpense = {
  id: '01991963-d3bc-7d12-80a8-43adbeb57d65' as RecordId,
  amountCents: 1234,
  currencyCode: 'USD',
  date: '2026-08-20',
  merchant: 'Acme, Inc.',
};

const transaction: MatchableTransaction = {
  id: '01991963-e1c5-7c7c-a3c2-c5064a9f56cb' as RecordId,
  amountCents: 1234,
  currencyCode: 'USD',
  date: '2026-08-20',
  merchant: 'ACME INC',
};

describe('work-expense matching', () => {
  it('uses UTC date-only distance and includes the three-day boundary', () => {
    expect(utcDateDistance({ left: '2026-08-20', right: '2026-08-23' })).toBe(3);
    expect(scoreCandidate({ expense, transaction: { ...transaction, date: '2026-08-23' } })).not.toBeNull();
    expect(scoreCandidate({ expense, transaction: { ...transaction, date: '2026-08-24' } })).toBeNull();
    expect(utcDateDistance({ left: '2026-02-30', right: '2026-03-02' })).toBeNull();
  });

  it('hard-gates original cents and currency', () => {
    expect(scoreCandidate({ expense, transaction: { ...transaction, amountCents: 1235 } })).toBeNull();
    expect(scoreCandidate({ expense, transaction: { ...transaction, currencyCode: 'EUR' } })).toBeNull();
  });

  it('normalizes exact merchant equality deterministically', () => {
    expect(merchantSimilarityBps({ left: 'Café & Co.', right: 'CAFE CO' })).toBe(10_000);
  });

  it('classifies a reciprocal unique same-day normalized edge as exact', () => {
    const score = scoreCandidate({ expense, transaction })!;
    const [classification] = classifyCandidateGraph({
      edges: [{ expenseId: expense.id, transactionId: transaction.id, ...score }],
    });
    expect(classification).toMatchObject({ state: EXPENSIFY_MATCH_STATES.exact });
    expect(classification?.candidates[0]?.isReciprocalTop).toBe(true);
  });

  it('keeps deterministic ordering and marks tied tops ambiguous', () => {
    const baseScore = scoreCandidate({ expense, transaction })!;
    const secondId = '01991964-0024-75c7-850d-e83ddf607272' as RecordId;
    const [classification] = classifyCandidateGraph({
      edges: [
        { expenseId: expense.id, transactionId: secondId, ...baseScore },
        { expenseId: expense.id, transactionId: transaction.id, ...baseScore },
      ],
    });
    expect(classification?.state).toBe(EXPENSIFY_MATCH_STATES.ambiguous);
    expect(classification?.candidates.map(({ transactionId }) => transactionId)).toEqual([transaction.id, secondId]);
  });

  it('marks an exact top ambiguous when the expense has another plausible edge', () => {
    const exactScore = scoreCandidate({ expense, transaction })!;
    const secondId = '01991964-0024-75c7-850d-e83ddf607272' as RecordId;
    const [classification] = classifyCandidateGraph({
      edges: [
        { expenseId: expense.id, transactionId: transaction.id, ...exactScore },
        {
          expenseId: expense.id,
          transactionId: secondId,
          ...exactScore,
          compositeScoreBps: 8_000,
          merchantSimilarityBps: 7_500,
          normalizedMerchantEqual: false,
        },
      ],
    });

    expect(classification?.state).toBe(EXPENSIFY_MATCH_STATES.ambiguous);
  });

  it('marks an exact top ambiguous when another expense plausibly contests its transaction', () => {
    const exactScore = scoreCandidate({ expense, transaction })!;
    const secondExpenseId = '01991964-0ac6-7ee3-97b7-eae7bce020f0' as RecordId;
    const classifications = classifyCandidateGraph({
      edges: [
        { expenseId: expense.id, transactionId: transaction.id, ...exactScore },
        {
          expenseId: secondExpenseId,
          transactionId: transaction.id,
          ...exactScore,
          compositeScoreBps: 8_000,
          merchantSimilarityBps: 7_500,
          normalizedMerchantEqual: false,
        },
      ],
    });

    expect(classifications.find(({ expenseId }) => expenseId === expense.id)?.state).toBe(
      EXPENSIFY_MATCH_STATES.ambiguous,
    );
  });
});
