import { CountryCode, PlaidEnvironments } from 'plaid';

import { readPlaidConfig } from './config';

const validEnvironment = {
  NODE_ENV: 'test',
  DB_QUERY_LOGGING: 'false',
  PLAID_CLIENT_ID: 'client-id',
  PLAID_SECRET: 'secret',
  PLAID_ENV: 'sandbox',
} satisfies NodeJS.ProcessEnv;

describe('readPlaidConfig', () => {
  it('returns null when Plaid is not configured', () => {
    expect(readPlaidConfig({ env: { NODE_ENV: 'test', DB_QUERY_LOGGING: 'false' } })).toBeNull();
  });

  it('applies first-release defaults', () => {
    expect(readPlaidConfig({ env: validEnvironment })).toEqual({
      clientId: 'client-id',
      secret: 'secret',
      environment: 'sandbox',
      basePath: PlaidEnvironments.sandbox,
      countryCodes: [CountryCode.Us, CountryCode.Ca],
      redirectUri: undefined,
      webhookUrl: undefined,
      transactionsDaysRequested: 180,
    });
  });

  it('rejects incomplete configuration', () => {
    expect(() =>
      readPlaidConfig({
        env: { NODE_ENV: 'test', DB_QUERY_LOGGING: 'false', PLAID_CLIENT_ID: 'client-id' },
      }),
    ).toThrow();
  });

  it('rejects unsupported countries and history ranges', () => {
    expect(() => readPlaidConfig({ env: { ...validEnvironment, PLAID_COUNTRY_CODES: 'US,XX' } })).toThrow(
      'PLAID_COUNTRY_CODES',
    );
    expect(() => readPlaidConfig({ env: { ...validEnvironment, PLAID_TRANSACTIONS_DAYS_REQUESTED: '89' } })).toThrow();
  });

  it('requires HTTPS URLs in production', () => {
    expect(() =>
      readPlaidConfig({
        env: { ...validEnvironment, PLAID_ENV: 'production', PLAID_WEBHOOK_URL: 'http://example.com/webhooks/plaid' },
      }),
    ).toThrow('Must use HTTPS');
  });
});
