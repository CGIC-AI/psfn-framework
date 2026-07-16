import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadFleetAuthConfig, FLEET_AUTH_FILE_NAME } from '../../system/config/fleet-auth-config.js';
import { writeFileDurableAtomicSync } from '../../shared/utils/fs.js';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
} from '../../shared/utils/types.js';
import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  createPostgresPool,
} from '../postgres.js';
import {
  createSanitizedPostgresChildEnv,
  redactPostgresCredential,
  sanitizePostgresConnection,
} from './postgres-connection.js';
import {
  FLEET_AUTH_DURABLE_TABLES,
  FLEET_AUTH_SCHEMA_NAME,
  assertFleetAuthBackupRestorePrivileges,
  type FleetAuthDatabaseRoles,
} from '../postgres/fleet-auth/schema.js';
import {
  restoreVerifiedFleetAuthSnapshot,
  verifyVerifiedFleetAuthSnapshotRestore,
  type FleetAuthRestoreResult,
  type VerifiedFleetAuthRestoreOptions,
} from './fleet-auth-restore.js';
import { validateFleetAuthSchemaAccessContracts } from './fleet-auth-schema-access.js';

const execFileAsync = promisify(execFile);
export const FLEET_AUTH_BACKUP_MANIFEST_NAME = 'fleet-auth-backup-manifest.json';
export const FLEET_AUTH_SNAPSHOT_NAME = 'fleet-auth.snapshot.json';
export const FLEET_AUTH_BACKUP_MANIFEST_SCHEMA_VERSION = 4;

export type FleetAuthBackupArtifactKind =
  | 'companion'
  | 'shared'
  | 'fleet_auth'
  | 'fleet_auth_config';

export interface FleetAuthBackupArtifact {
  kind: FleetAuthBackupArtifactKind;
  path: string;
  sha256: string;
  sizeBytes: number;
  postgresSchema?: string;
  ownerRole?: string;
  runtimeRoles?: string[];
}

export interface FleetAuthBackupManifest {
  schemaVersion: typeof FLEET_AUTH_BACKUP_MANIFEST_SCHEMA_VERSION;
  capturedAt: string;
  postgresSnapshot: string;
  authorityLineageId: string;
  artifacts: FleetAuthBackupArtifact[];
}

export interface FleetAuthConsistentBackupResult {
  manifestPath: string;
  fleetAuthSnapshotPath: string;
  schemaDumpPaths: Record<string, string>;
}

interface SnapshotExportRow {
  exported_snapshot: string;
  postgres_snapshot: string;
}

function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

function describeExecError(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as Error & { stderr?: string };
    return candidate.stderr?.trim() || candidate.message;
  }
  return String(error);
}

async function dumpSchemaAtSnapshot(options: {
  databaseUrl: string;
  schema: string;
  exportedSnapshot: string;
  destination: string;
  pgDumpBinary?: string;
}): Promise<void> {
  const schema = assertValidPostgresSchemaName(options.schema);
  const { connectionArg, password } = sanitizePostgresConnection(
    options.databaseUrl,
    'Fleet auth consistent backup',
  );
  try {
    await execFileAsync(options.pgDumpBinary?.trim() || 'pg_dump', [
      '--format=custom',
      '--no-password',
      '--no-owner',
      '--no-privileges',
      `--schema=${schema}`,
      `--snapshot=${options.exportedSnapshot}`,
      `--file=${options.destination}`,
      connectionArg,
    ], {
      env: createSanitizedPostgresChildEnv(password),
    });
  } catch (error) {
    const message = redactPostgresCredential(describeExecError(error), password);
    throw new Error(`Consistent pg_dump failed for schema ${schema}: ${message}`);
  }
  if (!existsSync(options.destination) || readFileSync(options.destination).length === 0) {
    throw new Error(`Consistent pg_dump produced no artifact for schema ${schema}`);
  }
}

