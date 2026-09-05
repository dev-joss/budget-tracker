import { findTransactions } from '@models/transactions-query';
import { redisClient } from '@root/redis-client';
import { createHash } from 'node:crypto';

import { extractRawFromTransaction } from '../extraction.service';
import { normalizePayeeName } from '../normalize-name';
import type { ExtractionSnapshot } from './apply';
import { EXTRACTION_PAGE_SIZE, extractionPolicy, extractionWhere } from './candidates';

const EVIDENCE_TTL_SECONDS = 24 * 60 * 60;
const evidenceKey = ({ userId, runId }: { userId: number; runId: string }) =>
  `payee-extraction-evidence:${userId}:${runId}`;
const sourceHash = ({ normalized }: { normalized: string }) => createHash('sha256').update(normalized).digest('hex');

/** The worker's owner lease serializes this resumable evidence scan. Redis stores only hashes and counts. */
export async function buildOccurrenceEvidence({
  userId,
  runId,
  cutoff,
  leaseActive,
}: {
  userId: number;
  runId: string;
  cutoff: string;
  leaseActive?: () => boolean | Promise<boolean>;
}): Promise<void> {
  const key = evidenceKey({ userId, runId });
  for (;;) {
    if (leaseActive && !(await leaseActive())) throw new Error('Payee evidence lease lost');
    const [cursor, complete] = await redisClient.hmget(key, 'cursor', 'complete');
    if (complete === '1') return;
    const rows = await findTransactions({
      ...extractionPolicy({ userId }),
      where: extractionWhere({ cutoff, cursor: cursor || undefined }),
      attributes: ['id', 'note', 'externalData'],
      order: [['id', 'ASC']],
      completeness: { page: { limit: EXTRACTION_PAGE_SIZE, offset: 0 } },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      const normalized = normalizePayeeName({
        raw: extractRawFromTransaction({ externalData: row.externalData, note: row.note }),
      });
      if (!normalized) continue;
      const field = sourceHash({ normalized });
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
    if (leaseActive && !(await leaseActive())) throw new Error('Payee evidence lease lost');
    const writes = redisClient.multi();
    for (const [field, count] of counts) writes.hincrby(key, field, count);
    if (rows.length) writes.hset(key, 'cursor', rows.at(-1)!.id);
    if (rows.length < EXTRACTION_PAGE_SIZE) writes.hset(key, 'complete', '1');
    writes.expire(key, EVIDENCE_TTL_SECONDS);
    const results = await writes.exec();
    if (!results || results.some(([error]) => error)) throw new Error('Payee evidence checkpoint failed');
    if (rows.length < EXTRACTION_PAGE_SIZE) return;
  }
}

export async function getRepeatedSources({
  userId,
  runId,
  snapshots,
}: {
  userId: number;
  runId: string;
  snapshots: ExtractionSnapshot[];
}): Promise<Set<string>> {
  const sources = [
    ...new Set(
      snapshots
        .map((snapshot) => normalizePayeeName({ raw: snapshot.merchant || snapshot.description }))
        .filter(Boolean),
    ),
  ];
  const repeated = new Set<string>();
  for (let offset = 0; offset < sources.length; offset += EXTRACTION_PAGE_SIZE) {
    const page = sources.slice(offset, offset + EXTRACTION_PAGE_SIZE);
    const counts = await redisClient.hmget(
      evidenceKey({ userId, runId }),
      ...page.map((normalized) => sourceHash({ normalized })),
    );
    page.forEach((normalized, index) => {
      if (Number(counts[index]) >= 2) repeated.add(normalized);
    });
  }
  return repeated;
}
