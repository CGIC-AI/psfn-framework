import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveCompanionFleetPaths, type CompanionsFleetConfig } from '../../system/config/companions-config.js';
import {
  COMPANION_LIBRARY_MANIFEST_FILE,
  COMPANION_LIBRARY_SEED_VERSION,
  provisionFleetWorkspaces,
  SHARED_WORKSPACE_POLICY,
} from './provisioning.js';
import { createHash } from 'node:crypto';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EXAMPLE_BUNDLE_DIR = join(REPO_ROOT, 'companion_docs.example');

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const FLEET: CompanionsFleetConfig = {
  postgres: {
    sharedMigrationRole: 'shared_migration',
    sharedMigrationDatabaseUrlRef: {
      kind: 'env',
      envName: 'SHARED_MIGRATION_DATABASE_URL',
    },
  },
  companions: [{
    companionId: COMPANION_ID,
    companionDataDir: 'companions/one',
    characterCardPath: 'companions/one/card.json',
    postgresSchema: 'companion_one',
    postgresRole: 'companion_one_runtime',
    postgresDatabaseUrlRef: {
      kind: 'env',
      envName: 'COMPANION_ONE_DATABASE_URL',
    },
  }],
};

describe('fleet workspace provisioning', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeFixture() {
    const root = mkdtempSync(join(tmpdir(), 'psfn-workspace-provision-'));
    const source = mkdtempSync(join(tmpdir(), 'psfn-workspace-seed-'));
    roots.push(root, source);
    writeFileSync(join(source, 'welcome.md'), 'seed welcome\n');
    writeFileSync(join(source, 'privacy-boundary-reference.md'), 'seed privacy\n');
    writeFileSync(join(source, 'live_verification_checklist.md'), 'seed checklist\n');
    writeFileSync(join(source, COMPANION_LIBRARY_MANIFEST_FILE), `${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: COMPANION_LIBRARY_SEED_VERSION,
      files: [
        { path: 'welcome.md', sha256: createHash('sha256').update('seed welcome\n').digest('hex') },
        { path: 'privacy-boundary-reference.md', sha256: createHash('sha256').update('seed privacy\n').digest('hex') },
        { path: 'live_verification_checklist.md', sha256: createHash('sha256').update('seed checklist\n').digest('hex') },
      ],
    }, null, 2)}\n`);
    return { root, source, fleet: resolveCompanionFleetPaths(FLEET, root) };
  }

  it('provisions isolated personal roots, one governed shared root, and a versioned seed', () => {
    const fixture = makeFixture();
    provisionFleetWorkspaces(fixture.fleet, { companionLibrarySourceDir: fixture.source });
    const personal = fixture.fleet.companions[0].personalWorkspacePath;

    expect(readFileSync(join(personal, 'docs/companion-library/welcome.md'), 'utf8'))
      .toBe('seed welcome\n');
    expect(readFileSync(join(personal, 'docs/companion-library/live_verification_checklist.md'), 'utf8'))
      .toBe('seed checklist\n');
    expect(JSON.parse(readFileSync(
      join(personal, '.psfn/seed-bundles', `${COMPANION_LIBRARY_SEED_VERSION}.json`),
      'utf8',
    ))).toMatchObject({ bundleVersion: COMPANION_LIBRARY_SEED_VERSION, overwritePolicy: 'never' });
    expect(JSON.parse(readFileSync(join(fixture.fleet.sharedWorkspacePath, 'policy.json'), 'utf8')))
      .toEqual(SHARED_WORKSPACE_POLICY);
  });

  it('never overwrites companion-authored files when applying the seed', () => {
    const fixture = makeFixture();
    const personal = fixture.fleet.companions[0].personalWorkspacePath;
    mkdirSync(join(personal, 'docs/companion-library'), { recursive: true });
    writeFileSync(join(personal, 'docs/companion-library/welcome.md'), 'personal version\n');

    provisionFleetWorkspaces(fixture.fleet, { companionLibrarySourceDir: fixture.source });

    expect(readFileSync(join(personal, 'docs/companion-library/welcome.md'), 'utf8'))
      .toBe('personal version\n');
  });

  it('fails closed when the shared policy was modified outside the governed surface', () => {
    const fixture = makeFixture();
    mkdirSync(fixture.fleet.sharedWorkspacePath, { recursive: true });
    writeFileSync(join(fixture.fleet.sharedWorkspacePath, 'policy.json'), '{}\n');

    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: fixture.source,
    })).toThrow(/policy.*malformed or differs/);
  });

  it('fails closed when seed content changes without an immutable manifest update', () => {
    const fixture = makeFixture();
    provisionFleetWorkspaces(fixture.fleet, { companionLibrarySourceDir: fixture.source });
    writeFileSync(join(fixture.source, 'welcome.md'), 'silently changed\n');

    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: fixture.source,
    })).toThrow(/does not match its checked-in manifest digest/);
  });

  it('fails closed when the source directory contains an unmanifested bundle file', () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.source, 'undeclared.md'), 'not in the manifest\n');

    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: fixture.source,
    })).toThrow(/every bundle file must be declared exactly once/);
  });

  it('fails closed when an undeclared nested directory or file is present', () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.source, 'nested'));
    writeFileSync(join(fixture.source, 'nested', 'undeclared.md'), 'nested undeclared file\n');

    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: fixture.source,
    })).toThrow(/only manifest-declared regular files/);
  });

  it('fails closed when the source bundle contains a symlink', () => {
    const fixture = makeFixture();
    const outside = join(fixture.root, 'outside.md');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(fixture.source, 'linked.md'));

    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: fixture.source,
    })).toThrow(/only manifest-declared regular files/);
  });

  it('fails closed with an actionable operator step when the source bundle is missing', () => {
    const fixture = makeFixture();
    const missing = join(fixture.root, 'no-such-companion_docs');

    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: missing,
    })).toThrow(/Companion Library source bundle not found/);
    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: missing,
    })).toThrow(/cp -r companion_docs\.example\/ companion_docs\//);
  });

  it('seeds from the tracked companion_docs.example bundle', () => {
    const fixture = makeFixture();
    provisionFleetWorkspaces(fixture.fleet, { companionLibrarySourceDir: EXAMPLE_BUNDLE_DIR });
    const personal = fixture.fleet.companions[0].personalWorkspacePath;

    for (const file of ['welcome.md', 'privacy-boundary-reference.md', 'live_verification_checklist.md']) {
      expect(readFileSync(join(personal, 'docs/companion-library', file), 'utf8'))
        .toBe(readFileSync(join(EXAMPLE_BUNDLE_DIR, file), 'utf8'));
    }
    expect(JSON.parse(readFileSync(
      join(personal, '.psfn/seed-bundles', `${COMPANION_LIBRARY_SEED_VERSION}.json`),
      'utf8',
    ))).toMatchObject({ bundleVersion: COMPANION_LIBRARY_SEED_VERSION, overwritePolicy: 'never' });
  });

  it('fails closed when a manifest changes without a bundle version bump', () => {
    const fixture = makeFixture();
    provisionFleetWorkspaces(fixture.fleet, { companionLibrarySourceDir: fixture.source });
    const privacy = 'seed privacy changed\n';
    writeFileSync(join(fixture.source, 'privacy-boundary-reference.md'), privacy);
    writeFileSync(join(fixture.source, COMPANION_LIBRARY_MANIFEST_FILE), `${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: COMPANION_LIBRARY_SEED_VERSION,
      files: [
        { path: 'welcome.md', sha256: createHash('sha256').update('seed welcome\n').digest('hex') },
        { path: 'privacy-boundary-reference.md', sha256: createHash('sha256').update(privacy).digest('hex') },
        { path: 'live_verification_checklist.md', sha256: createHash('sha256').update('seed checklist\n').digest('hex') },
      ],
    }, null, 2)}\n`);

    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: fixture.source,
    })).toThrow(/source bundle changed without a versioned re-application/);
  });
});
