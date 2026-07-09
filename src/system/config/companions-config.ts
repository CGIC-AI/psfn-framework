import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { loadRequiredJson } from './load-or-seed.js';
import { assertNoUnknownKeys } from './validators.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { parseBooleanEnv } from '../../shared/utils/env.js';
import { isStrictSubpath } from '../../persistence/layout.js';

export const COMPANIONS_FILE_NAME = 'companions.json';
export const COMPANIONS_SEED_FILE_NAME = 'companions.seed.json';

/**
 * Env flag that opts a deployment into the multi-companion substrate topology.
 *
 * Process-wiring / topology-selection scope (like `PSFN_RUNTIME_LAYOUT_MODE`):
 * it selects the shape of the runtime, not a mutable runtime setting. The fleet
 * itself is enumerated by the {@link COMPANIONS_FILE_NAME} owner file.
 */
export const MULTI_COMPANION_ENV_VAR = 'PSFN_MULTI_COMPANION';

const COMPANIONS_ERROR_PREFIX = 'Invalid companions config';

/**
 * Canonical companion-id format. Mirrors the UUID validation used elsewhere in
 * the codebase (`src/core/cogsec/forensic-archive.ts` artifact ids), i.e. a
 * lowercase RFC-4122 UUID (versions 1-5, which covers `randomUUID()` v4 ids).
 */
const COMPANION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Postgres schema identifier: strict lowercase identifier so it can be dropped
 * into `search_path = companion_<schema>` without quoting or injection risk.
 * Postgres identifiers are capped at 63 bytes; `pg_` is reserved by Postgres.
 */
const POSTGRES_SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/u;
const POSTGRES_SCHEMA_MAX_LENGTH = 63;

/** Valid TCP port range for per-companion Garden operator surfaces. */
const GARDEN_PORT_MIN = 1;
const GARDEN_PORT_MAX = 65_535;

const COMPANION_ENTRY_KEYS = [
  'companionId',
  'companionDataDir',
  'characterCardPath',
  'postgresSchema',
  'gardenPort',
] as const;

const COMPANIONS_ROOT_KEYS = ['companions'] as const;

export interface CompanionFleetEntry {
  /** RFC-4122 UUID identifying the companion across the fleet. */
  companionId: string;
  /** Relative path (under the persistence root) holding the companion's data. */
  companionDataDir: string;
  /** Relative path to the companion's character card. */
  characterCardPath: string;
  /** Lowercase Postgres schema owning this companion's tenant tables. */
  postgresSchema: string;
  /**
   * Optional TCP port for this companion's own Garden operator surface
   * (sprint-10 W4: one Garden per companion). When present the supervisor
   * launcher spawns a dedicated operator process listening on this port,
   * bound to this companion's admin transport socket. When absent, no
   * operator process is spawned for the companion. Must be unique across
   * the fleet — port collisions fail closed at validation time.
   */
  gardenPort?: number;
}

export interface CompanionsFleetConfig {
  companions: CompanionFleetEntry[];
}

export interface ResolvedCompanionFleetEntry extends Omit<CompanionFleetEntry, 'companionDataDir' | 'characterCardPath'> {
  /** Absolute companion data root resolved beneath the runtime persistence root. */
  companionDataDir: string;
  /** Absolute character-card path resolved beneath the runtime persistence root. */
  characterCardPath: string;
}

export interface ResolvedCompanionsFleetConfig {
  persistenceRoot: string;
  companions: ResolvedCompanionFleetEntry[];
}

export type CompanionRuntimeIdentity = ResolvedCompanionFleetEntry;

export interface CompanionsConfigLoadOptions {
  seedDir?: string;
}

export interface ResolveCompanionFleetOptions {
  dataDir: string;
  multiCompanion: boolean;
  seedDir?: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must be a string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const trimmed = requireString(value, field).trim();
  if (trimmed.length === 0) {
    throw new Error(`${COMPANIONS_ERROR_PREFIX}: ${field} must be a non-empty string`);
  }
  return trimmed;
}

