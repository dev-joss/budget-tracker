<script setup lang="ts">
import ResponsiveAlertDialog from '@/components/common/responsive-alert-dialog.vue';
import DateField from '@/components/fields/date-field.vue';
import InputField from '@/components/fields/input-field.vue';
import { Button } from '@/components/lib/ui/button';
import { Card, CardContent, CardHeader } from '@/components/lib/ui/card';
import { useWorkExpenseIntegration } from '@/composable/data-queries/work-expenses';
import { useDateLocale } from '@/composable/use-date-locale';
import { ROUTES_NAMES } from '@/routes';
import { EXPENSIFY_DEFAULT_HISTORY_MONTHS } from '@bt/shared/types';
import { BriefcaseBusinessIcon, CircleAlertIcon, CircleCheckIcon, RefreshCwIcon, UnplugIcon } from '@lucide/vue';
import { formatISO, subMonths } from 'date-fns';
import { computed, ref } from 'vue';

const {
  integration,
  syncStatus,
  isLoading,
  isError,
  refetch,
  connect,
  isConnecting,
  disconnect,
  isDisconnecting,
  sync,
  isStartingSync,
  isSyncing,
} = useWorkExpenseIntegration();
const { format } = useDateLocale();

const partnerUserId = ref('');
const partnerUserSecret = ref('');
const initialSyncDate = ref(subMonths(new Date(), EXPENSIFY_DEFAULT_HISTORY_MONTHS));
const isDisconnectOpen = ref(false);

const isConnectDisabled = computed(() => !partnerUserId.value.trim() || !partnerUserSecret.value || isConnecting.value);
const syncButtonLoading = computed(() => isStartingSync.value || isSyncing.value);

const formatTimestamp = ({ value }: { value: string | null | undefined }) => (value ? format(value, 'PPp') : '—');

const handleConnect = async () => {
  if (isConnectDisabled.value) return;
  const secret = partnerUserSecret.value;
  partnerUserSecret.value = '';
  try {
    await connect({
      partnerUserId: partnerUserId.value.trim(),
      partnerUserSecret: secret,
      initialSyncDate: formatISO(initialSyncDate.value, { representation: 'date' }),
    });
  } catch {
    // The mutation renders the API error as a notification.
  }
};

