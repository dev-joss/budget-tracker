import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const INPUT_FILES = [
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

export function getLocalE2eCacheKey({ rootDirectory }: { rootDirectory: string }): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch }));
  for (const file of INPUT_FILES) {
    const content = readFileSync(path.join(rootDirectory, file));
    hash.update(JSON.stringify({ file, bytes: content.length }));
    hash.update(content);
  }
  return hash.digest('hex');
}
