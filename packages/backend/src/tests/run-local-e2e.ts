import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import Redis from 'ioredis';
import { QueryTypes, Sequelize } from 'sequelize';

import { getLocalTemplateKey, getTemplateSeedDay } from './local-e2e-template-key';

const rootDirectory = process.cwd();
const database = process.env.APPLICATION_DB_DATABASE!;
const template = `${database}-template`;
const markerPrefix = 'local-e2e-v1:';
const workers = Number(process.env.JEST_WORKERS_AMOUNT);
const connectionOptions = {
  host: process.env.APPLICATION_DB_HOST,
  port: Number(process.env.APPLICATION_DB_PORT),
  username: process.env.APPLICATION_DB_USERNAME,
  password: process.env.APPLICATION_DB_PASSWORD,
  dialect: 'postgres' as const,
  logging: false as const,
  pool: { max: 1, min: 0, idle: 0 },
};

const quoteIdentifier = ({ value }: { value: string }) => `"${value.replaceAll('"', '""')}"`;

async function runCommand({ args }: { args: string[] }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    const interrupt = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}

async function verifyTemplate(): Promise<string> {
  const connection = new Sequelize({ ...connectionOptions, database: template });
  try {
    const migrations = readdirSync(path.join(rootDirectory, 'packages/backend/src/migrations'))
      .filter((name) => /\.(js|ts)$/.test(name))
      .toSorted();
    const executed = await connection.query<{ name: string }>('SELECT name FROM "SequelizeMeta" ORDER BY name', {
      type: QueryTypes.SELECT,
    });
    if (JSON.stringify(executed.map(({ name }) => name)) !== JSON.stringify(migrations)) {
      throw new Error('Template migration list does not match source');
    }
    const [rates] = await connection.query<{ count: number; first: string; last: string }>(
      `SELECT COUNT(*)::integer AS count,
        to_char(MIN(date) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first,
        to_char(MAX(date) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last FROM "ExchangeRates"`,
      { type: QueryTypes.SELECT },
    );
    const seedDay = getTemplateSeedDay({});
    if (!rates || rates.count < 10000 || rates.first !== seedDay || rates.last !== seedDay) {
      throw new Error('Template exchange-rate seeds are incomplete or out of date');
    }

    // Include schema definitions and seed contents so a damaged template cannot
    // pass solely because its published key and migration names still exist.
    const schema = await connection.query(
      `SELECT c.relname, c.relkind, a.attnum, a.attname,
        format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
        pg_get_expr(d.adbin, d.adrelid) AS default_value,
        CASE WHEN c.relkind = 'v' THEN pg_get_viewdef(c.oid) END AS view_definition,
        CASE WHEN c.relkind = 'i' THEN pg_get_indexdef(c.oid) END AS index_definition
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'S', 'i')
       ORDER BY c.relname, a.attnum`,
      { type: QueryTypes.SELECT },
    );
    const constraints = await connection.query(
      `SELECT c.conrelid::regclass::text AS relation, c.conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' ORDER BY relation, c.conname`,
      { type: QueryTypes.SELECT },
    );
    const enums = await connection.query(
      `SELECT t.typname, e.enumlabel, e.enumsortorder
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder`,
      { type: QueryTypes.SELECT },
    );
    const functions = await connection.query(
      `SELECT p.proname, pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
       ORDER BY p.proname, definition`,
      { type: QueryTypes.SELECT },
    );
    const triggers = await connection.query(
      `SELECT t.tgrelid::regclass::text AS relation, t.tgname, pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY relation, t.tgname`,
      { type: QueryTypes.SELECT },
    );
    const seeds: { count: number; digest: string }[] = [];
    for (const table of ['Currencies', 'MerchantCategoryCodes', 'ExchangeRates']) {
      const [seed] = await connection.query<{ count: number; digest: string }>(
        `SELECT COUNT(*)::integer AS count, md5(string_agg(row_to_json(t)::text, ',' ORDER BY row_to_json(t)::text)) AS digest
         FROM ${quoteIdentifier({ value: table })} t`,
        { type: QueryTypes.SELECT },
      );
      if (!seed || seed.count === 0) throw new Error(`Template seed table ${table} is empty`);
      seeds.push(seed);
    }
    return createHash('sha256').update(JSON.stringify({ schema, constraints, enums, functions, triggers, seeds })).digest('hex');
  } finally {
    await connection.close();
  }
}

