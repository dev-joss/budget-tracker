import type { PayeeExtractionStatus } from '@bt/shared/types';
import { t } from '@i18n/index';
import { NotFoundError } from '@js/errors';
import { redisClient } from '@root/redis-client';

export const EXTRACTION_STATUS_TTL = 24 * 60 * 60;
export const extractionStatusKey = ({ userId, runId }: { userId: number; runId: string }) =>
  `payee-extraction-status:${userId}:${runId}`;
export const extractionLastKey = ({ userId }: { userId: number }) => `payee-extraction-last:${userId}`;
export const extractionManualKey = ({ userId }: { userId: number }) => `payee-extraction-manual:${userId}`;

export function emptyExtractionStatus(): PayeeExtractionStatus {
  return { runId: null, status: 'idle', scanned: 0, linked: 0, skipped: 0, lowConfidence: 0, failed: 0, totalCount: 0 };
}

export async function writeExtractionStatus({ userId, status }: { userId: number; status: PayeeExtractionStatus }) {
  await redisClient.set(
    extractionStatusKey({ userId, runId: status.runId! }),
    JSON.stringify(status),
    'EX',
    EXTRACTION_STATUS_TTL,
  );
}

export async function getExtractionStatus({
  userId,
  runId,
}: {
  userId: number;
  runId?: string;
}): Promise<PayeeExtractionStatus> {
  const selected = runId ?? (await redisClient.get(extractionLastKey({ userId })));
  if (!selected) return emptyExtractionStatus();
  const serialized = await redisClient.get(extractionStatusKey({ userId, runId: selected }));
  if (!serialized) {
    if (runId) throw new NotFoundError({ message: t({ key: 'payeeExtraction.runNotFound' }) });
    return emptyExtractionStatus();
  }
  return JSON.parse(serialized) as PayeeExtractionStatus;
}

export async function failExtractionRun({ userId, runId }: { userId: number; runId: string }) {
  const status = await getExtractionStatus({ userId, runId });
  await writeExtractionStatus({ userId, status: { ...status, status: 'failed', error: 'processing-failed' } });
}
