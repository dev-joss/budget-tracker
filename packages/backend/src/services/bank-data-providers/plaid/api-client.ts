import { Configuration, PlaidApi } from 'plaid';

import type { PlaidConfig } from './config';

interface PlaidErrorBody {
  error_code?: string;
  error_message?: string;
  error_type?: string;
  request_id?: string;
}

export interface NormalizedPlaidError {
  code?: string;
  message: string;
  requestId?: string;
  type?: string;
}

export const createPlaidApiClient = ({ config }: { config: PlaidConfig }): PlaidApi =>
  new PlaidApi(
    new Configuration({
      basePath: config.basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': config.clientId,
          'PLAID-SECRET': config.secret,
        },
      },
    }),
  );

export const normalizePlaidError = ({ error }: { error: unknown }): NormalizedPlaidError => {
  const response = (error as { response?: { data?: PlaidErrorBody } } | null)?.response;
  const body = response?.data;
  return {
    code: body?.error_code,
    message: body?.error_message || (error instanceof Error ? error.message : 'Unknown Plaid error'),
    requestId: body?.request_id,
    type: body?.error_type,
  };
};
