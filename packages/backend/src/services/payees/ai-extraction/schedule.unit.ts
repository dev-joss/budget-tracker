import Accounts from '@models/accounts.model';
import { namespace } from '@models/connection';
import { findTransactions } from '@models/transactions-query';
import { redisClient } from '@root/redis-client';
import { createAIClient } from '@services/ai';
import { categorizationQueue } from '@services/ai-categorization/categorization-queue';

import { extractionEnabled } from './apply';
import { countExtractionCandidates } from './candidates';
import { schedulePayeeExtraction, triggerPayeeExtraction } from './schedule';
import { writeExtractionStatus } from './status';
import type { PayeeExtractionJobData } from './worker';

jest.mock('@i18n/index', () => ({ t: ({ key }: { key: string }) => key }));
jest.mock('@js/utils/logger', () => ({ logger: { info: jest.fn() } }));
jest.mock('@models/accounts.model', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('@models/connection', () => ({ namespace: { get: jest.fn() } }));
jest.mock('@models/transactions-query', () => ({ findTransactions: jest.fn() }));
jest.mock('@root/redis-client', () => ({ redisClient: { get: jest.fn(), set: jest.fn(), eval: jest.fn() } }));
jest.mock('@services/ai', () => ({ createAIClient: jest.fn() }));
jest.mock('@services/ai-categorization/categorization-queue', () => ({
  categorizationQueue: { getJob: jest.fn(), add: jest.fn() },
}));
jest.mock('@services/common/rate-limit.service', () => ({ RateLimitService: { checkRateLimit: jest.fn() } }));
jest.mock('./apply', () => ({
  extractionEnabled: jest.fn(),
  extractionDestination: () => 'openai/model',
  snapshotForExtraction: ({
    row,
  }: {
    row: { id: string; accountId: string; note: string; externalData: { merchant: string } };
  }) => ({ id: row.id, accountId: row.accountId, description: row.note, merchant: row.externalData.merchant }),
}));
jest.mock('./candidates', () => ({
  assertExtractionScope: jest.fn(),
  countExtractionCandidates: jest.fn(),
  extractionPolicy: jest.fn(),
  extractionWhere: jest.fn(),
}));
jest.mock('./status', () => ({
  EXTRACTION_STATUS_TTL: 86400,
  emptyExtractionStatus: () => ({ scanned: 0, linked: 0, skipped: 0, lowConfidence: 0, failed: 0 }),
  extractionLastKey: ({ userId }: { userId: number }) => `last:${userId}`,
  extractionManualKey: ({ userId }: { userId: number }) => `manual:${userId}`,
  writeExtractionStatus: jest.fn(),
}));

interface StoredJob {
  data: PayeeExtractionJobData;
  state: string;
  getState: () => Promise<string>;
  remove: () => Promise<void>;
}
const jobs = new Map<string, StoredJob>();
const makeStoredJob = ({
  jobId,
  data,
  state = 'active',
}: {
  jobId: string;
  data: PayeeExtractionJobData;
  state?: string;
}): StoredJob => {
  const job: StoredJob = {
    data,
    state,
    getState: async () => job.state,
    remove: async () => {
      jobs.delete(jobId);
    },
  };
  return job;
};
let sourceRow = { id: 'row', accountId: 'account', note: 'source-v1', externalData: { merchant: '' } };

beforeEach(() => {
  jest.clearAllMocks();
  jobs.clear();
  sourceRow = { id: 'row', accountId: 'account', note: 'source-v1', externalData: { merchant: '' } };
  jest.mocked(namespace.get).mockReturnValue(undefined);
  jest.mocked(findTransactions).mockImplementation(async () => [sourceRow] as never);
  jest.mocked(Accounts.findAll).mockResolvedValue([{ id: 'account', userId: 1 }] as never);
  jest.mocked(extractionEnabled).mockResolvedValue(true);
  jest.mocked(countExtractionCandidates).mockResolvedValue(1);
  jest.mocked(createAIClient).mockResolvedValue({ usingUserKey: true } as never);
  jest.mocked(redisClient.get).mockResolvedValue(null);
  jest.mocked(redisClient.set).mockResolvedValue('OK');
  jest.mocked(redisClient.eval).mockResolvedValue(1);
  jest.mocked(writeExtractionStatus).mockResolvedValue(undefined);
  jest.mocked(categorizationQueue.getJob).mockImplementation(async (jobId) => jobs.get(jobId) as never);
  jest.mocked(categorizationQueue.add).mockImplementation(async (_name, data, options) => {
    const jobId = options!.jobId!;
    const job = makeStoredJob({ jobId, data: data as PayeeExtractionJobData });
    jobs.set(jobId, job);
    return job as never;
  });
});

it('deduplicates the same active revision without storing source descriptions in the job', async () => {
  await schedulePayeeExtraction({ userId: 1, transactionIds: ['row'] });
  await schedulePayeeExtraction({ userId: 1, transactionIds: ['row', 'row'] });

  expect(categorizationQueue.add).toHaveBeenCalledTimes(1);
  const [job] = jobs.values();
  expect(job!.data.transactionIds).toEqual(['row']);
  expect(JSON.stringify(job!.data)).not.toContain('source-v1');
  expect([...jobs.keys()][0]).toMatch(/^payee-1-[a-f0-9]{64}$/);
});

it('queues changed source text while the previous revision remains active', async () => {
  await schedulePayeeExtraction({ userId: 1, transactionIds: ['row'] });
  sourceRow = { ...sourceRow, note: 'source-v2' };
  await schedulePayeeExtraction({ userId: 1, transactionIds: ['row'] });

  expect(categorizationQueue.add).toHaveBeenCalledTimes(2);
  expect(jobs.size).toBe(2);
  expect(new Set([...jobs.values()].map((job) => job.data.runId)).size).toBe(2);
});

it('uses a fresh run and evidence identity after the same revision completed', async () => {
  await schedulePayeeExtraction({ userId: 1, transactionIds: ['row'] });
  const [first] = jobs.values();
  first!.state = 'completed';
  await schedulePayeeExtraction({ userId: 1, transactionIds: ['row'] });

  expect(categorizationQueue.add).toHaveBeenCalledTimes(2);
  expect(jobs.size).toBe(1);
  expect([...jobs.values()][0]!.data.runId).not.toBe(first!.data.runId);
});

it('publishes the retained run pointer when an identical producer wins the add race', async () => {
  jest.mocked(categorizationQueue.add).mockImplementation(async (_name, data, options) => {
    const jobId = options!.jobId!;
    const retained = makeStoredJob({ jobId, data: { ...data, runId: 'payee-retained' } as PayeeExtractionJobData });
    jobs.set(jobId, retained);
    return retained as never;
  });

  await schedulePayeeExtraction({ userId: 1, transactionIds: ['row'] });

  expect(redisClient.set).toHaveBeenCalledWith('last:1', 'payee-retained', 'EX', 86400);
});

it('allows an explicit run when a stale manual pointer has no remaining queue job', async () => {
  jest.mocked(redisClient.get).mockResolvedValue('payee-stale');

  const result = await triggerPayeeExtraction({ userId: 1, transactionIds: ['row'] });

  expect(categorizationQueue.getJob).toHaveBeenCalledWith('payee-stale');
  expect(result.enqueued).toBe(true);
  expect(result.runId).not.toBe('payee-stale');
  expect(redisClient.set).toHaveBeenCalledWith('manual:1', result.runId, 'EX', 86400);
});

it('does not publish an orphan queued pointer when a retained job disappears before lookup', async () => {
  jest.mocked(categorizationQueue.add).mockResolvedValue({} as never);

  await schedulePayeeExtraction({ userId: 1, transactionIds: ['row'] });

  expect(redisClient.set).not.toHaveBeenCalled();
  expect(writeExtractionStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: expect.objectContaining({ status: 'failed', error: 'queue-unavailable' }) }),
  );
});

it('keeps committed imports successful when enqueueing fails', async () => {
  jest.mocked(categorizationQueue.add).mockRejectedValue(new Error('Queue unavailable'));

  await expect(schedulePayeeExtraction({ userId: 1, transactionIds: ['row'] })).resolves.toBeUndefined();

  expect(writeExtractionStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: expect.objectContaining({ status: 'failed', error: 'queue-unavailable' }) }),
  );
});
