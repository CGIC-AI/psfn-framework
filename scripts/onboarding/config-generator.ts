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
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../../src/shared/utils/fs.js';
import { verifyStartupOwnerFiles } from '../../src/system/config/startup-owner-files.js';
import { PER_COMPANION_OWNER_FILES } from '../../src/system/config/settings-contract.js';
import { DEFAULT_COMPANION_CARD_FILE_NAME } from '../../src/core/identity/companion-naming.js';
import { assertValidCharacterCard } from '../../src/core/identity/loader.js';
import { isRecord } from '../../src/shared/utils/types.js';
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

function ownerFileRoot(plan: OnboardingPlan, name: string): string {
  return PER_COMPANION_OWNER_FILES.has(name) ? plan.roots.companionDataDir : plan.roots.systemDataDir;
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
 * Re-point the seed's two primary-bearing model entries (primary, extraction) at
 * the chosen provider and slugs. Keeping exactly those two entries preserves the
 * "exactly one primary per canonical purpose" invariant the model registry guard
 * enforces, and avoids leaving catalog entries that reference a provider id the
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
 * The manifest describes the ACTUAL on-disk layout this flow generates: the
 * per-companion owner files and the character card land at the companion-data
 * ROOT (that is where the single-companion runtime reads them from —
 * `{companionDataDir}/{DEFAULT_COMPANION_CARD_FILE_NAME}` and the per-companion
 * owners directly under the companion root). So the manifest points its
 * companionDataDir/characterCardPath at that root, keeping the generated
 * manifest self-consistent if a later operator flips the deployment to the
 * fleet control plane (wckv.1.3 review rider). A genuine multi-companion split
 * would re-lay each companion under its own subdir.
 */
export function buildCompanionsManifest(plan: OnboardingPlan): unknown {
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
        companionDataDir: '.',
        characterCardPath: DEFAULT_COMPANION_CARD_FILE_NAME,
        postgresSchema: 'companion_main',
        postgresRole: 'companion_main_runtime',
        postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_MAIN_DATABASE_URL' },
        displayName: 'Companion',
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
  return join(plan.roots.companionDataDir, DEFAULT_COMPANION_CARD_FILE_NAME);
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
  const stagingSystem = join(stagingRoot, 'system-data');
  const stagingCompanion = plan.roots.shared ? stagingSystem : join(stagingRoot, 'companion-data');
  try {
    mkdirSync(stagingSystem, { recursive: true });
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
