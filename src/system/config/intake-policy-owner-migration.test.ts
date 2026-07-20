import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSkillWriteSinkRule,
  INTAKE_POLICY_FILE_NAME,
  INTAKE_POLICY_SCHEMA_VERSION,
  loadIntakePolicyConfig,
} from './intake-policy-config.js';
import { migrateIntakePolicyOwner } from './intake-policy-owner-migration.js';

describe('intake policy owner migration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeOwner(): {
    dataDir: string;
    filePath: string;
    legacy: Record<string, unknown>;
  } {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-policy-migration-'));
    tempDirs.push(dataDir);
    mkdirSync(dataDir, { recursive: true });
    const current = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    const legacy = structuredClone(current);
    legacy.schemaVersion = 1;
    const sinkGates = legacy.sinkGates as {
      sinks: Record<string, unknown>;
    };
    delete sinkGates.sinks.skill_write;
    const filePath = join(dataDir, INTAKE_POLICY_FILE_NAME);
    writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`);
    return { dataDir, filePath, legacy };
  }

  it('dry-runs without changing the v1 owner, then atomically applies v2', () => {
    const { dataDir, filePath } = makeOwner();
    const before = readFileSync(filePath, 'utf8');

    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      fromSchemaVersion: 1,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      addedPaths: ['sinkGates.sinks.skill_write'],
    });
    expect(readFileSync(filePath, 'utf8')).toBe(before);

    expect(migrateIntakePolicyOwner({ dataDir, apply: true })).toMatchObject({
      mode: 'apply',
      status: 'applied',
      fromSchemaVersion: 1,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
    });
    const loaded = loadIntakePolicyConfig(dataDir);
    expect(loaded.schemaVersion).toBe(INTAKE_POLICY_SCHEMA_VERSION);
    expect(loaded.sinkGates.sinks.skill_write).toEqual(createSkillWriteSinkRule());
    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      status: 'not_needed',
      fromSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
    });
  });

  it('fails closed on malformed or ambiguous legacy sink maps', () => {
    const missingSink = makeOwner();
    const missingRaw = structuredClone(missingSink.legacy);
    const missingGates = missingRaw.sinkGates as { sinks: Record<string, unknown> };
    delete missingGates.sinks.memory_write;
    writeFileSync(missingSink.filePath, `${JSON.stringify(missingRaw, null, 2)}\n`);
    expect(() => migrateIntakePolicyOwner({
      dataDir: missingSink.dataDir,
      apply: true,
    })).toThrow(/sinkGates\.sinks\.memory_write is required/);

    const ambiguous = makeOwner();
    const ambiguousRaw = structuredClone(ambiguous.legacy);
    const ambiguousGates = ambiguousRaw.sinkGates as { sinks: Record<string, unknown> };
    ambiguousGates.sinks.skill_write = createSkillWriteSinkRule();
    writeFileSync(ambiguous.filePath, `${JSON.stringify(ambiguousRaw, null, 2)}\n`);
    expect(() => migrateIntakePolicyOwner({
      dataDir: ambiguous.dataDir,
      apply: true,
    })).toThrow(/refuses schemaVersion 1 with an existing skill_write sink/);
  });

  it('does not treat a v2 owner missing skill_write as migratable', () => {
    const { dataDir, filePath, legacy } = makeOwner();
    const invalidV2 = structuredClone(legacy);
    invalidV2.schemaVersion = INTAKE_POLICY_SCHEMA_VERSION;
    writeFileSync(filePath, `${JSON.stringify(invalidV2, null, 2)}\n`);

    expect(() => migrateIntakePolicyOwner({ dataDir, apply: true }))
      .toThrow(/sinkGates\.sinks\.skill_write is required/);
    expect(() => loadIntakePolicyConfig(dataDir))
      .toThrow(/sinkGates\.sinks\.skill_write is required/);
  });
});
