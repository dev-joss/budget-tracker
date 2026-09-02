import { EXPENSIFY_SAFE_ERROR_CODES } from '@bt/shared/types';
import ExpensifyConnections from '@models/expensify-connections.model';
import ExpensifyExpenses from '@models/expensify-expenses.model';
import { addDays, format, parseISO } from 'date-fns';
import { Op } from 'sequelize';

import { ExpensifyClientError, exportExpensifyExpenses, type ExpensifyUpstreamExpense } from './expensify/client';
import { decryptExpensifyCredentials } from './expensify/credentials';
import { importExpensifySnapshot, type ImportSnapshotResult } from './import-snapshot.service';
import type { SynchronizationOwner } from './sync-status.service';

const REPORT_REFRESH_CHUNK_SIZE = 50;

interface DateWindow {
  startDate: string;
  endDate: string;
}

export function splitDiscoveryWindows({ startDate, endDate }: { startDate: string; endDate: string }): DateWindow[] {
  const windows: DateWindow[] = [];
  let cursor = parseISO(startDate);
  const last = parseISO(endDate);
  while (cursor <= last) {
    const inclusiveEnd = new Date(Math.min(addDays(cursor, 364).getTime(), last.getTime()));
    windows.push({ startDate: format(cursor, 'yyyy-MM-dd'), endDate: format(inclusiveEnd, 'yyyy-MM-dd') });
    cursor = addDays(inclusiveEnd, 1);
  }
  return windows;
}

function synchronizationOwnerWhere({ userId, owner }: { userId: number; owner: SynchronizationOwner }) {
  return {
    id: owner.connectionId,
    userId,
    credentialRevision: owner.credentialRevision,
    activeSynchronizationRunId: owner.synchronizationRunId,
    encryptedCredentials: { [Op.not]: null },
  };
}

async function assertSynchronizationOwnership({
  userId,
  owner,
}: {
  userId: number;
  owner: SynchronizationOwner;
}): Promise<void> {
  const current = await ExpensifyConnections.unscoped().findOne({
    where: synchronizationOwnerWhere({ userId, owner }),
    attributes: ['id'],
  });
  if (!current) {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.credentialsChanged });
  }
}

function chunks<T>({ values, size }: { values: T[]; size: number }): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function performSynchronization({
  userId,
  owner,
  onPhase,
}: {
  userId: number;
  owner: SynchronizationOwner;
  onPhase?: () => Promise<void>;
}): Promise<ImportSnapshotResult> {
  const connection = await ExpensifyConnections.unscoped().findOne({
    where: synchronizationOwnerWhere({ userId, owner }),
  });
  if (!connection?.encryptedCredentials) {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.credentialsChanged });
  }
  const credentials = decryptExpensifyCredentials({ encrypted: connection.encryptedCredentials });
  const [attemptRecorded] = await ExpensifyConnections.update(
    { lastAttemptedSyncAt: new Date(), lastErrorCode: null },
    { where: synchronizationOwnerWhere({ userId, owner }) },
  );
  if (attemptRecorded === 0) {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.credentialsChanged });
  }

  const today = format(new Date(), 'yyyy-MM-dd');
  const windows = splitDiscoveryWindows({ startDate: connection.initialSyncDate, endDate: today });
  const fetched: ExpensifyUpstreamExpense[] = [];

  for (const window of windows) {
    await assertSynchronizationOwnership({ userId, owner });
    await onPhase?.();
    fetched.push(
      ...(await exportExpensifyExpenses({
        connectionKey: connection.id,
        credentials,
        ...window,
        eligibleStatesOnly: true,
      })),
    );
  }

  const knownReports = await ExpensifyExpenses.findAll({
    where: { userId },
    attributes: ['externalReportId'],
    order: [['externalReportId', 'ASC']],
    raw: true,
  });
  const knownReportIds = [...new Set(knownReports.map(({ externalReportId }) => externalReportId))];
  for (const reportIds of chunks({
    values: knownReportIds,
    size: REPORT_REFRESH_CHUNK_SIZE,
  })) {
    await assertSynchronizationOwnership({ userId, owner });
    await onPhase?.();
    fetched.push(
      ...(await exportExpensifyExpenses({
        connectionKey: connection.id,
        credentials,
        reportIds,
        eligibleStatesOnly: false,
      })),
    );
  }

  await assertSynchronizationOwnership({ userId, owner });
  await onPhase?.();
  return importExpensifySnapshot({
    userId,
    owner,
    expenses: fetched,
  });
}
