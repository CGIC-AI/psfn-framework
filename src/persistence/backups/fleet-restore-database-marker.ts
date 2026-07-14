import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertValidPostgresSchemaName } from '../postgres.js';
import {
  redactPostgresCredential,
  sanitizePostgresConnection,
} from './postgres-connection.js';

const execFileAsync = promisify(execFile);
const RESTORE_CONTROL_SCHEMA = 'restore_control';

export interface FleetRestoreDatabaseOperation {
  operationId: string;
  operationIdentity: string;
}

export type FleetRestoreDatabaseMarkerState = 'absent' | 'prepared' | 'committed' | 'foreign';

export interface FleetRestoreMarkerPostgresOptions {
  databaseUrl: string;
  psqlBinary?: string;
}

function validateOperation(operation: FleetRestoreDatabaseOperation): void {
  if (!/^[0-9a-f]{32}$/u.test(operation.operationId)
    || !/^[0-9a-f]{64}$/u.test(operation.operationIdentity)) {
    throw new Error('Fleet restore database operation identity is invalid');
  }
}

async function executeMarkerSql(
  postgres: FleetRestoreMarkerPostgresOptions,
  sql: string,
): Promise<string> {
  const binary = postgres.psqlBinary?.trim() || 'psql';
  const { connectionArg, password } = sanitizePostgresConnection(postgres.databaseUrl, 'Fleet restore');
  try {
    const { stdout } = await execFileAsync(binary, [
      '--no-password',
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '--dbname',
      connectionArg,
      '--command',
      sql,
    ], { env: password !== undefined ? { ...process.env, PGPASSWORD: password } : process.env });
    return stdout.trim();
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactPostgresCredential(rawMessage, password);
    throw new Error(`Fleet restore database marker operation failed: ${message}`);
  }
}

export async function inspectFleetRestoreDatabaseMarker(
  postgres: FleetRestoreMarkerPostgresOptions,
  operation: FleetRestoreDatabaseOperation,
): Promise<FleetRestoreDatabaseMarkerState> {
  validateOperation(operation);
  const preparedMarker = `prepared:${operation.operationId}:${operation.operationIdentity}`;
  const committedMarker = `committed:${operation.operationId}:${operation.operationIdentity}`;
  const state = await executeMarkerSql(postgres, `
    /* restore_marker_inspect */
    SELECT CASE
      WHEN to_regnamespace('${RESTORE_CONTROL_SCHEMA}') IS NULL THEN 'absent'
      WHEN obj_description(to_regnamespace('${RESTORE_CONTROL_SCHEMA}'), 'pg_namespace') = '${preparedMarker}'
        THEN 'prepared'
      WHEN obj_description(to_regnamespace('${RESTORE_CONTROL_SCHEMA}'), 'pg_namespace') = '${committedMarker}'
        THEN 'committed'
      ELSE 'foreign'
    END;
  `);
  if (state !== 'absent' && state !== 'prepared' && state !== 'committed' && state !== 'foreign') {
    throw new Error('Fleet restore database marker inspection returned malformed output');
  }
  return state;
}

export async function prepareFleetRestoreDatabaseMarker(
  postgres: FleetRestoreMarkerPostgresOptions,
  operation: FleetRestoreDatabaseOperation,
): Promise<void> {
  validateOperation(operation);
  const preparedMarker = `prepared:${operation.operationId}:${operation.operationIdentity}`;
  await executeMarkerSql(postgres, `
    /* restore_marker_prepare */
    DO $prepare_marker$
    DECLARE
      existing_marker text;
    BEGIN
      IF to_regnamespace('${RESTORE_CONTROL_SCHEMA}') IS NULL THEN
        EXECUTE 'CREATE SCHEMA ${RESTORE_CONTROL_SCHEMA}';
        EXECUTE 'COMMENT ON SCHEMA ${RESTORE_CONTROL_SCHEMA} IS ''${preparedMarker}''';
        RETURN;
      END IF;
      existing_marker := obj_description(
        to_regnamespace('${RESTORE_CONTROL_SCHEMA}'),
        'pg_namespace'
      );
      IF existing_marker IS DISTINCT FROM '${preparedMarker}' THEN
        RAISE EXCEPTION 'another restore operation owns the database marker';
      END IF;
    END
    $prepare_marker$;
  `);
}

