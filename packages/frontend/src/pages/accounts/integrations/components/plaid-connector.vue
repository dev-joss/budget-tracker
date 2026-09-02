<template>
  <div class="space-y-4">
    <Callout v-if="errorMessage" variant="destructive">{{ errorMessage }}</Callout>

    <template v-if="!connectionId">
      <p class="text-muted-foreground text-sm">{{ t('pages.integrations.plaid.description') }}</p>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="emit('cancel')">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton :disabled="isLoading" @click="startLink">
          <Loader2Icon v-if="isLoading" class="size-4 animate-spin" />
          {{ t('pages.integrations.plaid.connectButton') }}
        </UiButton>
      </div>
    </template>

    <template v-else>
      <AccountSelectionList
        v-model="selectedAccountIds"
        v-model:currency-overrides="currencyOverrides"
        :accounts="availableAccounts"
      />
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" @click="emit('cancel')">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton :disabled="isLoading || selectedAccountIds.length === 0" @click="importAccounts">
          <Loader2Icon v-if="isLoading" class="size-4 animate-spin" />
          {{ t('pages.integrations.plaid.importButton', selectedAccountIds.length) }}
        </UiButton>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import {
  type AvailableAccount,
  connectProvider,
  createPlaidLinkToken,
  getAvailableAccounts,
  syncSelectedAccounts,
} from '@/api/bank-data-providers';
import UiButton from '@/components/lib/ui/button/Button.vue';
import { Callout } from '@/components/lib/ui/callout';
import { useNotificationCenter } from '@/components/notification-center';
import { createPlaidLink, loadPlaidLink, type PlaidLinkHandler, type PlaidLinkMetadata } from '@/lib/plaid-link';
import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { Loader2Icon } from '@lucide/vue';
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import AccountSelectionList from './account-selection-list.vue';

const emit = defineEmits<{ connected: []; cancel: [] }>();
const { t } = useI18n();
const { addErrorNotification } = useNotificationCenter();
const isLoading = ref(false);
const errorMessage = ref<string | null>(null);
const connectionId = ref<string | null>(null);
const availableAccounts = ref<AvailableAccount[]>([]);
const selectedAccountIds = ref<string[]>([]);
const currencyOverrides = ref<Record<string, string>>({});
let handler: PlaidLinkHandler | null = null;

const connect = async (publicToken: string, metadata: PlaidLinkMetadata) => {
  const response = await connectProvider({
    providerType: BANK_PROVIDER_TYPE.PLAID,
    credentials: { publicToken, linkMetadata: metadata },
  });
  connectionId.value = response.connectionId;
  availableAccounts.value = await getAvailableAccounts(response.connectionId);
};

const startLink = async () => {
  if (isLoading.value) return;
  try {
    isLoading.value = true;
    errorMessage.value = null;
    const { linkToken } = await createPlaidLinkToken();
    sessionStorage.setItem('plaidLinkFlow', JSON.stringify({ type: 'connect', linkToken }));
    await loadPlaidLink();
    handler?.destroy();
    handler = createPlaidLink({
      token: linkToken,
      onSuccess: (publicToken, metadata) => {
        void connect(publicToken, metadata)
          .catch((error: unknown) => {
            errorMessage.value = getErrorMessage(error);
          })
          .finally(() => {
            isLoading.value = false;
          });
      },
      onExit: () => {
        isLoading.value = false;
      },
    });
    handler.open();
  } catch (error) {
    errorMessage.value = getErrorMessage(error);
    isLoading.value = false;
  }
};

const importAccounts = async () => {
  if (!connectionId.value || selectedAccountIds.value.length === 0) return;
  try {
    isLoading.value = true;
    await syncSelectedAccounts(connectionId.value, selectedAccountIds.value, currencyOverrides.value);
    emit('connected');
  } catch (error) {
    addErrorNotification(getErrorMessage(error));
  } finally {
    isLoading.value = false;
  }
};

const getErrorMessage = (error: unknown) =>
  (error as { data?: { message?: string } })?.data?.message ||
  (error instanceof Error ? error.message : t('pages.integrations.plaid.errors.connectFailed'));

onBeforeUnmount(() => handler?.destroy());
</script>
