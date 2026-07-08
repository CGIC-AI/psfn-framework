import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import type { ArtifactLifecyclePolicyConfig } from '../../system/config/scheduler-config.js';
import type { ScratchpadEntry } from '../../core/agent/contracts.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import {
  resolveArtifactLifecycleAuditPath,
  resolveGeneratedImagesDir,
  resolveManagedWorkspaceTempDir,
} from '../layout.js';
import { appendJsonLine, readJsonLines } from '../jsonl.js';
import { ResearchLibraryStore } from '../../faculties/memory/research-library/store.js';

const log = createComponentLogger('ArtifactLifecycleManager');
const MAX_RECENT_RUNS = 20;

export interface ArtifactLifecycleFileCandidate {
  path: string;
  relativePath: string;
  updatedAt: number;
  promoted: boolean;
}

export interface ArtifactLifecycleAreaStatus {
  rootPath: string;
  retentionDays: number;
  totalCount: number;
  staleCount: number;
  promotedExemptionCount: number;
  stalePreview: ArtifactLifecycleFileCandidate[];
}

export interface ArtifactLifecycleScratchpadStatus {
  retentionDays: number;
  totalCount: number;
  staleCount: number;
  stalePreview: ScratchpadEntry[];
}

export interface ArtifactLifecycleRunRecord {
  timestamp: number;
  deletedScratchpadEntryIds: string[];
  deletedGeneratedMediaPaths: string[];
  deletedWorkspaceTempPaths: string[];
  skippedPromotedPaths: string[];
}

export interface ArtifactLifecycleStatus {
  policy: ArtifactLifecyclePolicyConfig;
  scratchpad: ArtifactLifecycleScratchpadStatus;
  generatedMedia: ArtifactLifecycleAreaStatus;
  workspaceTemp: ArtifactLifecycleAreaStatus | null;
  recentRuns: ArtifactLifecycleRunRecord[];
}

export interface ArtifactLifecycleCleanupResult {
  deletedScratchpadEntryIds: string[];
  deletedGeneratedMediaPaths: string[];
  deletedWorkspaceTempPaths: string[];
  skippedPromotedPaths: string[];
}

function isStrictSubpath(candidatePath: string, rootPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel.length > 0 && !rel.startsWith('..');
}

function toCutoff(now: number, retentionDays: number): number {
  return now - (retentionDays * 24 * 60 * 60 * 1000);
}

function sortByUpdatedAtDesc<T extends { updatedAt: number; path?: string; id?: string }>(entries: T[]): T[] {
  return [...entries].sort((left, right) => {
    const delta = right.updatedAt - left.updatedAt;
    if (delta !== 0) return delta;
    return (right.path ?? right.id ?? '').localeCompare(left.path ?? left.id ?? '');
  });
}

export class ArtifactLifecycleManager {
  readonly companionDataDir: string;
  readonly generatedMediaDir: string;
  readonly workspaceTempDir: string | null;
  readonly auditPath: string;

  constructor(private readonly deps: {
    companionDataDir: string;
    workspacePath?: string | null;
    policy: ArtifactLifecyclePolicyConfig;
    memoryStore: MemoryStorePort;
    researchLibraryStore: ResearchLibraryStore;
  }) {
    this.companionDataDir = resolve(deps.companionDataDir);
    this.generatedMediaDir = resolveGeneratedImagesDir(this.companionDataDir);
    this.workspaceTempDir = deps.workspacePath
      ? resolveManagedWorkspaceTempDir(deps.workspacePath)
      : null;
    this.auditPath = resolveArtifactLifecycleAuditPath(this.companionDataDir);
    mkdirSync(this.generatedMediaDir, { recursive: true });
    if (this.workspaceTempDir) {
      mkdirSync(this.workspaceTempDir, { recursive: true });
    }
  }

  listRecentRuns(limit: number = 10): ArtifactLifecycleRunRecord[] {
    return readJsonLines<ArtifactLifecycleRunRecord>(
      this.auditPath,
      raw => raw as ArtifactLifecycleRunRecord,
      {
        onError: ({ error }) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
      },
    ).entries
      .slice(-Math.max(1, Math.min(limit, MAX_RECENT_RUNS)))
      .reverse();
  }

  getStatus(now: number = Date.now()): ArtifactLifecycleStatus {
    const promotedSourcePaths = this.collectPromotedSourcePaths();
    return {
      policy: { ...this.deps.policy },
      scratchpad: this.buildScratchpadStatus(now),
      generatedMedia: this.buildAreaStatus({
        rootPath: this.generatedMediaDir,
        retentionDays: this.deps.policy.generatedMediaRetentionDays,
        promotedSourcePaths,
        now,
      }),
      workspaceTemp: this.workspaceTempDir
        ? this.buildAreaStatus({
          rootPath: this.workspaceTempDir,
          retentionDays: this.deps.policy.workspaceTempRetentionDays,
          promotedSourcePaths,
          now,
        })
        : null,
      recentRuns: this.listRecentRuns(),
    };
  }

