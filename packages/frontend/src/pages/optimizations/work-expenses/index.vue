<script setup lang="ts">
import type { WorkExpenseMatchCandidate, WorkExpenseReconciliationItem } from '@/api/work-expenses';
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import SelectField from '@/components/fields/select-field.vue';
import { Button } from '@/components/lib/ui/button';
import { Card } from '@/components/lib/ui/card';
import { Checkbox } from '@/components/lib/ui/checkbox';
import {
  exactMatchForItem,
  useConfirmWorkExpenseMatches,
  useRemoveWorkExpenseMatch,
  useResolveWorkExpenseReview,
  useWorkExpenseIntegration,
  useWorkExpenseReconciliation,
} from '@/composable/data-queries/work-expenses';
import { useDateLocale } from '@/composable/use-date-locale';
import { useFormatCurrency } from '@/composable/formatters';
import { cn } from '@/lib/utils';
import { ROUTES_NAMES } from '@/routes';
import {
  EXPENSIFY_MATCH_STATES,
  type ExpensifyMatchState,
  type ExpensifyReviewReason,
  type RecordId,
} from '@bt/shared/types';
import {
  ArrowLeftIcon,
  BriefcaseBusinessIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  Link2OffIcon,
  RefreshCwIcon,
  SettingsIcon,
} from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

interface StateFilterOption {
  value: 'all' | ExpensifyMatchState;
  label: string;
}

const PAGE_SIZE = 25;
const { t } = useI18n();
const { format } = useDateLocale();
const { formatAmountByCurrencyCode } = useFormatCurrency();
const offset = ref(0);
const selectedFilter = ref<StateFilterOption | null>(null);
const selectedCandidates = reactive<Record<string, RecordId | undefined>>({});
const selectedExactExpenseIds = ref<Set<RecordId>>(new Set());
const removeTarget = ref<WorkExpenseReconciliationItem | null>(null);

const filterOptions = computed<StateFilterOption[]>(() => [
  { value: 'all', label: t('optimizations.workExpenses.filters.all') },
  ...Object.values(EXPENSIFY_MATCH_STATES).map((value) => ({
    value,
    label: t(`optimizations.workExpenses.matchStates.${value}`),
  })),
]);

const activeState = computed(() => {
  const value = selectedFilter.value?.value;
  return value && value !== 'all' ? value : undefined;
});
const {
  integration,
  isLoading: isIntegrationLoading,
  isError: isIntegrationError,
  refetch: refetchIntegration,
  isSyncing,
  sync,
  isStartingSync,
} = useWorkExpenseIntegration();
const reconciliationQuery = useWorkExpenseReconciliation({
  state: activeState,
  limit: PAGE_SIZE,
  offset,
  enabled: computed(() => integration.value?.connected === true),
});
const confirmMutation = useConfirmWorkExpenseMatches();
const removeMutation = useRemoveWorkExpenseMatch();
const reviewMutation = useResolveWorkExpenseReview();

const items = computed(() => reconciliationQuery.data.value?.items ?? []);
const total = computed(() => reconciliationQuery.data.value?.total ?? 0);
const pageEnd = computed(() => Math.min(offset.value + PAGE_SIZE, total.value));
const canGoPrevious = computed(() => offset.value > 0);
const canGoNext = computed(() => pageEnd.value < total.value);

const exactMatchByExpenseId = computed(() => {
  const matches = new Map<RecordId, { expenseId: RecordId; transactionId: RecordId }>();
  for (const item of items.value) {
    if (item.expense.linkedTransactionId) continue;
    const match = exactMatchForItem({
      expenseId: item.expense.id,
      matchState: item.expense.matchState,
      candidates: item.candidates,
    });
    if (match) matches.set(item.expense.id, match);
  }
  return matches;
});
const exactMatches = computed(() => [...exactMatchByExpenseId.value.values()]);
const selectedExactMatches = computed(() =>
  exactMatches.value.filter((match) => selectedExactExpenseIds.value.has(match.expenseId)),
);
const allExactSelected = computed(
  () => exactMatches.value.length > 0 && selectedExactMatches.value.length === exactMatches.value.length,
);
const bulkSelectionState = computed(() => {
  if (allExactSelected.value) return true;
  return selectedExactMatches.value.length ? 'indeterminate' : false;
});

watch([activeState, items], () => {
  selectedExactExpenseIds.value = new Set();
  for (const key of Object.keys(selectedCandidates)) delete selectedCandidates[key];
});
watch(activeState, () => {
  offset.value = 0;
});

