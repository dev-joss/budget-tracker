import { EXPENSIFY_SAFE_ERROR_CODES } from '@bt/shared/types';
import { decryptCredentials, encryptCredentials } from '@services/bank-data-providers/utils/credential-encryption';
import { z } from 'zod';

import { ExpensifyClientError, type ExpensifyCredentials } from './client';

const credentialsSchema = z
  .object({
    partnerUserId: z.string().min(1).max(500),
    partnerUserSecret: z.string().min(1).max(500),
  })
  .strict();

export function encryptExpensifyCredentials({ credentials }: { credentials: ExpensifyCredentials }): string {
  return encryptCredentials({ ...credentials });
}

export function decryptExpensifyCredentials({ encrypted }: { encrypted: string }): ExpensifyCredentials {
  try {
    const parsed = credentialsSchema.safeParse(decryptCredentials(encrypted));
    if (!parsed.success) throw new Error('invalid credential payload');
    return parsed.data;
  } catch {
    throw new ExpensifyClientError({ code: EXPENSIFY_SAFE_ERROR_CODES.disconnected });
  }
}
