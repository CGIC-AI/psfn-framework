import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAutomataOwnerPolicy } from '../../faculties/automata/registry-contract.js';
import { validateIntakePolicy } from './intake-policy-config.js';
import { validatePartnerAffectShadowConfig } from './partner-affect-shadow-config.js';
import { migrateRequiredOwnerAdditions } from './required-owner-additions-migration.js';

let root: string | null = null;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function prepareLegacyOwners(): {
  dataDir: string;
  companionDataDir: string;
  settingsPath: string;
  intakePath: string;
  automataPath: string;
  partnerAffectPath: string;
} {
  root = mkdtempSync(join(tmpdir(), 'required-owner-additions-'));
  const dataDir = join(root, 'system');
  const companionDataDir = join(root, 'companion');
  mkdirSync(dataDir);
  mkdirSync(companionDataDir);

  const settingsPath = join(dataDir, 'settings.json');
  const intakePath = join(dataDir, 'intake-policy.json');
  const automataPath = join(dataDir, 'automata-policy.json');
  const partnerAffectPath = join(companionDataDir, 'partner-affect-shadow.json');
  const intake = readJson('config/intake-policy.seed.json');
  const automata = readJson('config/automata-policy.seed.json');
  delete intake.surfacePostures;
  const bus = automata.bus as Record<string, unknown>;
  delete bus.reindex;

  writeJson(settingsPath, { sessionHistoryBudgetPct: 9 });
  writeJson(intakePath, intake);
  writeJson(automataPath, automata);
  chmodSync(settingsPath, 0o644);
  chmodSync(intakePath, 0o644);
  chmodSync(automataPath, 0o644);
  return {
    dataDir,
    companionDataDir,
    settingsPath,
    intakePath,
    automataPath,
    partnerAffectPath,
  };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('migrateRequiredOwnerAdditions', () => {
  it('preflights, applies, and idempotently validates every owner addition required by startup', () => {
    const fixture = prepareLegacyOwners();
    const options = {
      dataDir: fixture.dataDir,
      companionDataDir: fixture.companionDataDir,
      seedDir: resolve('config'),
    };
    const before = {
      settings: readFileSync(fixture.settingsPath, 'utf8'),
      intake: readFileSync(fixture.intakePath, 'utf8'),
      automata: readFileSync(fixture.automataPath, 'utf8'),
    };

    expect(migrateRequiredOwnerAdditions(options)).toMatchObject({
      mode: 'dry-run',
      settings: { status: 'planned' },
      intakePolicy: { status: 'planned', addedPaths: ['surfacePostures'] },
      automataPolicy: { status: 'planned', addedPaths: ['bus.reindex'] },
      companionOwnerAdditions: {
        status: 'planned',
        addedPaths: ['partner-affect-shadow.json'],
      },
    });
    expect(readFileSync(fixture.settingsPath, 'utf8')).toBe(before.settings);
    expect(readFileSync(fixture.intakePath, 'utf8')).toBe(before.intake);
    expect(readFileSync(fixture.automataPath, 'utf8')).toBe(before.automata);
    expect(() => statSync(fixture.partnerAffectPath)).toThrow();

    expect(migrateRequiredOwnerAdditions({ ...options, apply: true })).toMatchObject({
      mode: 'apply',
      settings: { status: 'applied' },
      intakePolicy: { status: 'applied' },
      automataPolicy: { status: 'applied' },
      companionOwnerAdditions: { status: 'applied' },
    });
    const settings = readJson(fixture.settingsPath);
    expect(settings.sessionHistoryBudgetPct).toBe(9);
    expect(settings.lifecycleKubernetes).toBeDefined();
    validateIntakePolicy(readJson(fixture.intakePath), fixture.intakePath);
    parseAutomataOwnerPolicy(readJson(fixture.automataPath), fixture.automataPath);
    validatePartnerAffectShadowConfig(readJson(fixture.partnerAffectPath), fixture.partnerAffectPath);
    expect(statSync(fixture.settingsPath).mode & 0o777).toBe(0o644);
    expect(statSync(fixture.intakePath).mode & 0o777).toBe(0o644);
    expect(statSync(fixture.automataPath).mode & 0o777).toBe(0o644);
    expect(statSync(fixture.partnerAffectPath).mode & 0o777).toBe(0o640);

    const settledBytes = {
      settings: readFileSync(fixture.settingsPath, 'utf8'),
      intake: readFileSync(fixture.intakePath, 'utf8'),
      automata: readFileSync(fixture.automataPath, 'utf8'),
      partnerAffect: readFileSync(fixture.partnerAffectPath, 'utf8'),
    };
    expect(migrateRequiredOwnerAdditions({ ...options, apply: true })).toMatchObject({
      mode: 'apply',
      settings: { status: 'not_needed' },
      intakePolicy: { status: 'not_needed' },
      automataPolicy: { status: 'not_needed' },
      companionOwnerAdditions: { status: 'not_needed' },
    });
    expect(readFileSync(fixture.settingsPath, 'utf8')).toBe(settledBytes.settings);
    expect(readFileSync(fixture.intakePath, 'utf8')).toBe(settledBytes.intake);
    expect(readFileSync(fixture.automataPath, 'utf8')).toBe(settledBytes.automata);
    expect(readFileSync(fixture.partnerAffectPath, 'utf8')).toBe(settledBytes.partnerAffect);
  });

  it('repairs mode-only drift on already current owners', () => {
    const fixture = prepareLegacyOwners();
    const options = {
      dataDir: fixture.dataDir,
      companionDataDir: fixture.companionDataDir,
      seedDir: resolve('config'),
      apply: true,
    };
    migrateRequiredOwnerAdditions(options);
    for (const path of [
      fixture.settingsPath,
      fixture.intakePath,
      fixture.automataPath,
      fixture.partnerAffectPath,
    ]) chmodSync(path, 0o600);

    expect(migrateRequiredOwnerAdditions({ ...options, apply: false })).toMatchObject({
      settings: { status: 'planned', updatedPaths: ['mode'] },
      intakePolicy: { status: 'planned', updatedPaths: ['mode'] },
      automataPolicy: { status: 'planned', updatedPaths: ['mode'] },
      companionOwnerAdditions: { status: 'planned' },
    });
    expect(migrateRequiredOwnerAdditions(options)).toMatchObject({
      settings: { status: 'applied', updatedPaths: ['mode'] },
      intakePolicy: { status: 'applied', updatedPaths: ['mode'] },
      automataPolicy: { status: 'applied', updatedPaths: ['mode'] },
      companionOwnerAdditions: { status: 'applied' },
    });
    expect(statSync(fixture.settingsPath).mode & 0o777).toBe(0o644);
    expect(statSync(fixture.intakePath).mode & 0o777).toBe(0o644);
    expect(statSync(fixture.automataPath).mode & 0o777).toBe(0o644);
    expect(statSync(fixture.partnerAffectPath).mode & 0o777).toBe(0o640);
  });

  it('fails preflight without mutating any owner when a present addition is malformed', () => {
    const fixture = prepareLegacyOwners();
    const malformed = readJson(fixture.automataPath);
    (malformed.bus as Record<string, unknown>).reindex = null;
    writeJson(fixture.automataPath, malformed);
    const before = readFileSync(fixture.settingsPath, 'utf8');

    expect(() => migrateRequiredOwnerAdditions({
      dataDir: fixture.dataDir,
      companionDataDir: fixture.companionDataDir,
      seedDir: resolve('config'),
      apply: true,
    })).toThrow(/bus\.reindex/);
    expect(readFileSync(fixture.settingsPath, 'utf8')).toBe(before);
    expect(() => statSync(fixture.partnerAffectPath)).toThrow();
  });

  it('seeds newly required system owners only when they are absent', () => {
    const fixture = prepareLegacyOwners();
    rmSync(fixture.intakePath);
    rmSync(fixture.automataPath);
    const options = {
      dataDir: fixture.dataDir,
      companionDataDir: fixture.companionDataDir,
      seedDir: resolve('config'),
    };

    expect(migrateRequiredOwnerAdditions(options)).toMatchObject({
      intakePolicy: { status: 'planned', addedPaths: ['intake-policy.json'] },
      automataPolicy: { status: 'planned', addedPaths: ['automata-policy.json'] },
    });
    expect(() => statSync(fixture.intakePath)).toThrow();
    expect(() => statSync(fixture.automataPath)).toThrow();

    expect(migrateRequiredOwnerAdditions({ ...options, apply: true })).toMatchObject({
      intakePolicy: { status: 'applied', addedPaths: ['intake-policy.json'] },
      automataPolicy: { status: 'applied', addedPaths: ['automata-policy.json'] },
    });
    validateIntakePolicy(readJson(fixture.intakePath), fixture.intakePath);
    parseAutomataOwnerPolicy(readJson(fixture.automataPath), fixture.automataPath);
  });
});