const handleDisconnect = async () => {
  try {
    await disconnect(undefined);
    isDisconnectOpen.value = false;
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
</script>

<template>
  <Card class="@container/work-expense-settings max-w-4xl">
    <CardHeader class="border-b">
      <div class="flex items-start gap-3">
        <div class="bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-lg">
          <BriefcaseBusinessIcon class="text-primary-text size-5" />
        </div>
        <div>
          <h2 class="text-2xl font-semibold">{{ $t('settings.workExpenses.title') }}</h2>
          <p class="text-muted-foreground mt-1 text-sm">{{ $t('settings.workExpenses.description') }}</p>
        </div>
      </div>
    </CardHeader>

    <CardContent class="mt-6">
      <div v-if="isLoading" class="flex flex-col gap-4" aria-busy="true">
        <div class="bg-muted h-5 w-40 animate-pulse rounded" />
        <div class="bg-muted h-9 w-full max-w-lg animate-pulse rounded" />
        <div class="bg-muted h-9 w-full max-w-lg animate-pulse rounded" />
        <div class="bg-muted h-9 w-32 animate-pulse rounded" />
      </div>

      <div v-else-if="isError" class="flex flex-col items-center gap-3 py-10 text-center">
        <CircleAlertIcon class="text-destructive-text size-10" />
        <div>
          <h3 class="font-medium">{{ $t('settings.workExpenses.loadError.title') }}</h3>
          <p class="text-muted-foreground mt-1 text-sm">{{ $t('settings.workExpenses.loadError.description') }}</p>
        </div>
        <Button variant="outline" @click="refetch()">{{ $t('common.actions.retry') }}</Button>
      </div>

      <form v-else-if="!integration?.connected" class="flex max-w-xl flex-col gap-5" @submit.prevent="handleConnect">
        <div>
          <h3 class="font-medium">{{ $t('settings.workExpenses.disconnected.title') }}</h3>
          <p class="text-muted-foreground mt-1 text-sm">
            {{ $t('settings.workExpenses.disconnected.description') }}
          </p>
        </div>

        <InputField
          v-model="partnerUserId"
          :label="$t('settings.workExpenses.form.partnerUserId.label')"
          :placeholder="$t('settings.workExpenses.form.partnerUserId.placeholder')"
          :disabled="isConnecting"
        />
        <InputField
          v-model="partnerUserSecret"
          type="password"
          :label="$t('settings.workExpenses.form.partnerUserSecret.label')"
          :placeholder="$t('settings.workExpenses.form.partnerUserSecret.placeholder')"
          :disabled="isConnecting"
        />
        <DateField
          v-model="initialSyncDate"
          :label="$t('settings.workExpenses.form.initialSyncDate.label')"
          :disabled="isConnecting"
          :calendar-options="{ maxDate: new Date() }"
        />
        <p class="text-muted-foreground -mt-3 text-xs">
          {{ $t('settings.workExpenses.form.initialSyncDate.hint') }}
        </p>

        <Button type="submit" class="self-start" :disabled="isConnectDisabled" :loading="isConnecting">
          {{ $t('settings.workExpenses.actions.connect') }}
        </Button>
      </form>

      <div v-else class="flex flex-col gap-6">
        <div class="border-border bg-success/10 flex items-start gap-3 rounded-lg border p-4">
          <CircleCheckIcon class="text-success-text mt-0.5 size-5 shrink-0" />
          <div>
            <h3 class="font-medium">{{ $t('settings.workExpenses.connected.title') }}</h3>
            <p class="text-muted-foreground mt-1 text-sm">
              {{ $t('settings.workExpenses.connected.description') }}
            </p>
          </div>
        </div>

        <dl class="grid grid-cols-1 gap-4 @sm/work-expense-settings:grid-cols-2">
          <div class="border-border rounded-lg border p-4">
            <dt class="text-muted-foreground text-xs">{{ $t('settings.workExpenses.status.initialSyncDate') }}</dt>
            <dd class="mt-1 text-sm font-medium">{{ integration.initialSyncDate || '—' }}</dd>
          </div>
          <div class="border-border rounded-lg border p-4">
            <dt class="text-muted-foreground text-xs">{{ $t('settings.workExpenses.status.lastSuccessfulSync') }}</dt>
            <dd class="mt-1 text-sm font-medium">
              {{ formatTimestamp({ value: integration.lastSuccessfulSyncAt }) }}
            </dd>
          </div>
          <div class="border-border rounded-lg border p-4">
            <dt class="text-muted-foreground text-xs">{{ $t('settings.workExpenses.status.lastAttemptedSync') }}</dt>
            <dd class="mt-1 text-sm font-medium">
              {{ formatTimestamp({ value: integration.lastAttemptedSyncAt }) }}
            </dd>
          </div>
          <div class="border-border rounded-lg border p-4">
            <dt class="text-muted-foreground text-xs">{{ $t('settings.workExpenses.status.syncState') }}</dt>
            <dd class="mt-1 text-sm font-medium">
              {{ $t(`settings.workExpenses.syncStates.${syncStatus?.status ?? 'idle'}`) }}
            </dd>
          </div>
        </dl>

        <div
          v-if="integration.lastErrorCode || syncStatus?.errorCode"
          class="border-destructive/40 bg-destructive/10 flex items-start gap-3 rounded-lg border p-4"
        >
          <CircleAlertIcon class="text-destructive-text mt-0.5 size-5 shrink-0" />
          <div>
            <h3 class="font-medium">{{ $t('settings.workExpenses.safeError.title') }}</h3>
            <p class="text-muted-foreground mt-1 text-sm">
              {{ $t(`settings.workExpenses.errors.${syncStatus?.errorCode ?? integration.lastErrorCode}`) }}
            </p>
          </div>
        </div>

        <div v-if="syncStatus && syncStatus.status !== 'idle'" class="border-border rounded-lg border p-4">
          <p class="mb-3 text-sm font-medium">{{ $t('settings.workExpenses.syncProgress.title') }}</p>
          <div class="grid grid-cols-2 gap-3 text-sm @sm/work-expense-settings:grid-cols-4">
            <div>
              <p class="text-muted-foreground text-xs">{{ $t('settings.workExpenses.syncProgress.processed') }}</p>
              <p class="font-medium tabular-nums">{{ syncStatus.processedCount ?? 0 }}</p>
            </div>
            <div>
              <p class="text-muted-foreground text-xs">{{ $t('settings.workExpenses.syncProgress.imported') }}</p>
              <p class="font-medium tabular-nums">{{ syncStatus.importedCount ?? 0 }}</p>
            </div>
            <div>
              <p class="text-muted-foreground text-xs">{{ $t('settings.workExpenses.syncProgress.matched') }}</p>
              <p class="font-medium tabular-nums">{{ syncStatus.matchedCount ?? 0 }}</p>
            </div>
            <div>
              <p class="text-muted-foreground text-xs">{{ $t('settings.workExpenses.syncProgress.review') }}</p>
              <p class="font-medium tabular-nums">{{ syncStatus.reviewCount ?? 0 }}</p>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          <Button :disabled="syncButtonLoading" :loading="syncButtonLoading" @click="handleSync">
            <RefreshCwIcon class="size-4" />
            {{ $t('settings.workExpenses.actions.syncNow') }}
          </Button>
          <Button variant="outline" as-child>
            <RouterLink :to="{ name: ROUTES_NAMES.optimizationsWorkExpenses }">
              <BriefcaseBusinessIcon class="size-4" />
              {{ $t('settings.workExpenses.actions.reviewMatches') }}
            </RouterLink>
          </Button>
          <Button variant="soft-destructive" class="@sm/work-expense-settings:ml-auto" @click="isDisconnectOpen = true">
            <UnplugIcon class="size-4" />
            {{ $t('settings.workExpenses.actions.disconnect') }}
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>

  <ResponsiveAlertDialog
    v-model:open="isDisconnectOpen"
    :confirm-label="$t('settings.workExpenses.disconnect.confirm')"
    confirm-variant="destructive"
    :confirm-disabled="isDisconnecting"
    @confirm="handleDisconnect"
  >
    <template #title>{{ $t('settings.workExpenses.disconnect.title') }}</template>
    <template #description>{{ $t('settings.workExpenses.disconnect.description') }}</template>
  </ResponsiveAlertDialog>
</template>
