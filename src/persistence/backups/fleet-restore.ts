import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isRecord } from '../../shared/utils/types.js';
import { isStrictSubpath } from '../layout.js';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  withPostgresClient,
} from '../postgres.js';
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
import { verifyKubernetesHelmSnapshot } from './kubernetes-helm.js';
import {
  FLEET_ARTIFACT_IDENTITY_NAME,
  verifyBackupContentsManifest,
} from './backup-contents.js';
import {
  FLEET_BACKUP_MANIFEST_SCHEMA_VERSION,
  FLEET_CLUSTER_DIR_NAME,
  FLEET_COMPANIONS_DIR_NAME,
  FLEET_GROUP_DIR_NAME,
} from './service.js';
import type {
  FleetArtifactIdentity,
  FleetBackupUnitOutcome,
} from './fleet-backup-contracts.js';
import {
  executeFleetRestoreTransaction,
  type FleetRestoreFaultInjectionOptions,
  type FleetRestoreFaultStage,
  type StagedRestoreTree,
} from './fleet-restore-transaction.js';
import {
  createSanitizedPostgresChildEnv,
  redactPostgresCredential,
  sanitizePostgresConnection,
} from './postgres-connection.js';
import {
  commitFleetRestoreDatabaseMarker,
  inspectFleetRestoreDatabaseMarker,
  prepareFleetRestoreDatabaseMarker,
  removeFleetRestoreDatabaseMarker,
  rollbackFleetRestoreDatabaseSchemas,
  withFleetRestoreDatabaseLock,
} from './fleet-restore-database-marker.js';
import {
  FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME,
  FleetAuthAuthorityFloorStore,
} from '../postgres/fleet-auth/authority-floor.js';
import {
  assertFleetAuthBackupRestorePrivileges,
  type FleetAuthFamilyDatabaseRoles,
} from '../postgres/fleet-auth/schema.js';
import {
  restoreFleetAuthSnapshot,
  verifyFleetAuthSnapshotRestore,
  verifyFleetAuthBackupManifest,
} from './fleet-auth-coordinator.js';
import type { FleetAuthRestoreResult } from './fleet-auth-restore.js';
import { resolvePostgresUrlDatabaseName } from './postgres-restore.js';
import {
  applyFleetAuthSchemaAccessContracts,
  assertFleetAuthSchemaAccessIsolation,
  assertFleetAuthSchemaAccessTargets,
  type FleetAuthSchemaAccessContract,
  validateFleetAuthSchemaAccessContracts,
} from './fleet-auth-schema-access.js';
import { runMemorySubjectBackfillToCompletion } from '../../faculties/memory/postgres-store/subject-backfill.js';
import { quarantineRestoredContactLifecycleAuthority } from './contact-lifecycle-restore.js';

export type { FleetRestoreFaultInjectionOptions, FleetRestoreFaultStage };

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

export interface FleetRestoreProjectionLifecycle {
  invalidate(postgres: FleetRestorePostgresOptions, schemas: readonly string[]): Promise<void>;
  backfill(postgres: FleetRestorePostgresOptions, schemas: readonly string[]): Promise<void>;
}

export interface FleetRestoreResult {
  kind: 'companion' | 'cluster' | 'group';
  artifactDir: string;
  databaseDumpPath: string;
  restoredDestinations: string[];
}

export interface FleetAuthConsistentFamilyRestoreResult {
  restoredSchemas: string[];
  fleetAuth: FleetAuthRestoreResult;
}

export interface FleetAuthConsistentFamilyRestoreVerificationOptions {
  manifestPath: string;
  fleetManifestPath: string;
  scratchDatabaseUrl: string;
  scratchFleetAuthSchemaOwnerDatabaseUrl: string;
  scratchSchemaOwnerDatabaseUrls: Readonly<Record<string, string>>;
  roles: FleetAuthFamilyDatabaseRoles;
  authorityFloors: FleetAuthAuthorityFloorStore;
  activationGeneration: number;
  pgRestoreBinary?: string;
  psqlBinary?: string;
}

type FleetAuthConsistentFamilyRestoreDisposition = 'commit' | 'verify-rollback';

const FLEET_ARTIFACT_TIMESTAMP_PATTERN = /^\d{8}T\d{9}Z$/u;

