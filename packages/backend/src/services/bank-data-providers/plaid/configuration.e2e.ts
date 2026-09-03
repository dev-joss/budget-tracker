import { API_ERROR_CODES, BANK_PROVIDER_TYPE } from '@bt/shared/types';
import PlaidConfigurations from '@models/plaid-configurations.model';
import * as helpers from '@tests/helpers';

const validConfiguration = {
  clientId: 'test-client-id',
  secret: 'test-secret',
  environment: 'sandbox',
  countryCodes: ['US', 'CA'],
  transactionsDaysRequested: 180,
};

describe('Plaid configuration', () => {
  const originalAdminUsers = process.env.ADMIN_USERS;
  const originalPlaidEnvironment = {
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    environment: process.env.PLAID_ENV,
  };

  beforeEach(async () => {
    process.env.ADMIN_USERS = 'test1';
    delete process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_SECRET;
    delete process.env.PLAID_ENV;
    await PlaidConfigurations.destroy({ where: {} });
  });

  afterAll(() => {
    if (originalAdminUsers === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = originalAdminUsers;
    if (originalPlaidEnvironment.clientId === undefined) delete process.env.PLAID_CLIENT_ID;
    else process.env.PLAID_CLIENT_ID = originalPlaidEnvironment.clientId;
    if (originalPlaidEnvironment.secret === undefined) delete process.env.PLAID_SECRET;
    else process.env.PLAID_SECRET = originalPlaidEnvironment.secret;
    if (originalPlaidEnvironment.environment === undefined) delete process.env.PLAID_ENV;
    else process.env.PLAID_ENV = originalPlaidEnvironment.environment;
  });

  it('returns an empty state when no database configuration exists', async () => {
    const response = await helpers.makeRequest<
      {
        configuration: { configured: boolean; secretConfigured: boolean } | null;
      },
      true
    >({ method: 'get', url: '/bank-data-providers/plaid/configuration', raw: true });

    expect(response.configuration).toBeNull();
  });

  it('saves configuration without returning the secret', async () => {
    await helpers.makeRequest({
      method: 'put',
      url: '/bank-data-providers/plaid/configuration',
      payload: validConfiguration,
      raw: true,
    });

    const response = await helpers.makeRequest<
      {
        configuration: {
          configured: boolean;
          secretConfigured: boolean;
          clientId: string;
          environment: string;
          countryCodes: string[];
          transactionsDaysRequested: number;
        };
      },
      true
    >({ method: 'get', url: '/bank-data-providers/plaid/configuration', raw: true });

    expect(response.configuration).toEqual({
      configured: true,
      secretConfigured: true,
      clientId: 'test-client-id',
      environment: 'sandbox',
      countryCodes: ['US', 'CA'],
      transactionsDaysRequested: 180,
    });
    expect(JSON.stringify(response)).not.toContain('test-secret');

    const providers = await helpers.makeRequest<{ providers: Array<{ type: BANK_PROVIDER_TYPE }> }, true>({
      method: 'get',
      url: '/bank-data-providers',
      raw: true,
    });
    expect(providers.providers).toContainEqual(expect.objectContaining({ type: BANK_PROVIDER_TYPE.PLAID }));
  });

  it('rejects invalid country codes', async () => {
    const response = await helpers.makeRequest({
      method: 'put',
      url: '/bank-data-providers/plaid/configuration',
      payload: { ...validConfiguration, countryCodes: ['US', 'XX'] },
    });

    expect(response.statusCode).toBe(422);
  });

  it('requires administrator access', async () => {
    process.env.ADMIN_USERS = 'another-user';

    const response = await helpers.makeRequest({ method: 'get', url: '/bank-data-providers/plaid/configuration' });

    expect(response.statusCode).toBe(401);
    expect(response.body.response.code).toBe(API_ERROR_CODES.unauthorized);
  });
});
