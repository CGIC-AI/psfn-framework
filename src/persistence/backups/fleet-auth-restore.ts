import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import { createPostgresPool } from '../postgres.js';
import {
  type FleetAuthAuthorityFloor,
  FleetAuthAuthorityFloorStore,
} from '../postgres/fleet-auth/authority-floor.js';
import { reconcileFleetAuthAuthorityStateInTransaction } from '../postgres/fleet-auth/gateway-persistence.js';
import { FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_NAME } from '../postgres/fleet-auth/hub-device-assertion-replay-sql.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  assertFleetAuthBackupRestorePrivileges,
  type FleetAuthDatabaseRoles,
} from '../postgres/fleet-auth/schema.js';
import { FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME } from '../postgres/fleet-auth/companion-restore-sql.js';
import { parseContactAuthorityLifecycleResult } from '../../shared/contracts/contact-authority-lifecycle.js';

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
  companionAuthorityState: SnapshotRow[];
  principalContactBindings: SnapshotRow[];
  principalRoleGrants: SnapshotRow[];
  principalMergeAliases: SnapshotRow[];
  passkeyCredentials: SnapshotRow[];
  authorizationAuditEvents: SnapshotRow[];
  contactAuthorityIntents: SnapshotRow[];
  contactAuthorityResources: SnapshotRow[];
  contactAuthorityReceipts: SnapshotRow[];
}

interface FleetAuthSnapshot {
  schemaVersion: 5;
  capturedAt: string;
  postgresSnapshot: string;
  authorityLineageId: string;
  contentDigest: string;
  durable: FleetAuthDurableSnapshot;
}

export interface VerifiedFleetAuthBackupManifest {
  authorityLineageId: string;
  capturedAt: string;
  postgresSnapshot: string;
  artifacts: ReadonlyArray<{
    kind: 'companion' | 'shared' | 'fleet_auth' | 'fleet_auth_config';
    path: string;
    runtimeRoles?: readonly string[];
  }>;
}

export interface VerifiedFleetAuthRestoreOptions {
  manifestPath: string;
  manifest: VerifiedFleetAuthBackupManifest;
  databaseUrl: string;
  schemaOwnerDatabaseUrl: string;
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
  'companionAuthorityState',
  'principalContactBindings',
  'principalRoleGrants',
  'principalMergeAliases',
  'passkeyCredentials',
  'authorizationAuditEvents',
  'contactAuthorityIntents',
  'contactAuthorityResources',
  'contactAuthorityReceipts',
] as const;

