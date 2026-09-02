import { API_ERROR_CODES, EXPENSIFY_SAFE_ERROR_CODES } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ServiceUnavailableError, TooManyRequests, Unauthorized } from '@js/errors';
import ExpensifyConnections from '@models/expensify-connections.model';
import { withTransaction } from '@services/common/with-transaction';
import { format, subDays, subMonths } from 'date-fns';

import { ExpensifyClientError, exportExpensifyExpenses, type ExpensifyCredentials } from './expensify/client';
import { encryptExpensifyCredentials } from './expensify/credentials';
import { serializeIntegrationState } from './integration-state';

const defaultInitialSyncDate = (): string => format(subMonths(new Date(), 12), 'yyyy-MM-dd');

function throwHttpClientError({ error }: { error: ExpensifyClientError }): never {
  if (error.code === EXPENSIFY_SAFE_ERROR_CODES.authentication) {
    throw new Unauthorized({
      code: API_ERROR_CODES.invalidCredentials,
      message: t({ key: 'workExpenses.invalidCredentials' }),
    });
  }
  if (error.code === EXPENSIFY_SAFE_ERROR_CODES.rateLimited) {
    throw new TooManyRequests({ message: t({ key: 'workExpenses.rateLimited' }) });
  }
  throw new ServiceUnavailableError({ message: t({ key: 'workExpenses.integrationUnavailable' }) });
}

const storeIntegration = withTransaction(
  async ({
    userId,
    credentials,
    initialSyncDate,
  }: {
    userId: number;
    credentials: ExpensifyCredentials;
    initialSyncDate?: string;
  }) => {
    const existing = await ExpensifyConnections.unscoped().findOne({ where: { userId }, lock: true });
    const encryptedCredentials = encryptExpensifyCredentials({ credentials });
    if (existing) {
      const previousSynchronization = {
        scope: { connectionId: existing.id, credentialRevision: existing.credentialRevision },
        synchronizationRunId: existing.activeSynchronizationRunId,
      };
      await existing.update({
        encryptedCredentials,
        initialSyncDate: initialSyncDate ?? existing.initialSyncDate,
        credentialRevision: existing.credentialRevision + 1,
        activeSynchronizationRunId: null,
        lastErrorCode: null,
      });
      return { state: serializeIntegrationState({ connection: existing }), previousSynchronization };
    }

    const connection = await ExpensifyConnections.create({
      userId,
      encryptedCredentials,
      initialSyncDate: initialSyncDate ?? defaultInitialSyncDate(),
      credentialRevision: 1,
    });
    return { state: serializeIntegrationState({ connection }), previousSynchronization: null };
  },
);

export async function updateIntegration({
  userId,
  partnerUserId,
  partnerUserSecret,
  initialSyncDate,
}: {
  userId: number;
  partnerUserId: string;
  partnerUserSecret: string;
  initialSyncDate?: string;
}) {
  const credentials = {
    partnerUserId: partnerUserId.trim(),
    partnerUserSecret: partnerUserSecret.trim(),
  };
  const today = new Date();
  try {
    await exportExpensifyExpenses({
      connectionKey: `validation-${userId}`,
      credentials,
      startDate: format(subDays(today, 7), 'yyyy-MM-dd'),
      endDate: format(today, 'yyyy-MM-dd'),
    });
  } catch (error) {
    if (error instanceof ExpensifyClientError) throwHttpClientError({ error });
    throw error;
  }

  const { state, previousSynchronization } = await storeIntegration({ userId, credentials, initialSyncDate });
  if (previousSynchronization) {
    const { cancelSynchronization } = await import('./sync-queue');
    await cancelSynchronization({ userId, ...previousSynchronization });
  }
  return state;
}