function requireCompanionId(value: unknown, field: string): string {
  const id = requireNonEmptyString(value, field);
  if (!COMPANION_ID_PATTERN.test(id)) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must be a lowercase RFC-4122 UUID, got ${JSON.stringify(value)}`,
    );
  }
  return id;
}

function requirePostgresSchema(value: unknown, field: string): string {
  const schema = requireNonEmptyString(value, field);
  if (schema.length > POSTGRES_SCHEMA_MAX_LENGTH) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must be at most ${POSTGRES_SCHEMA_MAX_LENGTH} characters`,
    );
  }
  if (!POSTGRES_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must be a lowercase identifier `
      + `matching ${POSTGRES_SCHEMA_PATTERN.source}, got ${JSON.stringify(value)}`,
    );
  }
  if (schema.startsWith('pg_')) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must not start with the reserved "pg_" prefix`,
    );
  }
  return schema;
}

function requireOptionalGardenPort(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must be an integer TCP port, got ${JSON.stringify(value)}`,
    );
  }
  if (value < GARDEN_PORT_MIN || value > GARDEN_PORT_MAX) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must be between ${GARDEN_PORT_MIN} and ${GARDEN_PORT_MAX}, `
      + `got ${value}`,
    );
  }
  return value;
}

function requireRelativePath(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (isAbsolute(raw)) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must be a relative path under the persistence root, got ${JSON.stringify(value)}`,
    );
  }
  const normalized = normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must not escape the persistence root, got ${JSON.stringify(value)}`,
    );
  }
  return normalized;
}

function validateCompanionEntry(raw: unknown, index: number): CompanionFleetEntry {
  const label = `companions[${index}]`;
  if (!isRecord(raw)) {
    throw new Error(`${COMPANIONS_ERROR_PREFIX}: ${label} must be an object`);
  }
  assertNoUnknownKeys(raw, COMPANION_ENTRY_KEYS, label, { errorPrefix: COMPANIONS_ERROR_PREFIX });
  const gardenPort = requireOptionalGardenPort(raw.gardenPort, `${label}.gardenPort`);
  return {
    companionId: requireCompanionId(raw.companionId, `${label}.companionId`),
    companionDataDir: requireRelativePath(raw.companionDataDir, `${label}.companionDataDir`),
    characterCardPath: requireRelativePath(raw.characterCardPath, `${label}.characterCardPath`),
    postgresSchema: requirePostgresSchema(raw.postgresSchema, `${label}.postgresSchema`),
    ...(gardenPort !== undefined ? { gardenPort } : {}),
  };
}

function assertNoDuplicateField(
  companions: readonly CompanionFleetEntry[],
  select: (entry: CompanionFleetEntry) => string,
  fieldLabel: string,
): void {
  const seen = new Map<string, number>();
  for (let index = 0; index < companions.length; index += 1) {
    const value = select(companions[index]);
    const previous = seen.get(value);
    if (previous !== undefined) {
      throw new Error(
        `${COMPANIONS_ERROR_PREFIX}: duplicate ${fieldLabel} "${value}" `
        + `in companions[${previous}] and companions[${index}]`,
      );
    }
    seen.set(value, index);
  }
}

function assertNoDuplicateGardenPorts(companions: readonly CompanionFleetEntry[]): void {
  const seen = new Map<number, number>();
  for (let index = 0; index < companions.length; index += 1) {
    const port = companions[index].gardenPort;
    if (port === undefined) {
      continue;
    }
    const previous = seen.get(port);
    if (previous !== undefined) {
      throw new Error(
        `${COMPANIONS_ERROR_PREFIX}: duplicate gardenPort ${port} `
        + `in companions[${previous}] and companions[${index}] — each companion's Garden `
        + 'operator surface must listen on its own port',
      );
    }
    seen.set(port, index);
  }
}

function assertNoOverlappingDataDirs(companions: readonly CompanionFleetEntry[]): void {
  for (let i = 0; i < companions.length; i += 1) {
    const first = companions[i].companionDataDir;
    for (let j = i + 1; j < companions.length; j += 1) {
      const second = companions[j].companionDataDir;
      if (
        resolve(first) === resolve(second)
        || isStrictSubpath(first, second)
        || isStrictSubpath(second, first)
      ) {
        throw new Error(
          `${COMPANIONS_ERROR_PREFIX}: companionDataDir "${first}" (companions[${i}]) `
          + `must not overlap companionDataDir "${second}" (companions[${j}])`,
        );
      }
    }
  }
}

