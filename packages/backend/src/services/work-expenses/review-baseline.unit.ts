import { EXPENSIFY_REVIEW_REASONS } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import {
  acknowledgeReviewConditions,
  isReviewConditionAcknowledged,
  isUpstreamCurrentlyMissing,
  reviewBaselineForMissingUpstream,
  reviewBaselineForSeenUpstream,
} from './review-baseline';

describe('work-expense review baselines', () => {
  it('acknowledges the exact missing and ineligible upstream fingerprint', () => {
    const baseline = acknowledgeReviewConditions({
      baseline: null,
      reasons: [EXPENSIFY_REVIEW_REASONS.upstreamMissing, EXPENSIFY_REVIEW_REASONS.upstreamIneligible],
      upstreamFingerprint: 'fingerprint-1',
      resolvedAt: '2026-09-01T12:00:00.000Z',
    });

    expect(
      isReviewConditionAcknowledged({
        baseline,
        reason: EXPENSIFY_REVIEW_REASONS.upstreamMissing,
        upstreamFingerprint: 'fingerprint-1',
      }),
    ).toBe(true);
    expect(
      isReviewConditionAcknowledged({
        baseline,
        reason: EXPENSIFY_REVIEW_REASONS.upstreamIneligible,
        upstreamFingerprint: 'fingerprint-2',
      }),
    ).toBe(false);
  });

  it('clears missing acknowledgment on reappearance and ineligible acknowledgment on eligibility', () => {
    const baseline = acknowledgeReviewConditions({
      baseline: null,
      reasons: [EXPENSIFY_REVIEW_REASONS.upstreamMissing, EXPENSIFY_REVIEW_REASONS.upstreamIneligible],
      upstreamFingerprint: 'fingerprint-1',
      resolvedAt: '2026-09-01T12:00:00.000Z',
    });

    const stillIneligible = reviewBaselineForSeenUpstream({ baseline, isEligible: false });
    expect(
      isReviewConditionAcknowledged({
        baseline: stillIneligible,
        reason: EXPENSIFY_REVIEW_REASONS.upstreamMissing,
        upstreamFingerprint: 'fingerprint-1',
      }),
    ).toBe(false);
    expect(
      isReviewConditionAcknowledged({
        baseline: stillIneligible,
        reason: EXPENSIFY_REVIEW_REASONS.upstreamIneligible,
        upstreamFingerprint: 'fingerprint-1',
      }),
    ).toBe(true);

    const eligible = reviewBaselineForSeenUpstream({ baseline: stillIneligible, isEligible: true });
    expect(
      isReviewConditionAcknowledged({
        baseline: eligible,
        reason: EXPENSIFY_REVIEW_REASONS.upstreamIneligible,
        upstreamFingerprint: 'fingerprint-1',
      }),
    ).toBe(false);
  });

  it('tracks current disappearance separately from its acknowledgment', () => {
    const missing = reviewBaselineForMissingUpstream({
      baseline: null,
      upstreamFingerprint: 'fingerprint-1',
      detectedAt: '2026-09-01T12:00:00.000Z',
    });
    expect(isUpstreamCurrentlyMissing({ baseline: missing })).toBe(true);
    expect(
      isUpstreamCurrentlyMissing({
        baseline: reviewBaselineForSeenUpstream({ baseline: missing, isEligible: true }),
      }),
    ).toBe(false);
  });
});
