import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import {
  SKILLS_FILE_NAME,
  loadSkillsConfig,
  type SkillsRuntimeConfig,
} from '../../system/config/skills-config.js';
import { filterEligibleSkills } from './filter.js';
import { formatSkillsForPrompt } from './format.js';
import {
  applySkillPrecedence,
  buildSkillFileSignature,
  loadSkillEntries,
  readSkillContent,
  resolveSkillDirectories,
  scanSkillRoots,
} from './loader.js';
import { SkillStore } from './store.js';
import { SkillUsageTelemetryStore } from './telemetry.js';
import type {
  SkillInvocationRecordInput,
  ManagedSkillOwnership,
  SkillDirectorySpec,
  SkillEvaluation,
  SkillLookupResult,
  SkillSnapshot,
  SkillUsageStats,
} from './types.js';

export interface SkillsRuntimeOptions {
  dataDir: string;
  seedDir?: string;
  repoRoot: string;
  managedRootDir?: string;
  environment?: NodeJS.ProcessEnv;
  isBinaryAvailable?: (binaryName: string) => boolean;
  now?: () => Date;
}

interface SkillSnapshotCache {
  fingerprint: string;
  snapshot: SkillSnapshot;
  evaluations: SkillEvaluation[];
  byName: Map<string, SkillEvaluation>;
}

