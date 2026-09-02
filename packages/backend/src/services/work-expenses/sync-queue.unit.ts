import type { RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import type { WorkExpenseSynchronizationJobData } from './sync-queue';

describe('work-expense synchronization job payload', () => {
  it('contains only safe identifiers', () => {
    const payload: WorkExpenseSynchronizationJobData = {
      userId: 42,
      connectionId: '01991963-d3bc-7d12-80a8-43adbeb57d64' as RecordId,
      credentialRevision: 3,
      synchronizationRunId: '01991963-d3bc-7d12-80a8-43adbeb57d65' as RecordId,
    };
    expect(Object.keys(payload).toSorted()).toEqual([
      'connectionId',
      'credentialRevision',
      'synchronizationRunId',
      'userId',
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/partnerUser|partnerUserSecret|encryptedCredentials/i);
  });
});
