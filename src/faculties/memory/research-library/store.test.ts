import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResearchLibraryStore } from './store.js';

let tempDir: string | null = null;

function makeDirs() {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-research-library-'));
  const companionDataDir = join(tempDir, 'companion-data');
  const workspacePath = join(tempDir, 'workspace');
  mkdirSync(companionDataDir, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  return { companionDataDir, workspacePath };
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('ResearchLibraryStore', () => {
  it('imports direct text with provenance and preview text', () => {
    const { companionDataDir, workspacePath } = makeDirs();
    const store = new ResearchLibraryStore({ companionDataDir, workspacePath });

    const manifest = store.importText({
      title: 'Quiet research note',
      content: 'Important finding',
      provenance: {
        sourceKind: 'direct_text',
        sourceUrl: 'https://example.com/article',
        importedBy: 'test',
      },
    });

    const detail = store.getEntry(manifest.id);
    expect(detail?.manifest.title).toBe('Quiet research note');
    expect(detail?.manifest.provenance.sourceUrl).toBe('https://example.com/article');
    expect(detail?.previewText).toContain('Important finding');
  });

  it('imports workspace files and preserves source path provenance', () => {
    const { companionDataDir, workspacePath } = makeDirs();
    const sourcePath = join(workspacePath, 'notes', 'paper.txt');
    mkdirSync(join(workspacePath, 'notes'), { recursive: true });
    writeFileSync(sourcePath, 'primary source excerpt', 'utf8');

    const store = new ResearchLibraryStore({ companionDataDir, workspacePath });
    const manifest = store.importFile({
      path: sourcePath,
      title: 'Paper excerpt',
      provenance: {
        sourceKind: 'workspace_file',
        note: 'kept for later synthesis',
      },
    });

    const detail = store.getEntry(manifest.id);
    expect(detail?.manifest.provenance.sourceKind).toBe('workspace_file');
    expect(detail?.manifest.provenance.sourcePath).toBe(sourcePath);
    expect(detail?.previewText).toContain('primary source excerpt');
    expect(readFileSync(detail!.absolutePath, 'utf8')).toContain('primary source excerpt');
  });

  it('rejects imports outside workspace or generated-media roots', () => {
    const { companionDataDir, workspacePath } = makeDirs();
    const externalPath = join(tempDir!, 'outside.txt');
    writeFileSync(externalPath, 'outside', 'utf8');
    const store = new ResearchLibraryStore({ companionDataDir, workspacePath });

    expect(() => store.importFile({
      path: externalPath,
      provenance: { sourceKind: 'workspace_file' },
    })).toThrow('Only workspace files and previously generated media artifacts');
  });

  it('promotes scratchpad content into note entries', () => {
    const { companionDataDir, workspacePath } = makeDirs();
    const store = new ResearchLibraryStore({ companionDataDir, workspacePath });

    const manifest = store.promoteScratchpadEntry({
      scratchpadEntryId: 'scratch-1',
      content: 'rolling summary',
      title: 'Promoted summary',
      importedBy: 'test',
    });

    expect(manifest.provenance.sourceKind).toBe('scratchpad');
    expect(manifest.provenance.scratchpadEntryId).toBe('scratch-1');
    expect(store.getEntry(manifest.id)?.previewText).toContain('rolling summary');
  });
});
