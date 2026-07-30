// ── Owner-file generation (psfn-framework-wckv.1.1 / wckv.1.2) ──
// Turns a resolved OnboardingPlan into the canonical JSON owner-file set for the
// chosen install mode. Everything is staged and validated through the REAL
// settings-contract loaders (verifyStartupOwnerFiles) before a single file lands
// in the target roots, and the commit is abort-safe: a failure at any point
// rolls back to the pre-run state.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { writeJsonAtomic } from '../../src/shared/utils/fs.js';
import { verifyStartupOwnerFiles } from '../../src/system/config/startup-owner-files.js';
import { PER_COMPANION_OWNER_FILES } from '../../src/system/config/settings-contract.js';
import {
  DEFAULT_COMPANION_CARD_FILE_NAME,
  DEFAULT_COMPANION_NAME,
} from '../../src/core/identity/companion-naming.js';
import { assertValidCharacterCard } from '../../src/core/identity/loader.js';
import { isRecord } from '../../src/shared/utils/types.js';
import { resolveConfiguredCompanionFleet } from '../companion-fleet-runtime.js';
import type { OnboardingPlan } from './types.js';

/** Owner files whose whole content this flow synthesizes rather than copies. */
const BUILT_OWNER_FILES = new Set<string>([
  'settings.json',
  'models.json',
  'providers.json',
  'companions.json',
]);

/**
 * Owner files copied verbatim from the canonical seeds. Includes the guard-
 * checked owners AND the boot-required-but-guard-silent ones (places,
 * runtime-prompt-layers) so a generated root actually starts.
 */
const SEED_COPIED_OWNER_FILES: readonly string[] = [
  'trust-policy.json',
  'intake-policy.json',
  'backup.json',
  'partner-affect-shadow.json',
  'places.json',
  'runtime-prompt-layers.json',
  // per-companion (rooted under companionDataDir):
  'scheduler.json',
  'capability-tier.json',
  'charge-policy.json',
  'skills.json',
];

interface OwnerFileEntry {
  /** Owner file basename, e.g. "providers.json". */
  name: string;
  /** Absolute destination path in the target root. */
  path: string;
  /** Parsed JSON value to write. */
  value: unknown;
}

function nearestCommonAncestor(firstPath: string, secondPath: string): string {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  let candidate = first;
  for (;;) {
    const relativeSecond = relative(candidate, second);
    if (relativeSecond !== '..' && !relativeSecond.startsWith('../')) {
      break;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Cannot derive a common runtime root for ${first} and ${second}`);
    }
    candidate = parent;
  }
  return candidate;
}

/**
 * Runtime root against which companions.json paths are interpreted.
 *
 * A shared DATA_DIR cannot itself be the runtime root: fleet entries must be
 * strict descendants of that root and the runtime workspace must remain a
 * sibling of mutable data. Split roots naturally share their parent.
 */
export function resolveOnboardingRuntimeRoot(plan: Pick<OnboardingPlan, 'roots'>): string {
  const systemDataDir = resolve(plan.roots.systemDataDir);
  const companionDataDir = resolve(plan.roots.companionDataDir);
  const common = nearestCommonAncestor(systemDataDir, companionDataDir);
  return common === systemDataDir || common === companionDataDir
    ? dirname(common)
    : common;
}

/** Canonical one-entry fleet data root generated beneath the configured base. */
export function resolveOnboardingCompanionDataDir(plan: Pick<OnboardingPlan, 'roots'>): string {
  return plan.roots.shared
    ? resolve(plan.roots.companionDataDir, 'companions', 'main')
    : resolve(plan.roots.companionDataDir, 'main');
}

function manifestPath(plan: OnboardingPlan, absolutePath: string, field: string): string {
  const runtimeRoot = resolveOnboardingRuntimeRoot(plan);
  const path = relative(runtimeRoot, absolutePath);
  if (!path || path === '.' || path === '..' || path.startsWith('../')) {
    throw new Error(
      `Cannot generate ${field}: ${absolutePath} must be beneath runtime root ${runtimeRoot}`,
    );
  }
  return path;
}

function ownerFileRoot(plan: OnboardingPlan, name: string): string {
  return PER_COMPANION_OWNER_FILES.has(name)
    ? resolveOnboardingCompanionDataDir(plan)
    : plan.roots.systemDataDir;
}

function readSeed(seedDir: string, name: string): unknown {
  const seedPath = join(seedDir, name.replace(/\.json$/u, '.seed.json'));
  let raw: string;
  try {
    raw = readFileSync(seedPath, 'utf-8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read owner-file seed at ${seedPath}: ${reason}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Owner-file seed at ${seedPath} is not valid JSON: ${reason}`);
  }
}

