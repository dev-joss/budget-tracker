import { createController } from '@controllers/helpers/controller-factory';
import { createPlaidLinkToken } from '@services/bank-data-providers/plaid/create-link-token.service';
import { z } from 'zod';

export default createController(z.object({}), async ({ user }) => ({
  data: await createPlaidLinkToken({ userId: user.id }),
}));
