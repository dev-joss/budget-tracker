import { createHash } from 'node:crypto';
import type { PlaidApi } from 'plaid';

const decodeProtectedHeader = jest.fn();
const importJWK = jest.fn();
const jwtVerify = jest.fn();
jest.mock('jose', () => ({ decodeProtectedHeader, importJWK, jwtVerify }));

import { clearPlaidWebhookKeyCache, verifyPlaidWebhook } from './webhook-verification';

describe('verifyPlaidWebhook', () => {
  const rawBody = Buffer.from('{"item_id":"item-1"}');
  const now = new Date('2026-08-31T12:00:00Z');
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const webhookVerificationKeyGet = jest.fn();
  const apiClient = { webhookVerificationKeyGet } as unknown as PlaidApi;

  beforeEach(() => {
    jest.clearAllMocks();
    clearPlaidWebhookKeyCache();
    decodeProtectedHeader.mockReturnValue({ alg: 'ES256', kid: 'key-1' });
    importJWK.mockResolvedValue({ key: 'imported' });
    jwtVerify.mockResolvedValue({
      payload: { iat: Math.floor(now.getTime() / 1000), request_body_sha256: bodyHash },
    });
    webhookVerificationKeyGet.mockResolvedValue({
      data: {
        key: {
          alg: 'ES256',
          crv: 'P-256',
          kid: 'key-1',
          kty: 'EC',
          use: 'sig',
          x: 'x',
          y: 'y',
          created_at: 1,
          expired_at: null,
        },
      },
    });
  });

  it('restricts verification to ES256 and caches the trusted key', async () => {
    await verifyPlaidWebhook({ token: 'token', rawBody, apiClient, now });
    await verifyPlaidWebhook({ token: 'token', rawBody, apiClient, now });
    expect(jwtVerify).toHaveBeenCalledWith('token', { key: 'imported' }, { algorithms: ['ES256'] });
    expect(webhookVerificationKeyGet).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale token', async () => {
    jwtVerify.mockResolvedValue({
      payload: { iat: Math.floor(now.getTime() / 1000) - 301, request_body_sha256: bodyHash },
    });
    await expect(verifyPlaidWebhook({ token: 'token', rawBody, apiClient, now })).rejects.toThrow('stale');
  });

  it('rejects a body hash mismatch', async () => {
    jwtVerify.mockResolvedValue({
      payload: { iat: Math.floor(now.getTime() / 1000), request_body_sha256: 'bad' },
    });
    await expect(verifyPlaidWebhook({ token: 'token', rawBody, apiClient, now })).rejects.toThrow('body hash');
  });

  it('rejects a non-ES256 header before key lookup', async () => {
    decodeProtectedHeader.mockReturnValue({ alg: 'HS256', kid: 'key-1' });
    await expect(verifyPlaidWebhook({ token: 'token', rawBody, apiClient, now })).rejects.toThrow('header');
    expect(webhookVerificationKeyGet).not.toHaveBeenCalled();
  });
});