export function buildProvidersRegistry(plan: OnboardingPlan): unknown {
  const provider = plan.provider;
  return {
    schemaVersion: 1,
    providers: [
      {
        id: provider.id,
        type: provider.type,
        enabled: true,
        label: provider.label,
        apiBaseUrl: provider.apiBaseUrl,
        ...(provider.modelsApiUrl ? { modelsApiUrl: provider.modelsApiUrl } : {}),
        apiKeyRef: { kind: 'env', envName: provider.apiKeyEnvName },
        ...(provider.type === 'openrouter'
          ? { metadata: { webTools: { enabled: false, model: 'openai/gpt-4o-mini' } } }
          : {}),
      },
    ],
  };
}

/**
 * Re-point the seed's two selected model entries (primary, extraction) at the
 * chosen provider and slugs. The generated primary also owns vision: onboarding
 * does not ask for a separate vision model, while the canonical registry guard
 * requires exactly one primary for that purpose. Keeping exactly these two
 * entries avoids leaving catalog entries that reference a provider id the
 * generated providers.json does not define.
 */
export function buildModelsRegistry(plan: OnboardingPlan): unknown {
  const seed = readSeed(plan.seedDir, 'models.json');
  if (!isRecord(seed) || !Array.isArray(seed.models)) {
    throw new Error('Invalid models seed: expected { models: [...] }');
  }
  const providerId = plan.provider.id;
  const sourceType = plan.provider.type;
  const models = seed.models
    .filter((entry): entry is Record<string, unknown> => isRecord(entry)
      && (entry.id === 'primary' || entry.id === 'extraction'))
    .map((entry) => {
      const slug = entry.id === 'primary'
        ? plan.models.primaryModelSlug
        : plan.models.extractionModelSlug;
      const identity = isRecord(entry.identity) ? entry.identity : {};
      return {
        ...entry,
        ...(entry.id === 'primary' && Array.isArray(entry.purposes)
          ? {
              purposes: [
                ...entry.purposes,
                { purpose: 'vision', primary: true },
              ],
            }
          : {}),
        identity: {
          ...identity,
          provider: providerId,
          model: slug,
          source: { type: sourceType },
        },
      };
    });
  if (models.length !== 2) {
    throw new Error('Invalid models seed: expected "primary" and "extraction" entries');
  }
  return {
    schemaVersion: 1,
    promptCaching: isRecord(seed.promptCaching) ? seed.promptCaching : { enabled: true },
    models,
  };
}

/**
 * Single-companion fleet manifest naming this deployment's companion id.
 *
 * The manifest describes the actual on-disk layout this flow generates. Even a
 * fleet of one gets a strict companion subdirectory, because the fleet resolver
 * rejects the persistence root itself as a companion-owned root.
 */
export function buildCompanionsManifest(plan: OnboardingPlan): unknown {
  const companionDataDir = resolveOnboardingCompanionDataDir(plan);
  const characterCardPath = join(companionDataDir, DEFAULT_COMPANION_CARD_FILE_NAME);
  return {
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: {
        kind: 'env',
        envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
      },
    },
    companions: [
      {
        companionId: plan.companionId,
        companionDataDir: manifestPath(
          plan,
          companionDataDir,
          'companions[0].companionDataDir',
        ),
        characterCardPath: manifestPath(
          plan,
          characterCardPath,
          'companions[0].characterCardPath',
        ),
        postgresSchema: 'companion_main',
        postgresRole: 'companion_main_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_MAIN_DATABASE_URL' },
        displayName: plan.card?.data.name ?? DEFAULT_COMPANION_NAME,
      },
    ],
  };
}

