import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { delimiter, join, sep } from 'node:path';
import type { SkillsRuntimeConfig } from '../../system/config/skills-config.js';
import { DEFAULT_SKILL_COLLECTION_LIMITS } from './loader.js';
import type {
  SkillEligibilityResult,
  SkillEntry,
  SkillEvaluation,
  SkillSkipRecord,
} from './types.js';

export interface SkillEligibilityContext {
  runtimeConfig: SkillsRuntimeConfig;
  environment?: NodeJS.ProcessEnv;
  isBinaryAvailable?: (binaryName: string) => boolean | Promise<boolean>;
  maxBinaryRequirements?: number;
  /**
   * Aggregate binary-check ledger shared by every entry in one snapshot build
   * (psfn-framework-7wggj). {@link filterEligibleSkills} creates a call-scoped
   * ledger when the caller supplies none; the runtime creates one per
   * `buildCache` pass and threads it through every chunk so the bound is
   * genuinely collection-wide instead of per chunk.
   */
  binaryCheckLedger?: SkillBinaryCheckLedger;
  /** Ledger size used when this call has to create its own. */
  maxTotalBinaryChecks?: number;
}

/**
 * Mutable remaining-check counter for one eligibility pass
 * (psfn-framework-7wggj). Deliberately a shared mutable object rather than a
 * number: the aggregate bound only exists if every chunk decrements the same
 * ledger.
 */
export interface SkillBinaryCheckLedger {
  remaining: number;
}

export function createSkillBinaryCheckLedger(maxTotalBinaryChecks: number): SkillBinaryCheckLedger {
  return { remaining: maxTotalBinaryChecks };
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function splitConfigPath(path: string): string[] {
  return path
    .split('.')
    .map(segment => segment.trim())
    .filter(Boolean);
}

function lookupConfigValue(config: SkillsRuntimeConfig, path: string): unknown {
  const segments = splitConfigPath(path);
  if (segments.length === 0) return undefined;

  let value: unknown = config;
  for (const segment of segments) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }

    value = (value as Record<string, unknown>)[segment];
  }

  return value;
}

function isTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 && normalized !== 'false' && normalized !== '0' && normalized !== 'no';
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0;
  return false;
}

function binaryCandidates(binaryName: string): string[] {
  if (process.platform !== 'win32') return [binaryName];
  const extEnv = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
  const extensions = extEnv
    .split(';')
    .map(ext => ext.trim().toLowerCase())
    .filter(Boolean);

  const lower = binaryName.toLowerCase();
  if (extensions.some(ext => lower.endsWith(ext))) {
    return [binaryName];
  }

  return [binaryName, ...extensions.map(ext => `${binaryName}${ext}`)];
}

export interface BinaryAvailabilityProbe {
  isAvailable: (binaryName: string) => Promise<boolean>;
  /**
   * Observable counters (psfn-framework-7wggj). They exist so a regression
   * test can assert that PATH work stays proportional to the number of PATH
   * directories rather than to the number of (skill x binary) lookups.
   */
  stats: {
    /** PATH directories actually enumerated (each is listed at most once). */
    directoryScans: number;
    /** `access(X_OK)` syscalls issued — only for names present in a listing. */
    accessChecks: number;
    /** Availability questions asked, including memoized repeats. */
    lookups: number;
  };
}

/**
 * PATH-scan memoizing binary probe (psfn-framework-7wggj).
 *
 * The previous implementation re-walked every PATH directory for every binary
 * of every skill: a corpus of 64 skills x 64 binaries issued
 * 64*64*|PATH| `access` syscalls and stalled prompt assembly for minutes even
 * though every skill was within the per-skill bound. This probe lists each
 * PATH directory once, answers membership from that listing, and memoizes the
 * per-binary answer, so repeated names and absent names cost no syscalls at
 * all.
 *
 * The predicate is unchanged: a name is available only when it is present in a
 * PATH directory *and* `access(X_OK)` succeeds for it. A directory that cannot
 * be listed (searchable but not readable) falls back to the direct `access`
 * probe for that directory so no previously-visible binary becomes invisible.
 */
