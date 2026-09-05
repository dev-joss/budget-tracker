import type {
  PayeeExtractionCandidatesResponse,
  PayeeExtractionScope,
  PayeeExtractionStatus,
  PayeeExtractionTriggerResponse,
} from '@bt/shared/types';

import { makeRequest } from './common';

export async function getPayeeExtractionCandidates<R extends boolean | undefined = undefined>({
  payload,
  raw,
}: {
  payload?: { accountIds?: string[]; limit?: number; offset?: number };
  raw?: R;
} = {}) {
  return makeRequest<PayeeExtractionCandidatesResponse, R>({
    method: 'get',
    url: '/payees/extraction/candidates',
    payload,
    raw,
  });
}

export async function triggerPayeeExtraction<R extends boolean | undefined = undefined>({
  payload,
  raw,
}: { payload?: PayeeExtractionScope; raw?: R } = {}) {
  return makeRequest<PayeeExtractionTriggerResponse, R>({
    method: 'post',
    url: '/payees/extraction/trigger',
    payload: payload ?? {},
    raw,
  });
}

export async function getPayeeExtractionStatus<R extends boolean | undefined = undefined>({
  runId,
  raw,
}: { runId?: string; raw?: R } = {}) {
  return makeRequest<PayeeExtractionStatus, R>({
    method: 'get',
    url: '/payees/extraction/status',
    payload: runId ? { runId } : undefined,
    raw,
  });
}

export async function waitForPayeeExtraction({
  runId,
  timeoutMs = 12000,
}: {
  runId: string;
  timeoutMs?: number;
}): Promise<PayeeExtractionStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getPayeeExtractionStatus({ runId, raw: true });
    if (status.status === 'completed' || status.status === 'failed') return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Payee extraction did not reach a terminal state');
}