/** settings.json content, seed-derived, with the optional voice selection applied. */
export function buildSettings(plan: OnboardingPlan): unknown {
  const seed = readSeed(plan.seedDir, 'settings.json');
  if (!isRecord(seed)) {
    throw new Error('Invalid settings seed: expected object');
  }
  if (!plan.voice.enabled) {
    return seed;
  }
  return {
    ...seed,
    voiceEnabled: true,
    ...(plan.voice.sttProvider ? { sttProvider: plan.voice.sttProvider } : {}),
    ...(plan.voice.ttsProvider ? { ttsProvider: plan.voice.ttsProvider } : {}),
  };
}

/** All owner-file entries this plan will write, rooted at the FINAL target paths. */
export function ownerFileEntries(plan: OnboardingPlan): OwnerFileEntry[] {
  const entries: OwnerFileEntry[] = [];
  const built: Record<string, unknown> = {
    'settings.json': buildSettings(plan),
    'models.json': buildModelsRegistry(plan),
    'providers.json': buildProvidersRegistry(plan),
    'companions.json': buildCompanionsManifest(plan),
  };
  for (const name of BUILT_OWNER_FILES) {
    entries.push({ name, path: join(ownerFileRoot(plan, name), name), value: built[name] });
  }
  for (const name of SEED_COPIED_OWNER_FILES) {
    entries.push({ name, path: join(ownerFileRoot(plan, name), name), value: readSeed(plan.seedDir, name) });
  }
  return entries;
}

/**
 * Absolute path where the companion's character card lands: the companion-data
 * root, exactly where the single-companion runtime reads it
 * (`{companionDataDir}/{DEFAULT_COMPANION_CARD_FILE_NAME}` in load-config).
 */
export function characterCardTargetPath(plan: OnboardingPlan): string {
  return join(resolveOnboardingCompanionDataDir(plan), DEFAULT_COMPANION_CARD_FILE_NAME);
}

/** The character-card write entry, when the plan carries a resolved card. */
function characterCardEntry(plan: OnboardingPlan): OwnerFileEntry | undefined {
  if (!plan.card) return undefined;
  return {
    name: DEFAULT_COMPANION_CARD_FILE_NAME,
    path: characterCardTargetPath(plan),
    value: plan.card,
  };
}

/** Owner files plus the character card (when present): the full commit set. */
function commitWriteEntries(plan: OnboardingPlan): OwnerFileEntry[] {
  const cardEntry = characterCardEntry(plan);
  return cardEntry ? [...ownerFileEntries(plan), cardEntry] : ownerFileEntries(plan);
}

/**
 * Existing target files a fresh run would collide with — the owner files and
 * the character card. The card path is checked unconditionally so the flow's
 * early idempotency gate detects an existing companion even before a new card
 * is resolved.
 */
export function detectExistingOwnerFiles(plan: OnboardingPlan): string[] {
  const paths = [...ownerFileEntries(plan).map((entry) => entry.path), characterCardTargetPath(plan)];
  return paths.filter((path) => existsSync(path));
}

/**
 * Write every owner file into an isolated staging directory and validate the
 * result through the real startup owner-file guard. Throws with the collected
 * validation errors on failure. Leaves nothing in the target roots.
 */
