import ExpensifyConnections from '@models/expensify-connections.model';

import { serializeIntegrationState } from './integration-state';

export async function getIntegration({ userId }: { userId: number }) {
  const connection = await ExpensifyConnections.unscoped().findOne({ where: { userId } });
  return serializeIntegrationState({ connection });
}
