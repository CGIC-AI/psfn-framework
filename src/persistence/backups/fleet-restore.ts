import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isRecord } from '../../shared/utils/types.js';
import { isStrictSubpath } from '../layout.js';
import { assertValidPostgresSchemaName } from '../postgres.js';
import {
  COMPANION_TREE_DIR_NAME,
  WORKSPACE_TREE_DIR_NAME,
  verifyCompanionTreeSnapshot,
  verifyWorkspaceTreeSnapshot,
} from './companion-tree.js';
import {
  SYSTEM_CONFIG_DIR_NAME,
  verifySystemConfigSnapshot,
} from './system-config-tree.js';
import { verifyBackupContentsManifest } from './backup-contents.js';
import {
  FLEET_BACKUP_MANIFEST_SCHEMA_VERSION,
  type FleetBackupUnitOutcome,
} from './service.js';

const execFileAsync = promisify(execFile);
const POSTGRES_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TOC_OBJECT_DESCRIPTIONS = [
  'MATERIALIZED VIEW DATA',
  'SEQUENCE OWNED BY',
  'PUBLICATION TABLE',
  'TEXT SEARCH CONFIGURATION',
  'TEXT SEARCH DICTIONARY',
  'TEXT SEARCH PARSER',
  'TEXT SEARCH TEMPLATE',
  'FOREIGN DATA WRAPPER',
  'MATERIALIZED VIEW',
  'DEFAULT ACL',
  'FK CONSTRAINT',
  'INDEX ATTACH',
  'TABLE ATTACH',
  'TABLE DATA',
  'SEQUENCE SET',
  'FOREIGN TABLE',
  'OPERATOR CLASS',
  'OPERATOR FAMILY',
  'EVENT TRIGGER',
  'USER MAPPING',
  'ROW SECURITY',
  'BLOB COMMENTS',
  'BLOB METADATA',
  'FOREIGN SERVER',
  'AGGREGATE',
  'COLLATION',
  'CONSTRAINT',
  'CONVERSION',
  'DOMAIN',
  'FUNCTION',
  'PROCEDURE',
  'STATISTICS',
  'TRANSFORM',
  'TRIGGER',
  'SEQUENCE',
  'POLICY',
  'OPERATOR',
  'LANGUAGE',
  'EXTENSION',
  'ENCODING',
  'COMMENT',
  'DEFAULT',
  'SCHEMA',
  'TABLE',
  'INDEX',
  'VIEW',
  'TYPE',
  'RULE',
  'ACL',
  'CAST',
  'DATABASE',
] as const;

interface ParsedFleetManifest {
  mode: 'per-companion' | 'group';
  backupRootDir: string;
  units: FleetBackupUnitOutcome[];
}

export interface FleetRestorePostgresOptions {
  databaseUrl: string;
  pgRestoreBinary?: string;
  psqlBinary?: string;
}

export interface FleetRestoreResult {
  kind: 'companion' | 'cluster' | 'group';
  artifactDir: string;
  databaseDumpPath: string;
  restoredDestinations: string[];
}

interface StagedTree {
  destination: string;
  staging: string;
}

function parseFleetManifest(fleetManifestPath: string): ParsedFleetManifest {
  const manifestPath = resolve(fleetManifestPath);
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed)
    || parsed.schemaVersion !== FLEET_BACKUP_MANIFEST_SCHEMA_VERSION
    || (parsed.mode !== 'per-companion' && parsed.mode !== 'group')
    || parsed.overallStatus !== 'success'
    || !Array.isArray(parsed.units)) {
    throw new Error(`Fleet restore requires a successful schema-v1 fleet manifest: ${manifestPath}`);
  }
  const rawUnits: unknown[] = parsed.units;
  if (rawUnits.some(unit => !isRecord(unit)
    || (unit.kind !== 'companion' && unit.kind !== 'cluster' && unit.kind !== 'group')
    || unit.status !== 'success'
    || typeof unit.artifactDir !== 'string'
    || (unit.postgresSchema !== undefined && typeof unit.postgresSchema !== 'string')
    || (unit.postgresSchemas !== undefined && (!Array.isArray(unit.postgresSchemas)
      || unit.postgresSchemas.some(schema => typeof schema !== 'string'))))) {
    throw new Error(`Fleet restore manifest contains an invalid or unsuccessful unit: ${manifestPath}`);
  }
  const units = rawUnits as FleetBackupUnitOutcome[];
  return { mode: parsed.mode, backupRootDir: realpathSync(dirname(manifestPath)), units };
}

