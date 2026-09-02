import { EXPENSIFY_MATCH_STATES } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { serializeTransaction } from '@root/serializers/transactions.serializer';
import { confirmMatches } from '@services/work-expenses/confirm-matches.service';
import { disconnectIntegration } from '@services/work-expenses/disconnect-integration.service';
import { getIntegration } from '@services/work-expenses/get-integration.service';
import { getReconciliation } from '@services/work-expenses/get-reconciliation.service';
import { resolveReview } from '@services/work-expenses/resolve-review.service';
import { setManualWorkExpense } from '@services/work-expenses/set-manual-work-expense.service';
import { getSynchronizationStatus } from '@services/work-expenses/sync-status.service';
import { triggerSynchronization } from '@services/work-expenses/trigger-sync.service';
import { unlinkMatch } from '@services/work-expenses/unlink-match.service';
import { updateIntegration } from '@services/work-expenses/update-integration.service';
import { z } from 'zod';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { message: 'Date must be a real calendar date' },
  )
  .refine((value) => value >= '2000-01-01' && value <= new Date().toISOString().slice(0, 10), {
    message: 'Date must be between 2000-01-01 and today',
  });

export const getIntegrationController = createController(z.object({}), async ({ user, res }) => {
  res.setHeader('Cache-Control', 'no-store');
  return { data: await getIntegration({ userId: user.id }) };
});

export const updateIntegrationController = createController(
  z.object({
    body: z.object({
      partnerUserId: z.string().trim().min(1).max(500),
      partnerUserSecret: z.string().trim().min(1).max(500),
      initialSyncDate: dateOnly.optional(),
    }),
  }),
  async ({ user, body }) => ({ data: await updateIntegration({ userId: user.id, ...body }) }),
);

export const disconnectIntegrationController = createController(z.object({}), async ({ user }) => ({
  data: await disconnectIntegration({ userId: user.id }),
}));

export const triggerSynchronizationController = createController(z.object({}), async ({ user }) => ({
  data: await triggerSynchronization({ userId: user.id }),
  statusCode: 202,
}));

export const synchronizationStatusController = createController(z.object({}), async ({ user, res }) => {
  res.setHeader('Cache-Control', 'no-store');
  return { data: await getSynchronizationStatus({ userId: user.id }) };
});

export const getReconciliationController = createController(
  z.object({
    query: z.object({
      state: z
        .enum([
          EXPENSIFY_MATCH_STATES.exact,
          EXPENSIFY_MATCH_STATES.likely,
          EXPENSIFY_MATCH_STATES.ambiguous,
          EXPENSIFY_MATCH_STATES.unmatched,
          EXPENSIFY_MATCH_STATES.review,
        ])
        .optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().nonnegative().default(0),
    }),
  }),
  async ({ user, query }) => ({ data: await getReconciliation({ userId: user.id, ...query }) }),
);

export const confirmMatchesController = createController(
  z.object({
    body: z.object({
      matches: z
        .array(z.object({ expenseId: recordId(), transactionId: recordId() }))
        .min(1)
        .max(100),
    }),
  }),
  async ({ user, body }) => ({ data: await confirmMatches({ userId: user.id, matches: body.matches }) }),
);

export const unlinkMatchController = createController(
  z.object({ params: z.object({ expenseId: recordId() }) }),
  async ({ user, params }) => ({ data: await unlinkMatch({ userId: user.id, expenseId: params.expenseId }) }),
);

const resolveReviewBody = z
  .object({
    action: z.enum(['keep', 'relink']),
    transactionId: recordId().optional(),
  })
  .superRefine((body, context) => {
    if (body.action === 'relink' && !body.transactionId) {
      context.addIssue({ code: 'custom', path: ['transactionId'], message: 'transactionId is required for relink' });
    }
    if (body.action === 'keep' && body.transactionId) {
      context.addIssue({ code: 'custom', path: ['transactionId'], message: 'transactionId is only valid for relink' });
    }
  });

export const resolveReviewController = createController(
  z.object({ params: z.object({ expenseId: recordId() }), body: resolveReviewBody }),
  async ({ user, params, body }) => ({
    data: await resolveReview({
      userId: user.id,
      expenseId: params.expenseId,
      action: body.action,
      transactionId: body.transactionId,
    }),
  }),
);

export const setManualWorkExpenseController = createController(
  z.object({
    params: z.object({ id: recordId() }),
    body: z.object({ isWorkExpense: z.boolean() }),
  }),
  async ({ user, params, body }) => ({
    data: serializeTransaction(
      await setManualWorkExpense({
        userId: user.id,
        transactionId: params.id,
        isWorkExpense: body.isWorkExpense,
      }),
    ),
  }),
);
