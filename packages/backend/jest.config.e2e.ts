import path from 'node:path';

import baseConfig from './jest.config.base';
import { getLocalE2eCacheKey } from './src/tests/local-e2e-cache-key';

console.log('❗ RUNNING INTEGRATION TESTS');

/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
export default {
  ...baseConfig,
  testEnvironment: '<rootDir>/src/tests/e2e-environment.ts',
  ...(process.env.LOCAL_E2E_CACHE_ROOT
    ? {
        cacheDirectory: path.join(
          process.env.LOCAL_E2E_CACHE_ROOT,
          getLocalE2eCacheKey({ rootDirectory: path.resolve(__dirname, '../..') }),
        ),
      }
    : {}),
  maxWorkers: Number(process.env.JEST_WORKERS_AMOUNT),
  testMatch: ['<rootDir>/src/**/?(*.)+(e2e).[jt]s?(x)'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/setupIntegrationTests.ts'],
  testTimeout: 15000, // 15 seconds timeout for all e2e tests
  // Restart worker when it exceeds 1GB to prevent OOM during long test runs on CI
  workerIdleMemoryLimit: '1GB',
};