function assertCanonicalArtifactLayout(unit: FleetBackupUnitOutcome): void {
  const segments = unit.artifactDir?.split('/') ?? [];
  const timestamp = segments.at(-1);
  const canonical = unit.kind === 'companion'
    ? segments.length === 3
      && segments[0] === FLEET_COMPANIONS_DIR_NAME
      && segments[1] === unit.companionId
    : segments.length === 2
      && segments[0] === (unit.kind === 'cluster' ? FLEET_CLUSTER_DIR_NAME : FLEET_GROUP_DIR_NAME);
  if (!canonical || !timestamp || !FLEET_ARTIFACT_TIMESTAMP_PATTERN.test(timestamp)) {
    throw new Error(`Fleet restore ${unit.kind} artifact does not use its canonical layout`);
  }
}

function verifyArtifactIdentity(artifactDir: string, unit: FleetBackupUnitOutcome): void {
  const identityPath = join(artifactDir, FLEET_ARTIFACT_IDENTITY_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(identityPath, 'utf8'));
  } catch (error) {
    throw new Error(`Fleet restore artifact identity is missing or malformed: ${String(error)}`);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.kind !== unit.kind) {
    throw new Error('Fleet restore artifact identity does not match its manifest unit');
  }
  const keys = Object.keys(parsed).sort();
  const expectedKeys = unit.kind === 'companion'
    ? ['companionId', 'kind', 'postgresSchema', 'schemaVersion']
    : unit.kind === 'cluster'
      ? ['kind', 'postgresSchema', 'schemaVersion']
      : ['kind', 'postgresSchemas', 'schemaVersion'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys.sort())
    || (unit.kind === 'companion'
      && (typeof parsed.companionId !== 'string' || typeof parsed.postgresSchema !== 'string'))
    || (unit.kind === 'cluster' && typeof parsed.postgresSchema !== 'string')
    || (unit.kind === 'group'
      && (!Array.isArray(parsed.postgresSchemas)
        || parsed.postgresSchemas.some(schema => typeof schema !== 'string')))) {
    throw new Error('Fleet restore artifact identity has an invalid shape');
  }
  const identity = parsed as unknown as FleetArtifactIdentity;
  const expectedSchemas = unit.postgresSchemas ? [...unit.postgresSchemas].sort() : undefined;
  const identitySchemas = identity.postgresSchemas ? [...identity.postgresSchemas].sort() : undefined;
  if (identity.companionId !== unit.companionId
    || identity.postgresSchema !== unit.postgresSchema
    || JSON.stringify(identitySchemas) !== JSON.stringify(expectedSchemas)) {
    throw new Error('Fleet restore artifact identity does not match its manifest unit');
  }
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
  assertCanonicalArtifactLayout(unit);
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
  verifyArtifactIdentity(artifactDir, unit);
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

async function restorePostgresDump(
  dumpPath: string,
  postgres: FleetRestorePostgresOptions,
): Promise<void> {
  const binary = postgres.pgRestoreBinary?.trim() || 'pg_restore';
  const { connectionArg, password } = sanitizePostgresConnection(postgres.databaseUrl, 'Fleet restore');
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
      env: createSanitizedPostgresChildEnv(password),
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactPostgresCredential(rawMessage, password);
    throw new Error(`Fleet pg_restore failed for ${dumpPath}: ${message}`);
  }
}

async function dropOwnedPostgresSchema(
  schemaName: string,
  databaseUrl: string,
  psqlBinary?: string,
): Promise<void> {
  const schema = assertValidPostgresSchemaName(schemaName);
  const binary = psqlBinary?.trim() || 'psql';
  const { connectionArg, password } = sanitizePostgresConnection(databaseUrl, 'Fleet restore');
  try {
    await execFileAsync(binary, [
      '--no-password',
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--dbname',
      connectionArg,
      '--command',
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
    ], { env: createSanitizedPostgresChildEnv(password) });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactPostgresCredential(rawMessage, password);
    throw new Error(`Fleet restore could not roll back owned schema ${schema}: ${message}`);
  }
}

