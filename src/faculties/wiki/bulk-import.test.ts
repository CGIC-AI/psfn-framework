import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedWorldWikiStore, WikiStore } from './store.js';
import {
  deriveMarkdownTitle,
  guardImportFileForSharedWorld,
  importMarkdownDirectory,
} from './bulk-import.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSourceDir(files: Record<string, string>): string {
  const dir = makeTemp('psfn-wiki-src-');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, 'utf-8');
  }
  return dir;
}

describe('deriveMarkdownTitle + guard', () => {
  it('prefers the first H1 then falls back to the filename', () => {
    expect(deriveMarkdownTitle('kitchen.md', '# The Kitchen\n\nbody')).toBe('The Kitchen');
    expect(deriveMarkdownTitle('kitchen-notes.md', 'no heading here')).toBe('kitchen notes');
  });

  it('flags a first-person relational marker as a personal fact', () => {
    expect(guardImportFileForSharedWorld({ title: 'Neighborhood', body: 'The 11th arrondissement is lively.' })).toBeNull();
    expect(guardImportFileForSharedWorld({ title: 'Note', body: 'My partner grew up in the 11th.' }))
      .toMatch(/first-person relational marker/);
  });
});

describe('importMarkdownDirectory (shared-world, guarded)', () => {
  it('rejects personal-fact files per-file and accepts clean files into the shared scope', () => {
    const systemDataDir = makeTemp('psfn-shared-');
    const store = new SharedWorldWikiStore(systemDataDir, 'home');
    const source = makeSourceDir({
      'kitchen.md': '# Kitchen\n\nThe kitchen has a new toaster next to the satellite.',
      'partner.md': '# Partner note\n\nMy partner keeps snacks in the top drawer.',
    });

    const report = importMarkdownDirectory({
      directory: source,
      store,
      scope: 'shared_world:home',
      personalFactGuard: true,
    });

    expect(report.imported.map(e => e.file)).toEqual(['kitchen.md']);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]).toMatchObject({ file: 'partner.md' });
    expect(report.rejected[0].reason).toMatch(/personal/);

    // The clean file landed in shared scope; the rejected one was NEVER written.
    expect(store.get('kitchen')?.scope).toBe('shared_world:home');
    expect(store.get('partner')).toBeNull();
  });

  it('dry-run runs the guard but writes nothing', () => {
    const systemDataDir = makeTemp('psfn-shared-');
    const store = new SharedWorldWikiStore(systemDataDir, 'home');
    const source = makeSourceDir({ 'weather.md': '# Weather\n\nMostly sunny near the coast.' });

    const report = importMarkdownDirectory({
      directory: source,
      store,
      scope: 'shared_world:home',
      personalFactGuard: true,
      dryRun: true,
    });
    expect(report.imported).toHaveLength(1);
    expect(store.get('weather')).toBeNull();
  });
});

describe('importMarkdownDirectory (personal, no shared gate)', () => {
  it('imports personal facts into the personal wiki without guarding', () => {
    const workspace = makeTemp('psfn-workspace-');
    const store = new WikiStore(workspace);
    const source = makeSourceDir({
      'partner.md': '# Partner note\n\nMy partner keeps snacks in the top drawer.',
    });

    const report = importMarkdownDirectory({
      directory: source,
      store,
      scope: 'personal',
      personalFactGuard: false,
    });

    expect(report.rejected).toEqual([]);
    expect(report.imported.map(e => e.file)).toEqual(['partner.md']);
    // Personal store: the doc exists and carries no shared scope.
    expect(store.get('partner')?.body).toContain('snacks');
    expect(store.get('partner')).not.toHaveProperty('scope');
  });
});
