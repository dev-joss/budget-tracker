import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getLocalE2eCacheKey } from './local-e2e-cache-key';

describe('local e2e cache key', () => {
  let rootDirectory: string;

  beforeEach(() => {
    rootDirectory = mkdtempSync(path.join(os.tmpdir(), 'local-e2e-cache-key-'));
    const sourceRoot = path.resolve(__dirname, '../../../..');
    const files = [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'packages/backend/package.json',
      'packages/backend/tsconfig.json',
      'packages/shared/package.json',
      'packages/shared/tsconfig.json',
      'packages/backend/jest.config.base.ts',
      'packages/backend/jest.config.e2e.ts',
      'packages/backend/src/tests/transformers/esm-to-cjs.js',
      'packages/backend/src/tests/local-e2e-cache-key.ts',
    ];
    for (const file of files) {
      const target = path.join(rootDirectory, file);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(sourceRoot, file), target);
    }
  });

  afterEach(() => {
    rmSync(rootDirectory, { recursive: true, force: true });
  });

  it.each([
    { file: 'package-lock.json' },
    { file: 'packages/backend/tsconfig.json' },
    { file: 'packages/backend/jest.config.base.ts' },
    { file: 'packages/backend/src/tests/transformers/esm-to-cjs.js' },
  ])('isolates cached output when $file changes', ({ file }) => {
    const original = getLocalE2eCacheKey({ rootDirectory });
    writeFileSync(path.join(rootDirectory, file), 'changed');
    expect(getLocalE2eCacheKey({ rootDirectory })).not.toBe(original);
  });

  it('keeps the namespace stable for source edits handled by Jest', () => {
    const original = getLocalE2eCacheKey({ rootDirectory });
    writeFileSync(path.join(rootDirectory, 'packages/backend/src/app.ts'), 'changed');
    expect(getLocalE2eCacheKey({ rootDirectory })).toBe(original);
  });

  it('rejects missing compatibility inputs', () => {
    rmSync(path.join(rootDirectory, 'package-lock.json'));
    expect(() => getLocalE2eCacheKey({ rootDirectory })).toThrow();
  });
});
