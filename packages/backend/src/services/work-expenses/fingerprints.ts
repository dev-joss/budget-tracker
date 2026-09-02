import {
  EXPENSIFY_ELIGIBLE_REPORT_STATES,
  EXPENSIFY_REVIEW_REASONS,
  type ExpensifyReviewReason,
} from '@bt/shared/types';
import { normalizePayeeName } from '@services/payees/normalize-name';
import crypto from 'node:crypto';

import type { ExpensifyUpstreamExpense } from './expensify/client';

export function isEligibleUpstreamExpense({ expense }: { expense: ExpensifyUpstreamExpense }): boolean {
  return (
    expense.isReimbursable &&
    EXPENSIFY_ELIGIBLE_REPORT_STATES.includes(expense.reportState as (typeof EXPENSIFY_ELIGIBLE_REPORT_STATES)[number])
  );
}

function effectiveUpstreamMerchant({ expense }: { expense: ExpensifyUpstreamExpense }): string {
  return expense.modifiedMerchant?.trim() || expense.originalMerchant;
}

export function upstreamFingerprint({ expense }: { expense: ExpensifyUpstreamExpense }): string {
  const payload = [
    expense.externalExpenseId,
    expense.externalReportId,
    expense.reportState,
    String(expense.originalAmountCents),
    expense.originalCurrencyCode,
    expense.expenseDate,
    expense.originalMerchant,
    expense.modifiedMerchant ?? '',
    expense.isReimbursable ? '1' : '0',
  ].join('\u001f');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

interface StoredUpstreamExpense {
  originalAmountCents: number;
  originalCurrencyCode: string;
  expenseDate: string;
  originalMerchant: string;
  modifiedMerchant: string | null;
  isReimbursable: boolean;
  reportState: string;
}

export function materialUpstreamReviewReasons({
  before,
  after,
}: {
  before: StoredUpstreamExpense;
  after: ExpensifyUpstreamExpense;
}): ExpensifyReviewReason[] {
  const reasons = new Set<ExpensifyReviewReason>();
  if (!isEligibleUpstreamExpense({ expense: after })) reasons.add(EXPENSIFY_REVIEW_REASONS.upstreamIneligible);

  const priorMerchant = normalizePayeeName({ raw: before.modifiedMerchant?.trim() || before.originalMerchant });
  const currentMerchant = normalizePayeeName({ raw: effectiveUpstreamMerchant({ expense: after }) });
  if (
    before.originalAmountCents !== after.originalAmountCents ||
    before.originalCurrencyCode !== after.originalCurrencyCode ||
    before.expenseDate !== after.expenseDate ||
    before.isReimbursable !== after.isReimbursable ||
    priorMerchant !== currentMerchant
  ) {
    reasons.add(EXPENSIFY_REVIEW_REASONS.upstreamChanged);
  }
  return [...reasons];
}
