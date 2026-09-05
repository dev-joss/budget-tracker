import { type AIFeatureStatus, type PayeeExtractionScope, type PayeeExtractionStatus } from '@bt/shared/types';

export function isExtractionActive({ status }: { status?: PayeeExtractionStatus['status'] }): boolean {
  return status === 'queued' || status === 'processing';
}

export function buildExtractionScope({
  accountIds,
  selectedIds,
  allInScope,
}: {
  accountIds: string[];
  selectedIds: string[];
  allInScope: boolean;
}): PayeeExtractionScope | null {
  if (!accountIds.length || (!allInScope && !selectedIds.length)) return null;
  return { accountIds: [...accountIds], ...(allInScope ? {} : { transactionIds: [...selectedIds] }) };
}

export function canProcessExtraction({
  aiEnabled,
  descriptionsEnabled,
  hasDestination,
  hasScope,
  active,
  statusReady,
}: {
  aiEnabled: boolean;
  descriptionsEnabled: boolean;
  hasDestination: boolean;
  hasScope: boolean;
  active: boolean;
  statusReady: boolean;
}): boolean {
  return aiEnabled && descriptionsEnabled && hasDestination && hasScope && !active && statusReady;
}

/** A display model name alone does not establish credential availability. */
export function hasExtractionDestination({ feature }: { feature?: AIFeatureStatus }): boolean {
  return !!feature?.modelId && feature.isAvailable === true;
}
