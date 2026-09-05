import { uniqueRecordIds } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { serializeTransactions } from '@root/serializers';
import { listExtractionCandidates } from '@services/payees/ai-extraction/candidates';
import { triggerPayeeExtraction } from '@services/payees/ai-extraction/schedule';
import { getExtractionStatus } from '@services/payees/ai-extraction/status';
import { z } from 'zod';

export const extractionCandidates = createController(
  z.object({
    query: z.object({
      accountIds: z.preprocess(
        (value) => (typeof value === 'string' ? value.split(',') : value),
        uniqueRecordIds({ min: 1, max: 100 }).optional(),
      ),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  async ({ user, query }) => {
    const { items, totalCount } = await listExtractionCandidates({ userId: user.id, ...query });
    return { data: { items: serializeTransactions(items), totalCount } };
  },
);

export const extractionTrigger = createController(
  z.object({
    body: z
      .object({
        accountIds: uniqueRecordIds({ min: 1, max: 100 }).optional(),
        transactionIds: uniqueRecordIds({ min: 1, max: 1000 }).optional(),
      })
      .strict(),
  }),
  async ({ user, body }) => ({ data: await triggerPayeeExtraction({ userId: user.id, ...body }) }),
);

export const extractionStatus = createController(
  z.object({
    query: z.object({
      runId: z
        .string()
        .regex(/^payee-[a-zA-Z0-9-]+$/)
        .max(120)
        .optional(),
    }),
  }),
  async ({ user, query, res }) => {
    res.setHeader('Cache-Control', 'no-store');
    return { data: await getExtractionStatus({ userId: user.id, runId: query.runId }) };
  },
);
