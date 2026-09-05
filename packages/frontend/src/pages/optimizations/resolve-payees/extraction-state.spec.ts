import { AI_FEATURE } from '@bt/shared/types';
import { describe, expect, it } from 'vitest';

import {
  buildExtractionScope,
  canProcessExtraction,
  hasExtractionDestination,
  isExtractionActive,
} from './extraction-state';

describe('payee extraction scope', () => {
  it('requires explicit accounts and a nonempty selection unless all rows are selected', () => {
    expect(buildExtractionScope({ accountIds: [], selectedIds: ['tx'], allInScope: false })).toBeNull();
    expect(buildExtractionScope({ accountIds: ['account'], selectedIds: [], allInScope: false })).toBeNull();
    expect(buildExtractionScope({ accountIds: ['account'], selectedIds: ['tx'], allInScope: false })).toEqual({
      accountIds: ['account'],
      transactionIds: ['tx'],
    });
    expect(buildExtractionScope({ accountIds: ['account'], selectedIds: ['tx'], allInScope: true })).toEqual({
      accountIds: ['account'],
    });
  });
});
describe('payee extraction start state', () => {
  const ready = {
    aiEnabled: true,
    descriptionsEnabled: true,
    hasDestination: true,
    hasScope: true,
    active: false,
    statusReady: true,
  };
  it('requires both consents, a destination, a scope and current status', () => {
    expect(canProcessExtraction(ready)).toBe(true);
    for (const flag of ['aiEnabled', 'descriptionsEnabled', 'hasDestination', 'hasScope', 'statusReady'] as const) {
      expect(canProcessExtraction({ ...ready, [flag]: false })).toBe(false);
    }
    expect(canProcessExtraction({ ...ready, active: true })).toBe(false);
  });
  it('blocks queued and running extraction after reload but permits retry of terminal runs', () => {
    expect(isExtractionActive({ status: 'queued' })).toBe(true);
    expect(isExtractionActive({ status: 'processing' })).toBe(true);
    expect(isExtractionActive({ status: 'completed' })).toBe(false);
    expect(isExtractionActive({ status: 'failed' })).toBe(false);
    expect(isExtractionActive({})).toBe(false);
  });
});

describe('payee extraction destination', () => {
  const feature = {
    feature: AI_FEATURE.payeeExtraction,
    modelId: 'custom/local',
    modelName: 'Local',
    isConfigured: true,
    usingUserKey: true,
    customEndpointId: 'endpoint',
  };
  it('requires runtime availability rather than a configured model name', () => {
    expect(hasExtractionDestination({})).toBe(false);
    expect(hasExtractionDestination({ feature })).toBe(false);
    expect(hasExtractionDestination({ feature: { ...feature, isAvailable: false } })).toBe(false);
    expect(hasExtractionDestination({ feature: { ...feature, isAvailable: true } })).toBe(true);
  });
});
