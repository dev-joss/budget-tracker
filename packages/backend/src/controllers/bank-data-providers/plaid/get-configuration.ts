import { createController } from '@controllers/helpers/controller-factory';
import { getPlaidConfiguration } from '@services/bank-data-providers/plaid/config';
import { z } from 'zod';

export default createController(z.object({}), async () => ({
  data: { configuration: await getPlaidConfiguration() },
}));