function resolveArtifactDir(manifest: ParsedFleetManifest, unit: FleetBackupUnitOutcome): string {
  const relativePath = unit.artifactDir!;
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error('Fleet restore artifactDir must stay beneath the backup root');
  }
  const requestedArtifactDir = resolve(manifest.backupRootDir, relativePath);
  if (!isStrictSubpath(requestedArtifactDir, manifest.backupRootDir)
    || !existsSync(requestedArtifactDir)) {
    throw new Error(`Fleet restore artifact is missing or escapes the backup root: ${relativePath}`);
  }
  const artifactDir = realpathSync(requestedArtifactDir);
  if (!isStrictSubpath(artifactDir, manifest.backupRootDir)) {
    throw new Error(`Fleet restore artifact resolves outside the backup root: ${relativePath}`);
  }
  verifyBackupContentsManifest(artifactDir);
  return artifactDir;
}

function findDatabaseDump(artifactDir: string): string {
  const databaseDir = join(artifactDir, 'database');
  const dumps = existsSync(databaseDir)
    ? readdirSync(databaseDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.dump'))
      .map(entry => join(databaseDir, entry.name))
    : [];
  if (dumps.length !== 1 || statSync(dumps[0]).size <= 0) {
    throw new Error(`Fleet restore requires exactly one non-empty Postgres dump in ${databaseDir}`);
  }
  return dumps[0];
}

function toCredentialFreePostgresConnection(databaseUrl: string): {
  connectionArg: string;
  password?: string;
} {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('Fleet restore requires a postgres:// URL so credentials stay out of process arguments');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Fleet restore databaseUrl must use postgres:// or postgresql://');
  }
  const password = url.password ? decodeURIComponent(url.password) : '';
  url.password = '';
  return { connectionArg: url.toString(), ...(password ? { password } : {}) };
}

async function restorePostgresDump(
  dumpPath: string,
  postgres: FleetRestorePostgresOptions,
): Promise<void> {
  const binary = postgres.pgRestoreBinary?.trim() || 'pg_restore';
  const { connectionArg, password } = toCredentialFreePostgresConnection(postgres.databaseUrl);
  try {
    await execFileAsync(binary, [
      '--exit-on-error',
      '--single-transaction',
      '--no-password',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      connectionArg,
      dumpPath,
    ], {
      env: password ? { ...process.env, PGPASSWORD: password } : process.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fleet pg_restore failed for ${dumpPath}: ${message}`);
  }
}

function expectedUnitSchemas(unit: FleetBackupUnitOutcome): string[] {
  const rawSchemas = unit.kind === 'group'
    ? unit.postgresSchemas
    : (unit.postgresSchema ? [unit.postgresSchema] : undefined);
  if (!rawSchemas || rawSchemas.length === 0) {
    throw new Error(`Fleet restore ${unit.kind} manifest is missing its Postgres schema scope`);
  }
  const schemas = rawSchemas.map(schema => assertValidPostgresSchemaName(schema));
  if (new Set(schemas).size !== schemas.length) {
    throw new Error(`Fleet restore ${unit.kind} manifest repeats a Postgres schema`);
  }
  return schemas.sort();
}

function parseTocNamespace(line: string): string | undefined {
  const separator = line.indexOf(';');
  if (separator < 0) return undefined;
  const fields = line.slice(separator + 1).trim().split(/\s+/u);
  if (fields.length < 4) return undefined;
  const objectFields = fields.slice(2);
  const description = TOC_OBJECT_DESCRIPTIONS.find(candidate => (
    objectFields.join(' ').startsWith(`${candidate} `)
  ));
  if (!description) return undefined;
  const remainder = objectFields.slice(description.split(' ').length);
  const namespace = description === 'SCHEMA' ? remainder[1] : remainder[0];
  return namespace && namespace !== '-' ? namespace : undefined;
}

async function assertDumpScope(
  dumpPath: string,
  unit: FleetBackupUnitOutcome,
  postgres: FleetRestorePostgresOptions,
): Promise<string[]> {
  const expectedSchemas = expectedUnitSchemas(unit);
  if (unit.kind !== 'group' && !basename(dumpPath).endsWith(`.${expectedSchemas[0]}.dump`)) {
    throw new Error(
      `Fleet restore dump filename does not match manifest schema ${expectedSchemas[0]}: ${basename(dumpPath)}`,
    );
  }
  const binary = postgres.pgRestoreBinary?.trim() || 'pg_restore';
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ['--list', dumpPath], {
      maxBuffer: POSTGRES_COMMAND_MAX_BUFFER_BYTES,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fleet restore could not inspect Postgres dump ${dumpPath}: ${message}`);
  }
  const actualSchemas = new Set(
    stdout.split(/\r?\n/u).map(parseTocNamespace).filter((schema): schema is string => Boolean(schema)),
  );
  const allowedSchemas = new Set(unit.kind === 'group' ? [...expectedSchemas, 'public'] : expectedSchemas);
  const unexpected = [...actualSchemas].filter(schema => !allowedSchemas.has(schema)).sort();
  const missing = expectedSchemas.filter(schema => !actualSchemas.has(schema));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `Fleet restore dump schema scope mismatch: expected [${expectedSchemas.join(', ')}], `
      + `found [${[...actualSchemas].sort().join(', ')}]`,
    );
  }
  return expectedSchemas;
}

