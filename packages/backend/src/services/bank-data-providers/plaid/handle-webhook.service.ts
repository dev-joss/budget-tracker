import { DEACTIVATION_REASON } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';

import { enqueuePlaidSync } from './transaction-sync-queue';
import type { PlaidConnectionMetadata } from './types';

interface PlaidWebhookBody {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: { error_code?: string } | string | null;
  initial_update_complete?: boolean;
  historical_update_complete?: boolean;
}

export const handlePlaidWebhook = async ({ body }: { body: PlaidWebhookBody }): Promise<void> => {
  if (!body.item_id) {
    logger.info('[Plaid] Valid webhook has no Item ID', {
      webhookType: body.webhook_type,
      webhookCode: body.webhook_code,
    });
    return;
  }
  const connection = await BankDataProviderConnections.findOne({ where: { metadata: { itemId: body.item_id } } });
  if (!connection) {
    logger.info('[Plaid] Valid webhook has no matching connection', { itemId: body.item_id });
    return;
  }
  const metadata = connection.metadata as PlaidConnectionMetadata;
  const errorCode = typeof body.error === 'object' && body.error ? body.error.error_code : body.error;

  if (errorCode === 'ITEM_LOGIN_REQUIRED') {
    connection.isActive = false;
    connection.metadata = { ...metadata, deactivationReason: DEACTIVATION_REASON.AUTH_FAILURE };
    await connection.save();
    return;
  }
  if (body.webhook_code === 'PENDING_DISCONNECT' || body.webhook_code === 'PENDING_EXPIRATION') {
    connection.metadata = {
      ...metadata,
      repairWarning: body.webhook_code === 'PENDING_DISCONNECT' ? 'pending_disconnect' : 'pending_expiration',
    };
    await connection.save();
    return;
  }
  if (body.webhook_code === 'SYNC_UPDATES_AVAILABLE') {
    const accounts = await Accounts.findAll({ where: { bankDataProviderConnectionId: connection.id } });
    await enqueuePlaidSync({
      connectionId: connection.id,
      userId: connection.userId,
      systemAccountIds: accounts.map((account) => account.id),
    });
    return;
  }
  if (body.initial_update_complete || body.historical_update_complete) {
    connection.metadata = {
      ...metadata,
      initialUpdateComplete: body.initial_update_complete ?? metadata.initialUpdateComplete,
      historicalUpdateComplete: body.historical_update_complete ?? metadata.historicalUpdateComplete,
    };
    await connection.save();
  }
  logger.info('[Plaid] Valid webhook acknowledged', { webhookType: body.webhook_type, webhookCode: body.webhook_code });
};
