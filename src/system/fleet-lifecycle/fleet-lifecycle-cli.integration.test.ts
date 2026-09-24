import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool, executeQuery } from '../../persistence/postgres.js';
import { bootstrapSharedSchema } from '../../persistence/postgres/shared-schema.js';
import { seedCompanionStartupOwnerFiles } from '../config/startup-owner-files.js';

const TIMEOUT_MS = 180_000;
const PRIMARY = '11111111-1111-4111-8111-111111111111';
const NOVA = '33333333-3333-4333-8333-333333333333';
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = join(REPO_ROOT, 'scripts', 'ops', 'fleet-lifecycle.ts');

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

function entry(companionId: string, name: string) {
  return {
    companionId,
    companionDataDir: `companions/${name}`,
    characterCardPath: `companions/${name}/character-card.json`,
    postgresSchema: `companion_${name}`,
    postgresRole: `companion_${name}_runtime`,
    postgresDatabaseUrlRef: { kind: 'env', envName: `COMPANION_${name.toUpperCase()}_DATABASE_URL` },
  };
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

describe('fleet lifecycle CLI (local deployment)', () => {
  it('plans, applies, removes with retained data, and re-adds only through readmission', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const databaseUrl = (await harness.createDatabase()).databaseUrl;
    await bootstrapSharedSchema(databaseUrl);
    const admin = createPostgresPool(databaseUrl);
    const root = mkdtempSync(join(tmpdir(), 'fleet-lifecycle-e2e-'));
    try {
      await executeQuery(admin, `CREATE ROLE companion_nova_runtime LOGIN PASSWORD 'nova-test'`);
      await executeQuery(admin, 'CREATE SCHEMA companion_nova AUTHORIZATION companion_nova_runtime');

      const systemDataDir = join(root, 'system-data');
      mkdirSync(systemDataDir, { recursive: true });
      mkdirSync(join(root, 'companion-data'), { recursive: true });
      for (const name of ['flagship', 'nova']) {
        const dataDir = join(root, 'companions', name);
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, 'character-card.json'), '{}\n');
        seedCompanionStartupOwnerFiles({ companionDataDir: dataDir, seedDir: join(REPO_ROOT, 'config') });
      }
      const manifest = {
        postgres: {
          sharedMigrationRole: 'shared_schema_migration',
          sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL' },
        },
        companions: [entry(PRIMARY, 'flagship')],
      };
      const manifestPath = join(systemDataDir, 'companions.json');
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: root,
        NODE_ENV: 'test',
        PSFN_RUNTIME_ROOT: root,
        SYSTEM_DATA_DIR: systemDataDir,
        COMPANION_DATA_DIR: join(root, 'companion-data'),
        CONFIG_DIR: join(REPO_ROOT, 'config'),
        SHARED_SCHEMA_MIGRATION_DATABASE_URL: databaseUrl,
        COMPANION_NOVA_DATABASE_URL: withCredentials(databaseUrl, 'companion_nova_runtime', 'nova-test'),
      };
      const cli = (...args: string[]) => {
        const result = spawnSync(TSX, [CLI, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      };
      const planWith = (request: unknown) => {
        const requestPath = join(root, `request-${Math.random().toString(16).slice(2)}.json`);
        writeFileSync(requestPath, JSON.stringify(request));
        return cli('plan', '--request', requestPath);
      };
      const roster = () => (JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest)
        .companions.map(companion => companion.companionId);

      const addPlan = planWith({ operation: 'add', companion: entry(NOVA, 'nova') });
      expect(addPlan.stderr).toBe('');
      const add = JSON.parse(addPlan.stdout) as { planId: string; digest: string };
      expect(roster()).toEqual([PRIMARY]);
      const applied = cli('apply', '--plan', add.planId, '--approve', add.digest);
      expect(applied.stderr).toBe("");
      expect(JSON.parse(applied.stdout)).toMatchObject({ status: 'applied' });
      expect(roster()).toEqual([PRIMARY, NOVA]);
      expect(JSON.stringify(readFileSync(join(systemDataDir, 'fleet-lifecycle', 'plans', add.planId, 'plan.json'), 'utf8')))
        .not.toContain('nova-test');

      const removePlan = JSON.parse(planWith({
        operation: 'remove', companionId: NOVA, confirmCompanionId: NOVA,
      }).stdout) as { planId: string; digest: string };
      const removed = cli('apply', '--plan', removePlan.planId, '--approve', removePlan.digest);
      expect(JSON.parse(removed.stdout)).toMatchObject({ status: 'applied' });
      expect(roster()).toEqual([PRIMARY]);
      const fence = await admin.query<{ lifecycle_fenced: boolean }>(
        'SELECT lifecycle_fenced FROM shared.icp_autonomy_invalidation_fences WHERE companion_id = $1',
        [NOVA],
      );
      expect(fence.rows[0]?.lifecycle_fenced).toBe(true);
      // Removal retained the tenant schema.
      const schema = await admin.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'companion_nova'`);
      expect(schema.rowCount).toBe(1);

      const refused = planWith({ operation: 'add', companion: entry(NOVA, 'nova') });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('readmission_requires_reapproval');

      const readd = JSON.parse(planWith({
        operation: 'add', companion: entry(NOVA, 'nova'), readmit: { confirmCompanionId: NOVA },
      }).stdout) as { planId: string; digest: string };
      const replay = cli('apply', '--plan', add.planId, '--approve', add.digest);
      expect(JSON.parse(replay.stdout)).toMatchObject({ status: 'applied' });
      const readded = cli('apply', '--plan', readd.planId, '--approve', readd.digest);
      expect(readded.stderr).toBe('');
      expect(JSON.parse(readded.stdout)).toMatchObject({ status: 'applied' });
      expect(roster()).toEqual([PRIMARY, NOVA]);
      const cleared = await admin.query<{ lifecycle_fenced: boolean }>(
        'SELECT lifecycle_fenced FROM shared.icp_autonomy_invalidation_fences WHERE companion_id = $1',
        [NOVA],
      );
      expect(cleared.rows[0]?.lifecycle_fenced).toBe(false);
    } finally {
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
