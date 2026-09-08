import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import {
  SKILLS_FILE_NAME,
  loadSkillsConfig,
  DEFAULT_SKILL_REUSE_CONFIG,
  type SkillReuseConfig,
  type SkillsRuntimeConfig,
} from '../../system/config/skills-config.js';
import { filterEligibleSkills } from './filter.js';
import {
  compareSkillsForPrompt,
  formatSkillsForPrompt,
} from './format.js';
import {
  applySkillPrecedence,
  buildSkillFileSignature,
  cooperativeSort,
  createSkillDocumentReadBudget,
  DEFAULT_SKILL_COLLECTION_LIMITS,
  loadSkillEntries,
  readSkillBodyFromDocument,
  readSkillContent,
  readSkillContents as readSkillContentBatch,
  readSkillDocument,
  resolveSkillDirectories,
  scanSkillRoots,
  type SkillDocumentReadOptions,
} from './loader.js';
import type {
  CogSecArtifactAdmissionPort,
} from '../../core/cogsec/intake/durable-admission.js';
import {
  normalizeSkillCategory,
  normalizeSkillDescription,
  normalizeSkillName,
  SkillStore,
} from './store.js';
import { SkillUsageTelemetryStore } from './telemetry.js';
import type {
  SkillInvocationRecordInput,
  SkillCollectionLimits,
  ManagedSkillOwnership,
  SkillDirectorySpec,
  SkillEvaluation,
  SkillEntry,
  SkillLookupResult,
  SkillSnapshot,
  SkillSkipRecord,
  SkillUsageStats,
} from './types.js';

/**
 * A skill body read for execution, or the typed reason it stays inert
 * (psfn-framework-1fjvm.1). The held branch never carries the body.
 */
export type SkillContentReadResult =
  | { lookup: SkillLookupResult; content: string }
  | { lookup: SkillLookupResult; held: SkillSkipRecord };

export interface SkillsRuntimeOptions {
  dataDir: string;
  seedDir?: string;
  repoRoot: string;
  managedRootDir?: string;
  environment?: NodeJS.ProcessEnv;
  isBinaryAvailable?: (binaryName: string) => boolean | Promise<boolean>;
  now?: () => Date;
  collectionLimits?: Partial<SkillCollectionLimits>;
  /**
   * Content-addressed CogSec admission for executable skill bodies
   * (psfn-framework-1fjvm.1). Wired, no skill's frontmatter, description, or
   * body reaches model context or a callable skill view until the exact
   * document bytes hold an admitted receipt or are admitted by a fresh screen.
   *
   * Absent (maintenance CLIs, focused tests, compositions with no CogSec
   * intake), skills load exactly as before. That is a composition-level
   * decision recorded here, never a per-skill exemption: no source, precedence,
   * or bundled/system origin can skip the gate once it is wired.
   */
  admission?: CogSecArtifactAdmissionPort;
}

interface SkillSnapshotCache {
  fingerprint: string;
  snapshot: SkillSnapshot;
  evaluations: SkillEvaluation[];
  byName: Map<string, SkillEvaluation>;
  managedEntries: SkillEvaluation['entry'][];
}