interface TargetSchemaState {
  schema: string;
  objectCount: number;
}

async function readTargetSchemaState(
  postgres: FleetRestorePostgresOptions,
): Promise<TargetSchemaState[]> {
  const binary = postgres.psqlBinary?.trim() || 'psql';
  const { connectionArg, password } = toCredentialFreePostgresConnection(postgres.databaseUrl);
  const query = [
    'WITH scoped_objects(namespace_oid) AS (',
    'SELECT relnamespace FROM pg_class UNION ALL',
    'SELECT pronamespace FROM pg_proc UNION ALL',
    'SELECT typnamespace FROM pg_type UNION ALL',
    'SELECT collnamespace FROM pg_collation UNION ALL',
    'SELECT connamespace FROM pg_conversion UNION ALL',
    'SELECT oprnamespace FROM pg_operator UNION ALL',
    'SELECT opcnamespace FROM pg_opclass UNION ALL',
    'SELECT opfnamespace FROM pg_opfamily UNION ALL',
    'SELECT stxnamespace FROM pg_statistic_ext UNION ALL',
    'SELECT cfgnamespace FROM pg_ts_config UNION ALL',
    'SELECT dictnamespace FROM pg_ts_dict UNION ALL',
    'SELECT prsnamespace FROM pg_ts_parser UNION ALL',
    'SELECT tmplnamespace FROM pg_ts_template',
    ') SELECT n.nspname, count(o.namespace_oid)',
    'FROM pg_namespace AS n',
    'LEFT JOIN scoped_objects AS o ON o.namespace_oid = n.oid',
    "WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'",
    'GROUP BY n.nspname ORDER BY n.nspname',
  ].join(' ');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, [
      '--no-password',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--field-separator=\t',
      '--dbname',
      connectionArg,
      '--command',
      query,
    ], {
      env: password ? { ...process.env, PGPASSWORD: password } : process.env,
      maxBuffer: POSTGRES_COMMAND_MAX_BUFFER_BYTES,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fleet restore could not inspect target Postgres database: ${message}`);
  }
  return stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [schema, rawObjectCount, ...extra] = line.split('\t');
    const objectCount = Number(rawObjectCount);
    if (!schema || extra.length > 0 || !Number.isSafeInteger(objectCount) || objectCount < 0) {
      throw new Error('Fleet restore target Postgres schema preflight returned malformed output');
    }
    return { schema, objectCount };
  });
}

async function assertTargetDatabaseIsSafe(
  unit: FleetBackupUnitOutcome,
  expectedSchemas: readonly string[],
  postgres: FleetRestorePostgresOptions,
): Promise<void> {
  const targetSchemas = await readTargetSchemaState(postgres);
  if (unit.kind === 'group') {
    const nonEmpty = targetSchemas.filter(entry => entry.schema !== 'public' || entry.objectCount > 0);
    if (nonEmpty.length > 0) {
      throw new Error(
        `Fleet group restore requires a fresh target database; found ${nonEmpty.map(entry => entry.schema).join(', ')}`,
      );
    }
    return;
  }
  const collisions = targetSchemas.filter(entry => expectedSchemas.includes(entry.schema));
  if (collisions.length > 0) {
    throw new Error(`Fleet restore target Postgres schema already exists: ${collisions[0].schema}`);
  }
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || isStrictSubpath(first, second) || isStrictSubpath(second, first);
}

function resolveCanonicalDestination(destinationValue: string): string {
  const requested = resolve(destinationValue);
  let existingAncestor = requested;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), relative(existingAncestor, requested));
}

function cleanupStagedTrees(staged: readonly StagedTree[]): void {
  for (const tree of staged) {
    if (existsSync(tree.staging)) rmSync(tree.staging, { recursive: true, force: true });
  }
}

function cleanupPublishedTrees(staged: readonly StagedTree[]): void {
  for (const tree of staged) {
    if (existsSync(tree.destination)) rmSync(tree.destination, { recursive: true, force: true });
  }
}

function stageVerifiedTrees(
  artifactDirValue: string,
  backupRootValue: string,
  specs: ReadonlyArray<{ treeDirName: string; destination: string }>,
): StagedTree[] {
  const artifactDir = resolve(artifactDirValue);
  const backupRoot = resolve(backupRootValue);
  const resolvedSpecs = specs.map(spec => ({
    treeDirName: spec.treeDirName,
    destination: resolveCanonicalDestination(spec.destination),
  }));
  for (const spec of resolvedSpecs) {
    if (existsSync(spec.destination)) {
      throw new Error(
        `Fleet restore destination already exists; no-overwrite policy refuses collision: ${spec.destination}`,
      );
    }
    if (pathsOverlap(spec.destination, artifactDir) || pathsOverlap(spec.destination, backupRoot)) {
      throw new Error(`Fleet restore destination overlaps its immutable backup root: ${spec.destination}`);
    }
  }
  for (let index = 0; index < resolvedSpecs.length; index += 1) {
    for (let peer = index + 1; peer < resolvedSpecs.length; peer += 1) {
      if (pathsOverlap(resolvedSpecs[index].destination, resolvedSpecs[peer].destination)) {
        throw new Error('Fleet restore destinations must be distinct, non-overlapping roots');
      }
    }
  }

  const staged: StagedTree[] = [];
  try {
    for (const spec of resolvedSpecs) {
      mkdirSync(dirname(spec.destination), { recursive: true });
      const staging = join(
        dirname(spec.destination),
        `.${basename(spec.destination)}.restore-${randomUUID()}`,
      );
      staged.push({ destination: spec.destination, staging });
      cpSync(join(artifactDir, spec.treeDirName), staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    return staged;
  } catch (error) {
    cleanupStagedTrees(staged);
    throw error;
  }
}

async function commitRestore(options: {
  kind: FleetRestoreResult['kind'];
  artifactDir: string;
  dumpPath: string;
  postgres: FleetRestorePostgresOptions;
  unit: FleetBackupUnitOutcome;
  staged: StagedTree[];
}): Promise<FleetRestoreResult> {
  const expectedSchemas = await assertDumpScope(options.dumpPath, options.unit, options.postgres);
  await assertTargetDatabaseIsSafe(options.unit, expectedSchemas, options.postgres);
  const published: StagedTree[] = [];
  try {
    for (const tree of options.staged) {
      // Exclusive directory creation is the publication barrier: a concurrent
      // destination creator wins with EEXIST before Postgres is touched.
      mkdirSync(tree.destination);
      published.push(tree);
    }
    for (const tree of options.staged) {
      cpSync(tree.staging, tree.destination, { recursive: true, errorOnExist: true, force: false });
    }
    await restorePostgresDump(options.dumpPath, options.postgres);
    cleanupStagedTrees(options.staged);
  } catch (error) {
    cleanupPublishedTrees(published);
    cleanupStagedTrees(options.staged);
    throw error;
  }
  return {
    kind: options.kind,
    artifactDir: options.artifactDir,
    databaseDumpPath: options.dumpPath,
    restoredDestinations: options.staged.map(tree => tree.destination),
  };
}

function requireSingleUnit(
  manifest: ParsedFleetManifest,
  predicate: (unit: FleetBackupUnitOutcome) => boolean,
  label: string,
): FleetBackupUnitOutcome {
  const matches = manifest.units.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Fleet restore requires exactly one successful ${label} unit; found ${matches.length}`);
  }
  return matches[0];
}