export function createBinaryAvailabilityProbe(
  environment: NodeJS.ProcessEnv = process.env,
): BinaryAvailabilityProbe {
  const stats: BinaryAvailabilityProbe['stats'] = { directoryScans: 0, accessChecks: 0, lookups: 0 };
  const listings = new Map<string, Promise<Set<string> | null>>();
  const answers = new Map<string, Promise<boolean>>();
  const caseInsensitive = process.platform === 'win32';
  const normalizeName = (name: string): string => (caseInsensitive ? name.toLowerCase() : name);

  const searchPaths = (environment.PATH ?? '')
    .split(delimiter)
    .map(path => path.trim())
    .filter(Boolean);

  function listDirectory(baseDir: string): Promise<Set<string> | null> {
    const cached = listings.get(baseDir);
    if (cached) return cached;
    stats.directoryScans += 1;
    const scan = readdir(baseDir).then(
      names => new Set(names.map(normalizeName)),
      // Unreadable or missing directory: fall back to direct probing so the
      // predicate cannot become stricter than it was.
      () => null,
    );
    listings.set(baseDir, scan);
    return scan;
  }

  async function isExecutable(baseDir: string, candidate: string): Promise<boolean> {
    stats.accessChecks += 1;
    try {
      await access(join(baseDir, candidate), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async function probe(binaryName: string): Promise<boolean> {
    if (!binaryName) return false;
    if (searchPaths.length === 0) return false;

    const candidates = binaryCandidates(binaryName);
    for (const baseDir of searchPaths) {
      const names = await listDirectory(baseDir);
      for (const candidate of candidates) {
        // A declared name carrying a path separator resolves relative to the
        // PATH entry, so a flat directory listing cannot answer it: probe it
        // directly, exactly as the pre-memoized implementation did.
        const listable = names !== null && !candidate.includes(sep) && !candidate.includes('/');
        if (listable && !names.has(normalizeName(candidate))) continue;
        if (await isExecutable(baseDir, candidate)) return true;
      }
    }

    return false;
  }

  return {
    isAvailable: (binaryName: string): Promise<boolean> => {
      stats.lookups += 1;
      const key = binaryName.trim();
      const cached = answers.get(key);
      if (cached) return cached;
      const pending = probe(key);
      answers.set(key, pending);
      return pending;
    },
    stats,
  };
}

/**
 * Single-shot binary probe, used when no collection-scoped probe was supplied.
 * Keeps the historical semantics (PATH is re-read for the one lookup).
 */
export async function defaultBinaryAvailable(binaryName: string): Promise<boolean> {
  return createBinaryAvailabilityProbe().isAvailable(binaryName);
}

export async function evaluateSkillEligibility(
  entry: SkillEntry,
  context: SkillEligibilityContext,
): Promise<SkillEligibilityResult> {
  const runtimeConfig = context.runtimeConfig;
  const environment = context.environment ?? process.env;
  const checkBinary = context.isBinaryAvailable ?? defaultBinaryAvailable;

  const binaries = uniqStrings(entry.requires.binaries);
  const binaryLimit = context.maxBinaryRequirements
    ?? DEFAULT_SKILL_COLLECTION_LIMITS.maxBinaryRequirements;
  const binaryLimitExceeded = binaries.length > binaryLimit;
  const ledger = context.binaryCheckLedger;
  // Fail closed on the aggregate bound: a skill whose declared binaries cannot
  // be paid for in full out of the remaining collection budget is evaluated
  // not at all, exactly like the per-skill bound above it.
  const budgetExhausted = !binaryLimitExceeded
    && ledger !== undefined
    && ledger.remaining < binaries.length;
  const missingBinaries: string[] = [];
  if (!binaryLimitExceeded && !budgetExhausted) {
    for (const binary of binaries) {
      if (ledger) ledger.remaining -= 1;
      if (!await checkBinary(binary)) missingBinaries.push(binary);
    }
  }

  const missingEnv = uniqStrings(
    entry.requires.env.filter((envVar) => {
      const value = environment[envVar];
      return value === undefined || value.trim() === '';
    }),
  );

  const missingConfig = uniqStrings(
    entry.requires.config.filter(path => !isTruthy(lookupConfigValue(runtimeConfig, path))),
  );

  const disabledByConfig = runtimeConfig.disabledSkills.includes(entry.name);
  const globallyDisabled = !runtimeConfig.enabled;

  const reasons: string[] = [];
  if (globallyDisabled) reasons.push('skills runtime is disabled in config');
  if (disabledByConfig) reasons.push('skill is disabled via skills.disabledSkills');
  if (binaryLimitExceeded) {
    reasons.push(`binary requirements exceed limit: ${String(binaries.length)} declared, maximum ${String(binaryLimit)}; none evaluated`);
  }
  if (budgetExhausted) {
    reasons.push(`aggregate binary check budget exhausted: ${String(binaries.length)} declared, ${String(ledger.remaining)} remaining; none evaluated`);
  }
  if (missingBinaries.length > 0) reasons.push(`missing binaries: ${missingBinaries.join(', ')}`);
  if (missingEnv.length > 0) reasons.push(`missing env vars: ${missingEnv.join(', ')}`);
  if (missingConfig.length > 0) reasons.push(`missing config flags: ${missingConfig.join(', ')}`);

  return {
    eligible: reasons.length === 0,
    disabledByConfig,
    missingBinaries,
    missingEnv,
    missingConfig,
    reasons,
  };
}

export async function filterEligibleSkills(
  entries: SkillEntry[],
  context: SkillEligibilityContext,
): Promise<{
  evaluations: SkillEvaluation[];
  eligible: SkillEntry[];
  skipped: SkillSkipRecord[];
}> {
  const evaluations: SkillEvaluation[] = [];
  const eligible: SkillEntry[] = [];
  const skipped: SkillSkipRecord[] = [];
  // One ledger and one PATH-scan-memoizing probe per call when the caller
  // supplies none: the runtime creates both once per snapshot build, but a
  // direct caller must not silently degrade to a per-binary PATH walk or an
  // unbounded aggregate.
  const entryContext: SkillEligibilityContext = {
    ...context,
    isBinaryAvailable: context.isBinaryAvailable ?? createBinaryAvailabilityProbe().isAvailable,
    binaryCheckLedger: context.binaryCheckLedger ?? createSkillBinaryCheckLedger(
      context.maxTotalBinaryChecks ?? context.runtimeConfig.eligibility.maxTotalBinaryChecks,
    ),
  };

  for (const entry of entries) {
    const eligibility = await evaluateSkillEligibility(entry, entryContext);
    evaluations.push({ entry, eligibility });

    if (eligibility.eligible) {
      eligible.push(entry);
      continue;
    }

    skipped.push({
      kind: 'ineligible',
      name: entry.name,
      relativePath: entry.relativePath,
      source: entry.source,
      reason: eligibility.reasons.join('; '),
      details: eligibility.reasons,
    });
  }

  return {
    evaluations,
    eligible,
    skipped,
  };
}
