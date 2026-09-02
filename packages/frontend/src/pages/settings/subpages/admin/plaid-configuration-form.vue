<template>
  <section class="border-t pt-6">
    <h3 class="mb-2 text-lg font-medium">{{ $t('settings.admin.plaid.title') }}</h3>
    <p class="text-muted-foreground mb-4 text-sm leading-relaxed">
      {{ $t('settings.admin.plaid.description') }}
    </p>

    <div v-if="configurationQuery.isLoading.value" class="space-y-3">
      <div class="bg-muted h-9 w-full animate-pulse rounded" />
      <div class="bg-muted h-9 w-full animate-pulse rounded" />
      <div class="bg-muted h-20 w-full animate-pulse rounded" />
    </div>

    <form v-else class="flex max-w-xl flex-col gap-4" @submit.prevent="saveConfiguration">
      <InputField
        v-model="form.clientId"
        :label="$t('settings.admin.plaid.clientId.label')"
        :placeholder="$t('settings.admin.plaid.clientId.placeholder')"
      />
      <InputField
        v-model="form.secret"
        type="password"
        :label="$t('settings.admin.plaid.secret.label')"
        :placeholder="
          configurationQuery.data.value?.secretConfigured
            ? $t('settings.admin.plaid.secret.configuredPlaceholder')
            : $t('settings.admin.plaid.secret.placeholder')
        "
      />
      <SelectField
        v-model="environmentSelection"
        :values="environmentOptions"
        label-key="label"
        value-key="value"
        :label="$t('settings.admin.plaid.environment.label')"
        :placeholder="$t('settings.admin.plaid.environment.placeholder')"
      />

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">{{ $t('settings.admin.plaid.countryCodes.label') }}</legend>
        <div class="flex gap-5">
          <label v-for="country in countryOptions" :key="country.value" class="flex items-center gap-2 text-sm">
            <Checkbox
              :model-value="form.countryCodes.includes(country.value)"
              @update:model-value="toggleCountry({ country: country.value, selected: !!$event })"
            />
            {{ country.label }}
          </label>
        </div>
      </fieldset>

      <InputField
        v-model="form.transactionsDaysRequested"
        type="number"
        :min-value="90"
        :label="$t('settings.admin.plaid.transactionsDays.label')"
        :placeholder="$t('settings.admin.plaid.transactionsDays.placeholder')"
      />

      <p v-if="validationError" class="text-destructive-text text-sm">{{ validationError }}</p>

      <div>
        <Button type="submit" :disabled="configurationMutation.isPending.value">
          <Loader2Icon v-if="configurationMutation.isPending.value" class="size-4 animate-spin" />
          {{
            configurationMutation.isPending.value
              ? $t('settings.admin.plaid.actions.saving')
              : $t('settings.admin.plaid.actions.save')
          }}
        </Button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import {
  getPlaidConfiguration,
  updatePlaidConfiguration,
  type PlaidConfigurationInput,
} from '@/api/bank-data-providers';
import InputField from '@/components/fields/input-field.vue';
import SelectField from '@/components/fields/select-field.vue';
import { Button } from '@/components/lib/ui/button';
import { Checkbox } from '@/components/lib/ui/checkbox';
import { NotificationType, useNotificationCenter } from '@/components/notification-center';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { Loader2Icon } from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

interface SelectOption<T extends string> {
  label: string;
  value: T;
}

const { t } = useI18n();
const { addNotification } = useNotificationCenter();
const queryClient = useQueryClient();
const validationError = ref('');
const form = reactive<PlaidConfigurationInput>({
  clientId: '',
  secret: '',
  environment: 'sandbox',
  countryCodes: ['US', 'CA'],
  transactionsDaysRequested: 180,
});

const environmentOptions = computed<Array<SelectOption<'sandbox' | 'production'>>>(() => [
  { value: 'sandbox', label: t('settings.admin.plaid.environment.sandbox') },
  { value: 'production', label: t('settings.admin.plaid.environment.production') },
]);
const countryOptions = computed<Array<SelectOption<'US' | 'CA'>>>(() => [
  { value: 'US', label: t('settings.admin.plaid.countryCodes.us') },
  { value: 'CA', label: t('settings.admin.plaid.countryCodes.ca') },
]);
const environmentSelection = computed<SelectOption<'sandbox' | 'production'> | null>({
  get: () => environmentOptions.value.find((option) => option.value === form.environment) ?? null,
  set: (option) => {
    if (option) form.environment = option.value;
  },
});

const configurationQuery = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.plaidConfiguration,
  queryFn: getPlaidConfiguration,
});

watch(
  () => configurationQuery.data.value,
  (configuration) => {
    if (!configuration) return;
    form.clientId = configuration.clientId;
    form.secret = '';
    form.environment = configuration.environment;
    form.countryCodes = [...configuration.countryCodes];
    form.transactionsDaysRequested = configuration.transactionsDaysRequested;
  },
  { immediate: true },
);

const configurationMutation = useMutation({
  mutationFn: updatePlaidConfiguration,
  onSuccess: async () => {
    form.secret = '';
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.plaidConfiguration }),
      queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.bankProviders }),
    ]);
    addNotification({
      id: 'plaid-configuration-saved',
      text: t('settings.admin.plaid.notifications.saved'),
      type: NotificationType.success,
    });
  },
});

function toggleCountry({ country, selected }: { country: string; selected: boolean }) {
  form.countryCodes = selected
    ? [...new Set([...form.countryCodes, country])]
    : form.countryCodes.filter((value) => value !== country);
}

function saveConfiguration() {
  validationError.value = '';
  if (!form.clientId.trim()) {
    validationError.value = t('settings.admin.plaid.validation.clientIdRequired');
    return;
  }
  if (!form.secret?.trim() && !configurationQuery.data.value?.secretConfigured) {
    validationError.value = t('settings.admin.plaid.validation.secretRequired');
    return;
  }
  if (form.countryCodes.length === 0) {
    validationError.value = t('settings.admin.plaid.validation.countryRequired');
    return;
  }

  configurationMutation.mutate({
    configuration: {
      ...form,
      clientId: form.clientId.trim(),
      secret: form.secret?.trim() || undefined,
    },
  });
}
</script>
