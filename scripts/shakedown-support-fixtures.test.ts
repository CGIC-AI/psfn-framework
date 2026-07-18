import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importCharacterCardFromPath } from '../src/core/identity/importer.js';
import {
  planPostgresTenantAccess,
  type PostgresTenantAccessPlan,
} from '../src/persistence/postgres/tenancy.js';
import { PER_COMPANION_OWNER_FILES } from '../src/system/config/settings-contract.js';
import { seedCompanionStartupOwnerFiles } from '../src/system/config/startup-owner-files.js';
import {
  PRIMARY_COMPANION_ID,
  SUPPORT_COMPANION_IDS,
  type SupportFixtureDatabasePort,
  loadSupportFixtureContract,
  resolveSupportFixtureCliEnvironment,
  resolveSupportFixturePaths,
  standUpSupportFixtures,
  tearDownSupportFixtures,
} from './shakedown-support-fixtures.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const TEMPLATE_PATH = join(REPO_ROOT, 'shakedown', 'support', 'companions.template.json');
const CARD_SOURCES = new Map([
  [
    SUPPORT_COMPANION_IDS[0],
    join(REPO_ROOT, 'shakedown', 'support', 'cards', 'mica.json'),
  ],
  [
    SUPPORT_COMPANION_IDS[1],
    join(REPO_ROOT, 'shakedown', 'support', 'cards', 'lumen.json'),
  ],
] as const);

class FakeFixtureDatabase implements SupportFixtureDatabasePort {
  readonly schemas = new Set(['shakedown_artie']);
  readonly roles = new Set([
    planPostgresTenantAccess({ schema: 'shakedown_artie' }).role,
  ]);
  readonly calls: string[] = [];
  failProvisionSchema: string | null = null;
  roundStopped = true;

  async assertRoundStopped(): Promise<void> {
    this.calls.push('round-stopped');
    if (!this.roundStopped) {
      throw new Error('round database still has runtime sessions');
    }
  }

  async assertProvisioned(plan: PostgresTenantAccessPlan): Promise<void> {
    this.calls.push(`assert:${plan.schema}`);
    if (!this.schemas.has(plan.schema) || !this.roles.has(plan.role)) {
      throw new Error(`missing schema ${plan.schema}`);
    }
  }

  async provision(plan: PostgresTenantAccessPlan): Promise<void> {
    this.calls.push(`provision:${plan.schema}`);
    if (plan.schema === this.failProvisionSchema) {
      throw new Error(`injected provision failure for ${plan.schema}`);
    }
    this.schemas.add(plan.schema);
    this.roles.add(plan.role);
  }

  async drop(plan: PostgresTenantAccessPlan): Promise<void> {
    this.calls.push(`drop:${plan.schema}`);
    this.schemas.delete(plan.schema);
    this.roles.delete(plan.role);
  }

  async assertAbsent(plan: PostgresTenantAccessPlan): Promise<void> {
    this.calls.push(`absent:${plan.schema}`);
    if (this.schemas.has(plan.schema) || this.roles.has(plan.role)) {
      throw new Error(`tenant remained ${plan.schema}`);
    }
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRound(): {
  database: FakeFixtureDatabase;
  runtimeRoot: string;
  systemDataDir: string;
} {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-support-fixture-test-'));
  roots.push(runtimeRoot);
  const systemDataDir = join(runtimeRoot, 'system-data');
  const primaryCardPath = join(runtimeRoot, 'companion-data', 'companion.json');
  mkdirSync(systemDataDir, { recursive: true });
  mkdirSync(dirname(primaryCardPath), { recursive: true });
  seedCompanionStartupOwnerFiles({
    companionDataDir: dirname(primaryCardPath),
    seedDir: join(REPO_ROOT, 'config'),
  });
  writeFileSync(primaryCardPath, JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'ARTEMIS',
      description: 'Synthetic primary test companion.',
      personality: 'Methodical.',
      scenario: '',
      first_mes: '',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: ['test'],
      creator: 'test-suite',
    },
  }));
  return {
    database: new FakeFixtureDatabase(),
    runtimeRoot,
    systemDataDir,
  };
}

function lifecycleInput(round: ReturnType<typeof createRound>) {
  return {
    ...round,
    seedDir: join(REPO_ROOT, 'config'),
    templatePath: TEMPLATE_PATH,
    supportCardSources: CARD_SOURCES,
    importCard(sourcePath: string, destinationPath: string): void {
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    },
  };
}

