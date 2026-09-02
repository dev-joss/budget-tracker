import {
  EXPENSIFY_SAFE_ERROR_CODES,
  type ExpensifySafeErrorCode,
  type ExpensifySyncStatus,
  type RecordId,
} from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import ExpensifyConnections from '@models/expensify-connections.model';
import { redisClient } from '@root/redis-client';
import { SSE_EVENT_TYPES, sseManager } from '@services/common/sse';
import { Job, Queue, Worker } from 'bullmq';
import { Op } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';

import { ExpensifyClientError } from './expensify/client';
import {
  buildSynchronizationLockKey,
  clearSynchronizationStateIfOwned,
  type SynchronizationOwner,
  type SynchronizationScope,
  writeSynchronizationStatus,
} from './sync-status.service';
import { performSynchronization } from './synchronize.service';

export interface WorkExpenseSynchronizationJobData extends SynchronizationOwner {
  userId: number;
}

const LOCK_TTL_SECONDS = 2 * 60 * 60;

const RELEASE_LOCK_IF_OWNED = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const REFRESH_LOCK_IF_OWNED = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end`;

const connection = {
  host: process.env.APPLICATION_REDIS_HOST,
  maxRetriesPerRequest: null,
  connectTimeout: 20_000,
  keepAlive: 10_000,
  retryStrategy: (times: number) => Math.min(times * 100, 3_000),
};

const queueName =
  process.env.NODE_ENV === 'test' && process.env.JEST_WORKER_ID
    ? `work-expenses-sync-${process.env.JEST_WORKER_ID}`
    : 'work-expenses-sync';

export const workExpenseSynchronizationQueue = new Queue<WorkExpenseSynchronizationJobData>(queueName, {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { age: 3_600 },
  },
});

function safeFailureCode({ error }: { error: unknown }): ExpensifySafeErrorCode {
  return error instanceof ExpensifyClientError ? error.code : EXPENSIFY_SAFE_ERROR_CODES.unavailable;
}

function synchronizationOwnerWhere({ userId, owner }: { userId: number; owner: SynchronizationOwner }) {
  return {
    id: owner.connectionId,
    userId,
    credentialRevision: owner.credentialRevision,
    activeSynchronizationRunId: owner.synchronizationRunId,
    encryptedCredentials: { [Op.not]: null },
  };
}

async function publishOwnedStatus({
  userId,
  owner,
  status,
}: {
  userId: number;
  owner: SynchronizationOwner;
  status: Exclude<ExpensifySyncStatus, { status: 'idle' }>;
}): Promise<boolean> {
  const ownedConnection = await ExpensifyConnections.unscoped().findOne({
    where: synchronizationOwnerWhere({ userId, owner }),
    attributes: ['id'],
  });
  if (!ownedConnection) return false;

  const written = await writeSynchronizationStatus({ userId, owner, status });
  if (written) {
    sseManager.sendToUser({ userId, event: SSE_EVENT_TYPES.WORK_EXPENSE_SYNC_PROGRESS, data: status });
  }
  return written;
}

async function refreshOwnedLock({ userId, runId }: { userId: number; runId: RecordId }): Promise<boolean> {
  const refreshed = await redisClient.eval(
    REFRESH_LOCK_IF_OWNED,
    1,
    buildSynchronizationLockKey({ userId }),
    runId,
    LOCK_TTL_SECONDS,
  );
  return refreshed === 1;
}

async function releaseOwnedLock({ userId, runId }: { userId: number; runId: RecordId }): Promise<void> {
  await redisClient.eval(RELEASE_LOCK_IF_OWNED, 1, buildSynchronizationLockKey({ userId }), runId);
}

async function releaseSynchronizationOwnership({
  userId,
  owner,
}: {
  userId: number;
  owner: SynchronizationOwner;
}): Promise<void> {
  try {
    await releaseOwnedLock({ userId, runId: owner.synchronizationRunId });
  } finally {
    await ExpensifyConnections.update(
      { activeSynchronizationRunId: null },
      { where: synchronizationOwnerWhere({ userId, owner }) },
    );
  }
}

export const workExpenseSynchronizationWorker = new Worker<WorkExpenseSynchronizationJobData>(
  queueName,
  async (job: Job<WorkExpenseSynchronizationJobData>) => {
    const { userId, ...owner } = job.data;
    const { synchronizationRunId } = owner;
    const emptyCounters = { processedCount: 0, importedCount: 0, matchedCount: 0, reviewCount: 0 };
    try {
      const started = await publishOwnedStatus({
        userId,
        owner,
        status: { status: 'processing', runId: synchronizationRunId, ...emptyCounters },
      });
      if (!started) return;

      const counters = await performSynchronization({
        userId,
        owner,
        onPhase: async () => {
          if (!(await refreshOwnedLock({ userId, runId: synchronizationRunId }))) {
            throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.credentialsChanged });
          }
        },
      });
      await publishOwnedStatus({
        userId,
        owner,
        status: { status: 'completed', runId: synchronizationRunId, ...counters },
      });
    } catch (error) {
      const errorCode = safeFailureCode({ error });
      await ExpensifyConnections.update(
        { lastErrorCode: errorCode },
        { where: synchronizationOwnerWhere({ userId, owner }) },
      );
      await publishOwnedStatus({
        userId,
        owner,
        status: { status: 'failed', runId: synchronizationRunId, errorCode, ...emptyCounters },
      });
    } finally {
      await releaseSynchronizationOwnership({ userId, owner });
    }
  },
  { connection, concurrency: 2 },
);

workExpenseSynchronizationQueue.on('error', (error) => {
  if (!error.message.includes('Connection is closed'))
    logger.error({ message: '[Work expense sync] Queue error', error });
});
workExpenseSynchronizationWorker.on('error', (error) => {
  if (!error.message.includes('Connection is closed'))
    logger.error({ message: '[Work expense sync] Worker error', error });
});

export async function enqueueSynchronization({
  userId,
  scope,
}: {
  userId: number;
  scope: SynchronizationScope;
}): Promise<{
  runId: RecordId;
  status: 'queued';
}> {
  const synchronizationRunId = uuidv7() as RecordId;
  const owner: SynchronizationOwner = { ...scope, synchronizationRunId };
  const key = buildSynchronizationLockKey({ userId });
  const locked = await redisClient.set(key, synchronizationRunId, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (locked !== 'OK') {
    const { ConflictError } = await import('@js/errors');
    const { t } = await import('@i18n/index');
    throw new ConflictError({ message: t({ key: 'workExpenses.syncAlreadyActive' }) });
  }

  try {
    const [claimed] = await ExpensifyConnections.update(
      { activeSynchronizationRunId: synchronizationRunId, lastErrorCode: null },
      {
        where: {
          id: scope.connectionId,
          userId,
          credentialRevision: scope.credentialRevision,
          encryptedCredentials: { [Op.not]: null },
        },
      },
    );
    if (claimed === 0) {
      const { ValidationError } = await import('@js/errors');
      const { t } = await import('@i18n/index');
      throw new ValidationError({ message: t({ key: 'workExpenses.integrationDisconnected' }) });
    }
  } catch (error) {
    await releaseOwnedLock({ userId, runId: synchronizationRunId });
    throw error;
  }

  const status: ExpensifySyncStatus = {
    status: 'queued',
    runId: synchronizationRunId,
    processedCount: 0,
    importedCount: 0,
    matchedCount: 0,
    reviewCount: 0,
  };
  try {
    const published = await publishOwnedStatus({ userId, owner, status });
    if (!published) {
      const { ValidationError } = await import('@js/errors');
      const { t } = await import('@i18n/index');
      throw new ValidationError({ message: t({ key: 'workExpenses.integrationDisconnected' }) });
    }
    await workExpenseSynchronizationQueue.add(
      `work-expenses-${userId}-${synchronizationRunId}`,
      { userId, ...owner },
      { jobId: synchronizationRunId },
    );
    return { runId: synchronizationRunId, status: 'queued' };
  } catch (error) {
    await clearSynchronizationStateIfOwned({ userId, scope, synchronizationRunId });
    await ExpensifyConnections.update(
      { activeSynchronizationRunId: null },
      { where: synchronizationOwnerWhere({ userId, owner }) },
    );
    throw error;
  }
}

export async function cancelSynchronization({
  userId,
  scope,
  synchronizationRunId,
}: {
  userId: number;
  scope: SynchronizationScope;
  synchronizationRunId: RecordId | null;
}): Promise<void> {
  const jobs = await workExpenseSynchronizationQueue.getJobs(['waiting', 'delayed', 'prioritized']);
  await Promise.all(
    jobs
      .filter(
        (job) =>
          job.data.userId === userId &&
          job.data.connectionId === scope.connectionId &&
          job.data.credentialRevision === scope.credentialRevision &&
          (synchronizationRunId === null || job.data.synchronizationRunId === synchronizationRunId),
      )
      .map((job) => job.remove()),
  );
  await clearSynchronizationStateIfOwned({ userId, scope, synchronizationRunId });
}