export function stageAndValidate(plan: OnboardingPlan): void {
  // The character card is not a settings-contract owner file (the startup guard
  // never reads it), so validate it here through the runtime's own validator
  // before any owner file is staged — a malformed card fails before writes.
  if (plan.card) {
    assertValidCharacterCard(plan.card, characterCardTargetPath(plan));
  }
  const stagingRoot = mkdtempSync(join(tmpdir(), 'psfn-onboard-stage-'));
  const plannedRuntimeRoot = resolveOnboardingRuntimeRoot(plan);
  const stagingSystem = join(
    stagingRoot,
    relative(plannedRuntimeRoot, resolve(plan.roots.systemDataDir)),
  );
  const stagingCompanionBase = join(
    stagingRoot,
    relative(plannedRuntimeRoot, resolve(plan.roots.companionDataDir)),
  );
  const stagingCompanion = plan.roots.shared
    ? join(stagingCompanionBase, 'companions', 'main')
    : join(stagingCompanionBase, 'main');
  try {
    mkdirSync(stagingSystem, { recursive: true });
    mkdirSync(stagingCompanionBase, { recursive: true });
    mkdirSync(stagingCompanion, { recursive: true });
    for (const entry of ownerFileEntries(plan)) {
      const root = PER_COMPANION_OWNER_FILES.has(entry.name) ? stagingCompanion : stagingSystem;
      writeJsonAtomic(join(root, entry.name), entry.value);
    }
    const result = verifyStartupOwnerFiles({
      dataDir: stagingSystem,
      companionDataDir: stagingCompanion,
      seedDir: plan.seedDir,
      defaultContextWindow: 128_000,
      fleetAuth: false,
    });
    if (!result.ok) {
      throw new Error(
        `Generated owner files failed settings-contract validation:\n- ${result.errors.join('\n- ')}`,
      );
    }
    const fleet = resolveConfiguredCompanionFleet({
      PSFN_RUNTIME_ROOT: stagingRoot,
      CONFIG_DIR: plan.seedDir,
      ...(plan.roots.shared
        ? { DATA_DIR: stagingSystem }
        : {
          SYSTEM_DATA_DIR: stagingSystem,
          COMPANION_DATA_DIR: stagingCompanionBase,
        }),
    });
    const generatedCompanion = fleet.companions[0];
    const expectedCardPath = join(stagingCompanion, DEFAULT_COMPANION_CARD_FILE_NAME);
    if (
      fleet.companions.length !== 1
      || generatedCompanion?.companionDataDir !== stagingCompanion
      || generatedCompanion.characterCardPath !== expectedCardPath
    ) {
      throw new Error(
        'Generated companions.json did not resolve to the staged companion owner/card layout',
      );
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export interface CommitResult {
  writtenPaths: string[];
}

/**
 * Abort-safe commit. Validates first (staging), then writes atomically into the
 * target roots. On any failure, files created by this run are removed and any
 * files overwritten in update mode are restored from their backups.
 */
export function commitOwnerFiles(plan: OnboardingPlan): CommitResult {
  const existing = detectExistingOwnerFiles(plan);
  if (existing.length > 0 && !plan.updateExisting) {
    throw new Error(
      'Existing owner files were found and update was not confirmed; refusing to overwrite:\n- '
      + existing.join('\n- '),
    );
  }

  stageAndValidate(plan);

  const writeEntries = commitWriteEntries(plan);
  const created: string[] = [];
  const backups: Array<{ original: string; backup: string }> = [];
  try {
    for (const entry of writeEntries) {
      mkdirSync(dirname(entry.path), { recursive: true });
      if (existsSync(entry.path)) {
        const backup = `${entry.path}.onboard-bak-${process.pid}`;
        renameSync(entry.path, backup);
        backups.push({ original: entry.path, backup });
      } else {
        created.push(entry.path);
      }
      writeJsonAtomic(entry.path, entry.value);
    }
  } catch (error) {
    rollback(created, backups);
    throw error;
  }

  // Success: discard the backups of overwritten files.
  for (const { backup } of backups) {
    try {
      unlinkSync(backup);
    } catch {
      // Best-effort: a stale backup is harmless.
    }
  }

  return { writtenPaths: writeEntries.map((entry) => entry.path) };
}

function rollback(created: string[], backups: Array<{ original: string; backup: string }>): void {
  for (const path of created) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
  for (const { original, backup } of backups) {
    try {
      if (existsSync(backup)) {
        if (existsSync(original)) unlinkSync(original);
        renameSync(backup, original);
      }
    } catch {
      // ignore
    }
  }
}

/** Copy a canonical seed file to an arbitrary destination (used by tests/setup). */
export function copySeed(seedDir: string, name: string, destPath: string): void {
  copyFileSync(join(seedDir, name.replace(/\.json$/u, '.seed.json')), destPath);
}