describe('support-companion fixture artifacts', () => {
  it('uses valid importable non-private cards and a distinct three-process fleet contract', () => {
    const contract = loadSupportFixtureContract(TEMPLATE_PATH);

    expect(contract.companions.map(companion => companion.companionId)).toEqual([
      PRIMARY_COMPANION_ID,
      ...SUPPORT_COMPANION_IDS,
    ]);
    expect(new Set(contract.companions.map(companion => companion.postgresSchema)).size).toBe(3);
    expect(new Set(contract.companions.map(companion => companion.companionDataDir)).size).toBe(3);
    expect(new Set(contract.companions.map(companion => companion.gardenPort)).size).toBe(3);

    for (const [companionId, sourcePath] of CARD_SOURCES) {
      const imported = importCharacterCardFromPath(sourcePath);
      expect(imported.containerFormat).toBe('json');
      expect(imported.card.data.creator_notes).toContain('Synthetic, non-private fixture');
      expect(imported.card.data.name).toBe(
        companionId === SUPPORT_COMPANION_IDS[0] ? 'Mica' : 'Lumen',
      );
    }
  });

  it('resolves the documented sourced environment through the canonical round root', () => {
    const envTemplate = readFileSync(
      join(REPO_ROOT, 'shakedown', 'artie', 'shakedown.env.template'),
      'utf8',
    );
    expect(envTemplate).toContain(`COMPANION_ID=${PRIMARY_COMPANION_ID}`);
    expect(envTemplate).toContain('PSFN_RUNTIME_ROOT=$SHAKEDOWN_ROOT');
    expect(envTemplate).toContain('PSFN_SHAKEDOWN_ROOT=$SHAKEDOWN_ROOT');

    const resolved = resolveSupportFixtureCliEnvironment({
      PSFN_MULTI_COMPANION: '1',
      COMPANION_ID: PRIMARY_COMPANION_ID,
      POSTGRES_DATABASE_URL: 'postgresql://fixture.invalid/shakedown',
      PSFN_SHAKEDOWN_ROOT: '/round/root',
      SYSTEM_DATA_DIR: '/round/root/system-data',
    });

    expect(resolved).toEqual({
      databaseUrl: 'postgresql://fixture.invalid/shakedown',
      runtimeRoot: '/round/root',
      systemDataDir: '/round/root/system-data',
    });
  });

  it('keeps the package CLI entrypoint executable and fail-closed on unknown commands', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(REPO_ROOT, 'scripts', 'shakedown-support-fixtures.ts'),
        'unknown-command',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: npm run shakedown:support -- <stand-up|tear-down>');
  });

  it('rolls back canonical owner seeding without overwriting a stale owner file', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-owner-seed-test-'));
    roots.push(root);
    const ownerFiles = [...PER_COMPANION_OWNER_FILES];
    const staleOwnerFile = ownerFiles[1]!;
    const stalePath = join(root, staleOwnerFile);
    writeFileSync(stalePath, '{"stale":true}\n');

    expect(() => seedCompanionStartupOwnerFiles({
      companionDataDir: root,
      seedDir: join(REPO_ROOT, 'config'),
    })).toThrow();

    expect(readFileSync(stalePath, 'utf8')).toBe('{"stale":true}\n');
    for (const ownerFile of ownerFiles) {
      if (ownerFile !== staleOwnerFile) {
        expect(existsSync(join(root, ownerFile))).toBe(false);
      }
    }
  });
});

