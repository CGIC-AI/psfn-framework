import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedWorldWikiStore } from '../../../faculties/wiki/store.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import { AdminWikiDataService } from './wiki-service.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePlacesRegistry(systemDataDir: string): void {
  const registry: PlacesRegistryConfig = {
    schemaVersion: 1,
    sites: [{ siteId: 'home', displayName: 'Home', kind: 'physical' }],
    places: [],
  };
  writeFileSync(join(systemDataDir, 'places.json'), JSON.stringify(registry), 'utf8');
}

function sharedDocumentCount(
  data: Awaited<ReturnType<AdminWikiDataService['listWikiScopes']>>,
): number | undefined {
  return data.scopes.find(scope => scope.siteId === 'home')?.documentCount;
}

describe('AdminWikiDataService scope memo', () => {
  it('reuses shared counts until a service-owned wiki write invalidates them', async () => {
    const workspacePath = makeTempDir('psfn-wiki-service-workspace-');
    const systemDataDir = makeTempDir('psfn-wiki-service-system-');
    const importDirectory = makeTempDir('psfn-wiki-service-import-');
    writePlacesRegistry(systemDataDir);
    writeFileSync(
      join(importDirectory, 'third-note.md'),
      '# Third Note\n\nShared reference material for the home site.',
      'utf8',
    );

    const store = new SharedWorldWikiStore(systemDataDir, 'home');
    store.upsert({
      id: 'first-note',
      title: 'First Note',
      body: 'The first shared reference.',
      sourceClass: 'system_seed',
    });
    const service = new AdminWikiDataService({ workspacePath, systemDataDir });

    const initial = await service.listWikiScopes();
    expect(sharedDocumentCount(initial)).toBe(1);

    store.upsert({
      id: 'second-note',
      title: 'Second Note',
      body: 'A direct write used to prove the cached count is reused.',
      sourceClass: 'system_seed',
    });
    const cached = await service.listWikiScopes();
    expect(sharedDocumentCount(cached)).toBe(1);
    expect(cached).toEqual(initial);

    await service.importSharedWorldDirectory('home', {
      directory: importDirectory,
      dryRun: false,
    });
    const refreshed = await service.listWikiScopes();
    expect(sharedDocumentCount(refreshed)).toBe(3);
  });
});
