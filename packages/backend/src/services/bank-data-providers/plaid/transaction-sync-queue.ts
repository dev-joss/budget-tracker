import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import { findTransactions } from '@models/transactions-query';
import { redisClient } from '@root/redis-client';
import { Queue, Worker } from 'bullmq';
import { Op } from 'sequelize';

import { SyncStatus, setAccountSyncStatus } from '../sync/sync-status-tracker';
import { linkAndEmitSyncedTransactions } from '../utils/link-and-emit-synced-transactions';
import { syncPlaidItem } from './sync-item';

interface PlaidSyncJobData {
  connectionId: string;
  userId: number;
}

const queueName = process.env.JEST_WORKER_ID ? `plaid-item-sync-${process.env.JEST_WORKER_ID}` : 'plaid-item-sync';
const connection = {
  host: process.env.APPLICATION_REDIS_HOST,
  maxRetriesPerRequest: null,
  connectTimeout: 20000,
  keepAlive: 10000,
};

let queue: Queue<PlaidSyncJobData> | undefined;
let worker: Worker<PlaidSyncJobData> | undefined;

const generationKey = ({ connectionId }: { connectionId: string }) => `plaid-sync-generation:${connectionId}`;

const initializeQueue = () => {
  if (queue && worker) return { queue, worker };
  queue = new Queue<PlaidSyncJobData>(queueName, { connection });
  worker = new Worker<PlaidSyncJobData>(
    queueName,
    async (job) => {
      const { connectionId, userId } = job.data;
      const accounts = await Accounts.findAll({ where: { userId, bankDataProviderConnectionId: connectionId } });
      await Promise.all(
        accounts.map((account) => setAccountSyncStatus({ accountId: account.id, status: SyncStatus.SYNCING, userId })),
      );
      const createdIds: string[] = [];
      const extractionTransactionIds: string[] = [];
      try {
        let observedGeneration: string | null;
        do {
          observedGeneration = await redisClient.get(generationKey({ connectionId }));
          const result = await syncPlaidItem({ connectionId, userId });
          createdIds.push(...result.createdIds);
          extractionTransactionIds.push(...result.extractionTransactionIds);
        } while ((await redisClient.get(generationKey({ connectionId }))) !== observedGeneration);

        for (const account of accounts) {
          const accountTransactions = await findTransactions({
            planned: 'include',
            access: 'unscoped-internal',
            balanceAdjustments: 'include',
            completeness: 'all',
            attributes: ['id'],
            where: { id: { [Op.in]: [...createdIds, ...extractionTransactionIds] }, accountId: account.id },
          });
          await linkAndEmitSyncedTransactions({
            userId,
            accountId: account.id,
            transactionIds: accountTransactions
              .filter((transaction) => createdIds.includes(transaction.id))
              .map((transaction) => transaction.id),
            payeeExtractionTransactionIds: accountTransactions
              .filter((transaction) => extractionTransactionIds.includes(transaction.id))
              .map((transaction) => transaction.id),
          });
        }
        await Promise.all(
          accounts.map((account) =>
            setAccountSyncStatus({ accountId: account.id, status: SyncStatus.COMPLETED, userId }),
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Plaid sync error';
        await Promise.all(
          accounts.map((account) =>
            setAccountSyncStatus({ accountId: account.id, status: SyncStatus.FAILED, error: message, userId }),
          ),
        );
        throw error;
      }
    },
    { connection, concurrency: 5 },
  );
  worker.on('failed', (job, error) => {
    logger.error({ message: '[Plaid] Item sync job failed', error }, { connectionId: job?.data.connectionId });
  });
  return { queue, worker };
};

export const enqueuePlaidSync = async ({
  connectionId,
  userId,
  systemAccountIds,
}: {
  connectionId: string;
  userId: number;
  systemAccountIds: string[];
}): Promise<void> => {
  await Promise.all(
    systemAccountIds.map((accountId) =>
      setAccountSyncStatus({ accountId: accountId as Accounts['id'], status: SyncStatus.QUEUED, userId }),
    ),
  );
  await redisClient.incr(generationKey({ connectionId }));
  const bundle = initializeQueue();
  await bundle.queue.add(
    'sync-item',
    { connectionId, userId },
    { jobId: connectionId, removeOnComplete: true, removeOnFail: 100 },
  );
};
