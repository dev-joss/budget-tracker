import { createController } from '@controllers/helpers/controller-factory';
import { savePlaidConfiguration } from '@services/bank-data-providers/plaid/config';
import { CountryCode } from 'plaid';
import { z } from 'zod';

const schema = z.object({
  body: z.object({
    clientId: z.string().trim().min(1),
    secret: z.string().trim().min(1).optional(),
    environment: z.enum(['sandbox', 'production']),
    countryCodes: z.array(z.nativeEnum(CountryCode)).min(1),
    transactionsDaysRequested: z.number().int().min(90).max(730),
  }),
});

export default createController(schema, async ({ body }) => ({
  data: { configuration: await savePlaidConfiguration({ input: body }) },
}));
