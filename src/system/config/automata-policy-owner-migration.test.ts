import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAutomataOwnerPolicy } from '../../faculties/automata/registry-contract.js';
import { migrateAutomataPolicyOwner } from './automata-policy-owner-migration.js';

const PRE_BIOGRAPHY_OWNER_FIXTURE = resolve(
  'src/system/config/fixtures/automata-policy.pre-biography-owner.json',
);

let root: string | null = null;

interface Fixture {
  dataDir: string;
  automataPath: string;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readBus(path: string): Record<string, unknown> {
  return readJson(path).bus as Record<string, unknown>;
}

/**
 * An owner file written from the seed as it stood before o61vb.16 registered
 * the two biography classes: every key the operator could have known about is
 * present, and neither bus list names memory.biography_synthesis or
 * memory.biography_review.
 */
function prepareOwnerBefore(mutate?: (raw: Record<string, unknown>) => void): Fixture {
  root = mkdtempSync(join(tmpdir(), 'automata-policy-owner-migration-'));
  const dataDir = join(root, 'system');
  mkdirSync(dataDir);
  const automataPath = join(dataDir, 'automata-policy.json');
  copyFileSync(PRE_BIOGRAPHY_OWNER_FIXTURE, automataPath);
  if (mutate) {
    const raw = readJson(automataPath);
    mutate(raw);
    writeFileSync(automataPath, `${JSON.stringify(raw, null, 2)}\n`);
  }
  chmodSync(automataPath, 0o644);
  return { dataDir, automataPath };
}

function migrate(fixture: Fixture, apply: boolean) {
  return migrateAutomataPolicyOwner({
    dataDir: fixture.dataDir,
    seedDir: resolve('config'),
    ...(apply ? { apply: true } : {}),
  });
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('migrateAutomataPolicyOwner bus class assignments', () => {
  it('backfills classes registered after the owner was written so the registry contract passes', () => {
    const fixture = prepareOwnerBefore();
    const before = readFileSync(fixture.automataPath, 'utf8');
    expect(() => parseAutomataOwnerPolicy(readJson(fixture.automataPath), fixture.automataPath))
      .toThrow(/does not assign bus policy for: memory\.biography_synthesis, memory\.biography_review/);

    expect(migrate(fixture, false)).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      addedPaths: [
        'bus.eligibleClasses[memory.biography_synthesis]',
        'bus.eligibleClasses[memory.biography_review]',
      ],
    });
    expect(readFileSync(fixture.automataPath, 'utf8')).toBe(before);

    expect(migrate(fixture, true)).toMatchObject({
      mode: 'apply',
      status: 'applied',
      addedPaths: [
        'bus.eligibleClasses[memory.biography_synthesis]',
        'bus.eligibleClasses[memory.biography_review]',
      ],
    });
    const migrated = parseAutomataOwnerPolicy(
      readJson(fixture.automataPath),
      fixture.automataPath,
    );
    expect(migrated.bus.eligibleClasses).toContain('memory.biography_synthesis');
    expect(migrated.bus.eligibleClasses).toContain('memory.biography_review');

    const settled = readFileSync(fixture.automataPath, 'utf8');
    expect(migrate(fixture, true)).toMatchObject({ status: 'not_needed' });
    expect(readFileSync(fixture.automataPath, 'utf8')).toBe(settled);
  });

  it('preserves every operator-set assignment and value while seeding the unknown class', () => {
    const fixture = prepareOwnerBefore((raw) => {
      const bus = raw.bus as Record<string, unknown>;
      // The operator excluded a class the seed makes eligible, and retuned a
      // query budget. Neither may be reverted by an additive migration.
      bus.eligibleClasses = (bus.eligibleClasses as string[])
        .filter(classId => classId !== 'memory.sleeptime');
      bus.excludedClasses = [...bus.excludedClasses as string[], 'memory.sleeptime'];
      (bus.query as Record<string, unknown>).maxQueryChars = 999;
    });

    expect(migrate(fixture, true)).toMatchObject({
      status: 'applied',
      addedPaths: [
        'bus.eligibleClasses[memory.biography_synthesis]',
        'bus.eligibleClasses[memory.biography_review]',
      ],
    });

    const migrated = parseAutomataOwnerPolicy(
      readJson(fixture.automataPath),
      fixture.automataPath,
    );
    expect(migrated.bus.eligibleClasses).not.toContain('memory.sleeptime');
    expect(migrated.bus.excludedClasses).toContain('memory.sleeptime');
    expect(migrated.bus.query.maxQueryChars).toBe(999);
    expect(migrated.bus.eligibleClasses).toContain('memory.biography_synthesis');
    expect(migrated.bus.eligibleClasses).toContain('memory.biography_review');
    // The operator's own ordering is untouched; new classes append at the end.
    expect(migrated.bus.eligibleClasses.slice(-2)).toEqual([
      'memory.biography_synthesis',
      'memory.biography_review',
    ]);
  });

  it('rejects a malformed bus class list instead of appending to it', () => {
    const fixture = prepareOwnerBefore((raw) => {
      (raw.bus as Record<string, unknown>).eligibleClasses = {};
    });
    const before = readFileSync(fixture.automataPath, 'utf8');

    expect(() => migrate(fixture, true)).toThrow(/bus\.eligibleClasses must be an array/);
    expect(readFileSync(fixture.automataPath, 'utf8')).toBe(before);
    expect(readBus(fixture.automataPath).eligibleClasses).toEqual({});
  });

  it('rejects an unknown bus key even while a class assignment is missing', () => {
    const fixture = prepareOwnerBefore((raw) => {
      (raw.bus as Record<string, unknown>).bogus = {};
    });
    const before = readFileSync(fixture.automataPath, 'utf8');

    expect(() => migrate(fixture, true)).toThrow(/bus contains unknown keys: bogus/);
    expect(readFileSync(fixture.automataPath, 'utf8')).toBe(before);
  });

  it('rejects a non-object bus block', () => {
    const fixture = prepareOwnerBefore((raw) => {
      raw.bus = null;
    });
    const before = readFileSync(fixture.automataPath, 'utf8');

    expect(() => migrate(fixture, true)).toThrow(/bus must be an object/);
    expect(readFileSync(fixture.automataPath, 'utf8')).toBe(before);
  });
});
