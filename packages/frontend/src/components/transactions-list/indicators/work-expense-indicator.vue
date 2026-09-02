<script setup lang="ts">
import ResponsiveTooltip from '@/components/common/responsive-tooltip.vue';
import { cn } from '@/lib/utils';
import type { TransactionModel } from '@bt/shared/types';
import { BriefcaseBusinessIcon, CircleAlertIcon } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = withDefaults(
  defineProps<{
    transaction: TransactionModel;
    compact?: boolean;
  }>(),
  { compact: true },
);

const { t } = useI18n();
const hasReview = computed(() => Boolean(props.transaction.workExpenseReviewReasons?.length));
const sourceLabel = computed(() =>
  props.transaction.workExpenseSource
    ? t(`transactions.workExpense.sources.${props.transaction.workExpenseSource}`)
    : t('transactions.workExpense.sources.unknown'),
);
const label = computed(() =>
  hasReview.value
    ? t('transactions.workExpense.indicatorWithReview', { source: sourceLabel.value })
    : t('transactions.workExpense.indicator', { source: sourceLabel.value }),
);
</script>

<template>
  <ResponsiveTooltip v-if="transaction.isWorkExpense" :content="label" :delay-duration="100">
    <span
      :class="
        cn(
          'inline-flex shrink-0 items-center rounded-full',
          hasReview ? 'bg-muted text-warning-text' : 'bg-primary/10 text-primary-text',
          compact ? 'size-5 justify-center' : 'gap-1.5 px-2 py-1 text-xs font-medium',
        )
      "
      :aria-label="label"
    >
      <CircleAlertIcon v-if="hasReview" class="size-3.5" />
      <BriefcaseBusinessIcon v-else class="size-3.5" />
      <span v-if="!compact">{{ label }}</span>
    </span>
  </ResponsiveTooltip>
</template>