async function selectJsonRows(
  client: import('pg').PoolClient,
  table: typeof FLEET_AUTH_DURABLE_TABLES[number],
  orderBy: string,
): Promise<Record<string, unknown>[]> {
  // Table/order expressions are closed constants owned by this module.
  const result = await client.query<{ value: Record<string, unknown> }>(
    `SELECT to_jsonb(row_value) AS value
     FROM (SELECT * FROM ${FLEET_AUTH_SCHEMA_NAME}."${table}" ORDER BY ${orderBy}) AS row_value`,
  );
  return result.rows.map(row => row.value);
}

async function captureFleetAuthSnapshot(
  client: import('pg').PoolClient,
  postgresSnapshot: string,
  capturedAt: string,
): Promise<{ authorityLineageId: string; value: Record<string, unknown> }> {
  const authorityState = await selectJsonRows(client, 'authority_state', 'singleton');
  const authorityLineageId = authorityState[0]?.authority_lineage_id;
  if (typeof authorityLineageId !== 'string' || !/^[0-9a-f]{64}$/u.test(authorityLineageId)) {
    throw new Error('Fleet auth backup requires a provisioned authority lineage');
  }
  return {
    authorityLineageId,
    value: {
      schemaVersion: 4,
      capturedAt,
      postgresSnapshot,
      authorityLineageId,
      durable: {
        authorityState,
        humanPrincipals: await selectJsonRows(client, 'human_principals', 'principal_id'),
        providerSubjects: await selectJsonRows(client, 'provider_subjects', 'provider, subject_id'),
        providerSubjectHistory: await selectJsonRows(client, 'provider_subject_history', 'recorded_at, event_id'),
        providerSubjectTombstones: await selectJsonRows(client, 'provider_subject_tombstones', 'provider, subject_id'),
        companionAuthorityState: await selectJsonRows(client, 'companion_authority_state', 'companion_id'),
        principalContactBindings: await selectJsonRows(client, 'principal_contact_bindings', 'binding_id'),
        principalRoleGrants: await selectJsonRows(client, 'principal_role_grants', 'grant_id'),
        principalMergeAliases: await selectJsonRows(client, 'principal_merge_aliases', 'source_principal_id'),
        passkeyCredentials: await selectJsonRows(client, 'passkey_credentials', 'credential_id_hash'),
        authorizationAuditEvents: await selectJsonRows(client, 'authorization_audit_events', 'occurred_at, event_id'),
      },
    },
  };
}

