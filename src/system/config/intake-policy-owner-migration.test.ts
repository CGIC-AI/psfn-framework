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
    delete legacy.urlScanner;
    delete (legacy.sourceRiskTiers as Record<string, unknown>).companion_self;
    Object.assign(legacy.l2Screener as Record<string, unknown>, {
      model: 'legacy/l2',
    });
    Object.assign(legacy.l3Screener as Record<string, unknown>, {
      model: 'legacy/l3',
      secondaryModel: 'legacy/l3-secondary',
    });
    Object.assign(legacy.visionScreener as Record<string, unknown>, {
      model: 'legacy/vision',
    });
    const sinkGates = legacy.sinkGates as {
      sinks: Record<string, unknown>;
    };
    delete sinkGates.sinks.skill_write;
    for (const sink of ['persona_mutation', 'trust_mutation']) {
      (sinkGates.sinks[sink] as Record<string, unknown>).maxSourceRiskTier = 'standard';
    }
    const filePath = join(dataDir, INTAKE_POLICY_FILE_NAME);
    writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`);
    return { dataDir, filePath, legacy };
  }

  it('dry-runs without changing the v1 owner, then atomically applies v4', () => {
    const { dataDir, filePath } = makeOwner();
    const before = readFileSync(filePath, 'utf8');

    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      fromSchemaVersion: 1,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      addedPaths: [
        'urlScanner',
        'sinkGates.sinks.skill_write',
        'sourceRiskTiers.companion_self',
      ],
      removedPaths: [
        'l2Screener.model',
        'l3Screener.model',
        'l3Screener.secondaryModel',
        'visionScreener.model',
      ],
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
    expect(loaded.sourceRiskTiers.companion_self).toBe('trusted');
    expect(loaded.sinkGates.sinks.skill_write).toEqual(createSkillWriteSinkRule());
    expect(loaded.sinkGates.sinks.persona_mutation.maxSourceRiskTier).toBe('standard');
    expect(loaded.sinkGates.sinks.trust_mutation.maxSourceRiskTier).toBe('standard');
    expect(loaded.l3Screener.dualModel).toBe(false);
    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      status: 'not_needed',
      fromSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
    });
  });

  it('upgrades a v2 owner with the trusted companion-self source class', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-policy-migration-'));
    tempDirs.push(dataDir);
    const filePath = join(dataDir, INTAKE_POLICY_FILE_NAME);
    const legacy = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    legacy.schemaVersion = 2;
    delete legacy.urlScanner;
    delete (legacy.sourceRiskTiers as Record<string, unknown>).companion_self;
    const sinks = (legacy.sinkGates as { sinks: Record<string, Record<string, unknown>> }).sinks;
    sinks.persona_mutation.maxSourceRiskTier = 'standard';
    sinks.trust_mutation.maxSourceRiskTier = 'standard';
    writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`);

    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      status: 'planned',
      fromSchemaVersion: 2,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      addedPaths: ['urlScanner', 'sourceRiskTiers.companion_self'],
    });
    expect(migrateIntakePolicyOwner({ dataDir, apply: true })).toMatchObject({
      status: 'applied',
      fromSchemaVersion: 2,
    });
    const loaded = loadIntakePolicyConfig(dataDir);
    expect(loaded.sourceRiskTiers.companion_self).toBe('trusted');
    expect(loaded.sinkGates.sinks.persona_mutation.maxSourceRiskTier).toBe('standard');
    expect(loaded.sinkGates.sinks.trust_mutation.maxSourceRiskTier).toBe('standard');
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
    const { dataDir, filePath } = makeOwner();
    const invalidV2 = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    invalidV2.schemaVersion = 2;
    delete (invalidV2.sourceRiskTiers as Record<string, unknown>).companion_self;
    const sinkGates = invalidV2.sinkGates as { sinks: Record<string, unknown> };
    delete sinkGates.sinks.skill_write;
    writeFileSync(filePath, `${JSON.stringify(invalidV2, null, 2)}\n`);

    expect(() => migrateIntakePolicyOwner({ dataDir, apply: true }))
      .toThrow(/sinkGates\.sinks\.skill_write is required/);
    expect(() => loadIntakePolicyConfig(dataDir))
      .toThrow(/schemaVersion 2 owners require the explicit migrate:intake-policy-owner command/);
  });

  it('upgrades a v3 owner with URL scheme policy from the distributed seed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-policy-migration-'));
    tempDirs.push(dataDir);
    const filePath = join(dataDir, INTAKE_POLICY_FILE_NAME);
    const legacy = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    legacy.schemaVersion = 3;
    delete legacy.urlScanner;
    writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`);

    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      status: 'planned',
      fromSchemaVersion: 3,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      addedPaths: ['urlScanner'],
    });
    expect(migrateIntakePolicyOwner({ dataDir, apply: true })).toMatchObject({
      status: 'applied',
      fromSchemaVersion: 3,
    });
    expect(loadIntakePolicyConfig(dataDir).urlScanner.schemeActions).toMatchObject({
      javascript: 'deny',
      mailto: 'allow',
    });
  });

  it('repairs a v4 owner created before the companion-self security remediation', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-policy-migration-'));
    tempDirs.push(dataDir);
    const filePath = join(dataDir, INTAKE_POLICY_FILE_NAME);
    const affectedV3 = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    delete (affectedV3.sourceRiskTiers as Record<string, unknown>).companion_self;
    const sinks = (affectedV3.sinkGates as {
      sinks: Record<string, Record<string, unknown>>;
    }).sinks;
    sinks.persona_mutation.maxSourceRiskTier = 'untrusted';
    sinks.trust_mutation.maxSourceRiskTier = 'untrusted';
    writeFileSync(filePath, `${JSON.stringify(affectedV3, null, 2)}\n`);

    expect(() => loadIntakePolicyConfig(dataDir))
      .toThrow(/sourceRiskTiers\.companion_self is required/);
    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      status: 'planned',
      fromSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      addedPaths: ['sourceRiskTiers.companion_self'],
      updatedPaths: [
        'sinkGates.sinks.persona_mutation.maxSourceRiskTier',
        'sinkGates.sinks.trust_mutation.maxSourceRiskTier',
      ],
    });
    expect(migrateIntakePolicyOwner({ dataDir, apply: true })).toMatchObject({
      status: 'applied',
    });
    const loaded = loadIntakePolicyConfig(dataDir);
    expect(loaded.sourceRiskTiers.companion_self).toBe('trusted');
    expect(loaded.sinkGates.sinks.persona_mutation.maxSourceRiskTier).toBe('standard');
    expect(loaded.sinkGates.sinks.trust_mutation.maxSourceRiskTier).toBe('standard');
  });

  it('dry-runs and atomically removes retired screener model keys from a v4 owner', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-policy-migration-'));
    tempDirs.push(dataDir);
    const filePath = join(dataDir, INTAKE_POLICY_FILE_NAME);
    const current = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    const withRetiredModels = structuredClone(current);
    Object.assign(withRetiredModels.l2Screener as Record<string, unknown>, {
      model: 'legacy/l2',
    });
    Object.assign(withRetiredModels.l3Screener as Record<string, unknown>, {
      model: 'legacy/l3',
      secondaryModel: 'legacy/l3-secondary',
    });
    Object.assign(withRetiredModels.visionScreener as Record<string, unknown>, {
      model: 'legacy/vision',
    });
    writeFileSync(filePath, `${JSON.stringify(withRetiredModels, null, 2)}\n`);

    expect(() => loadIntakePolicyConfig(dataDir))
      .toThrow(/retired free-text model keys.*migrate:intake-policy-owner/is);
    const before = readFileSync(filePath, 'utf8');
    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      fromSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      removedPaths: [
        'l2Screener.model',
        'l3Screener.model',
        'l3Screener.secondaryModel',
        'visionScreener.model',
      ],
    });
    expect(readFileSync(filePath, 'utf8')).toBe(before);

    expect(migrateIntakePolicyOwner({ dataDir, apply: true })).toMatchObject({
      mode: 'apply',
      status: 'applied',
      removedPaths: [
        'l2Screener.model',
        'l3Screener.model',
        'l3Screener.secondaryModel',
        'visionScreener.model',
      ],
    });
    expect(loadIntakePolicyConfig(dataDir).visionScreener.enabled).toBe(true);
  });

  it('upgrades a real v4 owner (no screeningPool) to v5, injecting screeningPool from the seed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-policy-migration-'));
    tempDirs.push(dataDir);
    const filePath = join(dataDir, INTAKE_POLICY_FILE_NAME);
    const legacy = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    legacy.schemaVersion = 4;
    delete legacy.screeningPool;
    writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`);

    // Runtime load refuses a v4 owner under the v5 contract.
    expect(() => loadIntakePolicyConfig(dataDir))
      .toThrow(/schemaVersion 4 owners require the explicit migrate:intake-policy-owner command/);

    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({
      status: 'planned',
      fromSchemaVersion: 4,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      addedPaths: ['screeningPool'],
    });
    expect(migrateIntakePolicyOwner({ dataDir, apply: true })).toMatchObject({
      status: 'applied',
      fromSchemaVersion: 4,
    });
    const loaded = loadIntakePolicyConfig(dataDir);
    expect(loaded.schemaVersion).toBe(INTAKE_POLICY_SCHEMA_VERSION);
    expect(loaded.screeningPool.concurrency).toBeGreaterThanOrEqual(2);
    expect(loaded.screeningPool.concurrency).toBeLessThanOrEqual(4);
    // A second pass is a no-op.
    expect(migrateIntakePolicyOwner({ dataDir })).toMatchObject({ status: 'not_needed' });
  });

  it('injects screeningPool into a current-version owner missing the section', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-policy-migration-'));
    tempDirs.push(dataDir);
    const filePath = join(dataDir, INTAKE_POLICY_FILE_NAME);
    const current = JSON.parse(
      readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
    ) as Record<string, unknown>;
    delete current.screeningPool;
    writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`);

    expect(() => loadIntakePolicyConfig(dataDir)).toThrow(/screeningPool must be an object/);
    expect(migrateIntakePolicyOwner({ dataDir, apply: true })).toMatchObject({
      status: 'applied',
      fromSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      addedPaths: ['screeningPool'],
    });
    expect(loadIntakePolicyConfig(dataDir).screeningPool.concurrency).toBeGreaterThanOrEqual(2);
  });
});
