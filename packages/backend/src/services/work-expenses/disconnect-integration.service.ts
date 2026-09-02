import ExpensifyConnections from '@models/expensify-connections.model';
import { withTransaction } from '@services/common/with-transaction';

import { serializeIntegrationState } from './integration-state';

const disconnectStoredIntegration = withTransaction(async ({ userId }: { userId: number }) => {
  const connection = await ExpensifyConnections.unscoped().findOne({ where: { userId }, lock: true });
  if (!connection) return { state: serializeIntegrationState({ connection: null }), previousSynchronization: null };
  const previousSynchronization = {
    scope: { connectionId: connection.id, credentialRevision: connection.credentialRevision },
    synchronizationRunId: connection.activeSynchronizationRunId,
  };
  await connection.update({
    encryptedCredentials: null,
    credentialRevision: connection.credentialRevision + 1,
    activeSynchronizationRunId: null,
    lastErrorCode: null,
  });
  return { state: serializeIntegrationState({ connection }), previousSynchronization };
});

export async function disconnectIntegration({ userId }: { userId: number }) {
  const { state, previousSynchronization } = await disconnectStoredIntegration({ userId });
  if (!previousSynchronization) return state;

  const { cancelSynchronization } = await import('./sync-queue');
  await cancelSynchronization({ userId, ...previousSynchronization });
  return state;
}
