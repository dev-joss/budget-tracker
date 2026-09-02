import {
  confirmWorkExpenseMatches,
  connectWorkExpenseIntegration,
  disconnectWorkExpenseIntegration,
  getWorkExpenseIntegration,
  getWorkExpenseReconciliation,
  getWorkExpenseSyncStatus,
  removeWorkExpenseMatch,
  resolveWorkExpenseReview,
  triggerWorkExpenseSync,
  updateTransactionWorkExpense,
  type ConnectWorkExpenseIntegrationPayload,
} from '@/api/work-expenses';
import { VUE_QUERY_CACHE_KEYS, VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import { useInvalidatingMutation } from '@/composable/data-queries/use-invalidating-mutation';
import type { ExpensifyMatchState, RecordId } from '@bt/shared/types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';

const RECONCILIATION_INVALIDATION_KEYS = [
  VUE_QUERY_CACHE_KEYS.workExpenseReconciliation,
  [VUE_QUERY_GLOBAL_PREFIXES.transactionChange],
];

export const useWorkExpenseIntegration = () => {
  const queryClient = useQueryClient();
  const integrationQuery = useQuery({
    queryKey: VUE_QUERY_CACHE_KEYS.workExpenseIntegration,
    queryFn: () => getWorkExpenseIntegration({}),
  });

  const syncStatusQuery = useQuery({
    queryKey: VUE_QUERY_CACHE_KEYS.workExpenseSyncStatus,
    queryFn: () => getWorkExpenseSyncStatus({}),
    enabled: computed(() => integrationQuery.data.value?.connected === true),
    refetchInterval: (query) => {
      const state = query.state.data?.status;
      return state === 'queued' || state === 'processing' ? 2000 : false;
    },
  });

  const connectMutation = useInvalidatingMutation({
    mutationFn: (payload: ConnectWorkExpenseIntegrationPayload) => connectWorkExpenseIntegration(payload),
    invalidateKeys: [VUE_QUERY_CACHE_KEYS.workExpenseIntegration, VUE_QUERY_CACHE_KEYS.workExpenseSyncStatus],
    successKey: 'settings.workExpenses.notifications.connected',
    errorKey: 'settings.workExpenses.notifications.connectFailed',
  });

  const disconnectMutation = useInvalidatingMutation({
    mutationFn: () => disconnectWorkExpenseIntegration({}),
    invalidateKeys: [
      VUE_QUERY_CACHE_KEYS.workExpenseIntegration,
      VUE_QUERY_CACHE_KEYS.workExpenseSyncStatus,
      VUE_QUERY_CACHE_KEYS.workExpenseReconciliation,
    ],
    successKey: 'settings.workExpenses.notifications.disconnected',
    errorKey: 'settings.workExpenses.notifications.disconnectFailed',
  });

  const syncMutation = useInvalidatingMutation({
    mutationFn: () => triggerWorkExpenseSync({}),
    invalidateKeys: [
      VUE_QUERY_CACHE_KEYS.workExpenseSyncStatus,
      VUE_QUERY_CACHE_KEYS.workExpenseIntegration,
      ...RECONCILIATION_INVALIDATION_KEYS,
    ],
    successKey: 'settings.workExpenses.notifications.syncStarted',
    errorKey: 'settings.workExpenses.notifications.syncFailed',
    onSuccess: () => {
      queryClient.setQueryData(VUE_QUERY_CACHE_KEYS.workExpenseSyncStatus, { status: 'queued' });
    },
  });

  watch(
    () => syncStatusQuery.data.value?.status,
    (status, previousStatus) => {
      const wasRunning = previousStatus === 'queued' || previousStatus === 'processing';
      const isTerminal = status === 'completed' || status === 'failed';
      if (!wasRunning || !isTerminal) return;
      queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.workExpenseIntegration });
      queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.workExpenseReconciliation });
      queryClient.invalidateQueries({ queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange] });
    },
  );

  return {
    integration: integrationQuery.data,
    syncStatus: syncStatusQuery.data,
    isLoading: integrationQuery.isLoading,
    isError: integrationQuery.isError,
    refetch: integrationQuery.refetch,
    connect: connectMutation.mutateAsync,
    isConnecting: connectMutation.isPending,
    disconnect: disconnectMutation.mutateAsync,
    isDisconnecting: disconnectMutation.isPending,
    sync: syncMutation.mutateAsync,
    isStartingSync: syncMutation.isPending,
    isSyncing: computed(
      () => syncStatusQuery.data.value?.status === 'queued' || syncStatusQuery.data.value?.status === 'processing',
    ),
  };
};

export const useWorkExpenseReconciliation = ({
  state,
  limit,
  offset,
  enabled = true,
}: {
  state: MaybeRefOrGetter<ExpensifyMatchState | undefined>;
  limit: MaybeRefOrGetter<number>;
  offset: MaybeRefOrGetter<number>;
  enabled?: MaybeRefOrGetter<boolean>;
}) => {
  const params = computed(() => ({ state: toValue(state), limit: toValue(limit), offset: toValue(offset) }));
  return useQuery({
    queryKey: computed(() => [...VUE_QUERY_CACHE_KEYS.workExpenseReconciliation, params.value]),
    queryFn: () => getWorkExpenseReconciliation(params.value),
    enabled: computed(() => toValue(enabled)),
    placeholderData: keepPreviousData,
  });
};

export const useConfirmWorkExpenseMatches = () =>
  useInvalidatingMutation({
    mutationFn: confirmWorkExpenseMatches,
    invalidateKeys: RECONCILIATION_INVALIDATION_KEYS,
    successKey: 'optimizations.workExpenses.notifications.matchesConfirmed',
    errorKey: 'optimizations.workExpenses.notifications.confirmFailed',
  });

export const useRemoveWorkExpenseMatch = () =>
  useInvalidatingMutation({
    mutationFn: removeWorkExpenseMatch,
    invalidateKeys: RECONCILIATION_INVALIDATION_KEYS,
    successKey: 'optimizations.workExpenses.notifications.matchRemoved',
    errorKey: 'optimizations.workExpenses.notifications.removeMatchFailed',
  });

export const useResolveWorkExpenseReview = () =>
  useInvalidatingMutation({
    mutationFn: resolveWorkExpenseReview,
    invalidateKeys: RECONCILIATION_INVALIDATION_KEYS,
    successKey: 'optimizations.workExpenses.notifications.reviewResolved',
    errorKey: 'optimizations.workExpenses.notifications.resolveReviewFailed',
  });

export const useUpdateTransactionWorkExpense = () => {
  const queryClient = useQueryClient();
  return useInvalidatingMutation({
    mutationFn: updateTransactionWorkExpense,
    invalidateKeys: RECONCILIATION_INVALIDATION_KEYS,
    successKey: 'transactions.workExpense.notifications.updated',
    errorKey: 'transactions.workExpense.notifications.updateFailed',
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.workExpenseIntegration });
    },
  });
};

export const exactMatchForItem = ({
  expenseId,
  matchState,
  candidates,
}: {
  expenseId: RecordId;
  matchState: ExpensifyMatchState;
  candidates: { transactionId: RecordId; rank: number; isReciprocalTop: boolean }[];
}): { expenseId: RecordId; transactionId: RecordId } | null => {
  if (matchState !== 'exact') return null;
  const candidate = candidates.find((item) => item.rank === 1 && item.isReciprocalTop);
  return candidate ? { expenseId, transactionId: candidate.transactionId } : null;
};
