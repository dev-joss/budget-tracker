<script setup lang="ts">
import {
  loadPayeeExtractionCandidates,
  loadPayeeExtractionStatus,
  triggerPayeeExtraction,
} from '@/api/payee-extraction';
import { VUE_QUERY_CACHE_KEYS, VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import { Button } from '@/components/lib/ui/button';
import { Checkbox } from '@/components/lib/ui/checkbox';
import { useNotificationCenter } from '@/components/notification-center';
import TransactionDetailsModal from '@/components/transactions-list/transaction-details-modal.vue';
import { useManageTransactionDialog } from '@/components/transactions-list/use-manage-transaction-dialog';
import { useAiSettings } from '@/composable/data-queries/ai-settings';
import { useUserSettings } from '@/composable/data-queries/user-settings';
import { ROUTES_NAMES } from '@/routes';
import { useAccountsStore } from '@/stores/accounts';
import { useUserStore } from '@/stores/user';
import { AI_FEATURE } from '@bt/shared/types';
import { CircleCheckIcon } from '@lucide/vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { useElementSize } from '@vueuse/core';
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  buildExtractionScope,
  canProcessExtraction,
  hasExtractionDestination,
  isExtractionActive,
} from './extraction-state';

const pageRef = ref<HTMLElement>();
const { width } = useElementSize(pageRef);
const MOBILE_EDITOR_WIDTH = 640;
const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 2000;
const ManageTransactionDialogContent = defineAsyncComponent(
  () => import('@/components/dialogs/manage-transaction/dialog-content.vue'),
);
const { isDialogVisible, dialogProps, handleRecordClick, closeDialog } = useManageTransactionDialog();
const { t } = useI18n();
const { addSuccessNotification, addErrorNotification } = useNotificationCenter();
const queryClient = useQueryClient();
const accountsStore = useAccountsStore();
const userStore = useUserStore();
const accounts = computed(() =>
  (accountsStore.accounts ?? []).filter((account) => account.userId === userStore.user?.id),
);
const accountIds = ref<string[]>([]);
const selectedIds = ref<string[]>([]);
const allInScope = ref(false);
const offset = ref(0);
const runId = ref<string>();
const { data: settings } = useUserSettings();
const { featuresStatus, isFeaturesPending, featuresUnknown, refetchFeatures } = useAiSettings();
const feature = computed(() => featuresStatus.value.find((item) => item.feature === AI_FEATURE.payeeExtraction));
const hasDestination = computed(
  () =>
    !isFeaturesPending.value &&
    !featuresUnknown.value &&
    hasExtractionDestination({
      feature: feature.value,
    }),
);
const scope = computed(() =>
  buildExtractionScope({ accountIds: accountIds.value, selectedIds: selectedIds.value, allInScope: allInScope.value }),
);
const candidates = useQuery({
  queryKey: computed(() => [...VUE_QUERY_CACHE_KEYS.payeeExtractionCandidates, accountIds.value, offset.value]),
  queryFn: () =>
    loadPayeeExtractionCandidates({ accountIds: accountIds.value, limit: PAGE_SIZE, offset: offset.value }),
  enabled: computed(() => accountIds.value.length > 0),
});
const statusQuery = useQuery({
  queryKey: computed(() => [...VUE_QUERY_CACHE_KEYS.payeeExtractionStatus, runId.value]),
  queryFn: () => loadPayeeExtractionStatus({ runId: runId.value }),
  refetchInterval: POLL_INTERVAL_MS,
});
const active = computed(() => isExtractionActive({ status: statusQuery.data.value?.status }));
const canProcess = computed(() =>
  canProcessExtraction({
    aiEnabled: settings.value?.payeeAiExtractionEnabled ?? false,
    descriptionsEnabled: settings.value?.payeeExtractionUsesDescription ?? false,
    hasDestination: hasDestination.value,
    hasScope: !!scope.value && candidates.isSuccess.value && (candidates.data.value?.totalCount ?? 0) > 0,
    active: active.value,
    statusReady: statusQuery.isSuccess.value && !statusQuery.isError.value,
  }),
);
const trigger = useMutation({
  mutationFn: triggerPayeeExtraction,
  onSuccess: async (result) => {
    runId.value = result.runId ?? undefined;
    addSuccessNotification(t(result.enqueued ? 'payees.extraction.started' : 'payees.extraction.noWork'));
    await queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeeExtractionStatus });
  },
  onError: () => addErrorNotification(t('payees.extraction.startError')),
});
function retryConfiguration() {
  refetchFeatures();
}
function start() {
  if (canProcess.value && scope.value) trigger.mutate(scope.value);
}
function toggleAccount({ id, checked }: { id: string; checked: boolean }) {
  accountIds.value = checked ? [...accountIds.value, id] : accountIds.value.filter((value) => value !== id);
}
function toggleRow({ id, checked }: { id: string; checked: boolean }) {
  selectedIds.value = checked ? [...selectedIds.value, id] : selectedIds.value.filter((value) => value !== id);
}
watch(accountIds, () => {
  selectedIds.value = [];
  offset.value = 0;
  allInScope.value = false;
});
watch(offset, () => {
  selectedIds.value = [];
});
watch(
  () => candidates.data.value?.items,
  (items) => {
    selectedIds.value = selectedIds.value.filter((id) => items?.some((item) => item.id === id));
    if (items?.length === 0 && offset.value > 0) offset.value = 0;
  },
);
watch(
  () => statusQuery.data.value?.scanned,
  () => {
    queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeeExtractionCandidates });
    queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeesList });
    queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeesLookup });
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.includes(VUE_QUERY_GLOBAL_PREFIXES.transactionChange),
    });
  },
);
watch(isDialogVisible, (open) => {
  if (!open) candidates.refetch();
});
</script>

