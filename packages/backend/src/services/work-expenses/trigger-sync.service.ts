import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import ExpensifyConnections from '@models/expensify-connections.model';

import { enqueueSynchronization } from './sync-queue';

export async function triggerSynchronization({ userId }: { userId: number }) {
  const connection = await ExpensifyConnections.unscoped().findOne({
    where: { userId },
    attributes: ['id', 'credentialRevision', 'encryptedCredentials'],
  });
  if (!connection?.encryptedCredentials) {
    throw new ValidationError({ message: t({ key: 'workExpenses.integrationDisconnected' }) });
  }
  return enqueueSynchronization({
    userId,
    scope: { connectionId: connection.id, credentialRevision: connection.credentialRevision },
  });
}