export function validateCompanionsConfig(raw: unknown, sourcePath: string): CompanionsFleetConfig {
  if (!isRecord(raw)) {
    throw new Error(`${COMPANIONS_ERROR_PREFIX} at ${sourcePath}: expected object`);
  }
  assertNoUnknownKeys(raw, COMPANIONS_ROOT_KEYS, 'root', { errorPrefix: COMPANIONS_ERROR_PREFIX });
  if (!Array.isArray(raw.companions)) {
    throw new Error(`${COMPANIONS_ERROR_PREFIX} at ${sourcePath}: companions must be an array`);
  }
  if (raw.companions.length === 0) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX} at ${sourcePath}: companions must enumerate at least one companion`,
    );
  }

  const companions = raw.companions.map((entry, index) => validateCompanionEntry(entry, index));

  assertNoDuplicateField(companions, (entry) => entry.companionId, 'companionId');
  assertNoDuplicateField(companions, (entry) => entry.postgresSchema, 'postgresSchema');
  assertNoDuplicateGardenPorts(companions);
  assertNoOverlappingDataDirs(companions);

  return { companions };
}

export function loadCompanionsConfig(
  dataDir: string,
  options: CompanionsConfigLoadOptions = {},
): CompanionsFleetConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, COMPANIONS_FILE_NAME),
    examplePath: join(seedDir, COMPANIONS_SEED_FILE_NAME),
    validate: validateCompanionsConfig,
  });
}

export function saveCompanionsConfig(
  dataDir: string,
  nextConfig: unknown,
): CompanionsFleetConfig {
  const validated = validateCompanionsConfig(nextConfig, COMPANIONS_FILE_NAME);
  writeJsonAtomic(join(dataDir, COMPANIONS_FILE_NAME), validated);
  return validated;
}

export function companionsFilePath(dataDir: string): string {
  return join(dataDir, COMPANIONS_FILE_NAME);
}

export function companionsFileExists(dataDir: string): boolean {
  return existsSync(companionsFilePath(dataDir));
}

/**
 * Canonical accessor for the multi-companion topology flag.
 *
 * Fail-closed: an unset/empty value means single-companion (default) topology;
 * an explicitly-set but unparseable value throws rather than silently defaulting
 * off, since this selects a security-sensitive tenancy boundary.
 */
export function isMultiCompanionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MULTI_COMPANION_ENV_VAR];
  const normalized = raw?.trim();
  if (!normalized) {
    return false;
  }
  const parsed = parseBooleanEnv(normalized);
  if (parsed === undefined) {
    throw new Error(
      `Invalid ${MULTI_COMPANION_ENV_VAR}=${JSON.stringify(raw)}. `
      + 'Expected a boolean flag (1/0, true/false, yes/no, on/off).',
    );
  }
  return parsed;
}

/**
 * Resolve the companion fleet, failing closed in both directions:
 *
 * - flag on  + companions.json missing/invalid => refuse to start
 * - flag off + companions.json present         => refuse to start
 *
 * Returns the validated fleet when multi-companion is enabled, or `undefined`
 * for the default single-companion topology.
 */
export function resolveCompanionFleet(
  options: ResolveCompanionFleetOptions,
): CompanionsFleetConfig | undefined {
  const present = companionsFileExists(options.dataDir);
  const path = companionsFilePath(options.dataDir);

  if (options.multiCompanion) {
    if (!present) {
      throw new Error(
        `${MULTI_COMPANION_ENV_VAR} is enabled but the fleet manifest is missing at ${path}. `
        + 'Multi-companion mode requires a companions.json enumerating the fleet.',
      );
    }
    return loadCompanionsConfig(options.dataDir, { seedDir: options.seedDir });
  }

  if (present) {
    throw new Error(
      `A fleet manifest is present at ${path} but ${MULTI_COMPANION_ENV_VAR} is not enabled. `
      + 'Enable multi-companion mode or remove companions.json (owner-file strictness refuses to '
      + 'ignore a fleet manifest in single-companion topology).',
    );
  }
  return undefined;
}

function assertResolvedPathInsideRoot(
  candidatePath: string,
  persistenceRoot: string,
  field: string,
): string {
  if (!isStrictSubpath(candidatePath, persistenceRoot)) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must resolve beneath persistence root ${persistenceRoot}, `
      + `got ${candidatePath}`,
    );
  }

  const realRoot = realpathSync(persistenceRoot);
  let existingAncestor = candidatePath;
  while (!existsSync(existingAncestor)) {
    const parent = resolve(existingAncestor, '..');
    if (parent === existingAncestor || !isStrictSubpath(parent, persistenceRoot)) {
      existingAncestor = persistenceRoot;
      break;
    }
    existingAncestor = parent;
  }
  const realAncestor = realpathSync(existingAncestor);
  if (realAncestor !== realRoot && !isStrictSubpath(realAncestor, realRoot)) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} resolves through a symlink outside persistence root `
      + `${persistenceRoot}`,
    );
  }

  const canonicalPath = resolve(realAncestor, relative(existingAncestor, candidatePath));
  if (!isStrictSubpath(canonicalPath, realRoot)) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: ${field} must resolve beneath persistence root ${realRoot}, `
      + `got ${canonicalPath}`,
    );
  }
  return canonicalPath;
}

