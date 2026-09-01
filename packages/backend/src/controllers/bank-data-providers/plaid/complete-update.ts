import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { PlaidProvider } from '@services/bank-data-providers/plaid';
import { bankProviderRegistry } from '@services/bank-data-providers/registry';
import { z } from 'zod';

export default createController(z.object({ body: z.object({ connectionId: recordId() }) }), async ({ user, body }) => {
  const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.PLAID) as PlaidProvider;
  await provider.completeUpdate({ connectionId: body.connectionId, userId: user.id });
  return { data: { completed: true } };
});