function writeJsonDurable(path: string, value: unknown): void {
  writeFileDurableAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Dedicated coordinator path. Existing companion backup credentials cannot
 * call this because they have no fleet_auth USAGE/SELECT grants. Every dump
 * imports the same exported repeatable-read snapshot; fleet_auth durable rows
 * are queried by that exporter transaction itself.
 */
export async function runFleetAuthConsistentBackup(options: {
  databaseUrl: string;
  roles: FleetAuthDatabaseRoles;
  schemas: ReadonlyArray<{
    kind: 'companion' | 'shared';
    schema: string;
    ownerRole: string;
    runtimeRoles: readonly string[];
  }>;
  systemDataDir: string;
  backupDir: string;
  capturedAt?: string;
  pgDumpBinary?: string;
  afterSnapshotExported?: () => Promise<void>;
}): Promise<FleetAuthConsistentBackupResult> {
  if (options.schemas.length === 0) {
    throw new Error('Fleet auth consistent backup requires companion/shared schema artifacts');
  }
  const schemas = validateFleetAuthSchemaAccessContracts(
    options.schemas,
    options.schemas.map(entry => entry.schema),
    options.roles,
  );
  if (schemas.some(entry => entry.schema === FLEET_AUTH_SCHEMA_NAME)) {
    throw new Error('fleet_auth must use its dedicated JSON artifact, never a companion schema dump');
  }
  if (new Set(schemas.map(entry => entry.schema)).size !== schemas.length) {
    throw new Error('Fleet auth consistent backup schema list contains duplicates');
  }
  const sharedCount = schemas.filter(entry => entry.kind === 'shared').length;
  if (sharedCount !== 1) throw new Error('Fleet auth consistent backup requires exactly one shared schema');
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  if (!isCanonicalIsoTimestamp(capturedAt)) throw new Error('Fleet auth backup capturedAt is invalid');

  const backupDir = resolve(options.backupDir);
  if (existsSync(backupDir) && readdirSync(backupDir).length > 0) {
    throw new Error(`Fleet auth backup destination must be empty: ${backupDir}`);
  }
  await assertFleetAuthBackupRestorePrivileges(options.databaseUrl, options.roles);
  mkdirSync(join(backupDir, 'postgres'), { recursive: true });
  mkdirSync(join(backupDir, 'system-config'), { recursive: true });

  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-consistent-backup',
    max: 1,
  });
  const schemaDumpPaths: Record<string, string> = {};
  let client: import('pg').PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshotResult = await client.query<SnapshotExportRow>(`
      SELECT pg_export_snapshot() AS exported_snapshot,
             txid_current_snapshot()::text AS postgres_snapshot
    `);
    const snapshot = snapshotResult.rows.at(0);
    if (!snapshot?.exported_snapshot || !snapshot.postgres_snapshot) {
      throw new Error('PostgreSQL did not export a consistent fleet auth backup snapshot');
    }
    await options.afterSnapshotExported?.();

    const artifacts: FleetAuthBackupArtifact[] = [];
    for (const descriptor of schemas) {
      const path = join(backupDir, 'postgres', `${descriptor.schema}.dump`);
      await dumpSchemaAtSnapshot({
        databaseUrl: options.databaseUrl,
        schema: descriptor.schema,
        exportedSnapshot: snapshot.exported_snapshot,
        destination: path,
        pgDumpBinary: options.pgDumpBinary,
      });
      schemaDumpPaths[descriptor.schema] = path;
      artifacts.push({
        kind: descriptor.kind,
        path: relative(backupDir, path),
        postgresSchema: descriptor.schema,
        ownerRole: descriptor.ownerRole,
        runtimeRoles: [...descriptor.runtimeRoles].sort(),
        ...hashFile(path),
      });
    }

    const fleetAuthSnapshotPath = join(backupDir, FLEET_AUTH_SNAPSHOT_NAME);
    const fleetAuthSnapshot = await captureFleetAuthSnapshot(
      client,
      snapshot.postgres_snapshot,
      capturedAt,
    );
    writeJsonDurable(fleetAuthSnapshotPath, fleetAuthSnapshot.value);
    artifacts.push({
      kind: 'fleet_auth',
      path: relative(backupDir, fleetAuthSnapshotPath),
      postgresSchema: FLEET_AUTH_SCHEMA_NAME,
      ...hashFile(fleetAuthSnapshotPath),
    });

    // Validation proves the copied owner file is canonical; the byte copy
    // retains operator formatting. Credential references are included, values
    // resolved from the vault are not.
    loadFleetAuthConfig(options.systemDataDir);
    const ownerSource = join(options.systemDataDir, FLEET_AUTH_FILE_NAME);
    const ownerDestination = join(backupDir, 'system-config', FLEET_AUTH_FILE_NAME);
    writeFileDurableAtomicSync(ownerDestination, readFileSync(ownerSource));
    artifacts.push({
      kind: 'fleet_auth_config',
      path: relative(backupDir, ownerDestination),
      ...hashFile(ownerDestination),
    });

    const manifest: FleetAuthBackupManifest = {
      schemaVersion: FLEET_AUTH_BACKUP_MANIFEST_SCHEMA_VERSION,
      capturedAt,
      postgresSnapshot: snapshot.postgres_snapshot,
      authorityLineageId: fleetAuthSnapshot.authorityLineageId,
      artifacts,
    };
    const manifestPath = join(backupDir, FLEET_AUTH_BACKUP_MANIFEST_NAME);
    writeJsonDurable(manifestPath, manifest);
    await client.query('COMMIT');
    client.release();
    client = undefined;
    return { manifestPath, fleetAuthSnapshotPath, schemaDumpPaths };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      client = undefined;
    }
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

