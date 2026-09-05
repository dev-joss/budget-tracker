<template>
  <div class="flex min-h-screen items-center justify-center px-4 text-center">
    <div class="space-y-3">
      <Loader2Icon v-if="!errorMessage" class="mx-auto size-10 animate-spin" />
      <TriangleAlertIcon v-else class="text-destructive-text mx-auto size-10" />
      <p>{{ errorMessage || t('pages.plaidCallback.processing.description') }}</p>
      <UiButton v-if="errorMessage" @click="router.push({ name: ROUTES_NAMES.accounts })">
        {{ t('pages.plaidCallback.error.backToAccounts') }}
      </UiButton>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { completePlaidUpdate, connectProvider } from '@/api/bank-data-providers';
import UiButton from '@/components/lib/ui/button/Button.vue';
import { createPlaidLink, loadPlaidLink, type PlaidLinkHandler } from '@/lib/plaid-link';
import { ROUTES_NAMES } from '@/routes/constants';
import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { Loader2Icon, TriangleAlertIcon } from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

interface StoredFlow {
  type: 'connect' | 'update';
  linkToken: string;
  connectionId?: string;
}

const router = useRouter();
const { t } = useI18n();
const errorMessage = ref('');
let handler: PlaidLinkHandler | null = null;

onMounted(async () => {
  try {
    const rawFlow = sessionStorage.getItem('plaidLinkFlow');
    if (!rawFlow) throw new Error(t('pages.plaidCallback.error.description'));
    const flow = JSON.parse(rawFlow) as StoredFlow;
    await loadPlaidLink();
    handler = createPlaidLink({
      token: flow.linkToken,
      receivedRedirectUri: window.location.href,
      onSuccess: (publicToken, metadata) => {
        const request =
          flow.type === 'update' && flow.connectionId
            ? completePlaidUpdate({ connectionId: flow.connectionId }).then(() => flow.connectionId!)
            : connectProvider({
                providerType: BANK_PROVIDER_TYPE.PLAID,
                credentials: { publicToken, linkMetadata: metadata },
              }).then((response) => response.connectionId);
        void request
          .then((connectionId) => {
            sessionStorage.removeItem('plaidLinkFlow');
            return router.replace({ name: ROUTES_NAMES.accountIntegrationDetails, params: { connectionId } });
          })
          .catch(showError);
      },
      onExit: showError,
    });
    handler.open();
  } catch (error) {
    showError(error);
  }
});

const showError = (error: unknown) => {
  errorMessage.value =
    (error as { display_message?: string })?.display_message ||
    (error instanceof Error ? error.message : t('pages.plaidCallback.error.description'));
};

onBeforeUnmount(() => handler?.destroy());
</script>
