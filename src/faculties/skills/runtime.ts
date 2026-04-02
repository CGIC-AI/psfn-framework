import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import {
  SKILLS_FILE_NAME,
  loadSkillsConfig,
  saveSkillsConfig,
  type SkillsRuntimeConfig,
} from '../../system/config/skills-config.js';
import { filterEligibleSkills } from './filter.js';
import { formatSkillsForPrompt } from './format.js';
import {
  applySkillPrecedence,
  buildSkillFileSignature,
  loadSkillEntries,
  resolveSkillDirectories,
  scanSkillFiles,
} from './loader.js';
import { SkillStore } from './store.js';
import type {
  ManagedSkillOwnership,
  SkillDirectorySpec,
  SkillEvaluation,
  SkillLookupResult,
  SkillSnapshot,
} from './types.js';

export interface SkillsRuntimeOptions {
  dataDir: string;
  seedDir?: string;
  repoRoot: string;
  environment?: NodeJS.ProcessEnv;
  isBinaryAvailable?: (binaryName: string) => boolean;
}

interface SkillSnapshotCache {
  signature: string;
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
  private cache: SkillSnapshotCache | null = null;

  constructor(options: SkillsRuntimeOptions) {
    this.options = options;
    this.store = new SkillStore(options.dataDir, {
      repoRoot: options.repoRoot,
    });
  }

  invalidate(): void {
    this.cache = null;
  }

  getPromptXml(): string {
    return this.getSnapshot().promptXml;
  }

  getSnapshot(): SkillSnapshot {
    return this.getOrCreateCache().snapshot;
  }

  listSkillEvaluations(): SkillEvaluation[] {
    return [...this.getOrCreateCache().evaluations];
  }

  listCategorySummary(): Array<{ category: string; total: number; included: number }> {
    const cache = this.getOrCreateCache();
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

  findSkill(name: string): SkillLookupResult | null {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return null;
    const match = this.getOrCreateCache().byName.get(normalized);
    if (!match) return null;
    return {
      entry: match.entry,
      eligible: match.eligibility,
    };
  }

  getStore(): SkillStore {
    return this.store;
  }

  /** List managed (user-created) skills. */
  listManaged(): Array<{ name: string; description: string; category: string; version: number; content: string; createdAt: string; updatedAt: string }> {
    return this.store.list().map(({ absolutePath: _, relativePath: __, ...rest }) => rest);
  }

  getManagedOwnership(): ManagedSkillOwnership {
    return {
      owner: 'companion',
      managedRoot: this.toRepoRelativePath(this.store.getManagedRootDir()),
      configPath: this.toRepoRelativePath(resolve(this.options.dataDir, SKILLS_FILE_NAME)),
    };
  }

  /** Create a new managed skill. */
  createSkill(input: { name: string; category: string; content: string; description?: string }): { name: string; description: string; category: string; version: number; content: string; createdAt: string; updatedAt: string } {
    const record = this.store.create(input);
    this.invalidate();
    return { name: record.name, description: record.description, category: record.category, version: record.version, content: record.content, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }

  /** Update an existing managed skill. */
  updateSkill(input: { name: string; content: string; description?: string }): { name: string; description: string; category: string; version: number; content: string; createdAt: string; updatedAt: string } {
    const record = this.store.update(input);
    this.invalidate();
    return { name: record.name, description: record.description, category: record.category, version: record.version, content: record.content, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }

  /** Delete a managed skill by name. */
  deleteSkill(name: string): void {
    this.store.delete(name);
    this.invalidate();
  }

  /** Toggle a skill's enabled/disabled state via disabledSkills config. Returns new enabled state. */
  toggleSkill(name: string): boolean {
    const config = this.loadRuntimeConfig();
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('Skill name must be non-empty');

    const isDisabled = config.disabledSkills.includes(normalizedName);
    const nextDisabled = isDisabled
      ? config.disabledSkills.filter(s => s !== normalizedName)
      : [...config.disabledSkills, normalizedName];

    saveSkillsConfig(this.options.dataDir, {
      ...config,
      disabledSkills: nextDisabled,
    });
    this.invalidate();
    return isDisabled; // was disabled, now enabled → returns true
  }

  /** Get the current disabled skills list from config. */
  getDisabledSkills(): string[] {
    return this.loadRuntimeConfig().disabledSkills;
  }

  private getOrCreateCache(): SkillSnapshotCache {
    const runtimeConfig = this.loadRuntimeConfig();
    const repoRoot = requireSkillsRepoRoot(this.options.repoRoot);
    const configuredDirectories = resolveSkillDirectories(runtimeConfig, repoRoot);
    const directories = this.mergeManagedDirectory(configuredDirectories);
    const files = scanSkillFiles(directories);

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
      files: buildSkillFileSignature(files),
    });
    const signature = hashSignature(signaturePayload);

    if (this.cache && this.cache.signature === signature) {
      return this.cache;
    }

    const parsed = loadSkillEntries(files);
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
      signature,
      configEnabled: runtimeConfig.enabled,
      budget: {
        maxSkills: runtimeConfig.maxLoadedSkills,
        maxChars: runtimeConfig.maxSkillChars,
      },
      directories,
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

    this.cache = {
      signature,
      snapshot,
      evaluations: eligibility.evaluations,
      byName,
    };

    return this.cache;
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
