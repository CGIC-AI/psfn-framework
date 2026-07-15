import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PoolClient } from 'pg';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
} from '../../shared/utils/types.js';
import { createPostgresPool } from '../postgres.js';
import {
  type FleetAuthAuthorityFloor,
  FleetAuthAuthorityFloorStore,
} from '../postgres/fleet-auth/authority-floor.js';
import { reconcileFleetAuthAuthorityStateInTransaction } from '../postgres/fleet-auth/gateway-persistence.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  assertFleetAuthBackupRestorePrivileges,
  type FleetAuthDatabaseRoles,
} from '../postgres/fleet-auth/schema.js';

const RESTORE_LOCK_CLASS = 0x5053464e;
const RESTORE_LOCK_ID = 0x52535452;
const DISCORD_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;

type SnapshotRow = Record<string, unknown>;

interface FleetAuthDurableSnapshot {
  authorityState: SnapshotRow[];
  humanPrincipals: SnapshotRow[];
  providerSubjects: SnapshotRow[];
  providerSubjectHistory: SnapshotRow[];
  providerSubjectTombstones: SnapshotRow[];
  principalContactBindings: SnapshotRow[];
  principalRoleGrants: SnapshotRow[];
  passkeyCredentials: SnapshotRow[];
  authorizationAuditEvents: SnapshotRow[];
}

interface FleetAuthSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  postgresSnapshot: string;
  durable: FleetAuthDurableSnapshot;
}

export interface VerifiedFleetAuthBackupManifest {
  capturedAt: string;
  postgresSnapshot: string;
  artifacts: ReadonlyArray<{
    kind: 'companion' | 'shared' | 'fleet_auth' | 'fleet_auth_config';
    path: string;
  }>;
}

export interface VerifiedFleetAuthRestoreOptions {
  manifestPath: string;
  manifest: VerifiedFleetAuthBackupManifest;
  databaseUrl: string;
  roles: FleetAuthDatabaseRoles;
  authorityFloors: FleetAuthAuthorityFloorStore;
  activationGeneration: number;
  restoredAt?: string;
}

export interface FleetAuthRestoreResult {
  importedRows: number;
  authorityGeneration: number;
  restoreCheckpoint: number;
}

const SNAPSHOT_COLLECTION_KEYS = [
  'authorityState',
  'humanPrincipals',
  'providerSubjects',
  'providerSubjectHistory',
  'providerSubjectTombstones',
  'principalContactBindings',
  'principalRoleGrants',
  'passkeyCredentials',
  'authorizationAuditEvents',
] as const;

const ROW_KEYS = {
  authorityState: [
    'singleton', 'authority_generation', 'global_auth_epoch', 'restore_checkpoint',
    'activation_generation', 'updated_at',
  ],
  humanPrincipals: [
    'principal_id', 'status', 'authn_version', 'authz_version', 'authority_generation',
    'restore_state', 'created_at', 'updated_at',
  ],
  providerSubjects: [
    'provider', 'subject_id', 'principal_id', 'state', 'metadata', 'authority_generation',
    'restore_state', 'created_at', 'updated_at',
  ],
  providerSubjectHistory: [
    'event_id', 'provider', 'subject_id', 'principal_id', 'state', 'event_type',
    'authority_generation', 'payload', 'recorded_at',
  ],
  providerSubjectTombstones: [
    'provider', 'subject_id', 'prior_principal_id', 'authority_generation', 'revoked_at',
    'reason_digest',
  ],
  principalContactBindings: [
    'binding_id', 'principal_id', 'companion_id', 'contact_id', 'state',
    'verification_provenance', 'version', 'authority_generation', 'restore_state',
    'created_at', 'updated_at',
  ],
  principalRoleGrants: [
    'grant_id', 'principal_id', 'companion_id', 'role', 'lifecycle', 'version',
    'authority_generation', 'restore_state', 'created_at', 'updated_at',
  ],
  passkeyCredentials: [
    'credential_id_hash', 'principal_id', 'expected_provider',
    'expected_provider_subject_id', 'rp_id', 'public_key_projection',
    'credential_generation', 'state', 'sign_count', 'backup_eligible', 'backup_state',
    'authority_floor_generation', 'restore_state', 'imported_at', 'updated_at',
  ],
  authorizationAuditEvents: [
    'event_id', 'actor_context', 'action', 'resource', 'decision', 'reason_code',
    'companion_id', 'principal_id', 'authority_generation', 'global_auth_epoch',
    'correlation_id', 'occurred_at',
  ],
} as const;

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  assertNoUnknownKeys(value, keys, field, {
    errorPrefix: 'Invalid fleet auth snapshot',
  });
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`Invalid fleet auth snapshot: ${field}.${key} is required`);
    }
  }
}

