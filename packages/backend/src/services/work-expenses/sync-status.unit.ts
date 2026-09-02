import type { RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import {
  parseSynchronizationStatus,
  parseSynchronizationStatusEnvelope,
  synchronizationStatusBelongsToConnection,
} from './sync-status.service';

const envelope = {
  connectionId: '01991963-d3bc-7d12-80a8-43adbeb57d64',
  credentialRevision: 3,
  status: {
    status: 'processing',
    runId: '01991963-d3bc-7d12-80a8-43adbeb57d65',
    processedCount: 0,
    importedCount: 0,
    matchedCount: 0,
    reviewCount: 0,
  },
};

describe('work-expense synchronization status envelope', () => {
  it('returns only the public status payload', () => {
    expect(parseSynchronizationStatus({ raw: JSON.stringify(envelope) })).toEqual(envelope.status);
  });

  it('requires ownership metadata for persisted status', () => {
    expect(parseSynchronizationStatusEnvelope({ raw: JSON.stringify(envelope) })).toEqual(envelope);
    expect(parseSynchronizationStatusEnvelope({ raw: JSON.stringify(envelope.status) })).toBeNull();
  });

  it('rejects a status after a replacement run takes ownership', () => {
    const parsed = parseSynchronizationStatusEnvelope({ raw: JSON.stringify(envelope) });
    expect(parsed).not.toBeNull();
    expect(
      synchronizationStatusBelongsToConnection({
        envelope: parsed!,
        connection: {
          activeSynchronizationRunId: '01991963-d3bc-7d12-80a8-43adbeb57d66' as RecordId,
        },
      }),
    ).toBe(false);
    expect(synchronizationStatusBelongsToConnection({ envelope: parsed!, connection: null })).toBe(false);
  });

  it('requires active ownership for a non-terminal status', () => {
    const parsed = parseSynchronizationStatusEnvelope({ raw: JSON.stringify(envelope) });
    expect(parsed).not.toBeNull();
    expect(
      synchronizationStatusBelongsToConnection({
        envelope: parsed!,
        connection: { activeSynchronizationRunId: null },
      }),
    ).toBe(false);

    expect(
      synchronizationStatusBelongsToConnection({
        envelope: { ...parsed!, status: { ...parsed!.status, status: 'completed' } },
        connection: { activeSynchronizationRunId: null },
      }),
    ).toBe(true);
  });

  it('treats malformed state as idle', () => {
    expect(parseSynchronizationStatus({ raw: '{not-json' })).toEqual({ status: 'idle' });
    expect(parseSynchronizationStatusEnvelope({ raw: '{not-json' })).toBeNull();
  });
});
