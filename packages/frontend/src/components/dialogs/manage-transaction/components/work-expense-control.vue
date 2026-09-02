<script setup lang="ts">
import { Button } from '@/components/lib/ui/button';
import { useUpdateTransactionWorkExpense } from '@/composable/data-queries/work-expenses';
import type { ExpensifyReviewReason, TransactionModel, WorkExpenseSource } from '@bt/shared/types';
import { BriefcaseBusinessIcon, CircleAlertIcon } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  transaction: TransactionModel;
  canEdit: boolean;
}>();

const { t } = useI18n();
const mutation = useUpdateTransactionWorkExpense();
const isWorkExpense = ref(props.transaction.isWorkExpense);
const source = ref<WorkExpenseSource | null>(props.transaction.workExpenseSource);
const reviewReasons = ref<ExpensifyReviewReason[]>(props.transaction.workExpenseReviewReasons ?? []);

watch(
  () => props.transaction,
  (value) => {
    isWorkExpense.value = value.isWorkExpense;
    source.value = value.workExpenseSource;
    reviewReasons.value = value.workExpenseReviewReasons ?? [];
  },
);

const sourceLabel = computed(() =>
  source.value ? t(`transactions.workExpense.sources.${source.value}`) : t('transactions.workExpense.sources.unknown'),
);

const handleToggle = async () => {
  try {
    const updated = await mutation.mutateAsync({
      transactionId: props.transaction.id,
      isWorkExpense: !isWorkExpense.value,
    });
    isWorkExpense.value = updated.isWorkExpense;
    source.value = updated.workExpenseSource;
    reviewReasons.value = updated.workExpenseReviewReasons ?? [];
  } catch {
    // The mutation renders the API error as a notification.
  }
};
</script>

<template>
  <div class="border-border bg-muted/30 mb-5 rounded-lg border p-3">
    <div class="flex items-start gap-3">
      <div
        :class="[
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
          reviewReasons.length ? 'bg-muted text-warning-text' : 'bg-primary/10 text-primary-text',
        ]"
      >
        <CircleAlertIcon v-if="reviewReasons.length" class="size-4" />
        <BriefcaseBusinessIcon v-else class="size-4" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">
          {{
            isWorkExpense
              ? $t('transactions.workExpense.details.marked', { source: sourceLabel })
              : $t('transactions.workExpense.details.notMarked')
          }}
        </p>
        <p class="text-muted-foreground mt-0.5 text-xs">
          {{
            isWorkExpense
              ? $t('transactions.workExpense.details.markedDescription')
              : $t('transactions.workExpense.details.notMarkedDescription')
          }}
        </p>
        <div v-if="reviewReasons.length" class="text-warning-text mt-2 flex items-start gap-1.5 text-xs">
          <CircleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
          <span>{{ $t('transactions.workExpense.details.reviewWarning') }}</span>
        </div>
      </div>
      <Button
        v-if="canEdit"
        type="button"
        :variant="isWorkExpense ? 'outline' : 'soft-primary'"
        size="sm"
        :disabled="mutation.isPending.value"
        :loading="mutation.isPending.value"
        @click="handleToggle"
      >
        {{
          isWorkExpense ? $t('transactions.workExpense.actions.unmark') : $t('transactions.workExpense.actions.mark')
        }}
      </Button>
    </div>
  </div>
</template>
