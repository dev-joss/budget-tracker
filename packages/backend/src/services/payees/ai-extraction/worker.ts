import { AI_FEATURE, type PayeeExtractionScope, type PayeeExtractionStatus } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import type { SentryTraceData } from '@js/utils/sentry';
import { findTransactions } from '@models/transactions-query';
import { redisClient } from '@root/redis-client';
import {
  AI_MAX_OUTPUT_TOKENS,
  aiCallGuards,
  classifyAiCallFailure,
  createAIClient,
  hitOutputCeiling,
} from '@services/ai';
import { generateText } from 'ai';
import { DelayedError, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';

import {
  applyExtractedPayee,
  extractionDestination,
  extractionEnabled,
  resolveStoredPayee,
  snapshotForExtraction,
  type ExtractionSnapshot,
} from './apply';
import { EXTRACTION_PAGE_SIZE, extractionPolicy, extractionWhere } from './candidates';
import { buildOccurrenceEvidence, getRepeatedSources } from './evidence';
import {
  MAX_SOURCE_LENGTH,
  PAYEE_EXTRACTION_SYSTEM_PROMPT,
  batchDescriptions,
  buildExtractionPrompt,
  parseExtractionResponse,
} from './prompt';
import { getExtractionStatus, writeExtractionStatus } from './status';

export interface PayeeExtractionJobData extends SentryTraceData {
  kind: 'payee-extraction';
  userId: number;
  runId: string;
  transactionIds: string[];
  accountIds?: string[];
  cutoff: string;
  destination: string;
}

type RowOutcome = 'linked' | 'skipped' | 'lowConfidence' | 'failed';
interface ExtractionPage {
  ids: string[];
  outcomes: Record<string, RowOutcome>;
}
interface ExtractionProgress {
  cursor?: string;
  counts: PayeeExtractionStatus;
  page?: ExtractionPage;
}
const LEASE_MS = 90_000;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0`;

/** Deferred jobs stay in BullMQ; no process-local buffer owns pending IDs. */
export async function processExtractionJob({ job, token }: { job: Job<PayeeExtractionJobData>; token?: string }) {
  const { userId, runId } = job.data;
  const key = `payee-extraction-execution:${userId}`;
  const leaseToken = randomUUID();
  if (!(await redisClient.set(key, leaseToken, 'PX', LEASE_MS, 'NX'))) {
    await job.moveToDelayed(Date.now() + 5000, token);
    throw new DelayedError();
  }
  let leaseValid = true;
  const renewal = setInterval(() => {
    void redisClient
      .eval(RENEW, 1, key, leaseToken, LEASE_MS)
      .then((result) => {
        if (result !== 1) leaseValid = false;
      })
      .catch(() => {
        leaseValid = false;
      });
  }, 20_000);
  renewal.unref();
  try {
    await runExtraction({ job, leaseActive: async () => leaseValid && (await redisClient.get(key)) === leaseToken });
  } catch {
    logger.info('[Payee extraction] worker failed', { userId, runId });
    // SDK/database errors can contain descriptions; only a fixed code reaches BullMQ.
    throw new Error('Payee extraction processing failed');
  } finally {
    clearInterval(renewal);
    await redisClient.eval(RELEASE, 1, key, leaseToken).catch(() => undefined);
  }
}

async function runExtraction({
  job,
  leaseActive,
}: {
  job: Job<PayeeExtractionJobData>;
  leaseActive: () => Promise<boolean>;
}) {
  const { userId, runId, cutoff, destination } = job.data;
  const scope: PayeeExtractionScope = {
    accountIds: job.data.accountIds,
    ...(job.data.transactionIds.length ? { transactionIds: job.data.transactionIds } : {}),
  };
  const saved =
    typeof job.progress === 'object' && 'counts' in job.progress ? (job.progress as ExtractionProgress) : null;
  let progress: ExtractionProgress = saved ?? { counts: await getExtractionStatus({ userId, runId }) };
  progress.counts = { ...progress.counts, status: 'processing', error: undefined };
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const requireLease = async () => {
    if (!(await leaseActive())) throw new Error('lease-lost');
  };
  const currentStatus = (): PayeeExtractionStatus => {
    const counts = { ...progress.counts };
    for (const outcome of Object.values(progress.page?.outcomes ?? {})) {
      counts.scanned++;
      counts[outcome]++;
    }
    return counts;
  };
  const checkpoint = async () => {
    await requireLease();
    await job.updateProgress(progress);
    await writeExtractionStatus({ userId, status: currentStatus() });
  };
  const recordOutcome = async ({ id, outcome }: { id: string; outcome: RowOutcome }) => {
    if (progress.page!.outcomes[id]) return;
    progress.page!.outcomes[id] = outcome;
    await checkpoint();
  };
  const finishPending = async ({ outcome }: { outcome: RowOutcome }) => {
    for (const id of progress.page?.ids ?? []) {
      if (!progress.page!.outcomes[id]) progress.page!.outcomes[id] = outcome;
    }
    await checkpoint();
  };
  await checkpoint();
  await requireLease();
  if (await extractionEnabled({ userId })) await buildOccurrenceEvidence({ userId, runId, cutoff, leaseActive });
  for (;;) {
    await requireLease();
    if (!(await extractionEnabled({ userId }))) {
      progress.counts.error = 'extraction-disabled';
      if (progress.page) await finishPending({ outcome: 'skipped' });
      break;
    }
    // Persist IDs before any write. A shrinking candidate query cannot lose the unfinished page on retry.
    if (!progress.page) {
      const rows = await findTransactions({
        ...extractionPolicy({ userId }),
        where: extractionWhere({ scope, cutoff, cursor: progress.cursor }),
        completeness: { page: { limit: EXTRACTION_PAGE_SIZE, offset: 0 } },
        order: [['id', 'ASC']],
        attributes: ['id'],
      });
      if (!rows.length) break;
      progress.page = { ids: rows.map((row) => row.id), outcomes: {} };
      await checkpoint();
    }
    const pendingIds = progress.page.ids.filter((id) => !progress.page!.outcomes[id]);
    const rows = pendingIds.length
      ? await findTransactions({
          ...extractionPolicy({ userId }),
          where: extractionWhere({ scope: { ...scope, transactionIds: pendingIds }, cutoff }),
          completeness: { page: { limit: EXTRACTION_PAGE_SIZE, offset: 0 } },
          order: [['id', 'ASC']],
          attributes: ['id', 'accountId', 'note', 'externalData'],
        })
      : [];
    const snapshots = rows.map((row) => snapshotForExtraction({ row }));
    const repeatedSources = await getRepeatedSources({ userId, runId, snapshots });
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const unresolved: ExtractionSnapshot[] = [];
    for (const id of pendingIds) {
      const snapshot = byId.get(id);
      if (!snapshot || !snapshot.description.trim()) {
        await recordOutcome({ id, outcome: 'skipped' });
        continue;
      }
      await requireLease();
      let outcome: 'linked' | 'unresolved' | 'skipped' | 'failed';
      try {
        outcome = await resolveStoredPayee({ userId, snapshot, repeatedSources });
      } catch {
        outcome = 'failed';
      }
      if (outcome === 'unresolved' && snapshot.description.length > MAX_SOURCE_LENGTH) {
        await recordOutcome({ id, outcome: 'skipped' });
      } else if (outcome === 'unresolved') unresolved.push(snapshot);
      else await recordOutcome({ id, outcome });
    }
    const byDescription = new Map<string, ExtractionSnapshot[]>();
    for (const snapshot of unresolved) {
      byDescription.set(snapshot.description, [...(byDescription.get(snapshot.description) ?? []), snapshot]);
    }
    for (const descriptions of batchDescriptions({ descriptions: [...byDescription.keys()] })) {
      await requireLease();
      if (!(await extractionEnabled({ userId }))) {
        progress.counts.error = 'extraction-disabled';
        await finishPending({ outcome: 'skipped' });
        break;
      }
      // Accepted aliases from earlier batches must be authoritative before another model request.
      const batchRows: ExtractionSnapshot[] = [];
      for (const description of descriptions) {
        for (const snapshot of byDescription.get(description)!) {
          await requireLease();
          let outcome: 'linked' | 'unresolved' | 'skipped' | 'failed';
          try {
            outcome = await resolveStoredPayee({ userId, snapshot, repeatedSources });
          } catch {
            outcome = 'failed';
          }
          if (outcome === 'unresolved') batchRows.push(snapshot);
          else await recordOutcome({ id: snapshot.id, outcome });
        }
      }
      if (!batchRows.length) continue;
      const batchByDescription = new Map<string, ExtractionSnapshot[]>();
      for (const snapshot of batchRows) {
        batchByDescription.set(snapshot.description, [
          ...(batchByDescription.get(snapshot.description) ?? []),
          snapshot,
        ]);
      }
      const inputs = [...batchByDescription.keys()].map((sourceDescription, index) => ({
        id: `s${index + 1}`,
        sourceDescription,
      }));
      let parsed: ReturnType<typeof parseExtractionResponse>;
      try {
        const client = await createAIClient({ userId, feature: AI_FEATURE.payeeExtraction });
        if (!client || extractionDestination({ client }) !== destination) {
          progress.counts.error = 'ai-configuration-changed';
          await finishPending({ outcome: 'failed' });
          break;
        }
        await requireLease();
        if (!(await extractionEnabled({ userId }))) {
          progress.counts.error = 'extraction-disabled';
          await finishPending({ outcome: 'skipped' });
          break;
        }
        requests++;
        const result = await generateText({
          model: client.model,
          system: PAYEE_EXTRACTION_SYSTEM_PROMPT,
          prompt: buildExtractionPrompt({ inputs }),
          maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
          ...aiCallGuards({ provider: client.provider }),
        });
        inputTokens += result.usage.inputTokens ?? 0;
        outputTokens += result.usage.outputTokens ?? 0;
        if (hitOutputCeiling(result) || result.finishReason !== 'stop') throw new Error('invalid-output');
        parsed = parseExtractionResponse({ text: result.text, inputs });
      } catch (error) {
        // Lease loss must retry the retained page, not classify unrelated pending rows as model failures.
        await requireLease();
        const { kind } = classifyAiCallFailure({ error });
        progress.counts.error = kind === 'unknown' ? 'invalid-output' : kind;
        await finishPending({ outcome: 'failed' });
        break;
      }
      await requireLease();
      if (!(await extractionEnabled({ userId }))) {
        progress.counts.error = 'extraction-disabled';
        await finishPending({ outcome: 'skipped' });
        break;
      }
      const descriptionById = new Map(inputs.map((input) => [input.id, input.sourceDescription]));
      for (const id of parsed.invalid) {
        for (const snapshot of batchByDescription.get(descriptionById.get(id)!)!) {
          await recordOutcome({ id: snapshot.id, outcome: 'failed' });
        }
      }
      for (const id of parsed.lowConfidence) {
        for (const snapshot of batchByDescription.get(descriptionById.get(id)!)!) {
          await recordOutcome({ id: snapshot.id, outcome: 'lowConfidence' });
        }
      }
      for (const verdict of parsed.accepted) {
        await requireLease();
        if (!(await extractionEnabled({ userId }))) {
          progress.counts.error = 'extraction-disabled';
          await finishPending({ outcome: 'skipped' });
          break;
        }
        const acceptedSnapshots = batchByDescription.get(verdict.sourceDescription)!;
        let linked: string[] | null;
        try {
          linked = await applyExtractedPayee({
            userId,
            snapshots: acceptedSnapshots,
            name: verdict.normalizedPayeeName!,
            destination,
          });
        } catch {
          linked = null;
        }
        for (const snapshot of acceptedSnapshots) {
          await recordOutcome({
            id: snapshot.id,
            outcome: linked === null ? 'failed' : linked.includes(snapshot.id) ? 'linked' : 'skipped',
          });
        }
      }
      if (progress.counts.error) break;
    }
    // Every retained row has exactly one terminal outcome before the keyset cursor advances.
    await finishPending({ outcome: 'skipped' });
    progress = { cursor: progress.page.ids.at(-1), counts: currentStatus() };
    await checkpoint();
    if (progress.counts.error) break;
  }
  progress.counts = { ...currentStatus(), status: progress.counts.error ? 'failed' : 'completed' };
  progress.page = undefined;
  await checkpoint();
  logger.info('[Payee extraction] run complete', { userId, ...progress.counts, requests, inputTokens, outputTokens });
}
