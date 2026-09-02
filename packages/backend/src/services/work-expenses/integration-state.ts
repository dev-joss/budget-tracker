import type { ExpensifyIntegrationState, ExpensifySafeErrorCode } from '@bt/shared/types';
import type ExpensifyConnections from '@models/expensify-connections.model';

const isoOrNull = ({ value }: { value: Date | null }): string | null => value?.toISOString() ?? null;

export function serializeIntegrationState({
  connection,
}: {
  connection: ExpensifyConnections | null;
}): ExpensifyIntegrationState {
  return {
    connected: Boolean(connection?.encryptedCredentials),
    initialSyncDate: connection?.initialSyncDate ?? null,
    lastAttemptedSyncAt: isoOrNull({ value: connection?.lastAttemptedSyncAt ?? null }),
    lastSuccessfulSyncAt: isoOrNull({ value: connection?.lastSuccessfulSyncAt ?? null }),
    lastErrorCode: (connection?.lastErrorCode as ExpensifySafeErrorCode | null | undefined) ?? null,
  };
}