describe('support-companion fixture lifecycle', () => {
  it('stands up a validated manifest, isolated cards, and support schemas without mutating Artie', async () => {
    const round = createRound();
    const primaryCardPath = join(round.runtimeRoot, 'companion-data', 'companion.json');
    const primaryBefore = readFileSync(primaryCardPath, 'utf8');

    const evidence = await standUpSupportFixtures(lifecycleInput(round));
    const paths = resolveSupportFixturePaths(round.runtimeRoot, round.systemDataDir);
    const manifest = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as {
      companions: Array<{ companionId: string; characterCardPath: string }>;
    };

    expect(evidence.status).toBe('active');
    expect(manifest.companions.map(companion => companion.companionId)).toEqual([
      PRIMARY_COMPANION_ID,
      ...SUPPORT_COMPANION_IDS,
    ]);
    expect(readFileSync(primaryCardPath, 'utf8')).toBe(primaryBefore);
    expect(round.database.calls).toEqual([
      'round-stopped',
      'absent:shakedown_support_mica',
      'absent:shakedown_support_lumen',
      'assert:shakedown_artie',
      'provision:shakedown_support_mica',
      'provision:shakedown_support_lumen',
      'assert:shakedown_support_mica',
      'assert:shakedown_support_lumen',
    ]);
    for (const support of manifest.companions.slice(1)) {
      expect(existsSync(join(round.runtimeRoot, support.characterCardPath))).toBe(true);
    }
    for (const support of paths.supportCompanions) {
      expect(existsSync(support.personalWorkspacePath)).toBe(true);
      expect(support.ownerFilePaths).toHaveLength(PER_COMPANION_OWNER_FILES.size);
      expect(support.ownerFilePaths.every(existsSync)).toBe(true);
    }
    expect(existsSync(paths.statePath)).toBe(true);
  });

  it('refuses to adopt a stale support role before provisioning or writing state', async () => {
    const round = createRound();
    const paths = resolveSupportFixturePaths(round.runtimeRoot, round.systemDataDir);
    round.database.roles.add(
      planPostgresTenantAccess({ schema: 'shakedown_support_mica' }).role,
    );

    await expect(standUpSupportFixtures(lifecycleInput(round)))
      .rejects.toThrow('tenant remained shakedown_support_mica');

    expect(round.database.calls).toEqual([
      'round-stopped',
      'absent:shakedown_support_mica',
    ]);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.supportRoot)).toBe(false);
  });

  it('rolls back every planned support schema and file when stand-up fails partway', async () => {
    const round = createRound();
    round.database.failProvisionSchema = 'shakedown_support_lumen';
    const paths = resolveSupportFixturePaths(round.runtimeRoot, round.systemDataDir);

    await expect(standUpSupportFixtures(lifecycleInput(round)))
      .rejects.toThrow('injected provision failure');

    expect(round.database.schemas).toEqual(new Set(['shakedown_artie']));
    expect(existsSync(paths.manifestPath)).toBe(false);
    expect(existsSync(paths.supportRoot)).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
    for (const support of paths.supportCompanions) {
      expect(existsSync(support.personalWorkspacePath)).toBe(false);
    }
  });

  it('refuses teardown after manifest tampering and preserves all evidence', async () => {
    const round = createRound();
    await standUpSupportFixtures(lifecycleInput(round));
    const paths = resolveSupportFixturePaths(round.runtimeRoot, round.systemDataDir);
    const manifest = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as {
      companions: Array<Record<string, unknown>>;
    };
    manifest.companions[1] = {
      ...manifest.companions[1],
      postgresSchema: 'unrelated_schema',
    };
    writeFileSync(paths.manifestPath, JSON.stringify(manifest));
    const callsBefore = [...round.database.calls];

    await expect(tearDownSupportFixtures(lifecycleInput(round)))
      .rejects.toThrow('manifest does not match the recorded fixture');

    expect(round.database.calls).toEqual(callsBefore);
    expect(existsSync(paths.manifestPath)).toBe(true);
    expect(existsSync(paths.supportRoot)).toBe(true);
    expect(existsSync(paths.statePath)).toBe(true);
  });

  it('refuses teardown while a runtime still holds the round database', async () => {
    const round = createRound();
    await standUpSupportFixtures(lifecycleInput(round));
    const paths = resolveSupportFixturePaths(round.runtimeRoot, round.systemDataDir);
    round.database.roundStopped = false;
    const callsBefore = [...round.database.calls];

    await expect(tearDownSupportFixtures(lifecycleInput(round)))
      .rejects.toThrow('round database still has runtime sessions');

    expect(round.database.calls).toEqual([...callsBefore, 'round-stopped']);
    expect(round.database.schemas).toEqual(new Set([
      'shakedown_artie',
      'shakedown_support_mica',
      'shakedown_support_lumen',
    ]));
    expect(existsSync(paths.manifestPath)).toBe(true);
    expect(existsSync(paths.supportRoot)).toBe(true);
    expect(existsSync(paths.statePath)).toBe(true);
  });

  it('tears down only support tenants and leaves no support fixture residue', async () => {
    const round = createRound();
    await standUpSupportFixtures(lifecycleInput(round));
    const paths = resolveSupportFixturePaths(round.runtimeRoot, round.systemDataDir);

    const evidence = await tearDownSupportFixtures(lifecycleInput(round));

    expect(evidence.status).toBe('clean');
    expect(round.database.schemas).toEqual(new Set(['shakedown_artie']));
    expect(round.database.calls.slice(-7)).toEqual([
      'round-stopped',
      'assert:shakedown_artie',
      'drop:shakedown_support_lumen',
      'drop:shakedown_support_mica',
      'absent:shakedown_support_mica',
      'absent:shakedown_support_lumen',
      'assert:shakedown_artie',
    ]);
    expect(existsSync(paths.manifestPath)).toBe(false);
    expect(existsSync(paths.supportRoot)).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
    for (const support of paths.supportCompanions) {
      expect(existsSync(support.personalWorkspacePath)).toBe(false);
      expect(support.ownerFilePaths.every(path => !existsSync(path))).toBe(true);
    }
    expect(existsSync(join(round.runtimeRoot, 'companion-data', 'companion.json'))).toBe(true);
  });
});
