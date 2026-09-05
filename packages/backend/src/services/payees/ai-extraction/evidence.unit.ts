import { findTransactions } from '@models/transactions-query';
import { redisClient } from '@root/redis-client';
import { createHash } from 'node:crypto';

import { buildOccurrenceEvidence, getRepeatedSources } from './evidence';

jest.mock('@models/transactions-query', () => ({ findTransactions: jest.fn() }));
jest.mock('@root/redis-client', () => ({ redisClient: { hmget: jest.fn(), multi: jest.fn() } }));
jest.mock('../extraction.service', () => ({
  extractRawFromTransaction: ({ externalData, note }: { externalData?: { merchant?: string }; note?: string }) =>
    externalData?.merchant || note || '',
}));
jest.mock('./candidates', () => ({
  EXTRACTION_PAGE_SIZE: 200,
  extractionPolicy: ({ userId }: { userId: number }) => ({ owner: userId }),
  extractionWhere: ({ cursor, cutoff }: { cursor?: string; cutoff?: string }) => ({ cursor, cutoff }),
}));

const stored = new Map<string, string>();
const increments = jest.fn();
const expirations = jest.fn();
let failAfterCommit = false;

beforeEach(() => {
  jest.clearAllMocks();
  stored.clear();
  failAfterCommit = false;
  jest
    .mocked(redisClient.hmget)
    .mockImplementation(async (_key, ...fields) => fields.map((field) => stored.get(String(field)) ?? null));
  jest.mocked(redisClient.multi).mockImplementation(() => {
    const changes: Array<() => void> = [];
    const transaction = {
      hincrby: (key: string, field: string, count: number) => {
        increments(key, field, count);
        changes.push(() => stored.set(field, String(Number(stored.get(field) ?? 0) + count)));
        return transaction;
      },
      hset: (_key: string, field: string, value: string) => {
        changes.push(() => stored.set(field, value));
        return transaction;
      },
      expire: (key: string, seconds: number) => {
        expirations(key, seconds);
        return transaction;
      },
      exec: async () => {
        changes.forEach((change) => change());
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error('Connection lost after commit');
        }
        return changes.map(() => [null, 1]);
      },
    };
    return transaction as never;
  });
});

it('resumes after an uncertain committed checkpoint without counting its page twice', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    id: `row-${String(index).padStart(3, '0')}`,
    note: ' Café!! ',
    externalData: index === 0 ? { merchant: 'Acme' } : null,
  }));
  jest
    .mocked(findTransactions)
    .mockResolvedValueOnce(rows as never)
    .mockResolvedValueOnce([{ id: 'row-200', note: 'cafe', externalData: null }] as never);
  failAfterCommit = true;
  const scope = { userId: 1, runId: 'run', cutoff: '2026-09-05T00:00:00.000Z' };

  await expect(buildOccurrenceEvidence(scope)).rejects.toThrow('Connection lost after commit');
  expect(stored.get('cursor')).toBe('row-199');
  await buildOccurrenceEvidence(scope);

  expect(findTransactions).toHaveBeenLastCalledWith(
    expect.objectContaining({
      owner: 1,
      where: { cursor: 'row-199', cutoff: scope.cutoff },
      completeness: { page: { limit: 200, offset: 0 } },
    }),
  );
  expect(stored.get(createHash('sha256').update('cafe').digest('hex'))).toBe('200');
  expect(stored.get(createHash('sha256').update('acme').digest('hex'))).toBe('1');
  expect(stored.get('complete')).toBe('1');
  expect(expirations).toHaveBeenLastCalledWith('payee-extraction-evidence:1:run', 86400);
  expect(increments.mock.calls.every(([, field]) => /^[a-f0-9]{64}$/.test(field as string))).toBe(true);

  const repeated = await getRepeatedSources({
    userId: 1,
    runId: 'run',
    snapshots: [
      { id: 'a', accountId: 'account', description: ' CAFÉ ', merchant: '' },
      { id: 'b', accountId: 'account', description: 'cafe', merchant: 'Acme' },
    ],
  });
  expect([...repeated]).toEqual(['cafe']);
  await buildOccurrenceEvidence(scope);
  expect(findTransactions).toHaveBeenCalledTimes(2);
});

it('marks empty evidence complete without manufacturing an occurrence', async () => {
  jest.mocked(findTransactions).mockResolvedValue([]);

  await buildOccurrenceEvidence({ userId: 2, runId: 'empty', cutoff: '2026-09-05T00:00:00.000Z' });

  expect(increments).not.toHaveBeenCalled();
  expect(stored.get('complete')).toBe('1');
  expect(await getRepeatedSources({ userId: 2, runId: 'empty', snapshots: [] })).toEqual(new Set());
});

it('does not write a page when the execution lease is lost during its read', async () => {
  jest.mocked(findTransactions).mockResolvedValue([{ id: 'row', note: 'source', externalData: null }] as never);
  const leaseActive = jest.fn().mockReturnValueOnce(true).mockReturnValue(false);

  await expect(
    buildOccurrenceEvidence({ userId: 1, runId: 'lost', cutoff: '2026-09-05T00:00:00.000Z', leaseActive }),
  ).rejects.toThrow('Payee evidence lease lost');

  expect(redisClient.multi).not.toHaveBeenCalled();
});