async function run(): Promise<number> {
  if (process.env.NODE_ENV !== 'test' || process.env.TZ !== 'UTC') {
    throw new Error('Local e2e requires NODE_ENV=test and TZ=UTC');
  }
  if (!Number.isInteger(workers) || workers < 1) throw new Error('JEST_WORKERS_AMOUNT must be a positive integer');
  const admin = new Sequelize({ ...connectionOptions, database });
  // A transaction pins the advisory lock to one connection for the complete
  // invocation. An interrupted container releases it when PostgreSQL disconnects.
  const lock = await admin.transaction();
  try {
    const [result] = await admin.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(71921401) AS locked', {
      type: QueryTypes.SELECT,
      transaction: lock,
    });
    if (!result?.locked) throw new Error('Another local e2e run is active for this checkout');

    // Database DDL must use a connection outside the lock transaction.
    const control = new Sequelize({ ...connectionOptions, database });
    try {
      const [version] = await control.query<{ server_version: string }>('SHOW server_version', {
        type: QueryTypes.SELECT,
      });
      const postgresVersion = version!.server_version;
      const key = getLocalTemplateKey({ rootDirectory, postgresVersion });
      const [published] = await control.query<{ marker: string | null }>(
        "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = :template",
        { replacements: { template }, type: QueryTypes.SELECT },
      );
      let valid = false;
      if (published?.marker?.startsWith(`${markerPrefix}${key}:`)) {
        try {
          valid = published.marker === `${markerPrefix}${key}:${await verifyTemplate()}`;
        } catch (error) {
          console.log('Template verification failed; rebuilding:', (error as Error).message);
        }
      }
      if (valid) {
        console.log('Reusing verified template database.');
      } else {
        console.log('Creating template database...');
        await control.query(`DROP DATABASE IF EXISTS ${quoteIdentifier({ value: template })} WITH (FORCE)`);
        await control.query(`CREATE DATABASE ${quoteIdentifier({ value: template })}`);
        const migrationStatus = await runCommand({
          args: ['-r', 'ts-node/register', 'packages/backend/src/tests/run-template-migrations.ts'],
        });
        if (migrationStatus !== 0) return migrationStatus;
        const signature = await verifyTemplate();
        if (getLocalTemplateKey({ rootDirectory, postgresVersion }) !== key) {
          throw new Error('Template inputs or UTC date changed during preparation; rerun the tests');
        }
        await control.query(`COMMENT ON DATABASE ${quoteIdentifier({ value: template })} IS :marker`, {
          replacements: { marker: `${markerPrefix}${key}:${signature}` },
        });
        console.log('Template database verified and published.');
      }

      console.log('Creating worker databases from template...');
      for (let worker = 1; worker <= workers; worker++) {
        const workerDatabase = quoteIdentifier({ value: `${database}-${worker}` });
        await control.query(`DROP DATABASE IF EXISTS ${workerDatabase} WITH (FORCE)`);
        await control.query(`CREATE DATABASE ${workerDatabase} TEMPLATE ${quoteIdentifier({ value: template })}`);
      }
      // This Redis service belongs only to the hashed checkout project. Flush
      // every database so queued work and keys from an interrupted run are gone.
      const redis = new Redis({ host: 'test-redis', port: 6379 });
      try {
        await redis.flushall();
      } finally {
        await redis.quit();
      }
      console.log('Worker databases recreated; test Redis cleared.');
    } finally {
      await control.close();
    }

    console.log('Running tests...');
    return await runCommand({
      args: [
        'node_modules/jest/bin/jest.js',
        '-c',
        'packages/backend/jest.config.e2e.ts',
        '--passWithNoTests',
        '--forceExit',
        '--colors',
        ...process.argv.slice(2),
      ],
    });
  } finally {
    await lock.rollback();
    await admin.close();
  }
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('Local e2e failed:', error);
    process.exitCode = 1;
  });