export async function restoreFleetCompanionSlice(options: {
  fleetManifestPath: string;
  companionId: string;
  destinations: { companionDataDir: string; personalWorkspacePath: string };
  postgres: FleetRestorePostgresOptions;
}): Promise<FleetRestoreResult> {
  const manifest = parseFleetManifest(options.fleetManifestPath);
  if (manifest.mode !== 'per-companion') throw new Error('Companion-slice restore requires a per-companion fleet backup');
  const unit = requireSingleUnit(
    manifest,
    candidate => candidate.kind === 'companion' && candidate.companionId === options.companionId,
    `companion ${options.companionId}`,
  );
  const artifactDir = resolveArtifactDir(manifest, unit);
  verifyCompanionTreeSnapshot(artifactDir);
  verifyWorkspaceTreeSnapshot(artifactDir);
  const dumpPath = findDatabaseDump(artifactDir);
  const staged = stageVerifiedTrees(artifactDir, manifest.backupRootDir, [
    { treeDirName: COMPANION_TREE_DIR_NAME, destination: options.destinations.companionDataDir },
    { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.personalWorkspacePath },
  ]);
  try {
    const sessionsSource = join(artifactDir, 'sessions');
    if (existsSync(sessionsSource)) {
      const sessionsDestination = join(staged[0].staging, 'state', 'sessions');
      if (existsSync(sessionsDestination)) {
        throw new Error('Companion restore session destination collides with the verified companion tree');
      }
      mkdirSync(dirname(sessionsDestination), { recursive: true });
      cpSync(sessionsSource, sessionsDestination, { recursive: true, errorOnExist: true, force: false });
    }
    return await commitRestore({
      kind: 'companion',
      artifactDir,
      dumpPath,
      postgres: options.postgres,
      unit,
      staged,
    });
  } catch (error) {
    cleanupStagedTrees(staged);
    throw error;
  }
}