function parseCollection(
  value: unknown,
  field: keyof FleetAuthDurableSnapshot,
  rowKeys: readonly string[],
): SnapshotRow[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid fleet auth snapshot: durable.${field} must be an array`);
  }
  return value.map((row, index) => {
    if (!isRecord(row)) {
      throw new Error(`Invalid fleet auth snapshot: durable.${field}[${index}] must be an object`);
    }
    assertExactKeys(row, rowKeys, `durable.${field}[${index}]`);
    return row;
  });
}

function parseSnapshot(path: string, manifest: VerifiedFleetAuthBackupManifest): FleetAuthSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Fleet auth snapshot is unavailable: ${String(error)}`);
  }
  if (!isRecord(value)) throw new Error('Invalid fleet auth snapshot: root must be an object');
  assertExactKeys(value, ['schemaVersion', 'capturedAt', 'postgresSnapshot', 'durable'], 'root');
  if (value.schemaVersion !== 1
    || !isCanonicalIsoTimestamp(value.capturedAt)
    || value.capturedAt !== manifest.capturedAt
    || typeof value.postgresSnapshot !== 'string'
    || value.postgresSnapshot !== manifest.postgresSnapshot
    || !isRecord(value.durable)) {
    throw new Error('Invalid fleet auth snapshot: root does not match its verified manifest');
  }
  const durable = value.durable;
  assertExactKeys(durable, SNAPSHOT_COLLECTION_KEYS, 'durable');
  const parsed: FleetAuthDurableSnapshot = {
    authorityState: parseCollection(durable.authorityState, 'authorityState', ROW_KEYS.authorityState),
    humanPrincipals: parseCollection(durable.humanPrincipals, 'humanPrincipals', ROW_KEYS.humanPrincipals),
    providerSubjects: parseCollection(durable.providerSubjects, 'providerSubjects', ROW_KEYS.providerSubjects),
    providerSubjectHistory: parseCollection(
      durable.providerSubjectHistory,
      'providerSubjectHistory',
      ROW_KEYS.providerSubjectHistory,
    ),
    providerSubjectTombstones: parseCollection(
      durable.providerSubjectTombstones,
      'providerSubjectTombstones',
      ROW_KEYS.providerSubjectTombstones,
    ),
    principalContactBindings: parseCollection(
      durable.principalContactBindings,
      'principalContactBindings',
      ROW_KEYS.principalContactBindings,
    ),
    principalRoleGrants: parseCollection(
      durable.principalRoleGrants,
      'principalRoleGrants',
      ROW_KEYS.principalRoleGrants,
    ),
    passkeyCredentials: parseCollection(
      durable.passkeyCredentials,
      'passkeyCredentials',
      ROW_KEYS.passkeyCredentials,
    ),
    authorizationAuditEvents: parseCollection(
      durable.authorizationAuditEvents,
      'authorizationAuditEvents',
      ROW_KEYS.authorizationAuditEvents,
    ),
  };
  if (parsed.authorityState.length !== 1) {
    throw new Error('Invalid fleet auth snapshot: authorityState must contain its singleton row');
  }
  if (parsed.authorityState[0]?.singleton !== true) {
    throw new Error('Invalid fleet auth snapshot: authorityState singleton marker is invalid');
  }
  return {
    schemaVersion: 1,
    capturedAt: value.capturedAt,
    postgresSnapshot: value.postgresSnapshot,
    durable: parsed,
  };
}

function requiredString(row: SnapshotRow, key: string, field: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid fleet auth snapshot: ${field}.${key} must be a non-empty string`);
  }
  return value;
}

function jsonObject(row: SnapshotRow, key: string, field: string): string {
  const value = row[key];
  if (!isRecord(value)) {
    throw new Error(`Invalid fleet auth snapshot: ${field}.${key} must be an object`);
  }
  return JSON.stringify(value);
}

function providerSubjectResource(row: SnapshotRow, field: string): string {
  const provider = requiredString(row, 'provider', field);
  const subjectId = requiredString(row, 'subject_id', field);
  if (provider !== 'discord' || !DISCORD_SUBJECT_PATTERN.test(subjectId)) {
    throw new Error(`Invalid fleet auth snapshot: ${field} has an invalid provider subject`);
  }
  return `${provider}:${subjectId}`;
}

function parseStateInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid target fleet_auth authority_state.${field}`);
  }
  return parsed;
}

