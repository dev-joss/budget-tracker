import type {
  ExpensifyIntegrationState,
  ExpensifyMatchState,
  ExpensifyReconciliationResponse,
  ExpensifySyncStatus,
  RecordId,
} from '@bt/shared/types';
import type { TransactionApiResponse } from '@root/serializers/transactions.serializer';
import type { confirmMatches as apiConfirmMatches } from '@services/work-expenses/confirm-matches.service';
import type { unlinkMatch as apiUnlinkMatch } from '@services/work-expenses/unlink-match.service';

import { makeRequest, sleep } from './common';

export function getWorkExpenseIntegration<R extends boolean | undefined = undefined>({
  raw,
}: {
  raw?: R;
} = {}) {
  return makeRequest<ExpensifyIntegrationState, R>({ method: 'get', url: '/work-expenses/integration', raw });
}

export function updateWorkExpenseIntegration<R extends boolean | undefined = undefined>({
  payload,
  raw,
}: {
  payload: { partnerUserId: string; partnerUserSecret: string; initialSyncDate?: string };
  raw?: R;
}) {
  return makeRequest<ExpensifyIntegrationState, R>({
    method: 'put',
    url: '/work-expenses/integration',
    payload,
    raw,
  });
}

export function disconnectWorkExpenseIntegration<R extends boolean | undefined = undefined>({
  raw,
}: {
  raw?: R;
} = {}) {
  return makeRequest<ExpensifyIntegrationState, R>({ method: 'delete', url: '/work-expenses/integration', raw });
}

export function triggerWorkExpenseSync<R extends boolean | undefined = undefined>({ raw }: { raw?: R } = {}) {
  return makeRequest<{ runId: RecordId; status: 'queued' }, R>({
    method: 'post',
    url: '/work-expenses/sync',
    raw,
  });
}

export function getWorkExpenseSyncStatus<R extends boolean | undefined = undefined>({ raw }: { raw?: R } = {}) {
  return makeRequest<ExpensifySyncStatus, R>({ method: 'get', url: '/work-expenses/sync/status', raw });
}

export async function waitForWorkExpenseSync({
  predicate,
  timeoutMs = 20_000,
}: {
  predicate: (status: ExpensifySyncStatus) => boolean;
  timeoutMs?: number;
}): Promise<ExpensifySyncStatus> {
  const startedAt = Date.now();
  let last: ExpensifySyncStatus = { status: 'idle' };
  while (Date.now() - startedAt < timeoutMs) {
    last = await getWorkExpenseSyncStatus({ raw: true });
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`Work-expense sync did not reach the expected state: ${JSON.stringify(last)}`);
}

export function getWorkExpenseReconciliation<R extends boolean | undefined = undefined>({
  state,
  limit,
  offset,
  raw,
}: {
  state?: ExpensifyMatchState;
  limit?: number;
  offset?: number;
  raw?: R;
} = {}) {
  return makeRequest<ExpensifyReconciliationResponse, R>({
    method: 'get',
    url: '/work-expenses/reconciliation',
    payload: { state, limit, offset },
    raw,
  });
}

export function confirmWorkExpenseMatches<R extends boolean | undefined = undefined>({
  matches,
  raw,
}: {
  matches: Array<{ expenseId: RecordId; transactionId: RecordId }>;
  raw?: R;
}) {
  return makeRequest<Awaited<ReturnType<typeof apiConfirmMatches>>, R>({
    method: 'post',
    url: '/work-expenses/matches/confirm',
    payload: { matches },
    raw,
  });
}

export function unlinkWorkExpenseMatch<R extends boolean | undefined = undefined>({
  expenseId,
  raw,
}: {
  expenseId: RecordId;
  raw?: R;
}) {
  return makeRequest<Awaited<ReturnType<typeof apiUnlinkMatch>>, R>({
    method: 'delete',
    url: `/work-expenses/matches/${expenseId}`,
    raw,
  });
}

export function resolveWorkExpenseReview<R extends boolean | undefined = undefined>({
  expenseId,
  action,
  transactionId,
  raw,
}: {
  expenseId: RecordId;
  action: 'keep' | 'relink';
  transactionId?: RecordId;
  raw?: R;
}) {
  return makeRequest<ExpensifyReconciliationResponse['items'][number] | null, R>({
    method: 'post',
    url: `/work-expenses/reviews/${expenseId}/resolve`,
    payload: { action, transactionId },
    raw,
  });
}

export function setTransactionWorkExpense<R extends boolean | undefined = undefined>({
  id,
  isWorkExpense,
  raw,
}: {
  id: RecordId;
  isWorkExpense: boolean;
  raw?: R;
}) {
  return makeRequest<TransactionApiResponse, R>({
    method: 'patch',
    url: `/work-expenses/transactions/${id}/work-expense`,
    payload: { isWorkExpense },
    raw,
  });
}