const ROW_KEYS = {
  authorityState: [
    'singleton', 'authority_generation', 'global_auth_epoch', 'restore_checkpoint',
    'authority_lineage_id',
    'activation_generation', 'updated_at',
  ],
  humanPrincipals: [
    'principal_id', 'status', 'authn_version', 'authz_version', 'binding_version',
    'grant_version', 'policy_version', 'authority_generation',
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
  companionAuthorityState: [
    'companion_id', 'lifecycle', 'version', 'authority_generation', 'restore_state',
    'authority_lineage_id', 'lineage_generation', 'readd_decision_id',
    'created_at', 'updated_at',
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
  principalMergeAliases: [
    'source_principal_id', 'canonical_principal_id', 'decision_id',
    'authority_generation', 'reason_digest', 'restore_state', 'created_at',
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
    'correlation_id', 'occurred_at', 'decision_id', 'ceremony_id', 'reason_digest',
    'decision_context',
  ],
  contactAuthorityIntents: [
    'companion_id', 'intent_id', 'schema_version', 'intent_digest', 'action',
    'contact_id', 'canonical_contact_id', 'provider_subject_id', 'state',
    'authority_generation', 'restore_state', 'created_at', 'updated_at',
  ],
  contactAuthorityResources: [
    'companion_id', 'intent_id', 'kind', 'resource_id', 'terminal_fence', 'created_at',
  ],
  contactAuthorityReceipts: [
    'companion_id', 'intent_id', 'phase', 'request_digest', 'result',
    'authority_generation', 'global_auth_epoch', 'audit_event_id', 'restore_state',
    'created_at',
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
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Fleet auth snapshot is unavailable: ${String(error)}`);
  }
  if (!isRecord(value)) throw new Error('Invalid fleet auth snapshot: root must be an object');
  assertExactKeys(
    value,
    ['schemaVersion', 'capturedAt', 'postgresSnapshot', 'authorityLineageId', 'durable'],
    'root',
  );
  if (value.schemaVersion !== 5
    || !isCanonicalIsoTimestamp(value.capturedAt)
    || value.capturedAt !== manifest.capturedAt
    || typeof value.postgresSnapshot !== 'string'
    || value.postgresSnapshot !== manifest.postgresSnapshot
    || typeof value.authorityLineageId !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.authorityLineageId)
    || value.authorityLineageId !== manifest.authorityLineageId
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
    companionAuthorityState: parseCollection(
      durable.companionAuthorityState,
      'companionAuthorityState',
      ROW_KEYS.companionAuthorityState,
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
    principalMergeAliases: parseCollection(
      durable.principalMergeAliases,
      'principalMergeAliases',
      ROW_KEYS.principalMergeAliases,
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
    contactAuthorityIntents: parseCollection(
      durable.contactAuthorityIntents,
      'contactAuthorityIntents',
      ROW_KEYS.contactAuthorityIntents,
    ),
    contactAuthorityResources: parseCollection(
      durable.contactAuthorityResources,
      'contactAuthorityResources',
      ROW_KEYS.contactAuthorityResources,
    ),
    contactAuthorityReceipts: parseCollection(
      durable.contactAuthorityReceipts,
      'contactAuthorityReceipts',
      ROW_KEYS.contactAuthorityReceipts,
    ),
  };
  if (parsed.authorityState.length !== 1) {
    throw new Error('Invalid fleet auth snapshot: authorityState must contain its singleton row');
  }
  if (parsed.authorityState[0]?.singleton !== true) {
    throw new Error('Invalid fleet auth snapshot: authorityState singleton marker is invalid');
  }
  if (parsed.authorityState[0]?.authority_lineage_id !== value.authorityLineageId) {
    throw new Error('Invalid fleet auth snapshot: authority lineage does not match its manifest');
  }
  return {
    schemaVersion: 5,
    capturedAt: value.capturedAt,
    postgresSnapshot: value.postgresSnapshot,
    authorityLineageId: value.authorityLineageId,
    contentDigest: createHash('sha256').update(content).digest('hex'),
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

function admittedRestoredCompanionLineage(
  row: SnapshotRow,
  index: number,
  floor: FleetAuthAuthorityFloor,
  floors: FleetAuthAuthorityFloorStore,
): { lineageId: string | null; lineageGeneration: number | null; readdDecisionId: string | null } {
  const field = `durable.companionAuthorityState[${index}]`;
  const companionId = requiredString(row, 'companion_id', field);
  if (!isRfc4122Uuid(companionId)) {
    throw new Error(`Invalid fleet auth snapshot: ${field}.companion_id must be an RFC-4122 UUID`);
  }
  const lineageId = row.authority_lineage_id;
  const lineageGeneration = row.lineage_generation;
  const readdDecisionId = row.readd_decision_id;
  if (lineageId === null && lineageGeneration === null && readdDecisionId === null) {
    return { lineageId: null, lineageGeneration: null, readdDecisionId: null };
  }
  if (typeof lineageId !== 'string'
    || !/^[0-9a-f]{64}$/u.test(lineageId)
    || typeof lineageGeneration !== 'number'
    || !Number.isSafeInteger(lineageGeneration)
    || Number(lineageGeneration) < 1
    || typeof readdDecisionId !== 'string'
    || !isRfc4122Uuid(readdDecisionId)) {
    throw new Error(`Invalid fleet auth snapshot: ${field} has an incomplete companion lineage`);
  }
  const lineage = floors.findCompanionAuthorityReadd(companionId, floor);
  if (!lineage
    || !floors.companionAuthorityLineageIsCurrent({
      companionId,
      lineageId,
      lineageGeneration: Number(lineageGeneration),
    }, floor)
    || !timingSafeStringEqual(lineage.lineageId, lineageId)
    || lineage.entry.companionReadd.decisionId !== readdDecisionId) {
    // A snapshot lineage that predates the current permanent floor is retained
    // only as inert audit history. It cannot populate executable authority.
    return { lineageId: null, lineageGeneration: null, readdDecisionId: null };
  }
  return {
    lineageId,
    lineageGeneration: Number(lineageGeneration),
    readdDecisionId,
  };
}

interface CompanionRestoreAdmission {
  receiptId: string;
  lineageId: string | null;
  lineageGeneration: number | null;
  readdDecisionId: string | null;
}

interface CompanionRestoreReceiptContext {
  restoreOperationId: string;
  manifestDigest: string;
  snapshotDigest: string;
  admissions: ReadonlyMap<string, CompanionRestoreAdmission>;
}

async function issueCompanionRestoreReceipts(options: {
  owner: PoolClient;
  target: PoolClient;
  roles: FleetAuthDatabaseRoles;
  durable: FleetAuthDurableSnapshot;
  floor: FleetAuthAuthorityFloor;
  floors: FleetAuthAuthorityFloorStore;
  restoredAt: string;
  restoreOperationId: string;
  manifestDigest: string;
  snapshotDigest: string;
}): Promise<ReadonlyMap<string, CompanionRestoreAdmission>> {
  const [ownerIdentity, targetIdentity] = await Promise.all([
    options.owner.query<{
      current_user: string;
      current_database: string;
      schema_owner: string;
    }>(`
      SELECT current_user, current_database() AS current_database,
             owner_role.rolname AS schema_owner
      FROM pg_namespace AS namespace
      JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
      WHERE namespace.nspname = $1
    `, [FLEET_AUTH_SCHEMA_NAME]),
    options.target.query<{ current_database: string; restore_transaction_id: string }>(
      'SELECT current_database() AS current_database, txid_current()::text AS restore_transaction_id',
    ),
  ]);
  const owner = ownerIdentity.rows.at(0);
  const target = targetIdentity.rows.at(0);
  if (!owner || !target
    || owner.current_user !== options.roles.migration
    || owner.schema_owner !== options.roles.migration
    || owner.current_database !== target.current_database) {
    throw new Error(
      'Fleet auth restore receipt issuer must be the fleet_auth schema owner in the target database',
    );
  }

  const admissions = new Map<string, CompanionRestoreAdmission>();
  await options.owner.query('BEGIN');
  try {
    for (const [index, row] of options.durable.companionAuthorityState.entries()) {
      const companionId = requiredString(
        row,
        'companion_id',
        `durable.companionAuthorityState[${index}]`,
      );
      if (admissions.has(companionId)) {
        throw new Error('Invalid fleet auth snapshot: duplicate companion authority identity');
      }
      const lineage = admittedRestoredCompanionLineage(
        row,
        index,
        options.floor,
        options.floors,
      );
      const admission: CompanionRestoreAdmission = {
        receiptId: randomUUID(),
        ...lineage,
      };
      await options.owner.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.companion_restore_import_receipts
          (receipt_id, restore_operation_id, restore_transaction_id,
           manifest_digest, snapshot_digest,
           companion_id, version, authority_lineage_id, lineage_generation,
           readd_decision_id, created_at, imported_at,
           global_authority_lineage_id, authority_generation, restore_checkpoint)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `, [
        admission.receiptId,
        options.restoreOperationId,
        target.restore_transaction_id,
        options.manifestDigest,
        options.snapshotDigest,
        companionId,
        row.version,
        admission.lineageId,
        admission.lineageGeneration,
        admission.readdDecisionId,
        row.created_at,
        options.restoredAt,
        options.floor.trustedHost.lineageId,
        options.floor.trustedHost.authorityGeneration,
        options.floor.trustedHost.restoreCheckpoint,
      ]);
      admissions.set(companionId, admission);
    }
    await options.owner.query('COMMIT');
    return admissions;
  } catch (error) {
    try {
      await options.owner.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Fleet auth restore receipt issuance and rollback failed',
      );
    }
    throw error;
  }
}

