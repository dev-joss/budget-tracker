import { findTransactions } from '@models/transactions-query';
import { redisClient } from '@root/redis-client';
import { generateText } from 'ai';
import type { Job } from 'bullmq';

import { resolveStoredPayee } from './apply';
import { getExtractionStatus, writeExtractionStatus } from './status';
import { type PayeeExtractionJobData, processExtractionJob } from './worker';

jest.mock('@js/utils/logger', () => ({ logger: { info: jest.fn() } }));
jest.mock('@models/transactions-query', () => ({ findTransactions: jest.fn() }));
jest.mock('@root/redis-client', () => ({ redisClient: { set: jest.fn(), get: jest.fn(), eval: jest.fn() } }));
jest.mock('@services/ai', () => ({
  AI_MAX_OUTPUT_TOKENS: 1000,
  aiCallGuards: jest.fn(() => ({})),
  classifyAiCallFailure: jest.fn(() => ({ kind: 'unknown' })),
  createAIClient: jest.fn(async () => ({ model: 'model' })),
  hitOutputCeiling: jest.fn(() => false),
}));
jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('./apply', () => ({
  applyExtractedPayee: jest.fn(),
  extractionDestination: jest.fn(() => 'destination'),
  extractionEnabled: jest.fn(async () => true),
  resolveStoredPayee: jest.fn(),
  snapshotForExtraction: jest.fn(({ row }) => ({
    id: row.id,
    accountId: row.accountId,
    description: row.note.trim(),
    merchant: '',
  })),
}));
jest.mock('./candidates', () => ({
  EXTRACTION_PAGE_SIZE: 200,
  extractionPolicy: jest.fn(() => ({})),
  extractionWhere: jest.fn((value) => value),
}));
jest.mock('./evidence', () => ({
  buildOccurrenceEvidence: jest.fn(),
  getRepeatedSources: jest.fn(async () => new Set()),
}));
jest.mock('./status', () => ({ getExtractionStatus: jest.fn(), writeExtractionStatus: jest.fn() }));

const initialStatus = {
  runId: 'run',
  status: 'queued',
  scanned: 0,
  linked: 0,
  skipped: 0,
  lowConfidence: 0,
  failed: 0,
  totalCount: 1,
};
const row = { id: 'transaction', accountId: 'account', note: 'Unresolved merchant' };

function makeJob() {
  const state = { progress: {} as object };
  const job = {
    data: {
      kind: 'payee-extraction',
      userId: 1,
      runId: 'run',
      transactionIds: [],
      cutoff: '2026-09-05',
      destination: 'destination',
    },
    get progress() {
      return state.progress;
    },
    updateProgress: jest.fn(async (progress: object) => {
      state.progress = structuredClone(progress);
    }),
  };
  return { job: job as unknown as Job<PayeeExtractionJobData>, state, updateProgress: job.updateProgress };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(redisClient.set).mockImplementation(async (...args: unknown[]) => {
    jest.mocked(redisClient.get).mockResolvedValue(args[1] as string);
    return 'OK';
  });
  jest.mocked(redisClient.eval).mockResolvedValue(1);
  jest.mocked(getExtractionStatus).mockResolvedValue({ ...initialStatus, status: 'queued' });
  jest.mocked(resolveStoredPayee).mockResolvedValue('unresolved');
  jest.mocked(findTransactions).mockImplementation(async (query) => {
    const where = query.where as { cursor?: string };
    if (where.cursor) return [];
    return [row] as unknown as Awaited<ReturnType<typeof findTransactions>>;
  });
});

describe('payee extraction worker checkpoints', () => {
  it('rechecks deterministic matches before a model call', async () => {
    jest.mocked(resolveStoredPayee).mockResolvedValueOnce('unresolved').mockResolvedValueOnce('linked');
    const { job } = makeJob();
    await processExtractionJob({ job });
    expect(generateText).not.toHaveBeenCalled();
    expect(writeExtractionStatus).toHaveBeenLastCalledWith({
      userId: 1,
      status: expect.objectContaining({ scanned: 1, linked: 1, skipped: 0, status: 'completed' }),
    });
  });

  it('retains a page before a DB write and classifies an uncheckpointed link as skipped on retry', async () => {
    const { job, state, updateProgress } = makeJob();
    let linked = false;
    jest.mocked(resolveStoredPayee).mockImplementation(async () => {
      linked = true;
      return 'linked';
    });
    updateProgress.mockImplementation(async (progress) => {
      const page = (progress as { page?: { outcomes: Record<string, string> } }).page;
      if (linked && page?.outcomes.transaction === 'linked') throw new Error('checkpoint unavailable');
      state.progress = structuredClone(progress);
    });
    await expect(processExtractionJob({ job })).rejects.toThrow('Payee extraction processing failed');
    expect(state.progress).toEqual(expect.objectContaining({ page: { ids: ['transaction'], outcomes: {} } }));
    updateProgress.mockImplementation(async (progress) => {
      state.progress = structuredClone(progress);
    });
    jest.mocked(findTransactions).mockResolvedValue([]);
    await processExtractionJob({ job });
    expect(writeExtractionStatus).toHaveBeenLastCalledWith({
      userId: 1,
      status: expect.objectContaining({ scanned: 1, linked: 0, skipped: 1, status: 'completed' }),
    });
  });

  it('keeps known row outcomes when resuming a page', async () => {
    const { job, state } = makeJob();
    state.progress = {
      counts: initialStatus,
      page: { ids: ['transaction', 'removed'], outcomes: { transaction: 'linked' } },
    };
    jest.mocked(findTransactions).mockResolvedValue([]);
    await processExtractionJob({ job });
    expect(resolveStoredPayee).not.toHaveBeenCalled();
    expect(writeExtractionStatus).toHaveBeenLastCalledWith({
      userId: 1,
      status: expect.objectContaining({ scanned: 2, linked: 1, skipped: 1 }),
    });
  });

  it('counts whitespace-only retained rows as skipped without a model call', async () => {
    jest.mocked(findTransactions).mockImplementation(async (query) => {
      if ((query.where as { cursor?: string }).cursor) return [];
      return [{ ...row, note: '  ' }] as unknown as Awaited<ReturnType<typeof findTransactions>>;
    });
    const { job } = makeJob();
    await processExtractionJob({ job });
    expect(generateText).not.toHaveBeenCalled();
    expect(writeExtractionStatus).toHaveBeenLastCalledWith({
      userId: 1,
      status: expect.objectContaining({ scanned: 1, skipped: 1 }),
    });
  });

  it('stops after a provider failure and gives every pending row one failed outcome', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      ...row,
      id: `tx-${index}`,
      note: `Description ${index}`,
    }));
    jest
      .mocked(findTransactions)
      .mockImplementation(async (query) =>
        (query.where as { cursor?: string }).cursor
          ? []
          : (rows as unknown as Awaited<ReturnType<typeof findTransactions>>),
      );
    jest.mocked(generateText).mockRejectedValue(new Error('sensitive provider response'));
    const { job } = makeJob();
    await processExtractionJob({ job });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(writeExtractionStatus).toHaveBeenLastCalledWith({
      userId: 1,
      status: expect.objectContaining({ scanned: 51, failed: 51, error: 'invalid-output', status: 'failed' }),
    });
  });
});
