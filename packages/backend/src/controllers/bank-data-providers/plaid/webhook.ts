import { createController } from '@controllers/helpers/controller-factory';
import { handlePlaidWebhook } from '@services/bank-data-providers/plaid/handle-webhook.service';
import { verifyPlaidWebhook } from '@services/bank-data-providers/plaid/webhook-verification';
import type { Request } from 'express';
import { z } from 'zod';

export default createController(z.object({ body: z.record(z.string(), z.unknown()) }), async ({ req, body }) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const token = req.header('Plaid-Verification');
  if (!rawBody || !token) throw new Error('Plaid webhook signature is missing');
  await verifyPlaidWebhook({ token, rawBody });
  await handlePlaidWebhook({ body });
  return { data: { received: true } };
});
