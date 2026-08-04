import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOwnerFileModeExpectations,
  canonicalOwnerFileMode,
  formatOwnerFileMode,
  OWNER_FILE_MODE_AUTH_ADJACENT,
  OWNER_FILE_MODE_COMPANION_POLICY,
  OWNER_FILE_MODE_FLEET_SHARED,
  verifyOwnerFileModes,
  type OwnerFileModeExpectation,
} from './owner-file-modes.js';
import {
  describeStartupOwnerFileChecks,
  type OwnerFileSeedDescriptor,
} from './startup-owner-files.js';
import { FLEET_AUTH_FILE_NAME } from './fleet-auth-config.js';

const COMPANION_IDS = [
  '1b2f6c9e-0000-4000-8000-aaaaaaaaaaaa',
  '2c3a7d0f-1111-4000-8000-bbbbbbbbbbbb',
  '3d4b8e1a-2222-4000-8000-cccccccccccc',
] as const;

function systemDescriptors(): OwnerFileSeedDescriptor[] {
  return describeStartupOwnerFileChecks().filter((descriptor) => descriptor.scope === 'system');
}

function companionDescriptors(): OwnerFileSeedDescriptor[] {
  return describeStartupOwnerFileChecks().filter((descriptor) => descriptor.scope === 'companion');
}

describe('canonicalOwnerFileMode', () => {
  it('derives sensitivity-specific modes from the owner-file registry', () => {
    expect(canonicalOwnerFileMode({ ownerFileName: FLEET_AUTH_FILE_NAME, scope: 'system' }))
      .toBe(OWNER_FILE_MODE_AUTH_ADJACENT);
    expect(canonicalOwnerFileMode({ ownerFileName: 'charge-policy.json', scope: 'companion' }))
      .toBe(OWNER_FILE_MODE_COMPANION_POLICY);
    expect(canonicalOwnerFileMode({ ownerFileName: 'settings.json', scope: 'system' }))
      .toBe(OWNER_FILE_MODE_FLEET_SHARED);
    expect(formatOwnerFileMode(OWNER_FILE_MODE_AUTH_ADJACENT)).toBe('600');
    expect(formatOwnerFileMode(OWNER_FILE_MODE_COMPANION_POLICY)).toBe('640');
    expect(formatOwnerFileMode(OWNER_FILE_MODE_FLEET_SHARED)).toBe('644');
  });

  it('stamps every registry descriptor with its canonical mode', () => {
    for (const descriptor of describeStartupOwnerFileChecks()) {
      expect(descriptor.canonicalMode).toBe(
        canonicalOwnerFileMode({
          ownerFileName: descriptor.ownerFileName,
          scope: descriptor.scope,
        }),
      );
    }
    expect(
      systemDescriptors().find((d) => d.ownerFileName === FLEET_AUTH_FILE_NAME)?.canonicalMode,
    ).toBe(0o600);
    expect(companionDescriptors().every((d) => d.canonicalMode === 0o640)).toBe(true);
  });
});

describe('owner-file mode verification with a three-companion fixture', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  interface Fixture {
    dataDir: string;
    companionRoots: Array<{ companionId: string; companionDataDir: string }>;
    expectations: OwnerFileModeExpectation[];
  }

  /**
   * Materialize the startup-valid three-companion fleet layout: one system
   * root plus three UUID-keyed companion roots, every owner file at its
   * canonical sensitivity-specific mode. fleet-auth.json is left absent (its
   * loader tolerates absence) unless includeFleetAuth is set.
   */
  function buildFixture(options: { includeFleetAuth?: boolean } = {}): Fixture {
    const root = mkdtempSync(join(tmpdir(), 'psfn-owner-modes-'));
    tempDirs.push(root);
    const dataDir = join(root, 'system-data');
    mkdirSync(dataDir, { recursive: true });

    for (const descriptor of systemDescriptors()) {
      if (descriptor.ownerFileName === FLEET_AUTH_FILE_NAME && !options.includeFleetAuth) {
        continue;
      }
      const path = join(dataDir, descriptor.ownerFileName);
      writeFileSync(path, '{}\n', 'utf8');
      chmodSync(path, descriptor.canonicalMode);
    }

    const companionRoots = COMPANION_IDS.map((companionId) => {
      const companionDataDir = join(root, 'companions', companionId);
      mkdirSync(companionDataDir, { recursive: true });
      for (const descriptor of companionDescriptors()) {
        const path = join(companionDataDir, descriptor.ownerFileName);
        writeFileSync(path, '{}\n', 'utf8');
        chmodSync(path, descriptor.canonicalMode);
      }
      return { companionId, companionDataDir };
    });

    const expectations = buildOwnerFileModeExpectations({
      dataDir,
      companionRoots,
      descriptors: describeStartupOwnerFileChecks(),
    });
    return { dataDir, companionRoots, expectations };
  }

  it('expands system owners once and companion owners per exact root', () => {
    const fixture = buildFixture();
    const expectedCount = systemDescriptors().length
      + COMPANION_IDS.length * companionDescriptors().length;
    expect(fixture.expectations).toHaveLength(expectedCount);
    for (const companionId of COMPANION_IDS) {
      const scoped = fixture.expectations.filter((entry) =>
        entry.path.includes(join('companions', companionId)));
      expect(scoped).toHaveLength(companionDescriptors().length);
      expect(scoped.every((entry) => entry.label.startsWith(`companion ${companionId} `))).toBe(true);
    }
  });

  it('accepts canonical sensitivity-specific modes across the whole fleet', () => {
    const fixture = buildFixture({ includeFleetAuth: true });
    const result = verifyOwnerFileModes(fixture.expectations);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.verified).toHaveLength(fixture.expectations.length);
    expect(result.skippedMissingOptional).toEqual([]);
  });

  it('records an absent optional-when-missing owner without failing', () => {
    const fixture = buildFixture();
    const result = verifyOwnerFileModes(fixture.expectations);

    expect(result.ok).toBe(true);
    expect(result.skippedMissingOptional).toEqual([
      join(fixture.dataDir, FLEET_AUTH_FILE_NAME),
    ]);
  });

  it('rejects a 664 assumption on a per-companion policy owner', () => {
    const fixture = buildFixture();
    const drifted = join(
      fixture.companionRoots[1].companionDataDir,
      'charge-policy.json',
    );
    chmodSync(drifted, 0o664);

    const result = verifyOwnerFileModes(fixture.expectations);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(drifted);
    expect(result.errors[0]).toContain('expected 640, found 664');
  });

  it('rejects a drifted system-owner mode', () => {
    const fixture = buildFixture();
    const drifted = join(fixture.dataDir, 'settings.json');
    chmodSync(drifted, 0o600);

    const result = verifyOwnerFileModes(fixture.expectations);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) =>
      error.includes(drifted) && error.includes('expected 644, found 600'))).toBe(true);
  });

  it('rejects ownership drift against the expected runtime identity', () => {
    const fixture = buildFixture();
    const result = verifyOwnerFileModes(fixture.expectations, {
      expectedOwner: { uid: 999, gid: 999 },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((error) => error.includes('ownership drift'))).toBe(true);
    expect(result.errors[0]).toContain('expected 999:999');
  });

  it('fails closed on a missing required owner file', () => {
    const fixture = buildFixture();
    const missing = join(fixture.companionRoots[2].companionDataDir, 'scheduler.json');
    rmSync(missing);

    const result = verifyOwnerFileModes(fixture.expectations);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes(missing))).toBe(true);
  });
});