function resolveFleetPath(
  persistenceRoot: string,
  relativePath: string,
  field: string,
): string {
  const candidatePath = resolve(persistenceRoot, relativePath);
  return assertResolvedPathInsideRoot(candidatePath, persistenceRoot, field);
}

/**
 * Resolve owner-file-relative fleet paths against one canonical runtime root.
 * The returned paths are absolute and checked against existing symlink
 * ancestors so the launcher and runtime never reinterpret them via process CWD.
 */
export function resolveCompanionFleetPaths(
  fleet: CompanionsFleetConfig,
  persistenceRoot: string,
): ResolvedCompanionsFleetConfig {
  const requestedRoot = resolve(persistenceRoot);
  if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) {
    throw new Error(
      `${COMPANIONS_ERROR_PREFIX}: persistence root must be an existing directory, got ${requestedRoot}`,
    );
  }
  const resolvedRoot = realpathSync(requestedRoot);

  const companions = fleet.companions.map((entry, index) => ({
    ...entry,
    companionDataDir: resolveFleetPath(
      resolvedRoot,
      entry.companionDataDir,
      `companions[${index}].companionDataDir`,
    ),
    characterCardPath: resolveFleetPath(
      resolvedRoot,
      entry.characterCardPath,
      `companions[${index}].characterCardPath`,
    ),
  }));
  assertNoOverlappingDataDirs(companions);

  return {
    persistenceRoot: resolvedRoot,
    companions,
  };
}

function assertRuntimeIdentityValue(
  field: string,
  actual: string | undefined,
  expected: string,
  pathValue = false,
): void {
  const normalizedActual = actual?.trim();
  const matches = pathValue
    ? normalizedActual !== undefined && resolve(normalizedActual) === expected
    : normalizedActual === expected;
  if (!matches) {
    throw new Error(
      `Multi-companion runtime identity mismatch for ${field}: expected ${JSON.stringify(expected)} `
      + `from ${COMPANIONS_FILE_NAME}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Bind one process to exactly one resolved fleet entry or fail startup. */
export function resolveCompanionRuntimeIdentity(input: {
  fleet: ResolvedCompanionsFleetConfig;
  companionId: string;
  companionDataDir?: string;
  characterCardPath?: string;
  postgresSchema?: string;
}): CompanionRuntimeIdentity {
  const companionId = input.companionId.trim();
  const identity = input.fleet.companions.find(entry => entry.companionId === companionId);
  if (!identity) {
    throw new Error(
      `Multi-companion runtime identity ${JSON.stringify(companionId)} is not present in ${COMPANIONS_FILE_NAME}`,
    );
  }

  assertRuntimeIdentityValue('COMPANION_DATA_DIR', input.companionDataDir, identity.companionDataDir, true);
  assertRuntimeIdentityValue('CHARACTER_CARD_PATH', input.characterCardPath, identity.characterCardPath, true);
  assertRuntimeIdentityValue('COMPANION_PG_SCHEMA', input.postgresSchema, identity.postgresSchema);
  return identity;
}
