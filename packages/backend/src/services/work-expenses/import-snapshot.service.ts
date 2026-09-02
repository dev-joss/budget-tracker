import {
  EXPENSIFY_MATCH_STATES,
  EXPENSIFY_REVIEW_REASONS,
  EXPENSIFY_SAFE_ERROR_CODES,
  type ExpensifyReviewReason,
  type RecordId,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import ExpensifyConnections from '@models/expensify-connections.model';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import ExpensifyMatchCandidates from '@models/expensify-match-candidates.model';
import { withTransaction } from '@services/common/with-transaction';
import { Op } from 'sequelize';

import { ExpensifyClientError, type ExpensifyUpstreamExpense } from './expensify/client';
import { isEligibleUpstreamExpense, materialUpstreamReviewReasons, upstreamFingerprint } from './fingerprints';
import { rebuildUnconfirmedCandidates } from './rebuild-candidates.service';
import {
  isReviewConditionAcknowledged,
  reviewBaselineForMissingUpstream,
  reviewBaselineForSeenUpstream,
} from './review-baseline';
import type { SynchronizationOwner } from './sync-status.service';

function uniqueReasons({ reasons }: { reasons: ExpensifyReviewReason[] }): ExpensifyReviewReason[] {
  return [...new Set(reasons)];
}

export function deduplicateUpstreamExpenses({
  expenses,
}: {
  expenses: ExpensifyUpstreamExpense[];
}): ExpensifyUpstreamExpense[] {
  const byId = new Map<string, ExpensifyUpstreamExpense>();
  for (const expense of expenses) {
    const existing = byId.get(expense.externalExpenseId);
    if (existing && upstreamFingerprint({ expense: existing }) !== upstreamFingerprint({ expense })) {
      throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.invalidResponse });
    }
    byId.set(expense.externalExpenseId, expense);
  }
  return [...byId.values()].toSorted((left, right) => left.externalExpenseId.localeCompare(right.externalExpenseId));
}

function upstreamBaseline({ expense }: { expense: ExpensifyUpstreamExpense }) {
  return {
    externalReportId: expense.externalReportId,
    reportState: expense.reportState,
    originalAmountCents: expense.originalAmountCents,
    originalCurrencyCode: expense.originalCurrencyCode,
    expenseDate: expense.expenseDate,
    originalMerchant: expense.originalMerchant,
    modifiedMerchant: expense.modifiedMerchant,
    isReimbursable: expense.isReimbursable,
  };
}

export interface ImportSnapshotResult {
  processedCount: number;
  importedCount: number;
  matchedCount: number;
  reviewCount: number;
}