async function assertTargetNotAhead(
  client: PoolClient,
  floor: FleetAuthAuthorityFloor,
): Promise<void> {
  const result = await client.query<{
    authority_generation: string;
    restore_checkpoint: string;
    activation_generation: string;
  }>(`
    SELECT authority_generation, restore_checkpoint, activation_generation
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    WHERE singleton = TRUE
    FOR UPDATE
  `);
  const state = result.rows.at(0);
  if (!state) throw new Error('Target fleet_auth authority_state singleton is missing');
  if (parseStateInteger(state.authority_generation, 'authority_generation')
      > floor.trustedHost.authorityGeneration
    || parseStateInteger(state.restore_checkpoint, 'restore_checkpoint')
      > floor.trustedHost.restoreCheckpoint
    || parseStateInteger(state.activation_generation, 'activation_generation')
      > floor.trustedHost.activationGeneration) {
    throw new Error('Target fleet_auth authority is ahead of its non-restored trusted-host floor');
  }
}

async function importDurableRows(
  client: PoolClient,
  durable: FleetAuthDurableSnapshot,
  floor: FleetAuthAuthorityFloor,
  floors: FleetAuthAuthorityFloorStore,
  restoredAt: string,
): Promise<number> {
  let importedRows = 0;
  const record = async (query: Promise<{ rowCount: number | null }>): Promise<void> => {
    importedRows += (await query).rowCount ?? 0;
  };

  for (const row of durable.humanPrincipals) {
    await record(client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        (principal_id, status, authn_version, authz_version, authority_generation,
         restore_state, created_at, updated_at)
      VALUES ($1, 'quarantined', $2, $3, $4, 'quarantined', $5, $6)
      ON CONFLICT DO NOTHING
    `, [
      row.principal_id,
      row.authn_version,
      row.authz_version,
      floor.trustedHost.authorityGeneration,
      row.created_at,
      restoredAt,
    ]));
  }

  for (const [index, row] of durable.providerSubjects.entries()) {
    const resource = providerSubjectResource(row, `durable.providerSubjects[${index}]`);
    const state = floors.isAccountAuthorityTombstoned('provider_subject', resource, floor)
      ? 'revoked'
      : 'quarantined';
    await record(client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        (provider, subject_id, principal_id, state, metadata, authority_generation,
         restore_state, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'quarantined', $7, $8)
      ON CONFLICT DO NOTHING
    `, [
      row.provider,
      row.subject_id,
      row.principal_id,
      state,
      jsonObject(row, 'metadata', `durable.providerSubjects[${index}]`),
      floor.trustedHost.authorityGeneration,
      row.created_at,
      restoredAt,
    ]));
  }

  for (const [index, row] of durable.providerSubjectHistory.entries()) {
    providerSubjectResource(row, `durable.providerSubjectHistory[${index}]`);
    await record(client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
        (event_id, provider, subject_id, principal_id, state, event_type,
         authority_generation, payload, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      ON CONFLICT DO NOTHING
    `, [
      row.event_id,
      row.provider,
      row.subject_id,
      row.principal_id,
      row.state,
      row.event_type,
      row.authority_generation,
      jsonObject(row, 'payload', `durable.providerSubjectHistory[${index}]`),
      row.recorded_at,
    ]));
  }

  for (const [index, row] of durable.providerSubjectTombstones.entries()) {
    providerSubjectResource(row, `durable.providerSubjectTombstones[${index}]`);
    await record(client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
        (provider, subject_id, prior_principal_id, authority_generation, revoked_at, reason_digest)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING
    `, [
      row.provider,
      row.subject_id,
      row.prior_principal_id,
      floor.trustedHost.authorityGeneration,
      row.revoked_at,
      row.reason_digest,
    ]));
  }

  for (const row of durable.principalContactBindings) {
    const bindingId = requiredString(row, 'binding_id', 'durable.principalContactBindings');
    const state = floors.isAccountAuthorityTombstoned('contact_binding', bindingId, floor)
      ? 'revoked'
      : 'quarantined';
    await record(client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        (binding_id, principal_id, companion_id, contact_id, state,
         verification_provenance, version, authority_generation, restore_state,
         created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'quarantined', $9, $10)
      ON CONFLICT DO NOTHING
    `, [
      row.binding_id,
      row.principal_id,
      row.companion_id,
      row.contact_id,
      state,
      jsonObject(row, 'verification_provenance', 'durable.principalContactBindings'),
      row.version,
      floor.trustedHost.authorityGeneration,
      row.created_at,
      restoredAt,
    ]));
  }

  for (const row of durable.principalRoleGrants) {
    const grantId = requiredString(row, 'grant_id', 'durable.principalRoleGrants');
    const lifecycle = floors.isAccountAuthorityTombstoned('role_grant', grantId, floor)
      ? 'revoked'
      : 'quarantined';
    await record(client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        (grant_id, principal_id, companion_id, role, lifecycle, version,
         authority_generation, restore_state, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'quarantined', $8, $9)
      ON CONFLICT DO NOTHING
    `, [
      row.grant_id,
      row.principal_id,
      row.companion_id,
      row.role,
      lifecycle,
      row.version,
      floor.trustedHost.authorityGeneration,
      row.created_at,
      restoredAt,
    ]));
  }

  for (const row of durable.passkeyCredentials) {
    await record(client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
        (credential_id_hash, principal_id, expected_provider,
         expected_provider_subject_id, rp_id, public_key_projection,
         credential_generation, state, sign_count, backup_eligible, backup_state,
         authority_floor_generation, restore_state, imported_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'quarantined', $8, $9, $10,
              $11, 'quarantined', $12, $12)
      ON CONFLICT DO NOTHING
    `, [
      row.credential_id_hash,
      row.principal_id,
      row.expected_provider,
      row.expected_provider_subject_id,
      row.rp_id,
      row.public_key_projection,
      row.credential_generation,
      row.sign_count,
      row.backup_eligible,
      row.backup_state,
      Math.max(1, floor.passkeys.generation),
      restoredAt,
    ]));
  }

  for (const [index, row] of durable.authorizationAuditEvents.entries()) {
    await record(client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         companion_id, principal_id, authority_generation, global_auth_epoch,
         correlation_id, occurred_at)
      VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT DO NOTHING
    `, [
      row.event_id,
      jsonObject(row, 'actor_context', `durable.authorizationAuditEvents[${index}]`),
      row.action,
      row.resource,
      row.decision,
      row.reason_code,
      row.companion_id,
      row.principal_id,
      row.authority_generation,
      row.global_auth_epoch,
      row.correlation_id,
      row.occurred_at,
    ]));
  }
  return importedRows;
}

