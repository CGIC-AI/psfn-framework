import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { relativeMock } = vi.hoisted(() => ({ relativeMock: vi.fn() }));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, relative: relativeMock };
});

import { ResearchLibraryStore } from './store.js';

describe('ResearchLibraryStore path boundary', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psfn-research-library-path-boundary-'));
    relativeMock.mockReturnValue('/different-root/outside.txt');
  });

  afterEach(() => {
    relativeMock.mockReset();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a different-root path when relative returns an absolute path', () => {
    const companionDataDir = join(root, 'companion-data');
    const workspacePath = join(root, 'workspace');
    const outsidePath = join(root, 'outside.txt');
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(outsidePath, 'outside', 'utf8');
    const store = new ResearchLibraryStore({ companionDataDir, workspacePath });

    expect(() => store.importFile({
      path: outsidePath,
      provenance: { sourceKind: 'workspace_file' },
    })).toThrow('Only workspace files and previously generated media artifacts');
  });
});