  async runCleanup(now: number = Date.now()): Promise<ArtifactLifecycleCleanupResult> {
    const promotedSourcePaths = this.collectPromotedSourcePaths();
    const staleScratchpadEntries = this.collectStaleScratchpadEntries(now);
    const generatedMediaCandidates = this.collectStaleFileCandidates({
      rootPath: this.generatedMediaDir,
      retentionDays: this.deps.policy.generatedMediaRetentionDays,
      promotedSourcePaths,
      now,
    });
    const workspaceTempCandidates = this.workspaceTempDir
      ? this.collectStaleFileCandidates({
        rootPath: this.workspaceTempDir,
        retentionDays: this.deps.policy.workspaceTempRetentionDays,
        promotedSourcePaths,
        now,
      })
      : { stale: [], promoted: [] };

    const deletedScratchpadEntryIds: string[] = [];
    for (const entry of staleScratchpadEntries) {
      if (await this.deps.memoryStore.removeScratchpadEntry(entry.id)) {
        deletedScratchpadEntryIds.push(entry.id);
      }
    }

    const deletedGeneratedMediaPaths = this.deleteCandidates(generatedMediaCandidates.stale, this.generatedMediaDir);
    const deletedWorkspaceTempPaths = this.workspaceTempDir
      ? this.deleteCandidates(workspaceTempCandidates.stale, this.workspaceTempDir)
      : [];
    const skippedPromotedPaths = [
      ...generatedMediaCandidates.promoted,
      ...workspaceTempCandidates.promoted,
    ].map(entry => entry.path);

    const record: ArtifactLifecycleRunRecord = {
      timestamp: now,
      deletedScratchpadEntryIds,
      deletedGeneratedMediaPaths,
      deletedWorkspaceTempPaths,
      skippedPromotedPaths,
    };
    appendJsonLine(this.auditPath, record);

    log.info('Artifact lifecycle cleanup run completed', {
      deletedScratchpadEntries: deletedScratchpadEntryIds.length,
      deletedGeneratedMedia: deletedGeneratedMediaPaths.length,
      deletedWorkspaceTemp: deletedWorkspaceTempPaths.length,
      skippedPromoted: skippedPromotedPaths.length,
    });

    return record;
  }

  private buildScratchpadStatus(now: number): ArtifactLifecycleScratchpadStatus {
    const entries = sortByUpdatedAtDesc(this.deps.memoryStore.listScratchpadEntries(64));
    const staleEntries = this.collectStaleScratchpadEntries(now);
    return {
      retentionDays: this.deps.policy.scratchpadRetentionDays,
      totalCount: entries.length,
      staleCount: staleEntries.length,
      stalePreview: staleEntries.slice(0, this.deps.policy.cleanupBatchSize),
    };
  }

  private buildAreaStatus(params: {
    rootPath: string;
    retentionDays: number;
    promotedSourcePaths: Set<string>;
    now: number;
  }): ArtifactLifecycleAreaStatus {
    const { all, stale, promoted } = this.collectStaleFileCandidates(params);
    return {
      rootPath: params.rootPath,
      retentionDays: params.retentionDays,
      totalCount: all.length,
      staleCount: stale.length,
      promotedExemptionCount: promoted.length,
      stalePreview: stale.slice(0, this.deps.policy.cleanupBatchSize),
    };
  }

  private collectStaleScratchpadEntries(now: number): ScratchpadEntry[] {
    const cutoff = toCutoff(now, this.deps.policy.scratchpadRetentionDays);
    return sortByUpdatedAtDesc(this.deps.memoryStore.listScratchpadEntries(64))
      .filter(entry => entry.updatedAt <= cutoff)
      .slice(0, this.deps.policy.cleanupBatchSize);
  }

  private collectPromotedSourcePaths(): Set<string> {
    const promoted = new Set<string>();
    for (const entry of this.deps.researchLibraryStore.listEntries()) {
      const sourcePath = entry.provenance.sourcePath?.trim();
      if (!sourcePath) continue;
      promoted.add(resolve(sourcePath));
    }
    return promoted;
  }

  private collectStaleFileCandidates(params: {
    rootPath: string;
    retentionDays: number;
    promotedSourcePaths: Set<string>;
    now: number;
  }): {
    all: ArtifactLifecycleFileCandidate[];
    stale: ArtifactLifecycleFileCandidate[];
    promoted: ArtifactLifecycleFileCandidate[];
  } {
    if (!existsSync(params.rootPath)) {
      return { all: [], stale: [], promoted: [] };
    }

    const cutoff = toCutoff(params.now, params.retentionDays);
    const all: ArtifactLifecycleFileCandidate[] = [];
    const stale: ArtifactLifecycleFileCandidate[] = [];
    const promoted: ArtifactLifecycleFileCandidate[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const candidatePath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(candidatePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const updatedAt = statSync(candidatePath).mtimeMs;
        const promotedEntry = params.promotedSourcePaths.has(resolve(candidatePath));
        const candidate = {
          path: candidatePath,
          relativePath: relative(params.rootPath, candidatePath),
          updatedAt,
          promoted: promotedEntry,
        };
        all.push(candidate);
        if (updatedAt > cutoff) continue;
        if (promotedEntry) {
          promoted.push(candidate);
          continue;
        }
        if (stale.length < this.deps.policy.cleanupBatchSize) {
          stale.push(candidate);
        }
      }
    };

    walk(params.rootPath);
    return {
      all: sortByUpdatedAtDesc(all),
      stale: sortByUpdatedAtDesc(stale),
      promoted: sortByUpdatedAtDesc(promoted),
    };
  }

  private deleteCandidates(candidates: ArtifactLifecycleFileCandidate[], rootPath: string): string[] {
    const deleted: string[] = [];
    for (const candidate of candidates) {
      if (!existsSync(candidate.path)) continue;
      rmSync(candidate.path, { force: true });
      deleted.push(candidate.path);
      this.pruneEmptyParents(pathDirname(candidate.path), rootPath);
    }
    return deleted;
  }

  private pruneEmptyParents(startDir: string, stopRoot: string): void {
    let current = startDir;
    while (isStrictSubpath(current, stopRoot)) {
      const entries = readdirSync(current);
      if (entries.length > 0) return;
      rmSync(current, { recursive: false, force: true });
      current = pathDirname(current);
    }
  }
}

function pathDirname(input: string): string {
  return input.replace(/[\/][^\/]+$/, '') || input;
}