<template>
  <div ref="pageRef" class="@container flex flex-col gap-5 p-4">
    <div>
      <h1 class="text-2xl font-bold">{{ $t('payees.extraction.title') }}</h1>
      <p class="text-muted-foreground text-sm">{{ $t('payees.extraction.description') }}</p>
    </div>
    <div class="space-y-3 rounded-lg border p-4">
      <p v-if="feature && hasDestination" class="text-sm">
        {{
          $t('payees.extraction.destination', {
            destination: feature.endpointName ?? feature.modelId.split('/')[0],
            model: feature.modelName,
          })
        }}
      </p>
      <div v-else>
        <p class="text-warning-text text-sm">{{ $t('payees.extraction.unavailable') }}</p>
        <Button variant="outline" size="sm" @click="retryConfiguration">{{ $t('payees.extraction.retry') }}</Button>
      </div>
      <p
        v-if="!settings?.payeeAiExtractionEnabled || !settings?.payeeExtractionUsesDescription"
        class="text-warning-text text-sm"
      >
        {{ $t('payees.extraction.disabled') }}
      </p>
      <div class="flex flex-wrap gap-2">
        <Button as-child variant="outline"
          ><RouterLink :to="{ name: ROUTES_NAMES.settingsAiFeatures }">{{
            $t('payees.extraction.aiSettings')
          }}</RouterLink></Button
        >
        <Button as-child variant="outline"
          ><RouterLink :to="{ name: ROUTES_NAMES.settingsPayeesSettings }">{{
            $t('payees.extraction.payeeSettings')
          }}</RouterLink></Button
        >
      </div>
    </div>
    <fieldset class="rounded-lg border p-4" :disabled="active || trigger.isPending.value">
      <legend class="px-1 text-sm font-medium">{{ $t('payees.extraction.accounts') }}</legend>
      <div class="flex flex-wrap gap-4">
        <label v-for="account in accounts" :key="account.id" class="flex items-center gap-2 text-sm"
          ><Checkbox
            :model-value="accountIds.includes(account.id)"
            @update:model-value="(value) => toggleAccount({ id: account.id, checked: !!value })"
          />{{ account.name }}</label
        >
      </div>
    </fieldset>
    <p v-if="!accountIds.length" class="text-muted-foreground text-sm">{{ $t('payees.extraction.chooseScope') }}</p>
    <template v-else>
      <label class="flex items-center gap-2 text-sm"
        ><Checkbox v-model="allInScope" :disabled="active" />{{ $t('payees.extraction.allScope') }}</label
      >
      <p v-if="!allInScope" class="text-muted-foreground text-sm">{{ $t('payees.extraction.selectedScope') }}</p>
      <div v-if="candidates.isPending.value" class="bg-muted h-40 w-full animate-pulse rounded-lg" />
      <div v-else-if="candidates.isError.value" role="alert">
        <p>{{ $t('payees.extraction.loadError') }}</p>
        <Button variant="outline" @click="candidates.refetch()">{{ $t('payees.extraction.retry') }}</Button>
      </div>
      <div
        v-else-if="!candidates.data.value?.items.length"
        class="flex flex-col items-center gap-2 rounded-lg border p-8 text-center"
      >
        <CircleCheckIcon class="text-success-text size-8" />
        <h2 class="font-medium">{{ $t('payees.extraction.emptyTitle') }}</h2>
        <p class="text-muted-foreground text-sm">{{ $t('payees.extraction.emptyDescription') }}</p>
      </div>
      <div v-else class="divide-y rounded-lg border">
        <div v-for="row in candidates.data.value.items" :key="row.id" class="flex items-center gap-3 p-3">
          <Checkbox
            :aria-label="row.note || $t('payees.extraction.edit')"
            :model-value="selectedIds.includes(row.id)"
            :disabled="allInScope || active"
            @update:model-value="(value) => toggleRow({ id: row.id, checked: !!value })"
          />
          <p class="min-w-0 flex-1 text-sm break-words">{{ row.note }}</p>
          <Button variant="outline" size="sm" @click="handleRecordClick([row, undefined])">{{
            $t('payees.extraction.edit')
          }}</Button>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-muted-foreground flex-1 text-sm">
          {{ $t('payees.extraction.total', { count: candidates.data.value?.totalCount ?? 0 }) }}
        </p>
        <Button variant="outline" :disabled="offset === 0" @click="offset -= PAGE_SIZE">{{
          $t('payees.extraction.previous')
        }}</Button
        ><Button
          variant="outline"
          :disabled="offset + PAGE_SIZE >= (candidates.data.value?.totalCount ?? 0)"
          @click="offset += PAGE_SIZE"
          >{{ $t('payees.extraction.next') }}</Button
        >
      </div>
    </template>
    <div v-if="statusQuery.isError.value" role="alert">
      <p>{{ $t('payees.extraction.statusError') }}</p>
      <Button variant="outline" @click="statusQuery.refetch()">{{ $t('payees.extraction.retry') }}</Button>
    </div>
    <div v-else-if="statusQuery.data.value?.runId" aria-live="polite" class="space-y-2 rounded-lg border p-4 text-sm">
      <p class="font-medium">{{ $t(`payees.extraction.statuses.${statusQuery.data.value.status}`) }}</p>
      <p>{{ $t('payees.extraction.counts', { ...statusQuery.data.value }) }}</p>
      <p v-if="statusQuery.data.value.error || statusQuery.data.value.failed" class="text-warning-text">
        {{ $t('payees.extraction.stopped') }}
      </p>
    </div>
    <Button
      class="self-start"
      :disabled="!canProcess || trigger.isPending.value"
      :loading="trigger.isPending.value || active"
      @click="start"
      >{{ $t('payees.extraction.process') }}</Button
    >
    <TransactionDetailsModal v-model:open="isDialogVisible" :mobile="width > 0 && width < MOBILE_EDITOR_WIDTH"
      ><ManageTransactionDialogContent v-bind="dialogProps" @close-modal="closeDialog"
    /></TransactionDetailsModal>
  </div>
</template>