/**
 * Restore only the dedicated fleet_auth artifact after the coordinator has
 * verified the complete same-snapshot manifest family. The non-restored floor
 * advances before database mutation. Any later failure therefore leaves
 * authority over-fenced and startup reconciliation retries the quarantine.
 */
export async function restoreVerifiedFleetAuthSnapshot(
  options: VerifiedFleetAuthRestoreOptions,
): Promise<FleetAuthRestoreResult> {
  if (!Number.isSafeInteger(options.activationGeneration) || options.activationGeneration < 1) {
    throw new Error('Fleet auth restore activation generation must be an integer >= 1');
  }
  const restoredAt = options.restoredAt ?? new Date().toISOString();
  if (!isCanonicalIsoTimestamp(restoredAt)) {
    throw new Error('Fleet auth restoredAt must be an ISO timestamp');
  }
  const artifact = options.manifest.artifacts.find(candidate => candidate.kind === 'fleet_auth');
  if (!artifact) throw new Error('Verified fleet auth backup has no fleet_auth artifact');
  const snapshot = parseSnapshot(
    resolve(dirname(resolve(options.manifestPath)), artifact.path),
    options.manifest,
  );
  const restoredTombstones = snapshot.durable.providerSubjectTombstones.map((row, index) => ({
    kind: 'provider_subject' as const,
    resourceId: providerSubjectResource(
      row,
      `durable.providerSubjectTombstones[${index}]`,
    ),
  }));

  await assertFleetAuthBackupRestorePrivileges(options.databaseUrl, options.roles);
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'psfn-fleet-auth-consistent-restore',
    max: 1,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [RESTORE_LOCK_CLASS, RESTORE_LOCK_ID],
    );
    const currentFloor = options.authorityFloors.read();
    await assertTargetNotAhead(client, currentFloor);
    const preparedFloor = options.authorityFloors.prepareRestore({
      activationGeneration: options.activationGeneration,
      restoredTombstones,
      at: restoredAt,
    });
    const importedRows = await importDurableRows(
      client,
      snapshot.durable,
      preparedFloor,
      options.authorityFloors,
      restoredAt,
    );
    await reconcileFleetAuthAuthorityStateInTransaction(
      client,
      preparedFloor,
      randomUUID(),
    );
    await client.query('COMMIT');
    return {
      importedRows,
      authorityGeneration: preparedFloor.trustedHost.authorityGeneration,
      restoreCheckpoint: preparedFloor.trustedHost.restoreCheckpoint,
    };
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
