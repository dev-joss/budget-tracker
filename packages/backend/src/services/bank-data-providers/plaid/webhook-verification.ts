import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { PlaidApi } from 'plaid';

import { createPlaidApiClient } from './api-client';
import { resolvePlaidConfig } from './config';

const MAX_WEBHOOK_AGE_SECONDS = 5 * 60;
const KEY_CACHE_MS = 60 * 60 * 1000;
type ImportedJwk = Awaited<ReturnType<typeof importJWK>>;
const keyCache = new Map<string, { key: ImportedJwk; expiresAt: number }>();

export const verifyPlaidWebhook = async ({
  token,
  rawBody,
  apiClient,
  now = new Date(),
}: {
  token: string;
  rawBody: Buffer;
  apiClient?: PlaidApi;
  now?: Date;
}): Promise<void> => {
  const header = decodeProtectedHeader(token);
  if (header.alg !== 'ES256' || !header.kid) throw new Error('Invalid Plaid webhook JWT header');

  let cached = keyCache.get(header.kid);
  if (!cached || cached.expiresAt <= now.getTime()) {
    const config = apiClient ? null : await resolvePlaidConfig();
    if (!apiClient && !config) throw new Error('Plaid is not configured');
    const client = apiClient || createPlaidApiClient({ config: config! });
    const response = await client.webhookVerificationKeyGet({
      key_id: header.kid,
    });
    const keyData = response.data.key;
    if (keyData.alg !== 'ES256' || keyData.kid !== header.kid || keyData.expired_at) {
      throw new Error('Plaid webhook verification key is not trusted');
    }
    cached = {
      key: await importJWK(keyData as JWK, 'ES256'),
      expiresAt: now.getTime() + KEY_CACHE_MS,
    };
    keyCache.set(header.kid, cached);
  }

  const { payload } = await jwtVerify(token, cached.key, { algorithms: ['ES256'] });
  if (
    !payload.iat ||
    now.getTime() / 1000 - payload.iat > MAX_WEBHOOK_AGE_SECONDS ||
    payload.iat > now.getTime() / 1000 + 30
  ) {
    throw new Error('Plaid webhook JWT is stale');
  }
  if (typeof payload.request_body_sha256 !== 'string') throw new Error('Plaid webhook JWT has no body hash');

  const actual = Buffer.from(createHash('sha256').update(rawBody).digest('hex'));
  const expected = Buffer.from(payload.request_body_sha256);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Plaid webhook body hash does not match');
  }
};

export const clearPlaidWebhookKeyCache = (): void => keyCache.clear();
