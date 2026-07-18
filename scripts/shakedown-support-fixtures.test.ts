import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importCharacterCardFromPath } from '../src/core/identity/importer.js';
import type { PostgresTenantAccessPlan } from '../src/persistence/postgres/tenancy.js';
import {
  PRIMARY_COMPANION_ID,
  SUPPORT_COMPANION_IDS,
  type SupportFixtureDatabasePort,
  loadSupportFixtureContract,
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
  readonly present = new Set(['shakedown_artie']);
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
    if (!this.present.has(plan.schema)) {
      throw new Error(`missing schema ${plan.schema}`);
    }
  }

  async provision(plan: PostgresTenantAccessPlan): Promise<void> {
    this.calls.push(`provision:${plan.schema}`);
    if (plan.schema === this.failProvisionSchema) {
      throw new Error(`injected provision failure for ${plan.schema}`);
    }
    this.present.add(plan.schema);
  }

  async drop(plan: PostgresTenantAccessPlan): Promise<void> {
    this.calls.push(`drop:${plan.schema}`);
    this.present.delete(plan.schema);
  }

  async assertAbsent(plan: PostgresTenantAccessPlan): Promise<void> {
    this.calls.push(`absent:${plan.schema}`);
    if (this.present.has(plan.schema)) {
      throw new Error(`schema remained ${plan.schema}`);
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
      'assert:shakedown_artie',
      'provision:shakedown_support_mica',
      'provision:shakedown_support_lumen',
      'assert:shakedown_support_mica',
      'assert:shakedown_support_lumen',
    ]);
    for (const support of manifest.companions.slice(1)) {
      expect(existsSync(join(round.runtimeRoot, support.characterCardPath))).toBe(true);
    }
    expect(existsSync(paths.statePath)).toBe(true);
  });

  it('rolls back every planned support schema and file when stand-up fails partway', async () => {
    const round = createRound();
    round.database.failProvisionSchema = 'shakedown_support_lumen';
    const paths = resolveSupportFixturePaths(round.runtimeRoot, round.systemDataDir);

    await expect(standUpSupportFixtures(lifecycleInput(round)))
      .rejects.toThrow('injected provision failure');

    expect(round.database.present).toEqual(new Set(['shakedown_artie']));
    expect(existsSync(paths.manifestPath)).toBe(false);
    expect(existsSync(paths.supportRoot)).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
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
    expect(round.database.present).toEqual(new Set([
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
    expect(round.database.present).toEqual(new Set(['shakedown_artie']));
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
    expect(existsSync(join(round.runtimeRoot, 'companion-data', 'companion.json'))).toBe(true);
  });
});