export async function commitFleetRestoreDatabaseMarker(
  postgres: FleetRestoreMarkerPostgresOptions,
  operation: FleetRestoreDatabaseOperation,
): Promise<void> {
  validateOperation(operation);
  const preparedMarker = `prepared:${operation.operationId}:${operation.operationIdentity}`;
  const committedMarker = `committed:${operation.operationId}:${operation.operationIdentity}`;
  await executeMarkerSql(postgres, `
    /* restore_marker_commit */
    DO $commit_marker$
    DECLARE
      existing_marker text;
    BEGIN
      existing_marker := obj_description(
        to_regnamespace('${RESTORE_CONTROL_SCHEMA}'),
        'pg_namespace'
      );
      IF existing_marker IS DISTINCT FROM '${preparedMarker}'
        AND existing_marker IS DISTINCT FROM '${committedMarker}' THEN
        RAISE EXCEPTION 'restore database marker is missing or foreign';
      END IF;
      EXECUTE 'COMMENT ON SCHEMA ${RESTORE_CONTROL_SCHEMA} IS ''${committedMarker}''';
    END
    $commit_marker$;
  `);
}

export async function removeFleetRestoreDatabaseMarker(
  postgres: FleetRestoreMarkerPostgresOptions,
  operation: FleetRestoreDatabaseOperation,
): Promise<void> {
  validateOperation(operation);
  const preparedMarker = `prepared:${operation.operationId}:${operation.operationIdentity}`;
  const committedMarker = `committed:${operation.operationId}:${operation.operationIdentity}`;
  await executeMarkerSql(postgres, `
    /* restore_marker_remove */
    DO $remove_marker$
    DECLARE
      existing_marker text;
    BEGIN
      IF to_regnamespace('${RESTORE_CONTROL_SCHEMA}') IS NULL THEN
        RETURN;
      END IF;
      existing_marker := obj_description(
        to_regnamespace('${RESTORE_CONTROL_SCHEMA}'),
        'pg_namespace'
      );
      IF existing_marker IS DISTINCT FROM '${preparedMarker}'
        AND existing_marker IS DISTINCT FROM '${committedMarker}' THEN
        RAISE EXCEPTION 'restore database marker is foreign';
      END IF;
      EXECUTE 'DROP SCHEMA ${RESTORE_CONTROL_SCHEMA}';
    END
    $remove_marker$;
  `);
}

/**
 * Authenticates database ownership and drops only the restore's validated
 * schemas in the same Postgres transaction, closing the inspect/mutate race.
 * The durable marker remains until filesystem rollback also succeeds.
 */
export async function rollbackFleetRestoreDatabaseSchemas(
  postgres: FleetRestoreMarkerPostgresOptions,
  operation: FleetRestoreDatabaseOperation,
  expectedSchemas: readonly string[],
): Promise<void> {
  validateOperation(operation);
  const schemas = expectedSchemas.map(assertValidPostgresSchemaName);
  const preparedMarker = `prepared:${operation.operationId}:${operation.operationIdentity}`;
  const committedMarker = `committed:${operation.operationId}:${operation.operationIdentity}`;
  const drops = schemas.map(schema => `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`).join('\n');
  await executeMarkerSql(postgres, `
    /* restore_marker_rollback */
    DO $rollback_marker$
    DECLARE
      existing_marker text;
    BEGIN
      existing_marker := obj_description(
        to_regnamespace('${RESTORE_CONTROL_SCHEMA}'),
        'pg_namespace'
      );
      IF existing_marker IS DISTINCT FROM '${preparedMarker}'
        AND existing_marker IS DISTINCT FROM '${committedMarker}' THEN
        RAISE EXCEPTION 'restore database marker is missing or foreign';
      END IF;
      ${drops}
    END
    $rollback_marker$;
  `);
}