function parseArtifact(value: unknown, index: number): FleetAuthBackupArtifact {
  const field = `artifacts[${index}]`;
  if (!isRecord(value)) throw new Error(`Invalid fleet auth backup manifest: ${field} must be an object`);
  assertNoUnknownKeys(value, [
    'kind', 'path', 'sha256', 'sizeBytes', 'postgresSchema', 'ownerRole', 'runtimeRoles',
  ], field, {
    errorPrefix: 'Invalid fleet auth backup manifest',
  });
  if (value.kind !== 'companion' && value.kind !== 'shared'
    && value.kind !== 'fleet_auth' && value.kind !== 'fleet_auth_config') {
    throw new Error(`Invalid fleet auth backup manifest: ${field}.kind is invalid`);
  }
  if (typeof value.path !== 'string' || !value.path || isAbsolute(value.path)
    || value.path === '..' || value.path.startsWith('../')) {
    throw new Error(`Invalid fleet auth backup manifest: ${field}.path is unsafe`);
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256)) {
    throw new Error(`Invalid fleet auth backup manifest: ${field}.sha256 is invalid`);
  }
  if (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0) {
    throw new Error(`Invalid fleet auth backup manifest: ${field}.sizeBytes is invalid`);
  }
  if (value.postgresSchema !== undefined && typeof value.postgresSchema !== 'string') {
    throw new Error(`Invalid fleet auth backup manifest: ${field}.postgresSchema is invalid`);
  }
  if (value.ownerRole !== undefined && typeof value.ownerRole !== 'string') {
    throw new Error(`Invalid fleet auth backup manifest: ${field}.ownerRole is invalid`);
  }
  if (value.runtimeRoles !== undefined && (!Array.isArray(value.runtimeRoles)
    || value.runtimeRoles.length === 0
    || value.runtimeRoles.some((role) => {
      if (typeof role !== 'string') return true;
      try {
        assertValidPostgresRoleName(role);
        return false;
      } catch {
        return true;
      }
    })
    || new Set(value.runtimeRoles).size !== value.runtimeRoles.length)) {
    throw new Error(`Invalid fleet auth backup manifest: ${field}.runtimeRoles is invalid`);
  }
  return {
    kind: value.kind,
    path: value.path,
    sha256: value.sha256,
    sizeBytes: Number(value.sizeBytes),
    ...(typeof value.postgresSchema === 'string'
      ? { postgresSchema: assertValidPostgresSchemaName(value.postgresSchema) }
      : {}),
    ...(typeof value.ownerRole === 'string'
      ? { ownerRole: assertValidPostgresRoleName(value.ownerRole) }
      : {}),
    ...(Array.isArray(value.runtimeRoles)
      ? { runtimeRoles: [...value.runtimeRoles as string[]].sort() }
      : {}),
  };
}

