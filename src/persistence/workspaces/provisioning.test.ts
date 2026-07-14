import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCompanionFleetPaths, type CompanionsFleetConfig } from '../../system/config/companions-config.js';
import {
  COMPANION_LIBRARY_MANIFEST_FILE,
  COMPANION_LIBRARY_SEED_VERSION,
  provisionFleetWorkspaces,
  SHARED_WORKSPACE_POLICY,
} from './provisioning.js';
import { createHash } from 'node:crypto';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const FLEET: CompanionsFleetConfig = {
  companions: [{
    companionId: COMPANION_ID,
    companionDataDir: 'companions/one',
    characterCardPath: 'companions/one/card.json',
    postgresSchema: 'companion_one',
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
    writeFileSync(join(source, COMPANION_LIBRARY_MANIFEST_FILE), `${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: COMPANION_LIBRARY_SEED_VERSION,
      files: [
        { path: 'welcome.md', sha256: createHash('sha256').update('seed welcome\n').digest('hex') },
        { path: 'privacy-boundary-reference.md', sha256: createHash('sha256').update('seed privacy\n').digest('hex') },
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
      ],
    }, null, 2)}\n`);

    expect(() => provisionFleetWorkspaces(fixture.fleet, {
      companionLibrarySourceDir: fixture.source,
    })).toThrow(/source bundle changed without a versioned re-application/);
  });
});
