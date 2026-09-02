import { EXPENSIFY_REPORT_STATES, EXPENSIFY_REVIEW_REASONS } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { materialUpstreamReviewReasons, upstreamFingerprint } from './fingerprints';

const expense = {
  externalReportId: 'R1',
  reportState: EXPENSIFY_REPORT_STATES.approved,
  externalExpenseId: 'E1',
  originalAmountCents: 1000,
  originalCurrencyCode: 'USD',
  expenseDate: '2026-08-01',
  originalMerchant: 'Cafe & Co.',
  modifiedMerchant: null,
  isReimbursable: true,
};

describe('Expensify change rules', () => {
  it('fingerprints deterministically and includes modified values', () => {
    expect(upstreamFingerprint({ expense })).toBe(upstreamFingerprint({ expense: { ...expense } }));
    expect(upstreamFingerprint({ expense })).not.toBe(
      upstreamFingerprint({ expense: { ...expense, modifiedMerchant: 'Other' } }),
    );
  });

  it('does not treat movement between eligible report states as material', () => {
    expect(
      materialUpstreamReviewReasons({
        before: { ...expense, originalAmountCents: expense.originalAmountCents },
        after: { ...expense, reportState: EXPENSIFY_REPORT_STATES.reimbursed },
      }),
    ).toEqual([]);
  });

  it('uses exact normalized merchant changes and ineligibility reasons', () => {
    expect(
      materialUpstreamReviewReasons({
        before: { ...expense, originalAmountCents: expense.originalAmountCents },
        after: { ...expense, originalMerchant: 'Different', isReimbursable: false },
      }),
    ).toEqual(
      expect.arrayContaining([EXPENSIFY_REVIEW_REASONS.upstreamChanged, EXPENSIFY_REVIEW_REASONS.upstreamIneligible]),
    );
  });
});