async function deleteOutstandingCompanionRestoreReceipts(
  ownerPool: Pool,
  restoreOperationId: string,
): Promise<void> {
  await ownerPool.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_restore_import_receipts
    WHERE restore_operation_id = $1
  `, [restoreOperationId]);
}

async function assertTargetNotAhead(
  client: PoolClient,
  floor: FleetAuthAuthorityFloor,
): Promise<void> {
  const result = await client.query<{
    authority_lineage_id: string | null;
    authority_generation: string;
    restore_checkpoint: string;
    activation_generation: string;
  }>(`
    SELECT authority_lineage_id, authority_generation, restore_checkpoint, activation_generation
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    WHERE singleton = TRUE
    FOR UPDATE
  `);
  const state = result.rows.at(0);
  if (!state) throw new Error('Target fleet_auth authority_state singleton is missing');
  if (state.authority_lineage_id !== null
    && state.authority_lineage_id !== floor.trustedHost.lineageId) {
    throw new Error('Target fleet_auth authority lineage does not match the trusted-host floor');
  }
  if (parseStateInteger(state.authority_generation, 'authority_generation')
      > floor.trustedHost.authorityGeneration
    || parseStateInteger(state.restore_checkpoint, 'restore_checkpoint')
      > floor.trustedHost.restoreCheckpoint
    || parseStateInteger(state.activation_generation, 'activation_generation')
      > floor.trustedHost.activationGeneration) {
    throw new Error('Target fleet_auth authority is ahead of its non-restored trusted-host floor');
  }
}

async function insertOrAssertCompatibleConflict(options: {
  client: PoolClient;
  insertSql: string;
  insertValues: readonly unknown[];
  compatibilitySql: string;
  compatibilityValues: readonly unknown[];
  description: string;
}): Promise<number> {
  const inserted = await options.client.query(options.insertSql, [...options.insertValues]);
  if ((inserted.rowCount ?? 0) > 0) return inserted.rowCount ?? 0;
  const compatible = await options.client.query<{ compatible: boolean }>(
    options.compatibilitySql,
    [...options.compatibilityValues],
  );
  if (compatible.rows.at(0)?.compatible !== true) {
    throw new Error(`Fleet auth restore found a conflicting durable ${options.description}`);
  }
  return 0;
}

async function importDurableRows(
  client: PoolClient,
  durable: FleetAuthDurableSnapshot,
  floor: FleetAuthAuthorityFloor,
  floors: FleetAuthAuthorityFloorStore,
  restoredAt: string,
  receiptContext: CompanionRestoreReceiptContext,
): Promise<number> {
  let importedRows = 0;
  const record = async (query: Promise<number>): Promise<void> => {
    importedRows += await query;
  };

  for (const row of durable.humanPrincipals) {
    const values = [
      row.principal_id, row.authn_version, row.authz_version, row.binding_version,
      row.grant_version, row.policy_version, floor.trustedHost.authorityGeneration,
      row.created_at, restoredAt,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authn_version, authz_version, binding_version,
           grant_version, policy_version, authority_generation, restore_state,
           created_at, updated_at)
        VALUES ($1, 'quarantined', $2, $3, $4, $5, $6, $7,
                'quarantined', $8, $9)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          WHERE principal_id = $1
            AND authn_version >= $2::bigint
            AND authz_version >= $3::bigint
            AND binding_version >= $4::bigint
            AND grant_version >= $5::bigint
            AND policy_version >= $6::bigint
            AND authority_generation <= $7::bigint
            AND created_at <= $8::timestamptz
          FOR UPDATE
        ) AS compatible
      `,
      compatibilityValues: values.slice(0, 8),
      description: 'human principal',
    }));
  }

  for (const [index, row] of durable.companionAuthorityState.entries()) {
    const companionId = requiredString(
      row,
      'companion_id',
      `durable.companionAuthorityState[${index}]`,
    );
    const admission = receiptContext.admissions.get(companionId);
    if (!admission) {
      throw new Error('Fleet auth restore companion receipt admission is unavailable');
    }
    const values = [
      admission.receiptId,
      receiptContext.restoreOperationId,
      receiptContext.manifestDigest,
      receiptContext.snapshotDigest,
      companionId,
      row.version,
      admission.lineageId,
      admission.lineageGeneration,
      admission.readdDecisionId,
      row.created_at,
      restoredAt,
      floor.trustedHost.lineageId,
      floor.trustedHost.authorityGeneration,
      floor.trustedHost.restoreCheckpoint,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        SELECT 1
        WHERE ${FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME}(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
          WHERE companion_id = $5::uuid AND version >= $6::bigint
            AND authority_generation <= $13::bigint
            AND ($7::text IS NULL OR (
              authority_lineage_id = $7
              AND lineage_generation = $8::bigint
              AND readd_decision_id = $9::uuid
            ))
            AND created_at <= $10::timestamptz
          FOR UPDATE
        ) AS compatible
      `,
      compatibilityValues: values.slice(0, 13),
      description: 'companion authority state',
    }));
  }

  for (const row of durable.contactAuthorityIntents) {
    const values = [
      row.companion_id, row.intent_id, row.schema_version, row.intent_digest,
      row.action, row.contact_id, row.canonical_contact_id,
      row.provider_subject_id, floor.trustedHost.authorityGeneration,
      row.created_at, restoredAt,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents
          (companion_id, intent_id, schema_version, intent_digest, action,
           contact_id, canonical_contact_id, provider_subject_id, state,
           authority_generation, restore_state, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'quarantined', $9,
                'quarantined', $10, $11)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents
          WHERE companion_id = $1::uuid AND intent_id = $2::uuid
            AND schema_version = $3::integer AND intent_digest = $4
            AND action = $5 AND contact_id = $6
            AND canonical_contact_id IS NOT DISTINCT FROM $7::text
            AND provider_subject_id IS NOT DISTINCT FROM $8::text
            AND state = 'quarantined' AND restore_state = 'quarantined'
            AND authority_generation <= $9::bigint
            AND created_at <= $10::timestamptz
        ) AS compatible
      `,
      compatibilityValues: values.slice(0, 10),
      description: 'contact authority intent',
    }));
  }

  for (const row of durable.contactAuthorityResources) {
    const values = [
      row.companion_id, row.intent_id, row.kind, row.resource_id,
      row.terminal_fence, row.created_at,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resources
          (companion_id, intent_id, kind, resource_id, terminal_fence, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resources
          WHERE companion_id = $1::uuid AND intent_id = $2::uuid
            AND kind = $3 AND resource_id = $4
            AND terminal_fence = $5::boolean AND created_at = $6::timestamptz
        ) AS compatible
      `,
      compatibilityValues: values,
      description: 'contact authority resource fence',
    }));
  }

  for (const row of durable.principalMergeAliases) {
    const values = [
      row.source_principal_id, row.canonical_principal_id, row.decision_id,
      floor.trustedHost.authorityGeneration, row.reason_digest, row.created_at,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases
          (source_principal_id, canonical_principal_id, decision_id,
           authority_generation, reason_digest, restore_state, created_at)
        VALUES ($1, $2, $3, $4, $5, 'quarantined', $6)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases
          WHERE source_principal_id = $1::uuid AND canonical_principal_id = $2::uuid
            AND decision_id = $3::uuid AND authority_generation <= $4::bigint
            AND reason_digest = $5 AND created_at <= $6::timestamptz
        ) AS compatible
      `,
      compatibilityValues: values,
      description: 'principal merge alias',
    }));
  }

  for (const [index, row] of durable.providerSubjects.entries()) {
    const resource = providerSubjectResource(row, `durable.providerSubjects[${index}]`);
    const permanentlyTombstoned = floors.isAccountAuthorityTombstoned(
      'provider_subject',
      resource,
      floor,
    );
    const state = permanentlyTombstoned
      ? 'revoked'
      : 'quarantined';
    const values = [
      row.provider, row.subject_id, row.principal_id, state,
      jsonObject(row, 'metadata', `durable.providerSubjects[${index}]`),
      floor.trustedHost.authorityGeneration, row.created_at, restoredAt,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, metadata, authority_generation,
           restore_state, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'quarantined', $7, $8)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          WHERE provider = $1 AND subject_id = $2
            AND principal_id = $3::uuid
            AND $4::text IN ('revoked', 'quarantined')
            AND metadata = $5::jsonb
            AND authority_generation <= $6::bigint
            AND created_at <= $7::timestamptz
          FOR UPDATE
        ) AS compatible
      `,
      compatibilityValues: values.slice(0, 7),
      description: 'provider subject',
    }));
    if (permanentlyTombstoned) {
      const tombstoneValues = [
        row.provider, row.subject_id, row.principal_id,
        floor.trustedHost.authorityGeneration, restoredAt,
        createHash('sha256').update('trusted-host-authority-floor').digest('hex'),
      ];
      await record(insertOrAssertCompatibleConflict({
        client,
        insertSql: `
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
            (provider, subject_id, prior_principal_id, authority_generation, revoked_at, reason_digest)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
        `,
        insertValues: tombstoneValues,
        compatibilitySql: `
          SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
          WHERE provider = $1 AND subject_id = $2 AND prior_principal_id = $3::uuid
        ) AS compatible
        `,
        compatibilityValues: tombstoneValues.slice(0, 3),
        description: 'trusted-host provider tombstone',
      }));
    }
  }

  for (const [index, row] of durable.providerSubjectHistory.entries()) {
    providerSubjectResource(row, `durable.providerSubjectHistory[${index}]`);
    const values = [
      row.event_id, row.provider, row.subject_id, row.principal_id, row.state,
      row.event_type, row.authority_generation,
      jsonObject(row, 'payload', `durable.providerSubjectHistory[${index}]`), row.recorded_at,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
          (event_id, provider, subject_id, principal_id, state, event_type,
           authority_generation, payload, recorded_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
          WHERE event_id = $1::uuid AND provider = $2 AND subject_id = $3
            AND principal_id = $4::uuid AND state = $5 AND event_type = $6
            AND authority_generation = $7::bigint AND payload = $8::jsonb
            AND recorded_at = $9::timestamptz
        ) AS compatible
      `,
      compatibilityValues: values.slice(0, 9),
      description: 'provider subject history event',
    }));
  }

  for (const [index, row] of durable.providerSubjectTombstones.entries()) {
    providerSubjectResource(row, `durable.providerSubjectTombstones[${index}]`);
    const values = [
      row.provider, row.subject_id, row.prior_principal_id,
      floor.trustedHost.authorityGeneration, row.revoked_at, row.reason_digest,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
          (provider, subject_id, prior_principal_id, authority_generation, revoked_at, reason_digest)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
          WHERE provider = $1 AND subject_id = $2 AND prior_principal_id = $3::uuid
            AND $4::bigint >= 1
            AND authority_generation >= $7::bigint
            AND revoked_at >= $5::timestamptz
            AND (revoked_at > $5::timestamptz OR reason_digest = $6)
        ) AS compatible
      `,
      compatibilityValues: [...values, row.authority_generation],
      description: 'provider subject tombstone',
    }));
  }

  for (const row of durable.principalContactBindings) {
    const bindingId = requiredString(row, 'binding_id', 'durable.principalContactBindings');
    const state = floors.isAccountAuthorityTombstoned('contact_binding', bindingId, floor)
      ? 'revoked'
      : 'quarantined';
    const values = [
      row.binding_id, row.principal_id, row.companion_id, row.contact_id, state,
      jsonObject(row, 'verification_provenance', 'durable.principalContactBindings'),
      row.version, floor.trustedHost.authorityGeneration, row.created_at, restoredAt,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, version, authority_generation, restore_state,
           created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'quarantined', $9, $10)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          WHERE (binding_id = $1::uuid
              OR (principal_id = $2::uuid AND companion_id = $3::uuid AND contact_id = $4))
            AND binding_id = $1::uuid AND principal_id = $2::uuid
            AND companion_id = $3::uuid AND contact_id = $4
            AND $5::text IN ('revoked', 'quarantined')
            AND verification_provenance = $6::jsonb
            AND version >= $7::bigint AND authority_generation <= $8::bigint
            AND created_at <= $9::timestamptz
          FOR UPDATE
        ) AS compatible
      `,
      compatibilityValues: values.slice(0, 9),
      description: 'principal contact binding',
    }));
  }

  for (const row of durable.principalRoleGrants) {
    const grantId = requiredString(row, 'grant_id', 'durable.principalRoleGrants');
    const lifecycle = floors.isAccountAuthorityTombstoned('role_grant', grantId, floor)
      ? 'revoked'
      : 'quarantined';
    const values = [
      row.grant_id, row.principal_id, row.companion_id, row.role, lifecycle,
      row.version, floor.trustedHost.authorityGeneration, row.created_at, restoredAt,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          (grant_id, principal_id, companion_id, role, lifecycle, version,
           authority_generation, restore_state, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'quarantined', $8, $9)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          WHERE grant_id = $1::uuid AND principal_id = $2::uuid
            AND companion_id = $3::uuid AND role = $4
            AND $5::text IN ('revoked', 'quarantined')
            AND version >= $6::bigint AND authority_generation <= $7::bigint
            AND created_at <= $8::timestamptz
          FOR UPDATE
        ) AS compatible
      `,
      compatibilityValues: values.slice(0, 8),
      description: 'principal role grant',
    }));
  }

  for (const row of durable.passkeyCredentials) {
    const values = [
      row.credential_id_hash, row.principal_id, row.expected_provider,
      row.expected_provider_subject_id, row.rp_id, row.public_key_projection,
      row.credential_generation, row.sign_count, row.backup_eligible, row.backup_state,
      Math.max(1, floor.passkeys.generation), restoredAt,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
          (credential_id_hash, principal_id, expected_provider,
           expected_provider_subject_id, rp_id, public_key_projection,
           credential_generation, state, sign_count, backup_eligible, backup_state,
           authority_floor_generation, restore_state, imported_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'quarantined', $8, $9, $10,
                $11, 'quarantined', $12, $12)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
          WHERE credential_id_hash = $1 AND principal_id = $2::uuid
            AND expected_provider = $3 AND expected_provider_subject_id = $4
            AND rp_id = $5 AND public_key_projection = $6
            AND credential_generation >= $7::bigint AND sign_count >= $8::bigint
            AND backup_eligible = $9::boolean AND backup_state = $10::boolean
            AND $11::bigint >= 1 AND $12::timestamptz IS NOT NULL
            AND authority_floor_generation >= $13::bigint
          FOR UPDATE
        ) AS compatible
      `,
      compatibilityValues: [...values, row.authority_floor_generation],
      description: 'passkey projection',
    }));
  }

  for (const [index, row] of durable.authorizationAuditEvents.entries()) {
    const actorContext = jsonObject(
      row,
      'actor_context',
      `durable.authorizationAuditEvents[${index}]`,
    );
    const decisionContext = jsonObject(
      row,
      'decision_context',
      `durable.authorizationAuditEvents[${index}]`,
    );
    const isHubMutatedReplay = row.action === 'hub_device_assertion.verify'
      || row.reason_code === 'mutated_replay';
    if (isHubMutatedReplay) {
      const malformedFields = [
        actorContext === '{"kind":"hub_device_assertion"}' ? null : 'actor_context',
        row.action === 'hub_device_assertion.verify' ? null : 'action',
        row.resource === 'hub-device-assertion-replay' ? null : 'resource',
        row.decision === 'deny' ? null : 'decision',
        row.reason_code === 'mutated_replay' ? null : 'reason_code',
        row.companion_id === null ? null : 'companion_id',
        row.principal_id === null ? null : 'principal_id',
        row.decision_id === null ? null : 'decision_id',
        row.ceremony_id === null ? null : 'ceremony_id',
        row.reason_digest === null ? null : 'reason_digest',
      ].filter((field): field is string => field !== null);
      if (malformedFields.length > 0) {
        throw new Error(
          `Invalid fleet auth snapshot: durable.authorizationAuditEvents[${index}] `
          + `has malformed Hub mutated-replay denial fields: ${malformedFields.join(', ')}`,
        );
      }
      if (typeof row.correlation_id !== 'string'
        || !/^[0-9a-f]{64}$/u.test(row.correlation_id)) {
        throw new Error(
          `Invalid fleet auth snapshot: durable.authorizationAuditEvents[${index}] `
          + 'has a non-canonical Hub mutated-replay correlation',
        );
      }
      const imported = await client.query<{ imported: boolean }>(`
        SELECT ${FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_NAME}(
          $1, $2, $3, $4, $5::jsonb
        ) AS imported
      `, [
        row.event_id,
        row.authority_generation,
        row.global_auth_epoch,
        row.occurred_at,
        decisionContext,
      ]);
      if (imported.rows.at(0)?.imported === true) importedRows += 1;
      continue;
    }
    const values = [
      row.event_id,
      actorContext,
      row.action, row.resource, row.decision, row.reason_code, row.companion_id,
      row.principal_id, row.authority_generation, row.global_auth_epoch,
      row.correlation_id, row.occurred_at, row.decision_id, row.ceremony_id,
      row.reason_digest,
      decisionContext,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
          (event_id, actor_context, action, resource, decision, reason_code,
           companion_id, principal_id, authority_generation, global_auth_epoch,
           correlation_id, occurred_at, decision_id, ceremony_id, reason_digest,
           decision_context)
        VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16::jsonb)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
          WHERE event_id = $1::uuid AND actor_context = $2::jsonb
            AND action = $3 AND resource = $4 AND decision = $5
            AND reason_code IS NOT DISTINCT FROM $6::text
            AND companion_id IS NOT DISTINCT FROM $7::uuid
            AND principal_id IS NOT DISTINCT FROM $8::uuid
            AND authority_generation = $9::bigint AND global_auth_epoch = $10::bigint
            AND correlation_id IS NOT DISTINCT FROM $11::text
            AND occurred_at = $12::timestamptz
            AND decision_id IS NOT DISTINCT FROM $13::uuid
            AND ceremony_id IS NOT DISTINCT FROM $14::uuid
            AND reason_digest IS NOT DISTINCT FROM $15::text
            AND decision_context = $16::jsonb
        ) AS compatible
      `,
      compatibilityValues: values,
      description: 'authorization audit event',
    }));
  }
  for (const row of durable.contactAuthorityReceipts) {
    const result = parseContactAuthorityLifecycleResult(row.result);
    if (result.intentId !== row.intent_id
      || result.phase !== row.phase
      || result.authorityGeneration !== Number(row.authority_generation)
      || result.globalAuthEpoch !== Number(row.global_auth_epoch)
      || result.auditEventId !== row.audit_event_id) {
      throw new Error('Invalid fleet auth snapshot: contact authority receipt tuple mismatch');
    }
    const values = [
      row.companion_id, row.intent_id, row.phase, row.request_digest,
      JSON.stringify(result), row.authority_generation, row.global_auth_epoch,
      row.audit_event_id, row.created_at,
    ];
    await record(insertOrAssertCompatibleConflict({
      client,
      insertSql: `
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_receipts
          (companion_id, intent_id, phase, request_digest, result,
           authority_generation, global_auth_epoch, audit_event_id,
           restore_state, created_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'quarantined', $9)
        ON CONFLICT DO NOTHING
      `,
      insertValues: values,
      compatibilitySql: `
        SELECT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_receipts
          WHERE companion_id = $1::uuid AND intent_id = $2::uuid AND phase = $3
            AND request_digest = $4 AND result = $5::jsonb
            AND authority_generation = $6::bigint
            AND global_auth_epoch = $7::bigint
            AND audit_event_id = $8::uuid AND restore_state = 'quarantined'
            AND created_at = $9::timestamptz
        ) AS compatible
      `,
      compatibilityValues: values,
      description: 'contact authority phase receipt',
    }));
  }
  return importedRows;
}

/**
 * Restore only the dedicated fleet_auth artifact after the coordinator has
 * verified the complete same-snapshot manifest family. The non-restored floor
 * advances before database mutation. Any later failure therefore leaves
 * authority over-fenced and startup reconciliation retries the quarantine.
 */
async function executeVerifiedFleetAuthSnapshot(
  options: VerifiedFleetAuthRestoreOptions,
  verificationOnly: boolean,
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
  const manifestDigest = createHash('sha256')
    .update(readFileSync(resolve(options.manifestPath)))
    .digest('hex');
  const currentFloor = options.authorityFloors.read();
  if (snapshot.authorityLineageId !== currentFloor.trustedHost.lineageId) {
    throw new Error(
      'Fleet auth backup authority lineage does not match the non-restored trusted-host floor',
    );
  }
  const restoredTombstones = snapshot.durable.providerSubjectTombstones.map((row, index) => ({
    kind: 'provider_subject' as const,
    resourceId: providerSubjectResource(
      row,
      `durable.providerSubjectTombstones[${index}]`,
    ),
  }));

  await assertFleetAuthBackupRestorePrivileges(options.databaseUrl, options.roles);
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-consistent-restore',
    max: 1,
  });
  const ownerPool = createPostgresPool(options.schemaOwnerDatabaseUrl, {
    applicationName: 'fleet-auth-restore-receipt-issuer',
    max: 1,
  });
  const restoreOperationId = randomUUID();
  let client: PoolClient | undefined;
  let transactionOpen = false;
  let result: FleetAuthRestoreResult | undefined;
  let failure: unknown;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [RESTORE_LOCK_CLASS, RESTORE_LOCK_ID],
    );
    await assertTargetNotAhead(client, currentFloor);
    const preparedFloor = options.authorityFloors.prepareRestore({
      activationGeneration: options.activationGeneration,
      restoredTombstones,
      at: restoredAt,
    });
    // Establish the exact current singleton and floor projection before the
    // bounded companion importer validates any restored lineage tuple.
    const restoreAuditEventId = randomUUID();
    await reconcileFleetAuthAuthorityStateInTransaction(
      client,
      preparedFloor,
      restoreAuditEventId,
    );
    const owner = await ownerPool.connect();
    let admissions: ReadonlyMap<string, CompanionRestoreAdmission>;
    try {
      admissions = await issueCompanionRestoreReceipts({
        owner,
        target: client,
        roles: options.roles,
        durable: snapshot.durable,
        floor: preparedFloor,
        floors: options.authorityFloors,
        restoredAt,
        restoreOperationId,
        manifestDigest,
        snapshotDigest: snapshot.contentDigest,
      });
    } finally {
      owner.release();
    }
    const importedRows = await importDurableRows(
      client,
      snapshot.durable,
      preparedFloor,
      options.authorityFloors,
      restoredAt,
      {
        restoreOperationId,
        manifestDigest,
        snapshotDigest: snapshot.contentDigest,
        admissions,
      },
    );
    await client.query(verificationOnly ? 'ROLLBACK' : 'COMMIT');
    transactionOpen = false;
    result = {
      importedRows,
      authorityGeneration: preparedFloor.trustedHost.authorityGeneration,
      restoreCheckpoint: preparedFloor.trustedHost.restoreCheckpoint,
    };
  } catch (error) {
    failure = error;
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          'Fleet auth restore and database rollback failed',
        );
      }
    }
  } finally {
    client?.release();
    try {
      await pool.end();
    } catch (poolError) {
      failure = failure
        ? new AggregateError([failure, poolError], 'Fleet auth restore and pool cleanup failed')
        : poolError;
    }
    try {
      await deleteOutstandingCompanionRestoreReceipts(ownerPool, restoreOperationId);
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError(
            [failure, cleanupError],
            'Fleet auth restore and receipt cleanup failed',
          )
        : cleanupError;
    }
    try {
      await ownerPool.end();
    } catch (ownerPoolError) {
      failure = failure
        ? new AggregateError(
            [failure, ownerPoolError],
            'Fleet auth restore and schema-owner pool cleanup failed',
          )
        : ownerPoolError;
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error('Fleet auth restore completed without a result');
  return result;
}

export async function restoreVerifiedFleetAuthSnapshot(
  options: VerifiedFleetAuthRestoreOptions,
): Promise<FleetAuthRestoreResult> {
  return await executeVerifiedFleetAuthSnapshot(options, false);
}

/**
 * Exercise the complete fleet-auth import and reconciliation transaction
 * without publishing it. Callers must supply an isolated scratch database and
 * a cloned non-restored authority floor.
 */
export async function verifyVerifiedFleetAuthSnapshotRestore(
  options: VerifiedFleetAuthRestoreOptions,
): Promise<FleetAuthRestoreResult> {
  return await executeVerifiedFleetAuthSnapshot(options, true);
}
