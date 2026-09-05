<script setup lang="ts">
import { useFeatureModels } from '@/composable/data-queries/use-feature-models';
import { AI_FEATURE, type AIFeatureStatus } from '@bt/shared/types';
import ModelSelectorCard from '../shared/model-selector-card.vue';
defineProps<{ featureStatus: AIFeatureStatus }>();
const { availableModels, groupedModels, isLoading } = useFeatureModels(AI_FEATURE.payeeExtraction);
</script>
<template>
  <div v-if="isLoading" class="bg-muted h-32 w-full animate-pulse rounded-lg" />
  <ModelSelectorCard
    v-else
    :feature-status="featureStatus"
    :grouped-models="groupedModels"
    :available-models="availableModels"
    :tokens-per-transaction="{ input: 100, output: 50 }"
  />
</template>