function hashSignature(payload: string): string {
  return createHash('sha1').update(payload).digest('hex');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function requireSkillsRepoRoot(repoRoot: string): string {
  const normalized = repoRoot.trim();
  if (!normalized) {
    throw new Error('SkillsRuntime requires an explicit repoRoot');
  }
  return resolve(normalized);
}

export class SkillsRuntime {
  private options: SkillsRuntimeOptions;
  private store: SkillStore;
  private telemetry: SkillUsageTelemetryStore;
  private cache: SkillSnapshotCache | null = null;
  private cacheGeneration = 0;
  private cacheBuild: {
    generation: number;
    promise: Promise<SkillSnapshotCache>;
  } | null = null;

  constructor(options: SkillsRuntimeOptions) {
    this.options = options;
    this.store = new SkillStore(options.dataDir, {
      repoRoot: options.repoRoot,
      ...(options.managedRootDir ? { managedRootDir: options.managedRootDir } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.telemetry = new SkillUsageTelemetryStore(options.dataDir, {
      ...(options.now ? { now: options.now } : {}),
    });
  }

  invalidate(): void {
    this.cache = null;
    this.cacheGeneration += 1;
  }

  async getPromptXml(): Promise<string> {
    return (await this.getSnapshot()).promptXml;
  }

  getCachedPromptXml(): string {
    return this.cache?.snapshot.promptXml ?? '';
  }

  async getSnapshot(): Promise<SkillSnapshot> {
    return (await this.getOrCreateCache()).snapshot;
  }

  async listSkillEvaluations(): Promise<SkillEvaluation[]> {
    return [...(await this.getOrCreateCache()).evaluations];
  }

  async listCategorySummary(): Promise<Array<{ category: string; total: number; included: number }>> {
    const cache = await this.getOrCreateCache();
    const includedNames = new Set(cache.snapshot.includedSkills.map(skill => skill.name));
    const counts = new Map<string, { total: number; included: number }>();
    for (const evaluation of cache.evaluations) {
      const category = evaluation.entry.category?.trim() || 'uncategorized';
      const record = counts.get(category) ?? { total: 0, included: 0 };
      record.total += 1;
      if (includedNames.has(evaluation.entry.name)) {
        record.included += 1;
      }
      counts.set(category, record);
    }

    return [...counts.entries()]
      .map(([category, summary]) => ({
        category,
        total: summary.total,
        included: summary.included,
      }))
      .sort((left, right) => left.category.localeCompare(right.category));
  }

  async findSkill(name: string): Promise<SkillLookupResult | null> {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return null;
    const match = (await this.getOrCreateCache()).byName.get(normalized);
    if (!match) return null;
    return {
      entry: match.entry,
      eligible: match.eligibility,
    };
  }

  getStore(): SkillStore {
    return this.store;
  }

  async readSkillContent(name: string): Promise<{
    lookup: SkillLookupResult;
    content: string;
  } | null> {
    const lookup = await this.findSkill(name);
    if (!lookup) return null;
    return {
      lookup,
      content: await readSkillContent(lookup.entry),
    };
  }

  async recordSkillInvocation(
    name: string,
    input: SkillInvocationRecordInput,
  ): Promise<SkillUsageStats | null> {
    const result = await this.findSkill(name);
    if (!result) return null;
    return this.telemetry.record(result.entry.name, input);
  }

  getSkillUsageStats(name: string): SkillUsageStats | null {
    return this.telemetry.get(name);
  }

  listSkillUsageStats(): SkillUsageStats[] {
    return this.telemetry.list();
  }

  /**
   * Persist any pending debounced telemetry immediately. Shutdown/lifecycle
   * callers use this so the debounced tail is never lost.
   */
  flushSkillUsageTelemetry(): void {
    this.telemetry.flush();
  }

  /** List managed (user-created) skills. */
  listManaged(): Array<{ name: string; description: string; category: string; version: number; content: string; createdAt: string; updatedAt: string }> {
    return this.store.list().map(({ absolutePath: _, relativePath: __, ...rest }) => rest);
  }

  getManagedOwnership(): ManagedSkillOwnership {
    return {
      owner: 'personal',
      managedRoot: this.toRepoRelativePath(this.store.getManagedRootDir()),
      configPath: this.toRepoRelativePath(resolve(this.options.dataDir, SKILLS_FILE_NAME)),
    };
  }

  /**
   * Create a new managed skill via the operator admin surface. Garden is the
   * operator-facing approval authority, so its direct writes carry operator
   * provenance and do not queue.
   */
  createSkill(input: { name: string; category: string; content: string; description?: string }): { name: string; description: string; category: string; version: number; content: string; createdAt: string; updatedAt: string } {
    const record = this.store.create(input, { updatedBy: 'operator:garden' });
    this.invalidate();
    return { name: record.name, description: record.description, category: record.category, version: record.version, content: record.content, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }

  /** Update an existing managed skill via the operator admin surface. */
  updateSkill(input: { name: string; content: string; description?: string }): { name: string; description: string; category: string; version: number; content: string; createdAt: string; updatedAt: string } {
    const record = this.store.update(input, { updatedBy: 'operator:garden' });
    this.invalidate();
    return { name: record.name, description: record.description, category: record.category, version: record.version, content: record.content, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }

  /** Delete a managed skill by name. */
  deleteSkill(name: string): void {
    this.store.delete(name);
    this.invalidate();
  }

  private async getOrCreateCache(): Promise<SkillSnapshotCache> {
    const generation = this.cacheGeneration;
    if (this.cacheBuild?.generation === generation) {
      return this.cacheBuild.promise;
    }

    const promise = this.buildCache(generation);
    this.cacheBuild = { generation, promise };
    try {
      const cache = await promise;
      if (generation !== this.cacheGeneration) {
        return this.getOrCreateCache();
      }
      return cache;
    } finally {
      if (this.cacheBuild.promise === promise) {
        this.cacheBuild = null;
      }
    }
  }

  private async buildCache(generation: number): Promise<SkillSnapshotCache> {
    const runtimeConfig = this.loadRuntimeConfig();
    const repoRoot = requireSkillsRepoRoot(this.options.repoRoot);
    const configuredDirectories = resolveSkillDirectories(runtimeConfig, repoRoot);
    const directories = this.mergeManagedDirectory(configuredDirectories);
    const scan = await scanSkillRoots(directories);
    const files = scan.files;

    const signaturePayload = JSON.stringify({
      config: {
        enabled: runtimeConfig.enabled,
        directories: runtimeConfig.directories,
        extraDirectories: runtimeConfig.extraDirectories,
        maxLoadedSkills: runtimeConfig.maxLoadedSkills,
        maxSkillChars: runtimeConfig.maxSkillChars,
        disabledSkills: runtimeConfig.disabledSkills,
      },
      directories: directories.map(directory => ({
        relativePath: directory.relativePath,
        precedence: directory.precedence,
        source: directory.source,
      })),
      roots: scan.roots.map(root => ({
        path: root.path,
        absolutePath: root.absolutePath,
        exists: root.exists,
        message: root.message,
      })),
      files: buildSkillFileSignature(files),
    });
    const fingerprint = hashSignature(signaturePayload);

    if (this.cache && !this.cache.fingerprint.localeCompare(fingerprint)) {
      return this.cache;
    }

    const parsed = await loadSkillEntries(files);
    const deduped = applySkillPrecedence(parsed.entries);
    const eligibility = filterEligibleSkills(deduped.entries, {
      runtimeConfig,
      environment: this.options.environment,
      isBinaryAvailable: this.options.isBinaryAvailable,
    });

    const formatted = formatSkillsForPrompt(eligibility.eligible, {
      maxSkills: runtimeConfig.maxLoadedSkills,
      maxChars: runtimeConfig.maxSkillChars,
    });

    const snapshot: SkillSnapshot = {
      generatedAt: new Date().toISOString(),
      signature: fingerprint,
      configEnabled: runtimeConfig.enabled,
      budget: {
        maxSkills: runtimeConfig.maxLoadedSkills,
        maxChars: runtimeConfig.maxSkillChars,
      },
      directories,
      roots: scan.roots,
      scannedFiles: files.length,
      loadedSkills: deduped.entries.length,
      includedSkills: formatted.included,
      promptXml: formatted.xml,
      skipped: [
        ...parsed.skipped,
        ...deduped.skipped,
        ...eligibility.skipped,
        ...formatted.excluded,
      ],
    };

    const byName = new Map<string, SkillEvaluation>();
    for (const evaluation of eligibility.evaluations) {
      byName.set(evaluation.entry.name.toLowerCase(), evaluation);
    }

    const nextCache = {
      fingerprint,
      snapshot,
      evaluations: eligibility.evaluations,
      byName,
    };

    if (generation === this.cacheGeneration) {
      this.cache = nextCache;
    }
    return nextCache;
  }

  private loadRuntimeConfig(): SkillsRuntimeConfig {
    return loadSkillsConfig(this.options.dataDir, {
      seedDir: this.options.seedDir,
    });
  }

  private mergeManagedDirectory(
    configured: SkillDirectorySpec[],
  ): SkillDirectorySpec[] {
    const managedRoot = this.store.getManagedRootDir();
    const displayPath = this.toRepoRelativePath(managedRoot);

    const ordered: SkillDirectorySpec[] = [
      {
        absolutePath: managedRoot,
        relativePath: displayPath,
        source: 'custom',
        precedence: 0,
      },
      ...configured,
    ];

    const deduped = new Map<string, SkillDirectorySpec>();
    for (const directory of ordered) {
      const key = resolve(directory.absolutePath);
      if (!deduped.has(key)) {
        deduped.set(key, directory);
      }
    }

    return [...deduped.values()].map((directory, index) => ({
      ...directory,
      precedence: index,
    }));
  }

  private toRepoRelativePath(path: string): string {
    const relativePath = toPosix(relative(requireSkillsRepoRoot(this.options.repoRoot), path));
    return relativePath && !relativePath.startsWith('..')
      ? relativePath
      : toPosix(resolve(path));
  }
}
