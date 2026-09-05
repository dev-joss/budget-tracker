import { AI_FEATURE, type PayeeExtractionScope, type PayeeExtractionTriggerResponse } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError, TooManyRequests, ValidationError } from '@js/errors';
import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import { namespace } from '@models/connection';
import { findTransactions } from '@models/transactions-query';
import { redisClient } from '@root/redis-client';
import { createAIClient } from '@services/ai';
import { categorizationQueue } from '@services/ai-categorization/categorization-queue';
import { RateLimitService } from '@services/common/rate-limit.service';
import { createHash, randomUUID } from 'node:crypto';

import { extractionDestination, extractionEnabled, snapshotForExtraction } from './apply';
import { assertExtractionScope, countExtractionCandidates, extractionPolicy, extractionWhere } from './candidates';
import {
  EXTRACTION_STATUS_TTL,
  emptyExtractionStatus,
  extractionLastKey,
  extractionManualKey,
  writeExtractionStatus,
} from './status';
import type { PayeeExtractionJobData } from './worker';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
const PENDING_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

async function enqueueExtraction({
  userId,
  scope,
  automatic,
}: {
  userId: number;
  scope: PayeeExtractionScope;
  automatic: boolean;
}): Promise<PayeeExtractionTriggerResponse> {
  const cutoff = new Date().toISOString();
  const totalCount = await countExtractionCandidates({ userId, scope, cutoff });
  if (!totalCount) return { enqueued: false, runId: null, totalCount: 0 };
  if (!(await extractionEnabled({ userId })))
    throw new ValidationError({ message: t({ key: 'payeeExtraction.disabled' }) });
  const client = await createAIClient({ userId, feature: AI_FEATURE.payeeExtraction });
  if (!client) throw new ValidationError({ message: t({ key: 'payeeExtraction.notConfigured' }) });
  if (!automatic && !client.usingUserKey && process.env.NODE_ENV !== 'development') {
    const budget = await RateLimitService.checkRateLimit(`payee-extraction-budget:${userId}`, 3600, 3);
    if (!budget.allowed || budget.serviceUnavailable)
      throw new TooManyRequests({ message: t({ key: 'ai.categorizationRateLimited' }) });
  }
  const transactionIds = [...new Set(scope.transactionIds ?? [])].toSorted();
  const runId = `payee-${randomUUID()}`;
  const destination = extractionDestination({ client });
  // A source edit must get a follow-up even while the previous revision is active.
  const revisions = automatic
    ? await findTransactions({
        ...extractionPolicy({ userId }),
        where: extractionWhere({ scope, cutoff }),
        completeness: { page: { limit: 1000, offset: 0 } },
        order: [['id', 'ASC']],
        attributes: ['id', 'accountId', 'note', 'externalData'],
      })
    : [];
  const jobId = automatic
    ? `payee-${userId}-${createHash('sha256')
        .update(JSON.stringify([destination, revisions.map((row) => snapshotForExtraction({ row }))]))
        .digest('hex')}`
    : runId;
  const existing = automatic ? await categorizationQueue.getJob(jobId) : null;
  if (existing && PENDING_STATES.has(await existing.getState())) {
    return { enqueued: true, runId: (existing.data as PayeeExtractionJobData).runId, totalCount };
  }
  if (existing) await existing.remove();
  const data: PayeeExtractionJobData = {
    kind: 'payee-extraction',
    userId,
    runId,
    transactionIds,
    accountIds: scope.accountIds,
    cutoff,
    destination,
  };
  await writeExtractionStatus({ userId, status: { ...emptyExtractionStatus(), runId, status: 'queued', totalCount } });
  try {
    await categorizationQueue.add('payee-extraction', data, {
      jobId,
      // Keep a fast completed job readable while concurrent producers resolve its run ID.
      removeOnComplete: { age: EXTRACTION_STATUS_TTL },
    });
  } catch (error) {
    await writeExtractionStatus({
      userId,
      status: { ...emptyExtractionStatus(), runId, status: 'failed', totalCount, error: 'queue-unavailable' },
    });
    throw error;
  }
  // Concurrent identical schedules can lose the add race; expose the retained job's run.
  let retainedRunId = runId;
  if (automatic) {
    const retained = await categorizationQueue.getJob(jobId);
    if (!retained) {
      await writeExtractionStatus({
        userId,
        status: { ...emptyExtractionStatus(), runId, status: 'failed', totalCount, error: 'queue-unavailable' },
      });
      return { enqueued: false, runId: null, totalCount };
    }
    retainedRunId = (retained.data as PayeeExtractionJobData).runId;
  }
  try {
    await redisClient.set(extractionLastKey({ userId }), retainedRunId, 'EX', EXTRACTION_STATUS_TTL);
    if (!automatic) await redisClient.set(extractionManualKey({ userId }), retainedRunId, 'EX', EXTRACTION_STATUS_TTL);
  } catch {
    logger.info('[Payee extraction] could not save latest run pointer', { userId, runId: retainedRunId });
  }
  return { enqueued: true, runId: retainedRunId, totalCount };
}