const setExactSelected = ({ expenseId, selected }: { expenseId: RecordId; selected: boolean }) => {
  const next = new Set(selectedExactExpenseIds.value);
  if (selected) next.add(expenseId);
  else next.delete(expenseId);
  selectedExactExpenseIds.value = next;
};

const toggleAllExact = ({ value }: { value: boolean | 'indeterminate' }) => {
  selectedExactExpenseIds.value =
    value === true ? new Set(exactMatches.value.map((item) => item.expenseId)) : new Set();
};

const confirmSelectedExact = async () => {
  if (!selectedExactMatches.value.length) return;
  try {
    await confirmMutation.mutateAsync({ matches: selectedExactMatches.value });
    selectedExactExpenseIds.value = new Set();
  } catch {
    // The mutation renders the API error as a notification.
  }
};

const confirmCandidate = async ({ item }: { item: WorkExpenseReconciliationItem }) => {
  const transactionId = selectedCandidates[item.expense.id];
  if (!transactionId) return;
  try {
    await confirmMutation.mutateAsync({ matches: [{ expenseId: item.expense.id, transactionId }] });
  } catch {
    // The mutation renders the API error as a notification.
  }
};

const resolveReview = async ({ item, action }: { item: WorkExpenseReconciliationItem; action: 'keep' | 'relink' }) => {
  const transactionId = action === 'relink' ? selectedCandidates[item.expense.id] : undefined;
  if (action === 'relink' && !transactionId) return;
  try {
    await reviewMutation.mutateAsync({ expenseId: item.expense.id, action, transactionId });
  } catch {
    // The mutation renders the API error as a notification.
  }
};

const confirmRemove = async () => {
  if (!removeTarget.value) return;
  try {
    await removeMutation.mutateAsync({ expenseId: removeTarget.value.expense.id });
    removeTarget.value = null;
  } catch {
    // Keep the confirmation open so the user can retry.
  }
};

const handleSync = async () => {
  try {
    await sync(undefined);
  } catch {
    // The mutation renders the API error as a notification.
  }
};

const merchantName = ({ item }: { item: WorkExpenseReconciliationItem }) =>
  item.expense.modifiedMerchant || item.expense.originalMerchant;

const candidateAmount = ({ candidate }: { candidate: WorkExpenseMatchCandidate }) => {
  const amount = candidate.transaction.originalAmount ?? candidate.transaction.amount;
  const currency = candidate.transaction.originalCurrencyCode ?? candidate.transaction.currencyCode;
  return formatAmountByCurrencyCode(amount, currency);
};

const candidateSelected = ({ expenseId, transactionId }: { expenseId: RecordId; transactionId: RecordId }) =>
  selectedCandidates[expenseId] === transactionId;

const selectCandidate = ({ expenseId, transactionId }: { expenseId: RecordId; transactionId: RecordId }) => {
  selectedCandidates[expenseId] = transactionId;
};

const stateClass = ({ state }: { state: ExpensifyMatchState }) => {
  if (state === EXPENSIFY_MATCH_STATES.review) return 'bg-muted text-warning-text';
  if (state === EXPENSIFY_MATCH_STATES.exact) return 'bg-success/10 text-success-text';
  if (state === EXPENSIFY_MATCH_STATES.unmatched) return 'bg-muted text-muted-foreground';
  return 'bg-primary/10 text-primary-text';
};

const reviewReasonLabel = ({ reason }: { reason: ExpensifyReviewReason }) =>
  t(`optimizations.workExpenses.reviewReasons.${reason}`);
</script>

