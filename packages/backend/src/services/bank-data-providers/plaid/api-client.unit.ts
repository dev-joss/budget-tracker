import { normalizePlaidError } from './api-client';

describe('normalizePlaidError', () => {
  it('extracts safe Plaid error fields without request configuration', () => {
    const error = {
      config: { headers: { 'PLAID-SECRET': 'must-not-leak' } },
      response: {
        data: {
          error_code: 'ITEM_LOGIN_REQUIRED',
          error_message: 'Login is required',
          error_type: 'ITEM_ERROR',
          request_id: 'request-id',
        },
      },
    };

    expect(normalizePlaidError({ error })).toEqual({
      code: 'ITEM_LOGIN_REQUIRED',
      message: 'Login is required',
      requestId: 'request-id',
      type: 'ITEM_ERROR',
    });
    expect(JSON.stringify(normalizePlaidError({ error }))).not.toContain('must-not-leak');
  });

  it('normalizes unknown errors', () => {
    expect(normalizePlaidError({ error: new Error('Network failed') })).toEqual({
      code: undefined,
      message: 'Network failed',
      requestId: undefined,
      type: undefined,
    });
  });
});