async function hashSignature(payload: string, yieldEvery: number): Promise<string> {
  const hash = createHash('sha1');
  const chunkBytes = yieldEvery * 1024;
  for (let offset = 0; offset < payload.length; offset += chunkBytes) {
    hash.update(payload.slice(offset, offset + chunkBytes));
    await new Promise<void>(resolveYield => setImmediate(resolveYield));
  }
  return hash.digest('hex');
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
  /**
   * Reuse tuning as of the last cache build (psfn-framework-lpxg3.3). Cached so
   * the per-turn reuse loop never re-reads the owner file; `null` until the
   * first build, where the caller falls back to the contract defaults.
   */
  private cachedReuseConfig: SkillReuseConfig | null = null;
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

  /**
   * The CogSec-admitted, eligible skill entries already in the warm cache
   * (psfn-framework-lpxg3.3). Synchronous and side-effect free: the quiet reuse
   * loop reads the index the prompt for this turn was built from and adds no
   * scan, read, or admission work of its own. An empty array means "no warm
   * cache", never "no skills" — the caller treats it as no candidates.
   */
  getCachedAdmittedSkills(): readonly SkillEntry[] {
    return this.cache?.snapshot.includedSkills ?? [];
  }

  /**
   * Owner-file reuse bounds as of the last cache build, or the contract
   * defaults before one. Synchronous and I/O free for the same reason as
   * {@link getCachedAdmittedSkills}.
   */
  getCachedReuseConfig(): SkillReuseConfig {
    return this.cachedReuseConfig ?? { ...DEFAULT_SKILL_REUSE_CONFIG };
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

  /**
   * Admit ONE skill's exact complete SKILL.md bytes (psfn-framework-1fjvm.1).
   *
   * The document is read once, through the loader's TOCTOU-guarded stable
   * read, and those same bytes are what the admission gate hashes, looks up a
   * receipt for, and — on any refusal — re-screens. Nothing about the entry
   * (path, source, precedence, mtime, prior admission of an earlier version)
   * participates: only the bytes in hand.
   *
   * With no admission port wired the skill loads as before; that is a
   * composition decision, not a per-skill exemption.
   */
  private async admitSkillDocument(
    entry: SkillEntry,
    options: SkillDocumentReadOptions = {},
  ): Promise<{ admitted: true; body: string } | { admitted: false; skip: SkillSkipRecord }> {
    const document = await readSkillDocument(entry, options);
    const admission = this.options.admission;
    if (!admission) {
      return { admitted: true, body: readSkillBodyFromDocument(document, entry.relativePath) };
    }
    const outcome = await admission.admit({
      content: document,
      artifactRef: entry.relativePath,
      origin: { ref: `skill:${entry.relativePath}`, detail: entry.source },
    });
    if (!outcome.admitted) {
      return {
        admitted: false,
        skip: {
          kind: 'admission_held',
          name: entry.name,
          relativePath: entry.relativePath,
          source: entry.source,
          reason: outcome.detail,
          details: [
            `hold reason: ${outcome.reason}`,
            ...(outcome.riskLabels.length > 0
              ? [`screening labels: ${outcome.riskLabels.join(', ')}`]
              : []),
          ],
        },
      };
    }
    // Parse the ADMITTED bytes, not the bytes read from disk: a 'sanitize'
    // decision admits a transformed document, and the body handed onward must
    // be the one that was admitted.
    return {
      admitted: true,
      body: readSkillBodyFromDocument(outcome.content, entry.relativePath),
    };
  }

  /**
   * Admission failures that are not a screening verdict — an unreadable or
   * mid-write file, an oversized document, an exhausted read budget — hold the
   * skill too. A skill whose bytes could not be admitted must never be served
   * on the strength of frontmatter that was read earlier.
   */
  private async admitSkillDocumentOrHold(
    entry: SkillEntry,
    options: SkillDocumentReadOptions = {},
  ): Promise<{ admitted: true; body: string } | { admitted: false; skip: SkillSkipRecord }> {
    try {
      return await this.admitSkillDocument(entry, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        admitted: false,
        skip: {
          kind: 'admission_held',
          name: entry.name,
          relativePath: entry.relativePath,
          source: entry.source,
          reason: `CogSec admission could not read this skill: ${detail}`,
          details: ['hold reason: admission_unavailable'],
        },
      };
    }
  }

  /**
   * The skill body, or a typed hold record when CogSec admission refuses it.
   *
   * Re-admitting here rather than trusting the cache is the point: cache
   * admission proved the bytes that existed at scan time; this proves the bytes
   * that are about to be handed to the model. A byte-identical document costs
   * one content-addressed receipt lookup and no scan.
   */
  async readSkillContent(name: string): Promise<SkillContentReadResult | null> {
    const lookup = await this.findSkill(name);
    if (!lookup) return null;
    if (!this.options.admission) {
      return { lookup, content: await readSkillContent(lookup.entry) };
    }
    const outcome = await this.admitSkillDocumentOrHold(lookup.entry);
    return outcome.admitted
      ? { lookup, content: outcome.body }
      : { lookup, held: outcome.skip };
  }

  async readSkillContents(entries: SkillEntry[]): Promise<Map<string, string>> {
    const limits = this.getCollectionLimits();
    if (!this.options.admission) {
      const contents = await readSkillContentBatch(
        entries,
        limits.maxContentBytes,
        limits.yieldEvery,
      );
      return new Map(entries.map((entry, index) => [entry.id, contents[index]!]));
    }
    const readOptions = createSkillDocumentReadBudget(limits.maxContentBytes);
    const contents = new Map<string, string>();
    for (const [index, entry] of entries.entries()) {
      const outcome = await this.admitSkillDocumentOrHold(entry, readOptions);
      // A held skill is omitted, never returned with placeholder prose: the
      // caller's `has(id)` check is the single fail-closed test.
      if (outcome.admitted) contents.set(entry.id, outcome.body);
      if ((index + 1) % limits.yieldEvery === 0) {
        await new Promise<void>(resolveYield => setImmediate(resolveYield));
      }
    }
    return contents;
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

  /** Build Garden's managed-skill view from the same bounded async cache. */
  async listManaged(): Promise<{
    managed: Array<{ name: string; description: string; category: string; version: number; content: string; createdAt: string; updatedAt: string }>;
    skipped: SkillSkipRecord[];
  }> {
    const cache = await this.getOrCreateCache();
    const limits = this.getCollectionLimits();
    const totalBytes = cache.managedEntries.reduce((total, entry) => total + entry.size, 0);
    if (totalBytes > limits.maxContentBytes) {
      return {
        managed: [],
        skipped: [{
          kind: 'collection_limit',
          name: 'managed skill collection',
          relativePath: this.toRepoRelativePath(this.store.getManagedRootDir()),
          source: 'custom',
          reason: `Managed skill bodies require ${String(totalBytes)} bytes; aggregate read limit is ${String(limits.maxContentBytes)} bytes`,
          details: ['managed bodies were not read; no partial Garden list was returned'],
        }],
      };
    }

    const managed: Array<{
      name: string;
      description: string;
      category: string;
      version: number;
      content: string;
      createdAt: string;
      updatedAt: string;
    }> = [];
    const managedRoot = this.store.getManagedRootDir();
    const contents = await readSkillContentBatch(
      cache.managedEntries,
      limits.maxContentBytes,
      limits.yieldEvery,
    );
    for (const [index, entry] of cache.managedEntries.entries()) {
      const categoryFromPath = relative(managedRoot, entry.absolutePath).split(sep)[0] ?? '';
      managed.push({
        name: normalizeSkillName(entry.name),
        description: normalizeSkillDescription(entry.description),
        category: normalizeSkillCategory(entry.category ?? categoryFromPath),
        version: entry.version ?? 1,
        content: contents[index]!,
        createdAt: entry.createdAt ?? new Date(entry.birthtimeMs).toISOString(),
        updatedAt: entry.updatedAt ?? new Date(entry.mtimeMs).toISOString(),
      });
      if ((index + 1) % limits.yieldEvery === 0) {
        await new Promise<void>(resolveYield => setImmediate(resolveYield));
      }
    }
    return {
      managed: await cooperativeSort(
        managed,
        (left, right) => left.name.localeCompare(right.name),
        limits.yieldEvery,
      ),
      // Garden is the operator's only repair surface for a managed skill, so a
      // skill held by CogSec admission must appear here as a typed hold rather
      // than silently vanish from the list (psfn-framework-1fjvm.1).
      skipped: cache.snapshot.skipped.filter(skip => (
        skip.kind === 'admission_held' && skip.source === 'custom'
      )),
    };
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
      const cache = await this.cacheBuild.promise;
      return generation === this.cacheGeneration ? cache : this.getOrCreateCache();
    }

    const promise = this.buildCache(generation);
    const build = { generation, promise };
    this.cacheBuild = build;
    try {
      const cache = await promise;
      if (generation !== this.cacheGeneration) {
        return this.getOrCreateCache();
      }
      return cache;
    } finally {
      this.finishCacheBuild(build);
    }
  }

  private finishCacheBuild(build: NonNullable<SkillsRuntime['cacheBuild']>): void {
    if (this.cacheBuild === build) this.cacheBuild = null;
  }

  private async buildCache(generation: number): Promise<SkillSnapshotCache> {
    const runtimeConfig = this.loadRuntimeConfig();
    this.cachedReuseConfig = runtimeConfig.reuse;
    const repoRoot = requireSkillsRepoRoot(this.options.repoRoot);
    const configuredDirectories = resolveSkillDirectories(runtimeConfig, repoRoot);
    const directories = this.mergeManagedDirectory(configuredDirectories);
    const limits = this.getCollectionLimits();
    const scan = await scanSkillRoots(directories, { collectionLimits: limits });
    const files = scan.files;
    const fileSignature = await buildSkillFileSignature(files, limits.yieldEvery);

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
      collection: scan.collection,
      skipped: scan.skipped,
      files: fileSignature,
    });
    const fingerprint = await hashSignature(signaturePayload, limits.yieldEvery);

    if (this.cache && !this.cache.fingerprint.localeCompare(fingerprint)) {
      return this.cache;
    }

    const parsed = await loadSkillEntries(files, {
      collectionLimits: limits,
      initialRetainedBytes: scan.collection.candidateBytesRetained,
    });
    const deduped = await applySkillPrecedence(parsed.entries, limits.yieldEvery);
    // CogSec admission (psfn-framework-1fjvm.1) runs BEFORE eligibility,
    // formatting, and the by-name lookup map, so a held skill's frontmatter
    // never reaches the prompt XML and `findSkill` cannot resolve it.
    const admission = await this.admitSkillEntries(deduped.entries, limits);
    const eligibility: Awaited<ReturnType<typeof filterEligibleSkills>> = {
      evaluations: [],
      eligible: [],
      skipped: [],
    };
    for (let offset = 0; offset < admission.entries.length; offset += limits.yieldEvery) {
      const chunk = await filterEligibleSkills(
        admission.entries.slice(offset, offset + limits.yieldEvery),
        {
          runtimeConfig,
          environment: this.options.environment,
          isBinaryAvailable: this.options.isBinaryAvailable,
          maxBinaryRequirements: limits.maxBinaryRequirements,
        },
      );
      eligibility.evaluations.push(...chunk.evaluations);
      eligibility.eligible.push(...chunk.eligible);
      eligibility.skipped.push(...chunk.skipped);
      await new Promise<void>(resolveYield => setImmediate(resolveYield));
    }

    const promptOrdered = await cooperativeSort(
      eligibility.eligible,
      compareSkillsForPrompt,
      limits.yieldEvery,
    );
    const formatted = formatSkillsForPrompt(
      promptOrdered,
      {
        maxSkills: runtimeConfig.maxLoadedSkills,
        maxChars: runtimeConfig.maxSkillChars,
      },
      { presorted: true },
    );

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
      loadedSkills: admission.entries.length,
      collection: {
        ...scan.collection,
        metadataBytesRead: parsed.metadataBytesRead,
        metadataBytesRetained: parsed.metadataBytesRetained,
        limited: scan.collection.limited
          || parsed.skipped.some(item => item.kind === 'collection_limit'),
      },
      includedSkills: formatted.included,
      promptXml: formatted.xml,
      skipped: [
        ...scan.skipped,
        ...parsed.skipped,
        ...deduped.skipped,
        ...admission.skipped,
        ...eligibility.skipped,
        ...formatted.excluded,
      ],
    };

    const byName = new Map<string, SkillEvaluation>();
    for (const [index, evaluation] of eligibility.evaluations.entries()) {
      byName.set(evaluation.entry.name.toLowerCase(), evaluation);
      if ((index + 1) % limits.yieldEvery === 0) {
        await new Promise<void>(resolveYield => setImmediate(resolveYield));
      }
    }

    const nextCache = {
      fingerprint,
      snapshot,
      evaluations: eligibility.evaluations,
      byName,
      managedEntries: admission.entries.filter(entry => entry.source === 'custom'),
    };

    if (generation === this.cacheGeneration) {
      this.cache = nextCache;
    }
    return nextCache;
  }

  /**
   * Admit every discovered skill's exact document bytes before any of them can
   * be formatted into the prompt or resolved by name.
   *
   * Runs only when the snapshot fingerprint changed, so an unchanged skill
   * collection pays nothing here; a changed one pays one content-addressed
   * receipt lookup per skill and a real screen only for the bytes that have no
   * admitted receipt under the current screening contract.
   */
  private async admitSkillEntries(
    entries: SkillEntry[],
    limits: SkillCollectionLimits,
  ): Promise<{ entries: SkillEntry[]; skipped: SkillSkipRecord[] }> {
    if (!this.options.admission) return { entries, skipped: [] };
    const readOptions = createSkillDocumentReadBudget(limits.maxContentBytes);
    const admitted: SkillEntry[] = [];
    const skipped: SkillSkipRecord[] = [];
    for (const [index, entry] of entries.entries()) {
      const outcome = await this.admitSkillDocumentOrHold(entry, readOptions);
      if (outcome.admitted) admitted.push(entry);
      else skipped.push(outcome.skip);
      if ((index + 1) % limits.yieldEvery === 0) {
        await new Promise<void>(resolveYield => setImmediate(resolveYield));
      }
    }
    return { entries: admitted, skipped };
  }

  private loadRuntimeConfig(): SkillsRuntimeConfig {
    return loadSkillsConfig(this.options.dataDir, {
      seedDir: this.options.seedDir,
    });
  }

  private getCollectionLimits(): SkillCollectionLimits {
    return {
      ...DEFAULT_SKILL_COLLECTION_LIMITS,
      ...this.options.collectionLimits,
    };
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