<template>
  <div class="@container/work-expenses flex flex-col gap-5 p-4">
    <div class="flex flex-wrap items-center gap-3">
      <Button variant="ghost" size="icon-sm" as-child>
        <RouterLink :to="{ name: ROUTES_NAMES.optimizations }" :aria-label="$t('optimizations.backToOptimizations')">
          <ArrowLeftIcon class="size-4" />
        </RouterLink>
      </Button>
      <div class="min-w-0 flex-1">
        <h1 class="text-2xl font-bold tracking-tight">{{ $t('optimizations.workExpenses.title') }}</h1>
        <p class="text-muted-foreground mt-1 text-sm">{{ $t('optimizations.workExpenses.description') }}</p>
      </div>
      <Button variant="outline" as-child>
        <RouterLink :to="{ name: ROUTES_NAMES.settingsWorkExpenses }">
          <SettingsIcon class="size-4" />
          {{ $t('optimizations.workExpenses.actions.integrationSettings') }}
        </RouterLink>
      </Button>
    </div>

    <Card v-if="isIntegrationLoading" class="flex flex-col gap-4 p-6" aria-busy="true">
      <div class="bg-muted h-6 w-48 animate-pulse rounded" />
      <div class="bg-muted h-4 w-full max-w-xl animate-pulse rounded" />
      <div class="bg-muted h-9 w-32 animate-pulse rounded" />
    </Card>

    <Card v-else-if="isIntegrationError" class="flex flex-col items-center gap-3 p-8 text-center">
      <CircleAlertIcon class="text-destructive-text size-10" />
      <div>
        <h2 class="font-medium">{{ $t('optimizations.workExpenses.integrationLoadError.title') }}</h2>
        <p class="text-muted-foreground mt-1 text-sm">
          {{ $t('optimizations.workExpenses.integrationLoadError.description') }}
        </p>
      </div>
      <Button variant="outline" @click="refetchIntegration()">{{ $t('common.actions.retry') }}</Button>
    </Card>

    <Card v-else-if="!integration?.connected" class="flex flex-col items-center gap-3 p-8 text-center">
      <BriefcaseBusinessIcon class="text-muted-foreground size-10" />
      <div>
        <h2 class="font-medium">{{ $t('optimizations.workExpenses.disconnected.title') }}</h2>
        <p class="text-muted-foreground mt-1 text-sm">
          {{ $t('optimizations.workExpenses.disconnected.description') }}
        </p>
      </div>
      <Button as-child>
        <RouterLink :to="{ name: ROUTES_NAMES.settingsWorkExpenses }">
          {{ $t('optimizations.workExpenses.disconnected.action') }}
        </RouterLink>
      </Button>
    </Card>

    <template v-else>
      <div class="flex flex-col gap-3 @sm/work-expenses:flex-row @sm/work-expenses:items-end">
        <SelectField
          v-model="selectedFilter"
          class="w-full @sm/work-expenses:max-w-64"
          :values="filterOptions"
          value-key="value"
          label-key="label"
          :label="$t('optimizations.workExpenses.filters.label')"
          :placeholder="$t('optimizations.workExpenses.filters.placeholder')"
          clearable
        />
        <Button
          variant="outline"
          :disabled="isSyncing || isStartingSync"
          :loading="isSyncing || isStartingSync"
          @click="handleSync"
        >
          <RefreshCwIcon :class="cn('size-4', isSyncing && 'animate-spin')" />
          {{ $t('optimizations.workExpenses.actions.syncNow') }}
        </Button>
      </div>

      <Card v-if="exactMatches.length" class="flex flex-wrap items-center gap-3 p-4">
        <Checkbox
          :model-value="bulkSelectionState"
          :aria-label="$t('optimizations.workExpenses.bulk.selectAll')"
          @update:model-value="(value) => toggleAllExact({ value })"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">
            {{ $t('optimizations.workExpenses.bulk.title', { count: exactMatches.length }, exactMatches.length) }}
          </p>
          <p class="text-muted-foreground text-xs">{{ $t('optimizations.workExpenses.bulk.description') }}</p>
        </div>
        <Button
          :disabled="!selectedExactMatches.length || confirmMutation.isPending.value"
          :loading="confirmMutation.isPending.value"
          @click="confirmSelectedExact"
        >
          <CircleCheckIcon class="size-4" />
          {{
            $t(
              'optimizations.workExpenses.bulk.confirm',
              { count: selectedExactMatches.length },
              selectedExactMatches.length,
            )
          }}
        </Button>
      </Card>

      <div v-if="reconciliationQuery.isLoading.value" class="flex flex-col gap-4" aria-busy="true">
        <Card v-for="index in 3" :key="index" class="p-5">
          <div class="mb-4 flex justify-between gap-4">
            <div class="space-y-2">
              <div class="bg-muted h-5 w-48 animate-pulse rounded" />
              <div class="bg-muted h-4 w-32 animate-pulse rounded" />
            </div>
            <div class="bg-muted h-6 w-20 animate-pulse rounded-full" />
          </div>
          <div class="grid grid-cols-1 gap-4 @lg/work-expenses:grid-cols-2">
            <div class="bg-muted h-28 animate-pulse rounded" />
            <div class="bg-muted h-28 animate-pulse rounded" />
          </div>
        </Card>
      </div>

      <Card v-else-if="reconciliationQuery.isError.value" class="flex flex-col items-center gap-3 p-8 text-center">
        <CircleAlertIcon class="text-destructive-text size-10" />
        <div>
          <h2 class="font-medium">{{ $t('optimizations.workExpenses.loadError.title') }}</h2>
          <p class="text-muted-foreground mt-1 text-sm">{{ $t('optimizations.workExpenses.loadError.description') }}</p>
        </div>
        <Button variant="outline" @click="reconciliationQuery.refetch()">{{ $t('common.actions.retry') }}</Button>
      </Card>

      <Card v-else-if="!items.length" class="flex flex-col items-center gap-3 p-8 text-center">
        <CircleCheckIcon class="text-success-text size-10" />
        <div>
          <h2 class="font-medium">{{ $t('optimizations.workExpenses.empty.title') }}</h2>
          <p class="text-muted-foreground mt-1 text-sm">{{ $t('optimizations.workExpenses.empty.description') }}</p>
        </div>
        <Button variant="outline" :disabled="isSyncing" @click="handleSync">
          <RefreshCwIcon class="size-4" />
          {{ $t('optimizations.workExpenses.actions.syncNow') }}
        </Button>
      </Card>

      <div v-else class="flex flex-col gap-4">
        <Card v-for="item in items" :key="item.expense.id" class="p-5">
          <div class="mb-4 flex items-start gap-3">
            <Checkbox
              v-if="exactMatchByExpenseId.has(item.expense.id)"
              class="mt-1"
              :model-value="selectedExactExpenseIds.has(item.expense.id)"
              :aria-label="$t('optimizations.workExpenses.bulk.selectExpense', { merchant: merchantName({ item }) })"
              @update:model-value="
                (value) => setExactSelected({ expenseId: item.expense.id, selected: value === true })
              "
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="truncate font-semibold">{{ merchantName({ item }) }}</h2>
                <span
                  :class="
                    cn('rounded-full px-2 py-0.5 text-xs font-medium', stateClass({ state: item.expense.matchState }))
                  "
                >
                  {{ $t(`optimizations.workExpenses.matchStates.${item.expense.matchState}`) }}
                </span>
              </div>
              <p class="text-muted-foreground mt-1 text-sm">
                {{ formatAmountByCurrencyCode(item.expense.originalAmount, item.expense.originalCurrencyCode) }}
                · {{ format(item.expense.expenseDate, 'PP') }} ·
                {{ $t('optimizations.workExpenses.report', { id: item.expense.externalReportId }) }}
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-5 @lg/work-expenses:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <section class="border-border rounded-lg border p-4">
              <h3 class="text-sm font-medium">{{ $t('optimizations.workExpenses.expenseDetails.title') }}</h3>
              <dl class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt class="text-muted-foreground">{{ $t('optimizations.workExpenses.expenseDetails.merchant') }}</dt>
                <dd class="truncate text-right">{{ merchantName({ item }) }}</dd>
                <dt class="text-muted-foreground">{{ $t('optimizations.workExpenses.expenseDetails.reportState') }}</dt>
                <dd class="text-right">{{ item.expense.reportState }}</dd>
                <dt class="text-muted-foreground">{{ $t('optimizations.workExpenses.expenseDetails.expenseId') }}</dt>
                <dd class="truncate text-right font-mono text-xs">{{ item.expense.externalExpenseId }}</dd>
                <dt v-if="item.expense.linkedTransactionId" class="text-muted-foreground">
                  {{ $t('optimizations.workExpenses.expenseDetails.linkedTransaction') }}
                </dt>
                <dd v-if="item.expense.linkedTransactionId" class="truncate text-right font-mono text-xs">
                  {{ item.expense.linkedTransactionId }}
                </dd>
              </dl>

              <div
                v-if="item.expense.reviewReasons.length"
                class="border-border bg-muted/40 mt-4 rounded-lg border p-3"
              >
                <p class="text-warning-text flex items-center gap-2 text-sm font-medium">
                  <CircleAlertIcon class="size-4" />
                  {{ $t('optimizations.workExpenses.review.title') }}
                </p>
                <ul class="text-muted-foreground mt-2 list-inside list-disc text-xs">
                  <li v-for="reason in item.expense.reviewReasons" :key="reason">
                    {{ reviewReasonLabel({ reason }) }}
                  </li>
                </ul>
              </div>
            </section>

            <section>
              <h3 class="text-sm font-medium">{{ $t('optimizations.workExpenses.candidates.title') }}</h3>
              <p v-if="!item.candidates.length" class="text-muted-foreground mt-3 text-sm">
                {{ $t('optimizations.workExpenses.candidates.empty') }}
              </p>
              <div v-else class="mt-3 flex flex-col gap-2">
                <Button
                  v-for="candidate in item.candidates"
                  :key="candidate.transactionId"
                  type="button"
                  variant="outline"
                  :aria-pressed="
                    candidateSelected({
                      expenseId: item.expense.id,
                      transactionId: candidate.transactionId,
                    })
                  "
                  :class="
                    cn(
                      'h-auto w-full justify-start px-3 py-3 text-left font-normal',
                      candidateSelected({ expenseId: item.expense.id, transactionId: candidate.transactionId }) &&
                        'border-primary bg-primary/5',
                    )
                  "
                  @click="selectCandidate({ expenseId: item.expense.id, transactionId: candidate.transactionId })"
                >
                  <span
                    :class="
                      cn(
                        'border-border mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                        candidateSelected({ expenseId: item.expense.id, transactionId: candidate.transactionId }) &&
                          'border-primary',
                      )
                    "
                  >
                    <span
                      v-if="candidateSelected({ expenseId: item.expense.id, transactionId: candidate.transactionId })"
                      class="bg-primary size-2 rounded-full"
                    />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span class="truncate font-medium">
                        {{ candidate.transaction.payeeName || candidate.transaction.note || $t('common.ui.other') }}
                      </span>
                      <span class="text-amount tabular-nums">{{ candidateAmount({ candidate }) }}</span>
                    </span>
                    <span class="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      <span>{{ candidate.transaction.accountName }}</span>
                      <span>{{ format(candidate.transaction.time, 'PP') }}</span>
                      <span>
                        {{
                          $t('optimizations.workExpenses.candidates.score', {
                            score: candidate.compositeScoreBps / 100,
                          })
                        }}
                      </span>
                      <span>
                        {{
                          $t(
                            'optimizations.workExpenses.candidates.dateDistance',
                            { count: candidate.dateDistance },
                            candidate.dateDistance,
                          )
                        }}
                      </span>
                    </span>
                  </span>
                </Button>
              </div>

              <div class="mt-4 flex flex-wrap justify-end gap-2">
                <template v-if="item.expense.matchState === EXPENSIFY_MATCH_STATES.review">
                  <Button
                    v-if="item.expense.linkedTransactionId"
                    variant="outline-success"
                    :disabled="reviewMutation.isPending.value"
                    @click="resolveReview({ item, action: 'keep' })"
                  >
                    {{ $t('optimizations.workExpenses.review.keep') }}
                  </Button>
                  <Button
                    :disabled="!selectedCandidates[item.expense.id] || reviewMutation.isPending.value"
                    @click="resolveReview({ item, action: 'relink' })"
                  >
                    {{ $t('optimizations.workExpenses.review.relink') }}
                  </Button>
                </template>
                <Button
                  v-else-if="!item.expense.linkedTransactionId"
                  :disabled="!selectedCandidates[item.expense.id] || confirmMutation.isPending.value"
                  @click="confirmCandidate({ item })"
                >
                  {{ $t('optimizations.workExpenses.actions.confirmMatch') }}
                </Button>
                <Button
                  v-if="item.expense.linkedTransactionId"
                  variant="soft-destructive"
                  :disabled="removeMutation.isPending.value"
                  @click="removeTarget = item"
                >
                  <Link2OffIcon class="size-4" />
                  {{ $t('optimizations.workExpenses.actions.removeMatch') }}
                </Button>
              </div>
            </section>
          </div>
        </Card>
      </div>

      <div v-if="total > PAGE_SIZE" class="flex items-center justify-between gap-3">
        <p class="text-muted-foreground text-sm">
          {{ $t('optimizations.workExpenses.pagination.range', { from: offset + 1, to: pageEnd, total }) }}
        </p>
        <div class="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="!canGoPrevious || reconciliationQuery.isFetching.value"
            @click="offset = Math.max(0, offset - PAGE_SIZE)"
          >
            <ChevronLeftIcon class="size-4" />
            {{ $t('common.actions.previous') }}
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="!canGoNext || reconciliationQuery.isFetching.value"
            @click="offset += PAGE_SIZE"
          >
            {{ $t('common.actions.next') }}
            <ChevronRightIcon class="size-4" />
          </Button>
        </div>
      </div>
    </template>
  </div>

  <ResponsiveAlertDialog
    :open="Boolean(removeTarget)"
    :confirm-label="$t('optimizations.workExpenses.removeMatch.confirm')"
    confirm-variant="destructive"
    :confirm-disabled="removeMutation.isPending.value"
    @update:open="(open) => !open && (removeTarget = null)"
    @confirm="confirmRemove"
  >
    <template #title>{{ $t('optimizations.workExpenses.removeMatch.title') }}</template>
    <template #description>{{ $t('optimizations.workExpenses.removeMatch.description') }}</template>
  </ResponsiveAlertDialog>
</template>
