import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const INPUT_FILES = [
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
];

function listMigrationFiles({ rootDirectory, directory }: { rootDirectory: string; directory: string }): string[] {
  return readdirSync(path.join(rootDirectory, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? listMigrationFiles({ rootDirectory, directory: file }) : [file];
  });
}

export function getTemplateSeedDay({ now = new Date() }: { now?: Date } = {}): string {
  const seedDate = new Date(now.getTime());
  seedDate.setUTCDate(seedDate.getUTCDate() - 10);
  return seedDate.toISOString().slice(0, 10);
}

export function getLocalTemplateKey({
  rootDirectory,
  postgresVersion,
  now = new Date(),
}: {
  rootDirectory: string;
  postgresVersion: string;
  now?: Date;
}): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      version: 1,
      node: process.version,
      architecture: process.arch,
      postgresVersion,
      nodeEnvironment: 'test',
      timezone: 'UTC',
      day: now.toISOString().slice(0, 10),
    }),
  );

  const files = [
    ...INPUT_FILES,
    ...listMigrationFiles({ rootDirectory, directory: 'packages/backend/src/migrations' }),
  ].toSorted();
  for (const file of files) {
    const content = readFileSync(path.join(rootDirectory, file));
    hash.update(JSON.stringify({ file, bytes: content.length }));
    hash.update(content);
  }
  return hash.digest('hex');
}