const importSnapshotImpl = async ({
  userId,
  owner,
  expenses: rawExpenses,
}: {
  userId: number;
  owner: SynchronizationOwner;
  expenses: ExpensifyUpstreamExpense[];
}): Promise<ImportSnapshotResult> => {
  const connection = await ExpensifyConnections.unscoped().findOne({
    where: {
      id: owner.connectionId,
      userId,
      credentialRevision: owner.credentialRevision,
      activeSynchronizationRunId: owner.synchronizationRunId,
      encryptedCredentials: { [Op.not]: null },
    },
    lock: true,
  });
  if (!connection?.encryptedCredentials) {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.credentialsChanged });
  }

  const expenses = deduplicateUpstreamExpenses({ expenses: rawExpenses });
  const existingRows = await ExpensifyExpenses.findAll({ where: { userId }, lock: true });
  const existingByExternalId = new Map(existingRows.map((expense) => [expense.externalExpenseId, expense]));
  const seenIds = new Set(expenses.map((expense) => expense.externalExpenseId));
  const now = new Date();
  const candidatesToRemove = new Set<RecordId>();
  let importedCount = 0;

  for (const expense of expenses) {
    const existing = existingByExternalId.get(expense.externalExpenseId);
    const eligible = isEligibleUpstreamExpense({ expense });
    const fingerprint = upstreamFingerprint({ expense });
    if (!existing && !eligible) continue;
    if (eligible) importedCount += 1;

    if (!existing) {
      await ExpensifyExpenses.create({
        userId,
        externalExpenseId: expense.externalExpenseId,
        externalReportId: expense.externalReportId,
        reportState: expense.reportState,
        originalAmount: Money.fromCents(expense.originalAmountCents),
        originalCurrencyCode: expense.originalCurrencyCode,
        expenseDate: expense.expenseDate,
        originalMerchant: expense.originalMerchant,
        modifiedMerchant: expense.modifiedMerchant,
        isReimbursable: expense.isReimbursable,
        upstreamFingerprint: fingerprint,
        lastSeenSynchronizationId: owner.synchronizationRunId,
        lastSeenAt: now,
        matchState: EXPENSIFY_MATCH_STATES.unmatched,
      });
      continue;
    }

    const ineligibleWasAcknowledged = isReviewConditionAcknowledged({
      baseline: existing.reviewBaseline,
      reason: EXPENSIFY_REVIEW_REASONS.upstreamIneligible,
      upstreamFingerprint: fingerprint,
    });
    const changeReasons = materialUpstreamReviewReasons({
      before: {
        reportState: existing.reportState,
        originalAmountCents: existing.originalAmount.toCents(),
        originalCurrencyCode: existing.originalCurrencyCode,
        expenseDate: existing.expenseDate,
        originalMerchant: existing.originalMerchant,
        modifiedMerchant: existing.modifiedMerchant,
        isReimbursable: existing.isReimbursable,
      },
      after: expense,
    }).filter((reason) => reason !== EXPENSIFY_REVIEW_REASONS.upstreamIneligible || !ineligibleWasAcknowledged);
    const linkedAndChanged = Boolean(existing.linkedTransactionId && changeReasons.length);
    if (!eligible) candidatesToRemove.add(existing.id);
    const reviewBaseline = reviewBaselineForSeenUpstream({
      baseline: existing.reviewBaseline,
      isEligible: eligible,
    });

    await existing.update({
      externalReportId: expense.externalReportId,
      reportState: expense.reportState,
      originalAmount: Money.fromCents(expense.originalAmountCents),
      originalCurrencyCode: expense.originalCurrencyCode,
      expenseDate: expense.expenseDate,
      originalMerchant: expense.originalMerchant,
      modifiedMerchant: expense.modifiedMerchant,
      isReimbursable: expense.isReimbursable,
      upstreamFingerprint: fingerprint,
      lastSeenSynchronizationId: owner.synchronizationRunId,
      lastSeenAt: now,
      ...(!existing.linkedTransactionId && existing.matchState !== EXPENSIFY_MATCH_STATES.review && !eligible
        ? { matchState: EXPENSIFY_MATCH_STATES.unmatched }
        : {}),
      ...(linkedAndChanged
        ? {
            matchState: EXPENSIFY_MATCH_STATES.review,
            reviewReasons: uniqueReasons({ reasons: [...existing.reviewReasons, ...changeReasons] }),
            reviewBaseline: {
              ...reviewBaseline,
              currentUpstream: upstreamBaseline({ expense }),
            },
          }
        : { reviewBaseline }),
    });
  }

  const disappeared = existingRows.filter((expense) => !seenIds.has(expense.externalExpenseId));
  for (const expense of disappeared) {
    candidatesToRemove.add(expense.id);
    const reviewBaseline = reviewBaselineForMissingUpstream({
      baseline: expense.reviewBaseline,
      upstreamFingerprint: expense.upstreamFingerprint,
      detectedAt: now.toISOString(),
    });
    if (!expense.linkedTransactionId) {
      await expense.update({
        ...(expense.matchState !== EXPENSIFY_MATCH_STATES.review
          ? { matchState: EXPENSIFY_MATCH_STATES.unmatched }
          : {}),
        reviewBaseline,
      });
      continue;
    }
    if (
      isReviewConditionAcknowledged({
        baseline: expense.reviewBaseline,
        reason: EXPENSIFY_REVIEW_REASONS.upstreamMissing,
        upstreamFingerprint: expense.upstreamFingerprint,
      })
    ) {
      continue;
    }
    await expense.update({
      matchState: EXPENSIFY_MATCH_STATES.review,
      reviewReasons: uniqueReasons({
        reasons: [...expense.reviewReasons, EXPENSIFY_REVIEW_REASONS.upstreamMissing],
      }),
      reviewBaseline,
    });
  }

  if (candidatesToRemove.size) {
    await ExpensifyMatchCandidates.destroy({
      where: { userId, expenseId: { [Op.in]: [...candidatesToRemove] } },
    });
  }

  const { matchedCount } = await rebuildUnconfirmedCandidates({ userId });
  const reviewCount = await ExpensifyExpenses.count({
    where: { userId, matchState: EXPENSIFY_MATCH_STATES.review },
  });
  await connection.update({
    lastSuccessfulSyncAt: now,
    lastErrorCode: null,
  });

  return {
    processedCount: expenses.length,
    importedCount,
    matchedCount,
    reviewCount,
  };
};

export const importExpensifySnapshot = withTransaction(importSnapshotImpl);
