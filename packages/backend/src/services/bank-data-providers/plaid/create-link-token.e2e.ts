import { afterEach, describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import { http, HttpResponse } from 'msw';

const originalPlaidEnvironment = {
  PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
  PLAID_SECRET: process.env.PLAID_SECRET,
  PLAID_ENV: process.env.PLAID_ENV,
};

const configurePlaid = () => {
  process.env.PLAID_CLIENT_ID = 'client-id';
  process.env.PLAID_SECRET = 'secret';
  process.env.PLAID_ENV = 'sandbox';
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalPlaidEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /bank-data-providers/plaid/link-token', () => {
  it('creates a Link token for the signed-in user', async () => {
    configurePlaid();
    global.mswMockServer.use(
      http.post('https://sandbox.plaid.com/link/token/create', () =>
        HttpResponse.json({
          link_token: 'link-sandbox-token',
          expiration: '2026-09-01T12:00:00Z',
          request_id: 'request-id',
        }),
      ),
    );

    await expect(helpers.bankDataProviders.createPlaidLinkToken({ raw: true })).resolves.toEqual({
      linkToken: 'link-sandbox-token',
      expiration: '2026-09-01T12:00:00Z',
    });
  });

  it('returns an error when Plaid is not configured', async () => {
    delete process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_SECRET;
    delete process.env.PLAID_ENV;

    const response = await helpers.bankDataProviders.createPlaidLinkToken();
    expect(response.statusCode).toBe(500);
  });

  it('returns an error when Plaid rejects the request', async () => {
    configurePlaid();
    global.mswMockServer.use(
      http.post('https://sandbox.plaid.com/link/token/create', () =>
        HttpResponse.json({ error_code: 'INVALID_REQUEST', error_message: 'Invalid request' }, { status: 400 }),
      ),
    );

    const response = await helpers.bankDataProviders.createPlaidLinkToken();
    expect(response.statusCode).toBe(500);
  });
});
