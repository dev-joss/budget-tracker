import { EXPENSIFY_REVIEW_REASONS, type ExpensifyReviewReason } from '@bt/shared/types';

interface AcknowledgedReviewConditions {
  upstreamIneligibleFingerprint?: string;
  upstreamMissingFingerprint?: string;
}

const ACKNOWLEDGED_CONDITIONS_KEY = 'acknowledgedReviewConditions';
const CURRENT_UPSTREAM_MISSING_KEY = 'currentUpstreamMissing';

function readAcknowledgedConditions({
  baseline,
}: {
  baseline: Record<string, unknown> | null;
}): AcknowledgedReviewConditions {
  const value = baseline?.[ACKNOWLEDGED_CONDITIONS_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const conditions = value as Record<string, unknown>;
  return {
    ...(typeof conditions.upstreamIneligibleFingerprint === 'string'
      ? { upstreamIneligibleFingerprint: conditions.upstreamIneligibleFingerprint }
      : {}),
    ...(typeof conditions.upstreamMissingFingerprint === 'string'
      ? { upstreamMissingFingerprint: conditions.upstreamMissingFingerprint }
      : {}),
  };
}

export function isReviewConditionAcknowledged({
  baseline,
  reason,
  upstreamFingerprint,
}: {
  baseline: Record<string, unknown> | null;
  reason: typeof EXPENSIFY_REVIEW_REASONS.upstreamIneligible | typeof EXPENSIFY_REVIEW_REASONS.upstreamMissing;
  upstreamFingerprint: string;
}): boolean {
  const conditions = readAcknowledgedConditions({ baseline });
  return reason === EXPENSIFY_REVIEW_REASONS.upstreamMissing
    ? conditions.upstreamMissingFingerprint === upstreamFingerprint
    : conditions.upstreamIneligibleFingerprint === upstreamFingerprint;
}

export function acknowledgeReviewConditions({
  baseline,
  reasons,
  upstreamFingerprint,
  resolvedAt,
}: {
  baseline: Record<string, unknown> | null;
  reasons: ExpensifyReviewReason[];
  upstreamFingerprint: string;
  resolvedAt: string;
}): Record<string, unknown> {
  const conditions = readAcknowledgedConditions({ baseline });
  if (reasons.includes(EXPENSIFY_REVIEW_REASONS.upstreamMissing)) {
    conditions.upstreamMissingFingerprint = upstreamFingerprint;
  }
  if (reasons.includes(EXPENSIFY_REVIEW_REASONS.upstreamIneligible)) {
    conditions.upstreamIneligibleFingerprint = upstreamFingerprint;
  }
  return {
    ...baseline,
    resolvedAt,
    ...(Object.keys(conditions).length ? { [ACKNOWLEDGED_CONDITIONS_KEY]: conditions } : {}),
  };
}

export function reviewBaselineForSeenUpstream({
  baseline,
  isEligible,
}: {
  baseline: Record<string, unknown> | null;
  isEligible: boolean;
}): Record<string, unknown> | null {
  if (!baseline) return null;
  const conditions = readAcknowledgedConditions({ baseline });
  delete conditions.upstreamMissingFingerprint;
  if (isEligible) delete conditions.upstreamIneligibleFingerprint;

  const next = { ...baseline };
  delete next[CURRENT_UPSTREAM_MISSING_KEY];
  if (Object.keys(conditions).length) next[ACKNOWLEDGED_CONDITIONS_KEY] = conditions;
  else delete next[ACKNOWLEDGED_CONDITIONS_KEY];
  return next;
}

export function reviewBaselineForMissingUpstream({
  baseline,
  upstreamFingerprint,
  detectedAt,
}: {
  baseline: Record<string, unknown> | null;
  upstreamFingerprint: string;
  detectedAt: string;
}): Record<string, unknown> {
  const current = baseline?.[CURRENT_UPSTREAM_MISSING_KEY];
  const currentFingerprint =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>).upstreamFingerprint
      : undefined;
  return {
    ...baseline,
    [CURRENT_UPSTREAM_MISSING_KEY]:
      currentFingerprint === upstreamFingerprint ? current : { upstreamFingerprint, detectedAt },
  };
}

export function isUpstreamCurrentlyMissing({ baseline }: { baseline: Record<string, unknown> | null }): boolean {
  const current = baseline?.[CURRENT_UPSTREAM_MISSING_KEY];
  return Boolean(current && typeof current === 'object' && !Array.isArray(current));
}