async function rollbackFleetAuthOwnedSchemas(options: {
  postgres: FleetRestorePostgresOptions;
  contracts: readonly FleetAuthSchemaAccessContract[];
  ownerDatabaseUrls: Readonly<Record<string, string>>;
}): Promise<void> {
  for (const contract of options.contracts) {
    await dropOwnedPostgresSchema(
      contract.schema,
      options.ownerDatabaseUrls[contract.schema],
      options.postgres.psqlBinary,
    );
  }
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Restore is an evidence-lifecycle mutation: restored projections stay hidden until bounded reclassification. */
export async function invalidateRestoredMemorySubjectProjections(
  postgres: FleetRestorePostgresOptions,
  schemas: readonly string[],
): Promise<void> {
  const pool = createPostgresPool(postgres.databaseUrl, {
    applicationName: 'fleet-restore-memory-subject-invalidation',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    await withPostgresClient(pool, async (client) => {
      for (const rawSchema of schemas) {
        const schema = assertValidPostgresSchemaName(rawSchema);
        const tables = await client.query<{ memories: string | null; classifications: string | null }>(`
          SELECT to_regclass($1)::text AS memories, to_regclass($2)::text AS classifications
        `, [`${schema}.l2_memories`, `${schema}.l2_memory_subject_classifications`]);
        if (!tables.rows[0]?.memories || !tables.rows[0]?.classifications) continue;
        const qualified = quotePostgresIdentifier(schema);
        // The subject-evidence invalidation trigger intentionally addresses
        // companion-local projection tables without schema qualification.
        // Pin its lookup to the restored schema for this transaction.
        await client.query(`SET LOCAL search_path TO ${qualified}, extensions`);
        await client.query(`
          UPDATE ${qualified}.l2_memories
          SET authorization_revision = authorization_revision + 1,
              subject_evidence_digest = NULL
        `);
        await client.query(`
          UPDATE ${qualified}.l2_memory_subject_classifications
          SET status = 'invalidated',
              updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
        `);
        const checkpoint = await client.query<{ checkpoint: string | null }>(
          'SELECT to_regclass($1)::text AS checkpoint',
          [`${schema}.l2_memory_subject_backfill_checkpoints`],
        );
        if (checkpoint.rows[0]?.checkpoint) {
          await client.query(`
            UPDATE ${qualified}.l2_memory_subject_backfill_checkpoints
            SET cursor_memory_id = NULL, completed = FALSE, processed_count = 0,
                updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
          `);
        }
      }
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Reclassify each restored schema before restore success can make the corpus reachable. */
export async function backfillRestoredMemorySubjectProjections(
  postgres: FleetRestorePostgresOptions,
  schemas: readonly string[],
): Promise<void> {
  for (const rawSchema of schemas) {
    const schema = assertValidPostgresSchemaName(rawSchema);
    const pool = createPostgresPool(postgres.databaseUrl, {
      applicationName: 'fleet-restore-memory-subject-backfill',
      allowExitOnIdle: true,
      max: 1,
      schema,
    });
    try {
      const tables = await pool.query<{ memories: string | null; classifications: string | null }>(`
        SELECT to_regclass('l2_memories')::text AS memories,
               to_regclass('l2_memory_subject_classifications')::text AS classifications
      `);
      if (!tables.rows[0]?.memories || !tables.rows[0]?.classifications) continue;
      await runMemorySubjectBackfillToCompletion(pool);
    } finally {
      await pool.end().catch(() => undefined);
    }
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
  postgres: Pick<FleetRestorePostgresOptions, 'pgRestoreBinary'>,
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

/**
 * Restore one validated schema-only archive without any filesystem side
 * effects. Used by ephemeral shard lifecycle rehearsals and operator tooling.
 */
export async function restorePostgresSchemaSlice(options: {
  dumpPath: string;
  schema: string;
  postgres: FleetRestorePostgresOptions;
}): Promise<{ schema: string; dumpPath: string }> {
  const schema = assertValidPostgresSchemaName(options.schema);
  const unit: FleetBackupUnitOutcome = {
    kind: 'companion',
    postgresSchema: schema,
    status: 'success',
  };
  await assertDumpScope(options.dumpPath, unit, options.postgres);
  const pool = createPostgresPool(options.postgres.databaseUrl, {
    applicationName: 'fleet-schema-slice-restore-preflight',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    const existing = await pool.query<{ exists: boolean }>(
      'SELECT to_regnamespace($1) IS NOT NULL AS exists',
      [schema],
    );
    if (existing.rows[0]?.exists === true) {
      throw new Error(`PostgreSQL schema-slice restore requires absent target schema ${schema}`);
    }
  } finally {
    await pool.end();
  }
  try {
    await restorePostgresDump(options.dumpPath, options.postgres);
  } catch (error) {
    try {
      await dropOwnedPostgresSchema(
        schema,
        options.postgres.databaseUrl,
        options.postgres.psqlBinary,
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `PostgreSQL schema-slice restore failed and rollback remains pending for ${schema}`,
      );
    }
    throw error;
  }
  return { schema, dumpPath: options.dumpPath };
}

async function assertFleetAuthFamilyDumpScope(
  dumpPath: string,
  expectedSchema: string,
  pgRestoreBinary?: string,
): Promise<void> {
  const schema = assertValidPostgresSchemaName(expectedSchema);
  const binary = pgRestoreBinary?.trim() || 'pg_restore';
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ['--list', dumpPath], {
      maxBuffer: POSTGRES_COMMAND_MAX_BUFFER_BYTES,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fleet auth family restore could not inspect Postgres dump ${dumpPath}: ${message}`);
  }
  const actualSchemas = new Set(
    stdout.split(/\r?\n/u).map(parseTocNamespace).filter((value): value is string => Boolean(value)),
  );
  if (actualSchemas.size !== 1 || !actualSchemas.has(schema)) {
    throw new Error(
      `Fleet auth family dump schema scope mismatch: expected [${schema}], `
      + `found [${[...actualSchemas].sort().join(', ')}]`,
    );
  }
}

export async function restoreFleetAuthConsistentFamily(options: {
  manifestPath: string;
  backupRestoreDatabaseUrl: string;
  fleetAuthSchemaOwnerDatabaseUrl: string;
  roles: FleetAuthFamilyDatabaseRoles;
  authorityFloors: FleetAuthAuthorityFloorStore;
  activationGeneration: number;
  restoredAt?: string;
  schemaOwnerDatabaseUrls: Readonly<Record<string, string>>;
  pgRestoreBinary?: string;
  psqlBinary?: string;
  disposition?: FleetAuthConsistentFamilyRestoreDisposition;
  faultInjection?: (
    stage: 'after_database_preflight' | 'after_fleet_auth_restore',
  ) => void | Promise<void>;
}): Promise<FleetAuthConsistentFamilyRestoreResult> {
  const disposition = options.disposition ?? 'commit';
  const manifest = verifyFleetAuthBackupManifest(options.manifestPath);
  const familyDir = dirname(resolve(options.manifestPath));
  const schemaArtifacts = manifest.artifacts.filter(
    (artifact): artifact is typeof artifact & { kind: 'companion' | 'shared'; postgresSchema: string } => (
      (artifact.kind === 'companion' || artifact.kind === 'shared')
      && artifact.postgresSchema !== undefined
    ),
  );
  const verifiedSchemaDumps = schemaArtifacts.map(artifact => ({
    artifact,
    dumpPath: resolve(familyDir, artifact.path),
  }));
  for (const { artifact, dumpPath } of verifiedSchemaDumps) {
    await assertFleetAuthFamilyDumpScope(
      dumpPath,
      artifact.postgresSchema,
      options.pgRestoreBinary,
    );
  }

  const expectedSchemas = verifiedSchemaDumps.map(({ artifact }) => artifact.postgresSchema);
  const accessContracts = validateFleetAuthSchemaAccessContracts(
    verifiedSchemaDumps.map(({ artifact }) => ({
      kind: artifact.kind,
      schema: artifact.postgresSchema,
      ownerRole: artifact.ownerRole ?? '',
      runtimeRoles: artifact.runtimeRoles ?? [],
    })),
    expectedSchemas,
    options.roles,
  );
  const postgres = {
    databaseUrl: options.backupRestoreDatabaseUrl,
    ...(options.psqlBinary ? { psqlBinary: options.psqlBinary } : {}),
  };
  const databaseTarget = sanitizePostgresConnection(
    options.backupRestoreDatabaseUrl,
    'Fleet auth family restore',
  ).connectionArg;
  const operationIdentity = createHash('sha256').update(JSON.stringify({
    kind: 'fleet-auth-consistent-family',
    capturedAt: manifest.capturedAt,
    postgresSnapshot: manifest.postgresSnapshot,
    authorityLineageId: manifest.authorityLineageId,
    databaseTarget,
    expectedSchemas: [...expectedSchemas].sort(),
    accessContracts,
  })).digest('hex');
  const operation = {
    operationId: operationIdentity.slice(0, 32),
    operationIdentity,
  };
  return await withFleetRestoreDatabaseLock(postgres, async () => {
    await assertFleetAuthBackupRestorePrivileges(options.backupRestoreDatabaseUrl, options.roles);
    await assertFleetAuthSchemaAccessTargets({
      databaseUrl: options.backupRestoreDatabaseUrl,
      contracts: accessContracts,
      ownerRole: options.roles.backupRestore,
      ownerDatabaseUrls: options.schemaOwnerDatabaseUrls,
    });
    const markerState = await inspectFleetRestoreDatabaseMarker(postgres, operation);
    if (markerState === 'foreign') {
      throw new Error('Fleet auth family restore found a foreign database restore marker');
    }
    let schemaState = await expectedSchemaPresence(expectedSchemas, postgres);
    if (markerState === 'prepared') {
      await rollbackFleetAuthOwnedSchemas({
        postgres,
        contracts: accessContracts,
        ownerDatabaseUrls: options.schemaOwnerDatabaseUrls,
      });
      await removeFleetRestoreDatabaseMarker(postgres, operation);
      schemaState = 'none';
    } else if (markerState === 'committed') {
      if (schemaState !== 'all') {
        throw new Error('Fleet auth family restore committed marker has incomplete schema state');
      }
      await assertFleetAuthSchemaAccessIsolation({
        databaseUrl: options.backupRestoreDatabaseUrl,
        contracts: accessContracts,
        ownerRole: options.roles.backupRestore,
      });
      if (disposition === 'verify-rollback') {
        await rollbackFleetAuthOwnedSchemas({
          postgres,
          contracts: accessContracts,
          ownerDatabaseUrls: options.schemaOwnerDatabaseUrls,
        });
        await removeFleetRestoreDatabaseMarker(postgres, operation);
        schemaState = 'none';
      } else {
        await removeFleetRestoreDatabaseMarker(postgres, operation);
        const floor = options.authorityFloors.read();
        return {
          restoredSchemas: expectedSchemas,
          fleetAuth: {
            importedRows: 0,
            authorityGeneration: floor.trustedHost.authorityGeneration,
            restoreCheckpoint: floor.trustedHost.restoreCheckpoint,
          },
        };
      }
    }
    if (schemaState !== 'none') {
      throw new Error('Fleet auth family restore requires absent target schemas before mutation');
    }
    await options.faultInjection?.('after_database_preflight');

    const restoredSchemas: string[] = [];
    let markerPrepared = false;
    try {
      await prepareFleetRestoreDatabaseMarker(postgres, operation);
      markerPrepared = true;
      for (const { artifact, dumpPath } of verifiedSchemaDumps) {
        await restorePostgresDump(dumpPath, {
          databaseUrl: options.schemaOwnerDatabaseUrls[artifact.postgresSchema],
          ...(options.pgRestoreBinary ? { pgRestoreBinary: options.pgRestoreBinary } : {}),
        });
        restoredSchemas.push(artifact.postgresSchema);
      }
      await applyFleetAuthSchemaAccessContracts({
        contracts: accessContracts,
        ownerDatabaseUrls: options.schemaOwnerDatabaseUrls,
        backupRole: options.roles.backupRestore,
      });
      await assertFleetAuthSchemaAccessIsolation({
        databaseUrl: options.backupRestoreDatabaseUrl,
        contracts: accessContracts,
        ownerRole: options.roles.backupRestore,
      });

      for (const schema of restoredSchemas) {
        const restoredPostgres = {
          databaseUrl: options.schemaOwnerDatabaseUrls[schema],
          ...(options.pgRestoreBinary ? { pgRestoreBinary: options.pgRestoreBinary } : {}),
        };
        await invalidateRestoredMemorySubjectProjections(restoredPostgres, [schema]);
        await quarantineRestoredContactLifecycleAuthority(restoredPostgres, [schema]);
        await backfillRestoredMemorySubjectProjections(restoredPostgres, [schema]);
      }

      const fleetAuthRestoreOptions = {
        manifestPath: options.manifestPath,
        databaseUrl: options.backupRestoreDatabaseUrl,
        schemaOwnerDatabaseUrl: options.fleetAuthSchemaOwnerDatabaseUrl,
        roles: options.roles,
        authorityFloors: options.authorityFloors,
        activationGeneration: options.activationGeneration,
        ...(options.restoredAt ? { restoredAt: options.restoredAt } : {}),
      };
      const fleetAuth = disposition === 'verify-rollback'
        ? await verifyFleetAuthSnapshotRestore(fleetAuthRestoreOptions)
        : await restoreFleetAuthSnapshot(fleetAuthRestoreOptions);
      await options.faultInjection?.('after_fleet_auth_restore');
      if (disposition === 'verify-rollback') {
        await rollbackFleetAuthOwnedSchemas({
          postgres,
          contracts: accessContracts,
          ownerDatabaseUrls: options.schemaOwnerDatabaseUrls,
        });
        await removeFleetRestoreDatabaseMarker(postgres, operation);
        markerPrepared = false;
        return { restoredSchemas, fleetAuth };
      }
      await commitFleetRestoreDatabaseMarker(postgres, operation);
      await removeFleetRestoreDatabaseMarker(postgres, operation);
      return { restoredSchemas, fleetAuth };
    } catch (error) {
      if (markerPrepared) {
        try {
          await rollbackFleetAuthOwnedSchemas({
            postgres,
            contracts: accessContracts,
            ownerDatabaseUrls: options.schemaOwnerDatabaseUrls,
          });
          await removeFleetRestoreDatabaseMarker(postgres, operation);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Fleet auth family restore failed and durable schema rollback remains pending',
          );
        }
      }
      throw error;
    }
  });
}

function assertDedicatedRestoreVerificationDatabase(databaseUrl: string): string {
  const databaseName = resolvePostgresUrlDatabaseName(
    databaseUrl,
    'Fleet auth restore verification',
  );
  if (!databaseName.endsWith('_restore_verify')) {
    throw new Error(
      'Fleet auth restore verification refuses a database without the _restore_verify suffix',
    );
  }
  return databaseName;
}

async function verifyRecoveryFamilyExactlyMatchesCoordinator(options: {
  coordinatorManifestPath: string;
  recoveryManifest: ParsedFleetManifest;
  roles: FleetAuthFamilyDatabaseRoles;
  pgRestoreBinary?: string;
}): Promise<void> {
  const coordinator = verifyFleetAuthBackupManifest(options.coordinatorManifestPath);
  const coordinatorArtifacts = coordinator.artifacts.filter(
    (artifact): artifact is typeof artifact & {
      kind: 'companion' | 'shared';
      postgresSchema: string;
    } => (artifact.kind === 'companion' || artifact.kind === 'shared')
      && typeof artifact.postgresSchema === 'string',
  );
  const coordinatorSchemas = coordinatorArtifacts.map(artifact => artifact.postgresSchema);
  validateFleetAuthSchemaAccessContracts(
    coordinatorArtifacts.map(artifact => ({
      kind: artifact.kind,
      schema: artifact.postgresSchema,
      ownerRole: artifact.ownerRole ?? '',
      runtimeRoles: artifact.runtimeRoles ?? [],
    })),
    coordinatorSchemas,
    options.roles,
  );
  const expected = coordinatorArtifacts.map(artifact => ({
    key: `${artifact.kind}:${artifact.postgresSchema}`,
    artifact,
  })).sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(expected.map(entry => entry.key)).size !== expected.length) {
    throw new Error('Fleet auth coordinator schema family contains duplicate slices');
  }

  const actual: Array<{ key: string; schema: string; dumpPath: string }> = [];
  const companionIds = new Set<string>();
  for (const unit of options.recoveryManifest.units) {
    if (unit.kind === 'group') {
      throw new Error('Fleet auth restore verification requires schema-scoped recovery artifacts');
    }
    const schemas = expectedUnitSchemas(unit);
    if (schemas.length !== 1) {
      throw new Error('Fleet auth recovery slice must name exactly one PostgreSQL schema');
    }
    if (unit.kind === 'companion') {
      if (typeof unit.companionId !== 'string' || !unit.companionId
        || companionIds.has(unit.companionId)) {
        throw new Error('Fleet auth recovery family requires distinct companion identities');
      }
      companionIds.add(unit.companionId);
    }
    const schema = schemas[0];
    const artifactDir = resolveArtifactDir(options.recoveryManifest, unit);
    if (unit.kind === 'companion') {
      verifyCompanionTreeSnapshot(artifactDir);
      verifyWorkspaceTreeSnapshot(artifactDir);
    } else {
      verifySystemConfigSnapshot(artifactDir);
      verifyWorkspaceTreeSnapshot(artifactDir);
      const contents = verifyBackupContentsManifest(artifactDir);
      if (contents.kubernetesHelmRecovery === 'required') {
        verifyKubernetesHelmSnapshot(artifactDir);
      }
    }
    const dumpPath = findDatabaseDump(artifactDir);
    await assertDumpScope(dumpPath, unit, {
      ...(options.pgRestoreBinary ? { pgRestoreBinary: options.pgRestoreBinary } : {}),
    });
    actual.push({
      key: `${unit.kind === 'cluster' ? 'shared' : 'companion'}:${schema}`,
      schema,
      dumpPath,
    });
  }
  actual.sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(actual.map(entry => entry.key)).size !== actual.length
    || JSON.stringify(actual.map(entry => entry.key)) !== JSON.stringify(expected.map(entry => entry.key))) {
    throw new Error('Fleet auth coordinator and recovery schema families must match exactly');
  }
  for (let index = 0; index < actual.length; index += 1) {
    const recoveryDigest = createHash('sha256')
      .update(readFileSync(actual[index].dumpPath))
      .digest('hex');
    if (recoveryDigest !== expected[index].artifact.sha256) {
      throw new Error(
        `Fleet auth recovery dump for ${actual[index].schema} is not bound to the coordinator family`,
      );
    }
  }
}

/**
 * Exercise the canonical recovery family through its real owner-authenticated
 * restore entrypoint. Recovery filesystem/session/system-config/Helm artifacts
 * are verified read-only before the dedicated scratch database is touched.
 * Schema restore, access-contract application, isolation, and fleet_auth import
 * then run through `restoreFleetAuthConsistentFamily` and roll back. No
 * production floor, database, or filesystem destination is mutated.
 */
export async function verifyFleetAuthConsistentFamilyRestore(
  options: FleetAuthConsistentFamilyRestoreVerificationOptions,
): Promise<void> {
  assertDedicatedRestoreVerificationDatabase(options.scratchDatabaseUrl);
  const recoveryManifest = parseFleetManifest(options.fleetManifestPath);
  if (recoveryManifest.mode !== 'per-companion') {
    throw new Error('Fleet auth restore verification requires schema-scoped recovery artifacts');
  }
  await verifyRecoveryFamilyExactlyMatchesCoordinator({
    coordinatorManifestPath: options.manifestPath,
    recoveryManifest,
    roles: options.roles,
    ...(options.pgRestoreBinary ? { pgRestoreBinary: options.pgRestoreBinary } : {}),
  });
  const scratchRoot = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-restore-verify-'));
  const floorRoot = join(scratchRoot, 'authority-floor');
  try {
    mkdirSync(floorRoot, { recursive: true, mode: 0o700 });
    copyFileSync(
      join(options.authorityFloors.root, FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME),
      join(floorRoot, FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME),
    );
    const scratchFloors = new FleetAuthAuthorityFloorStore(floorRoot);
    await restoreFleetAuthConsistentFamily({
      manifestPath: options.manifestPath,
      backupRestoreDatabaseUrl: options.scratchDatabaseUrl,
      fleetAuthSchemaOwnerDatabaseUrl: options.scratchFleetAuthSchemaOwnerDatabaseUrl,
      roles: options.roles,
      authorityFloors: scratchFloors,
      activationGeneration: options.activationGeneration,
      schemaOwnerDatabaseUrls: options.scratchSchemaOwnerDatabaseUrls,
      disposition: 'verify-rollback',
      ...(options.pgRestoreBinary ? { pgRestoreBinary: options.pgRestoreBinary } : {}),
      ...(options.psqlBinary ? { psqlBinary: options.psqlBinary } : {}),
    });
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

interface TargetSchemaState {
  schema: string;
  objectCount: number;
}

async function readTargetSchemaState(
  postgres: FleetRestorePostgresOptions,
): Promise<TargetSchemaState[]> {
  const binary = postgres.psqlBinary?.trim() || 'psql';
  const { connectionArg, password } = sanitizePostgresConnection(postgres.databaseUrl, 'Fleet restore');
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
      env: createSanitizedPostgresChildEnv(password),
      maxBuffer: POSTGRES_COMMAND_MAX_BUFFER_BYTES,
    }));
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactPostgresCredential(rawMessage, password);
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

async function expectedSchemaPresence(
  expectedSchemas: readonly string[],
  postgres: FleetRestorePostgresOptions,
): Promise<'none' | 'all' | 'partial'> {
  const present = new Set((await readTargetSchemaState(postgres)).map(entry => entry.schema));
  const count = expectedSchemas.filter(schema => present.has(schema)).length;
  if (count === 0) return 'none';
  if (count === expectedSchemas.length) return 'all';
  return 'partial';
}

async function commitRestore(options: {
  kind: FleetRestoreResult['kind'];
  artifactDir: string;
  backupRootDir: string;
  dumpPath: string;
  postgres: FleetRestorePostgresOptions;
  unit: FleetBackupUnitOutcome;
  specs: ReadonlyArray<{ treeDirName: string; destination: string }>;
  prepareStaging?: (trees: readonly StagedRestoreTree[]) => void;
  projectionLifecycle?: FleetRestoreProjectionLifecycle;
  faultInjection?: FleetRestoreFaultInjectionOptions['faultInjection'];
}): Promise<FleetRestoreResult> {
  const expectedSchemas = await assertDumpScope(options.dumpPath, options.unit, options.postgres);
  const databaseTarget = sanitizePostgresConnection(
    options.postgres.databaseUrl,
    'Fleet restore',
  ).connectionArg;
  const transaction = await executeFleetRestoreTransaction({
    kind: options.kind,
    artifactDir: options.artifactDir,
    backupRootDir: options.backupRootDir,
    dumpPath: options.dumpPath,
    databaseTarget,
    expectedSchemas,
    specs: options.specs,
    prepareStaging: options.prepareStaging,
    faultInjection: options.faultInjection,
    assertTargetDatabaseSafe: async () => await assertTargetDatabaseIsSafe(
      options.unit,
      expectedSchemas,
      options.postgres,
    ),
    inspectDatabaseState: async () => await expectedSchemaPresence(expectedSchemas, options.postgres),
    inspectDatabaseOperation: async operation => await inspectFleetRestoreDatabaseMarker(
      options.postgres,
      operation,
    ),
    prepareDatabaseOperation: async operation => await prepareFleetRestoreDatabaseMarker(
      options.postgres,
      operation,
    ),
    commitDatabaseOperation: async operation => await commitFleetRestoreDatabaseMarker(
      options.postgres,
      operation,
    ),
    removeDatabaseOperation: async operation => await removeFleetRestoreDatabaseMarker(
      options.postgres,
      operation,
    ),
    restoreDatabase: async () => {
      await restorePostgresDump(options.dumpPath, options.postgres);
      const projectionLifecycle = options.projectionLifecycle ?? {
        invalidate: async (postgres, schemas) => {
          await invalidateRestoredMemorySubjectProjections(postgres, schemas);
          await quarantineRestoredContactLifecycleAuthority(postgres, schemas);
        },
        backfill: backfillRestoredMemorySubjectProjections,
      };
      await projectionLifecycle.invalidate(options.postgres, expectedSchemas);
      await projectionLifecycle.backfill(options.postgres, expectedSchemas);
    },
    rollbackDatabase: async operation => await rollbackFleetRestoreDatabaseSchemas(
      options.postgres,
      operation,
      expectedSchemas,
    ),
  });
  return {
    kind: options.kind,
    artifactDir: options.artifactDir,
    databaseDumpPath: options.dumpPath,
    restoredDestinations: transaction.restoredDestinations,
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
  projectionLifecycle?: FleetRestoreProjectionLifecycle;
} & FleetRestoreFaultInjectionOptions): Promise<FleetRestoreResult> {
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
  return await commitRestore({
    kind: 'companion',
    artifactDir,
    backupRootDir: manifest.backupRootDir,
    dumpPath,
    postgres: options.postgres,
    unit,
    projectionLifecycle: options.projectionLifecycle,
    specs: [
      { treeDirName: COMPANION_TREE_DIR_NAME, destination: options.destinations.companionDataDir },
      { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.personalWorkspacePath },
    ],
    faultInjection: options.faultInjection,
    prepareStaging: (staged) => {
    const sessionsSource = join(artifactDir, 'sessions');
    if (existsSync(sessionsSource)) {
      const sessionsDestination = join(staged[0].staging, 'state', 'sessions');
      if (existsSync(sessionsDestination)) {
        throw new Error('Companion restore session destination collides with the verified companion tree');
      }
      mkdirSync(dirname(sessionsDestination), { recursive: true });
      cpSync(sessionsSource, sessionsDestination, { recursive: true, errorOnExist: true, force: false });
    }
    },
  });
}

export async function restoreFleetClusterArtifact(options: {
  fleetManifestPath: string;
  destinations: { systemDataDir: string; sharedWorkspacePath: string };
  postgres: FleetRestorePostgresOptions;
  projectionLifecycle?: FleetRestoreProjectionLifecycle;
} & FleetRestoreFaultInjectionOptions): Promise<FleetRestoreResult> {
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
    backupRootDir: manifest.backupRootDir,
    dumpPath,
    postgres: options.postgres,
    unit,
    projectionLifecycle: options.projectionLifecycle,
    specs: [
      { treeDirName: SYSTEM_CONFIG_DIR_NAME, destination: options.destinations.systemDataDir },
      { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.sharedWorkspacePath },
    ],
    faultInjection: options.faultInjection,
  });
}

export async function restoreFleetGroupArtifact(options: {
  fleetManifestPath: string;
  destinations: { groupCompanionDataDir: string; groupWorkspacesRoot: string; systemDataDir: string };
  postgres: FleetRestorePostgresOptions;
  projectionLifecycle?: FleetRestoreProjectionLifecycle;
} & FleetRestoreFaultInjectionOptions): Promise<FleetRestoreResult> {
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
    backupRootDir: manifest.backupRootDir,
    dumpPath,
    postgres: options.postgres,
    unit,
    projectionLifecycle: options.projectionLifecycle,
    specs: [
      { treeDirName: COMPANION_TREE_DIR_NAME, destination: options.destinations.groupCompanionDataDir },
      { treeDirName: WORKSPACE_TREE_DIR_NAME, destination: options.destinations.groupWorkspacesRoot },
      { treeDirName: SYSTEM_CONFIG_DIR_NAME, destination: options.destinations.systemDataDir },
    ],
    faultInjection: options.faultInjection,
  });
}