export async function restoreFleetClusterArtifact(options: {
  fleetManifestPath: string;
  destinations: { systemDataDir: string; sharedWorkspacePath: string };
  postgres: FleetRestorePostgresOptions;
}): Promise<FleetRestoreResult> {
  const manifest = parseFleetManifest(options.fleetManifestPath);
  if (manifest.mode !== 'per-companion') throw new Error('Cluster restore requires a per-companion fleet backup');
  const unit = requireSingleUnit(manifest, candidate => candidate.kind === 'cluster', 'cluster');
  const artifactDir = resolveArtifactDir(manifest, unit);
  verifySystemConfigSnapshot(artifactDir);
  verifyWorkspaceTreeSnapshot(artifactDir);
  const dumpPath = findDatabaseDump(artifactDir);
  return await commitRestore({
    kind: 'cluster',
    artifactDir,
    dumpPath,
    postgres: options.postgres,
    unit,
    staged: stageVerifiedTrees(artifactDir, manifest.backupRootDir, [
      { treeDirName: SYSTEM_CONFIG_DIR_NAME, destination: options.destinations.systemDataDir },
      { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.sharedWorkspacePath },
    ]),
  });
}

export async function restoreFleetGroupArtifact(options: {
  fleetManifestPath: string;
  destinations: { groupCompanionDataDir: string; groupWorkspacesRoot: string; systemDataDir: string };
  postgres: FleetRestorePostgresOptions;
}): Promise<FleetRestoreResult> {
  const manifest = parseFleetManifest(options.fleetManifestPath);
  if (manifest.mode !== 'group') throw new Error('Group restore requires a group fleet backup');
  const unit = requireSingleUnit(manifest, candidate => candidate.kind === 'group', 'group');
  const artifactDir = resolveArtifactDir(manifest, unit);
  verifyCompanionTreeSnapshot(artifactDir);
  verifyWorkspaceTreeSnapshot(artifactDir);
  verifySystemConfigSnapshot(artifactDir);
  const dumpPath = findDatabaseDump(artifactDir);
  return await commitRestore({
    kind: 'group',
    artifactDir,
    dumpPath,
    postgres: options.postgres,
    unit,
    staged: stageVerifiedTrees(artifactDir, manifest.backupRootDir, [
      { treeDirName: COMPANION_TREE_DIR_NAME, destination: options.destinations.groupCompanionDataDir },
      { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.groupWorkspacesRoot },
      { treeDirName: SYSTEM_CONFIG_DIR_NAME, destination: options.destinations.systemDataDir },
    ]),
  });
}
