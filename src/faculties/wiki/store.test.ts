import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePersonalWikiDir } from '../../persistence/layout.js';
import { WikiStore, normalizeWikiDocumentId } from './store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-wiki-'));
  tempDirs.push(dir);
  return dir;
}

describe('WikiStore', () => {
  it('persists workspace-backed wiki documents with metadata and checksum validation', () => {
    const workspace = makeWorkspace();
    const store = new WikiStore(workspace, {
      now: () => new Date('2026-06-28T12:00:00.000Z'),
    });

    const created = store.upsert({
      title: 'Companion Architecture Notes',
      body: '# Architecture\n\nGateway and Garden are separate surfaces.',
      tags: ['Architecture', 'Garden'],
      sourceClass: 'operator_authored_note',
      sensitivity: 'personal',
      updatedBy: 'operator',
    });

    expect(created).toMatchObject({
      id: 'companion-architecture-notes',
      title: 'Companion Architecture Notes',
      sourceClass: 'operator_authored_note',
      tags: ['architecture', 'garden'],
      sensitivity: 'personal',
      version: 1,
      createdAt: '2026-06-28T12:00:00.000Z',
      updatedAt: '2026-06-28T12:00:00.000Z',
      updatedBy: 'operator',
    });

    const wikiRoot = resolvePersonalWikiDir(workspace);
    expect(existsSync(join(wikiRoot, 'documents', 'companion-architecture-notes.md'))).toBe(true);
    const metadataPath = join(wikiRoot, 'metadata', 'companion-architecture-notes.json');
    expect(existsSync(metadataPath)).toBe(true);
    expect(JSON.parse(readFileSync(metadataPath, 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      id: 'companion-architecture-notes',
      bodyPath: 'documents/companion-architecture-notes.md',
      bodyFormat: 'markdown',
    });

    expect(store.list()).toHaveLength(1);
    expect(store.get('companion-architecture-notes')?.body).toContain('Gateway and Garden');
    expect(store.search({ query: 'garden' })).toMatchObject({
      count: 1,
      matches: [
        expect.objectContaining({
          id: 'companion-architecture-notes',
          sourceClass: 'operator_authored_note',
          preview: expect.stringContaining('Gateway and Garden'),
        }),
      ],
    });
  });

  it('requires provenance for source-derived wiki documents', () => {
    const store = new WikiStore(makeWorkspace());

    expect(() => store.upsert({
      title: 'Imported Vault Note',
      body: 'Copied from a partner vault note.',
      sourceClass: 'imported_partner_vault_note',
    })).toThrow('requires at least one provenance ref');

    const imported = store.upsert({
      title: 'Imported Vault Note',
      body: 'Copied from a partner vault note.',
      sourceClass: 'imported_partner_vault_note',
      provenanceRefs: ['vault:partner:Daily/2026-06-28.md'],
    });
    expect(imported.provenanceRefs).toEqual(['vault:partner:Daily/2026-06-28.md']);
  });

  it('rejects unsafe ids and normalizes title-derived ids', () => {
    expect(normalizeWikiDocumentId(undefined, 'Research: A/B Test Plan!')).toBe('research-a-b-test-plan');
    expect(() => normalizeWikiDocumentId('../escape')).toThrow('invalid characters');
    expect(() => new WikiStore(makeWorkspace()).upsert({
      id: '../escape',
      title: 'Escape',
      body: 'nope',
    })).toThrow('invalid characters');
  });

  // ── W5b scope dimension ──

  it('default (personal) writes omit scope from serialized metadata (byte-identical to pre-W5b)', () => {
    const workspace = makeWorkspace();
    const store = new WikiStore(workspace);
    const doc = store.upsert({ title: 'World Note', body: 'Some durable world fact.' });
    // In-memory: absent scope == personal, so the field is not set.
    expect(doc).not.toHaveProperty('scope');
    const metadataPath = join(resolvePersonalWikiDir(workspace), 'metadata', `${doc.id}.json`);
    const persisted = JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
    expect('scope' in persisted).toBe(false);
    // Round-trips cleanly through read (checksum + metadata validation).
    expect(store.get(doc.id)?.body).toContain('durable world fact');
  });

  it('accepts an explicit personal scope (still omitted, still byte-identical)', () => {
    const store = new WikiStore(makeWorkspace());
    const doc = store.upsert({ title: 'Personal Note', body: 'A note.', scope: 'personal' });
    expect(doc).not.toHaveProperty('scope');
  });

  it('fail-closed REJECTS any direct shared_world scope write (the leak surface)', () => {
    const store = new WikiStore(makeWorkspace());
    expect(() => store.upsert({
      title: 'Kitchen Toaster',
      body: 'A new toaster sits next to the satellite in the kitchen.',
      scope: 'shared_world:home',
    })).toThrow(/personal-scope only/);
  });

  it('rejects a malformed scope value before writing anything', () => {
    const store = new WikiStore(makeWorkspace());
    expect(() => store.upsert({
      title: 'Bad Scope',
      body: 'x',
      scope: 'shared_world:bad site!' as unknown as 'personal',
    })).toThrow(/valid siteId/);
  });
});
