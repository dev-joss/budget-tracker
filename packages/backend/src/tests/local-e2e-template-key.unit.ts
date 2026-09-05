import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { getLocalTemplateKey, getTemplateSeedDay } from './local-e2e-template-key';

const FIXTURE_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'packages/backend/package.json',
  'packages/backend/tsconfig.json',
  'packages/shared/package.json',
  'packages/backend/src/tests/test-exchange-rates.json',
  'packages/backend/src/resources/mcc-codes.json',
  'packages/backend/src/tests/run-template-migrations.ts',
  'packages/backend/src/tests/run-local-e2e.ts',
  'packages/backend/src/tests/local-e2e-template-key.ts',
  'packages/backend/src/migrations/001-seed.js',
  'packages/backend/src/migrations/utils/schema.ts',
];

describe('local e2e template key', () => {
  let rootDirectory: string;
  const now = new Date('2026-09-05T00:00:00.000Z');

  const writeFixture = ({ file, content = 'fixture' }: { file: string; content?: string }) => {
    const target = path.join(rootDirectory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const getKey = ({ date = now, postgresVersion = '16.15' }: { date?: Date; postgresVersion?: string } = {}) =>
    getLocalTemplateKey({ rootDirectory, postgresVersion, now: date });

  beforeEach(() => {
    rootDirectory = mkdtempSync(path.join(os.tmpdir(), 'local-e2e-template-key-'));
    for (const file of FIXTURE_FILES) writeFixture({ file });
  });

  afterEach(() => {
    rmSync(rootDirectory, { recursive: true, force: true });
  });

  it.each(FIXTURE_FILES.map((file) => ({ file })))('invalidates when $file changes', ({ file }) => {
    const original = getKey();
    writeFixture({ file, content: 'changed' });
    expect(getKey()).not.toBe(original);
  });

  it('invalidates for added or removed migrations', () => {
    const original = getKey();
    const file = 'packages/backend/src/migrations/002-added.ts';
    writeFixture({ file });
    expect(getKey()).not.toBe(original);
    rmSync(path.join(rootDirectory, file));
    expect(getKey()).toBe(original);
    rmSync(path.join(rootDirectory, 'packages/backend/src/migrations/001-seed.js'));
    expect(getKey()).not.toBe(original);
  });

  it('does not depend on file creation order or unrelated application edits', () => {
    const original = getKey();
    rmSync(path.join(rootDirectory, 'packages/backend/src/migrations'), { recursive: true });
    writeFixture({ file: 'packages/backend/src/migrations/utils/schema.ts' });
    writeFixture({ file: 'packages/backend/src/migrations/001-seed.js' });
    writeFixture({ file: 'packages/backend/src/app.ts', content: 'edited application' });
    expect(getKey()).toBe(original);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a missing required seed input', () => {
    rmSync(path.join(rootDirectory, 'packages/backend/src/tests/test-exchange-rates.json'));
    expect(() => getKey()).toThrow();
  });

  it('keeps the key within a UTC day and invalidates at midnight', () => {
    const original = getKey();
    expect(getKey({ date: new Date('2026-09-05T23:59:59.999Z') })).toBe(original);
    expect(getKey({ date: new Date('2026-09-06T00:00:00.000Z') })).not.toBe(original);
    expect(getKey({ postgresVersion: '17.1' })).not.toBe(original);
  });
});

describe('getTemplateSeedDay', () => {
  it.each([
    { timestamp: '2026-09-05T23:59:59.999Z', expected: '2026-08-26' },
    { timestamp: '2026-09-06T00:00:00.000Z', expected: '2026-08-27' },
    { timestamp: '2024-03-10T00:00:00.000Z', expected: '2024-02-29' },
    { timestamp: '2026-01-01T00:00:00.000Z', expected: '2025-12-22' },
  ])('uses UTC calendar days for $timestamp', ({ timestamp, expected }) => {
    expect(getTemplateSeedDay({ now: new Date(timestamp) })).toBe(expected);
  });
});
