import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sqliteVec from 'sqlite-vec';
import { MemoryStore } from '../../faculties/memory/store.js';
import { resolveArtifactLifecycleAuditPath, resolveManagedWorkspaceTempDir } from '../layout.js';
import { ResearchLibraryStore } from '../../faculties/memory/research-library/store.js';
import { ArtifactLifecycleManager } from './manager.js';

describe('ArtifactLifecycleManager', () => {
  let tempRoot: string;
  let companionDataDir: string;
  let workspacePath: string;
  let db: Database.Database;
  let memoryStore: MemoryStore;
  let researchLibraryStore: ResearchLibraryStore;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'psfn-artifact-lifecycle-'));
    companionDataDir = join(tempRoot, 'companion-data');
    workspacePath = join(tempRoot, 'workspace');
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    db = new Database(':memory:');
    sqliteVec.load(db);
    memoryStore = new MemoryStore(db);
    researchLibraryStore = new ResearchLibraryStore({ companionDataDir, workspacePath });
  });

  afterEach(() => {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('cleans stale scratchpad and managed temporary artifacts while skipping promoted files', async () => {
    const now = Date.UTC(2026, 3, 1, 12, 0, 0);
    const staleScratchpadTime = now - (20 * 24 * 60 * 60 * 1000);
    memoryStore.addScratchpadEntry('stale note', { id: 'sp-stale', now: staleScratchpadTime });
    memoryStore.addScratchpadEntry('fresh note', { id: 'sp-fresh', now });

    const generatedDir = join(companionDataDir, 'images', '2026-03-01');
    mkdirSync(generatedDir, { recursive: true });
    const staleGenerated = join(generatedDir, 'stale.png');
    const promotedGenerated = join(generatedDir, 'promoted.png');
    writeFileSync(staleGenerated, 'stale');
    writeFileSync(promotedGenerated, 'promoted');
    utimesSync(staleGenerated, new Date(staleScratchpadTime), new Date(staleScratchpadTime));
    utimesSync(promotedGenerated, new Date(staleScratchpadTime), new Date(staleScratchpadTime));

    const workspaceTempDir = resolveManagedWorkspaceTempDir(workspacePath);
    mkdirSync(workspaceTempDir, { recursive: true });
    const staleWorkspace = join(workspaceTempDir, 'old.txt');
    const freshWorkspace = join(workspaceTempDir, 'fresh.txt');
    writeFileSync(staleWorkspace, 'old');
    writeFileSync(freshWorkspace, 'fresh');
    utimesSync(staleWorkspace, new Date(staleScratchpadTime), new Date(staleScratchpadTime));

    researchLibraryStore.importFile({
      path: promotedGenerated,
      provenance: {
        sourceKind: 'generated_media',
        importedBy: 'test',
      },
    });

    const manager = new ArtifactLifecycleManager({
      companionDataDir,
      workspacePath,
      policy: {
        scratchpadRetentionDays: 14,
        generatedMediaRetentionDays: 14,
        workspaceTempRetentionDays: 14,
        cleanupBatchSize: 10,
      },
      memoryStore,
      researchLibraryStore,
    });

    const status = manager.getStatus(now);
    expect(status.scratchpad.stalePreview.map(entry => entry.id)).toEqual(['sp-stale']);
    expect(status.generatedMedia.stalePreview.map(entry => entry.relativePath)).toEqual(['2026-03-01/stale.png']);
    expect(status.generatedMedia.promotedExemptionCount).toBe(1);
    expect(status.workspaceTemp?.stalePreview.map(entry => entry.relativePath)).toEqual(['old.txt']);

    const result = await manager.runCleanup(now);
    expect(result.deletedScratchpadEntryIds).toEqual(['sp-stale']);
    expect(result.deletedGeneratedMediaPaths).toEqual([staleGenerated]);
    expect(result.deletedWorkspaceTempPaths).toEqual([staleWorkspace]);
    expect(result.skippedPromotedPaths).toEqual([promotedGenerated]);

    expect(memoryStore.getScratchpadEntry('sp-stale')).toBeUndefined();
    expect(memoryStore.getScratchpadEntry('sp-fresh')).toBeDefined();
    expect(existsSync(staleGenerated)).toBe(false);
    expect(existsSync(promotedGenerated)).toBe(true);
    expect(existsSync(staleWorkspace)).toBe(false);
    expect(existsSync(freshWorkspace)).toBe(true);

    const auditLines = readFileSync(resolveArtifactLifecycleAuditPath(companionDataDir), 'utf8').trim().split(/\r?\n/);
    expect(auditLines).toHaveLength(1);
    const auditRecord = JSON.parse(auditLines[0]) as { deletedScratchpadEntryIds: string[] };
    expect(auditRecord.deletedScratchpadEntryIds).toEqual(['sp-stale']);
  });
});