export async function triggerPayeeExtraction({
  userId,
  accountIds,
  transactionIds,
}: {
  userId: number;
} & PayeeExtractionScope): Promise<PayeeExtractionTriggerResponse> {
  await assertExtractionScope({ userId, accountIds });
  const key = `payee-extraction-trigger:${userId}`;
  const token = randomUUID();
  if (!(await redisClient.set(key, token, 'EX', 30, 'NX')))
    throw new ConflictError({ message: t({ key: 'payeeExtraction.alreadyRunning' }) });
  try {
    const previousId = await redisClient.get(extractionManualKey({ userId }));
    if (previousId) {
      const previous = await categorizationQueue.getJob(previousId);
      if (previous && PENDING_STATES.has(await previous.getState()))
        throw new ConflictError({ message: t({ key: 'payeeExtraction.alreadyRunning' }) });
    }
    return await enqueueExtraction({ userId, scope: { accountIds, transactionIds }, automatic: false });
  } finally {
    await redisClient.eval(RELEASE, 1, key, token).catch(() => undefined);
  }
}

/** Best-effort enrichment: failures never change the source import outcome. */
export async function schedulePayeeExtraction({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: string[];
}): Promise<void> {
  if (!transactionIds.length) return;
  const transaction = namespace.get('transaction');
  if (transaction && !transaction.finished) {
    transaction.afterCommit(() => scheduleCommittedExtraction({ userId, transactionIds }));
    return;
  }
  await scheduleCommittedExtraction({ userId, transactionIds });
}

async function scheduleCommittedExtraction({ userId, transactionIds }: { userId: number; transactionIds: string[] }) {
  try {
    const ids = [...new Set(transactionIds)];
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const rows = await findTransactions({
        planned: 'exclude',
        balanceAdjustments: 'exclude',
        transfers: 'exclude',
        access: { accessibleTo: userId },
        completeness: 'all',
        where: { id: ids.slice(offset, offset + 1000) },
        attributes: ['id', 'accountId'],
      });
      const accounts = await Accounts.findAll({
        where: { id: [...new Set(rows.map((row) => row.accountId))] },
        attributes: ['id', 'userId'],
      });
      const ownerByAccount = new Map(accounts.map((account) => [account.id, account.userId]));
      const byOwner = new Map<number, string[]>();
      for (const row of rows) {
        const owner = ownerByAccount.get(row.accountId);
        if (owner !== undefined) byOwner.set(owner, [...(byOwner.get(owner) ?? []), row.id]);
      }
      for (const [owner, ownedIds] of byOwner) {
        if (await extractionEnabled({ userId: owner })) {
          await enqueueExtraction({ userId: owner, scope: { transactionIds: ownedIds }, automatic: true });
        }
      }
    }
  } catch {
    logger.info('[Payee extraction] could not schedule imported rows', { userId, scanned: transactionIds.length });
  }
}