export function verifyFleetAuthBackupManifest(manifestPath: string): FleetAuthBackupManifest {
  const canonicalManifestPath = resolve(manifestPath);
  const backupDir = dirname(canonicalManifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(canonicalManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Fleet auth backup manifest is unavailable: ${String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('Invalid fleet auth backup manifest: root must be an object');
  assertNoUnknownKeys(parsed, [
    'schemaVersion',
    'capturedAt',
    'postgresSnapshot',
    'authorityLineageId',
    'artifacts',
  ], 'root', {
    errorPrefix: 'Invalid fleet auth backup manifest',
  });
  if (parsed.schemaVersion !== FLEET_AUTH_BACKUP_MANIFEST_SCHEMA_VERSION
    || !isCanonicalIsoTimestamp(parsed.capturedAt)
    || typeof parsed.postgresSnapshot !== 'string'
    || parsed.postgresSnapshot.length === 0
    || typeof parsed.authorityLineageId !== 'string'
    || !/^[0-9a-f]{64}$/u.test(parsed.authorityLineageId)
    || !Array.isArray(parsed.artifacts)) {
    throw new Error('Invalid fleet auth backup manifest: malformed root fields');
  }
  const artifacts = parsed.artifacts.map(parseArtifact);
  const kindCounts = new Map<FleetAuthBackupArtifactKind, number>();
  const artifactPaths = new Set<string>();
  const postgresSchemas = new Set<string>();
  for (const artifact of artifacts) {
    kindCounts.set(artifact.kind, (kindCounts.get(artifact.kind) ?? 0) + 1);
    const artifactPath = resolve(backupDir, artifact.path);
    const relativePath = relative(backupDir, artifactPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || basename(artifactPath) === FLEET_AUTH_AUTHORITY_FLOOR_FILE_SENTINEL) {
      throw new Error('Invalid fleet auth backup manifest: artifact escapes or includes authority floor state');
    }
    if (artifactPaths.has(artifactPath)) {
      throw new Error('Invalid fleet auth backup manifest: duplicate artifact path');
    }
    artifactPaths.add(artifactPath);
    if (artifact.kind === 'fleet_auth') {
      if (artifact.postgresSchema !== FLEET_AUTH_SCHEMA_NAME
        || artifact.ownerRole !== undefined
        || artifact.runtimeRoles !== undefined) {
        throw new Error('Invalid fleet auth backup manifest: fleet_auth artifact has the wrong schema');
      }
    } else if (artifact.kind === 'companion' || artifact.kind === 'shared') {
      if (!artifact.postgresSchema || artifact.postgresSchema === FLEET_AUTH_SCHEMA_NAME
        || !artifact.ownerRole || !artifact.runtimeRoles) {
        throw new Error('Invalid fleet auth backup manifest: companion/shared schema is missing or reserved');
      }
    } else if (artifact.postgresSchema !== undefined
      || artifact.ownerRole !== undefined
      || artifact.runtimeRoles !== undefined) {
      throw new Error('Invalid fleet auth backup manifest: non-schema artifact carries a PostgreSQL access mapping');
    }
    if (artifact.postgresSchema) {
      if (postgresSchemas.has(artifact.postgresSchema)) {
        throw new Error('Invalid fleet auth backup manifest: duplicate PostgreSQL schema artifact');
      }
      postgresSchemas.add(artifact.postgresSchema);
    }
    if (!existsSync(artifactPath)) throw new Error(`Fleet auth backup artifact is missing: ${artifact.path}`);
    if (!lstatSync(artifactPath).isFile()) {
      throw new Error(`Fleet auth backup artifact is not a regular file: ${artifact.path}`);
    }
    const actual = hashFile(artifactPath);
    if (actual.sha256 !== artifact.sha256 || actual.sizeBytes !== artifact.sizeBytes) {
      throw new Error(`Fleet auth backup artifact digest mismatch: ${artifact.path}`);
    }
  }
  if (kindCounts.get('fleet_auth') !== 1 || kindCounts.get('fleet_auth_config') !== 1
    || kindCounts.get('shared') !== 1 || (kindCounts.get('companion') ?? 0) < 1) {
    throw new Error('Invalid fleet auth backup manifest: incomplete same-snapshot artifact family');
  }
  return {
    schemaVersion: FLEET_AUTH_BACKUP_MANIFEST_SCHEMA_VERSION,
    capturedAt: parsed.capturedAt,
    postgresSnapshot: parsed.postgresSnapshot,
    authorityLineageId: parsed.authorityLineageId,
    artifacts,
  };
}

export type FleetAuthRestoreOptions = Omit<VerifiedFleetAuthRestoreOptions, 'manifest'>;

export async function restoreFleetAuthSnapshot(
  options: FleetAuthRestoreOptions,
): Promise<FleetAuthRestoreResult> {
  const manifest = verifyFleetAuthBackupManifest(options.manifestPath);
  return await restoreVerifiedFleetAuthSnapshot({ ...options, manifest });
}

export async function verifyFleetAuthSnapshotRestore(
  options: FleetAuthRestoreOptions,
): Promise<FleetAuthRestoreResult> {
  const manifest = verifyFleetAuthBackupManifest(options.manifestPath);
  return await verifyVerifiedFleetAuthSnapshotRestore({ ...options, manifest });
}

// Deliberately local to avoid importing the authority-floor implementation
// into backup code; no artifact with this basename is ever accepted.
const FLEET_AUTH_AUTHORITY_FLOOR_FILE_SENTINEL = 'fleet-auth-authority-floor.json';
