import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  assertValidPostgresSchemaName,
  quotePostgresSchemaName,
} from '../postgres.js';

const ADOPTION_METADATA_SCHEMA = 'psfn_admin';
const ADOPTION_LOCK_CLASS = 0x5053464e;
const ADOPTION_PLAN_VERSION = 1;

export type PublicAdoptionObjectKind = 'sequence' | 'table' | 'view';

export interface PublicAdoptionColumnDefault {
  column: string;
  expression: string;
}

export interface PublicAdoptionForeignKey {
  name: string;
  definition: string;
}

interface PublicAdoptionInventoryBase {
  kind: PublicAdoptionObjectKind;
  name: string;
  definitionChecksum: string;
  rowCount: number;
  dataChecksum: string;
}

export interface PublicAdoptionSequenceInventory extends PublicAdoptionInventoryBase {
  kind: 'sequence';
  startValue: string;
  minValue: string;
  maxValue: string;
  incrementBy: string;
  cacheSize: string;
  cycle: boolean;
  lastValue: string;
  isCalled: boolean;
  ownedBy?: { table: string; column: string };
}

export interface PublicAdoptionTableInventory extends PublicAdoptionInventoryBase {
  kind: 'table';
  columnDefaults: PublicAdoptionColumnDefault[];
  foreignKeys: PublicAdoptionForeignKey[];
}

export interface PublicAdoptionViewInventory extends PublicAdoptionInventoryBase {
  kind: 'view';
  definition: string;
}

export type PublicAdoptionInventoryObject =
  | PublicAdoptionSequenceInventory
  | PublicAdoptionTableInventory
  | PublicAdoptionViewInventory;

export interface PublicAdoptionInventory {
  sourceSchema: 'public';
  objects: PublicAdoptionInventoryObject[];
}

export interface PublicAdoptionRollbackEvidence {
  metadataSchema: typeof ADOPTION_METADATA_SCHEMA;
  sourceSchema: 'public';
  targetSchema: string;
  sourcePreserved: true;
  rollbackAction: 'drop_target_schema';
}

export interface PublicAdoptionPlan {
  schemaVersion: typeof ADOPTION_PLAN_VERSION;
  sourceSchema: 'public';
  targetSchema: string;
  sourceInventoryChecksum: string;
  objects: PublicAdoptionInventoryObject[];
  rollback: PublicAdoptionRollbackEvidence;
  planChecksum: string;
}

export interface PublicAdoptionObjectResult {
  kind: PublicAdoptionObjectKind;
  name: string;
  rowCount: number;
  dataChecksum: string;
  status: 'applied' | 'already_applied';
}

export interface PublicAdoptionApplyResult {
  planChecksum: string;
  sourceInventoryChecksumBefore: string;
  sourceInventoryChecksumAfter: string;
  targetSchema: string;
  objects: PublicAdoptionObjectResult[];
  rollback: PublicAdoptionRollbackEvidence;
  resumed: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableObjectSort(
  left: Pick<PublicAdoptionInventoryObject, 'kind' | 'name'>,
  right: Pick<PublicAdoptionInventoryObject, 'kind' | 'name'>,
): number {
  const order: Record<PublicAdoptionObjectKind, number> = { sequence: 0, table: 1, view: 2 };
  return order[left.kind] - order[right.kind] || left.name.localeCompare(right.name);
}

function normalizeCount(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`PostgreSQL public adoption ${field} is not a safe non-negative integer`);
  }
  return parsed;
}

function quoteObjectName(name: string): string {
  return quotePostgresSchemaName(assertValidPostgresSchemaName(name));
}

function qualified(schema: string, object: string): string {
  return `${quotePostgresSchemaName(schema)}.${quoteObjectName(object)}`;
}

async function relationContentEvidence(
  client: PoolClient,
  schema: string,
  relation: string,
): Promise<{ rowCount: number; dataChecksum: string }> {
  const result = await client.query<{ row_count: string; data_checksum: string }>(`
    SELECT COUNT(*)::text AS row_count,
           md5(COALESCE(string_agg(row_json, E'\\n' ORDER BY row_json), '')) AS data_checksum
    FROM (
      SELECT to_jsonb(source_row)::text AS row_json
      FROM ${qualified(schema, relation)} AS source_row
    ) rows
  `);
  const row = result.rows.at(0);
  if (!row || !/^[a-f0-9]{32}$/u.test(row.data_checksum)) {
    throw new Error(`PostgreSQL public adoption could not checksum ${schema}.${relation}`);
  }
  return {
    rowCount: normalizeCount(row.row_count, `${schema}.${relation} row count`),
    dataChecksum: row.data_checksum,
  };
}

function inventoryChecksum(inventory: PublicAdoptionInventory): string {
  return sha256(JSON.stringify(inventory));
}

/** Read only catalog/data evidence. No source rows or secrets are logged or returned. */
export async function inventoryLegacyPublicSchema(
  client: PoolClient,
  diagnostics?: (event: {
    step: 'catalog' | 'sequence' | 'table' | 'view';
    objectName?: string;
    objectCount?: number;
  }) => void,
): Promise<PublicAdoptionInventory> {
  const tableRows = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const viewRows = await client.query<{ table_name: string; view_definition: string | null }>(`
    SELECT table_name, view_definition
    FROM information_schema.views
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  const sequenceRows = await client.query<{
    sequence_name: string;
    start_value: string;
    min_value: string;
    max_value: string;
    increment_by: string;
    cache_size: string;
    cycle: boolean;
    last_value: string | null;
  }>(`
    SELECT sequencename AS sequence_name, start_value::text, min_value::text, max_value::text,
           increment_by::text, cache_size::text, cycle, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public'
    ORDER BY sequencename
  `);

  const objects: PublicAdoptionInventoryObject[] = [];
  diagnostics?.({
    step: 'catalog',
    objectCount: tableRows.rows.length + viewRows.rows.length + sequenceRows.rows.length,
  });
  for (const raw of sequenceRows.rows) {
    const name = assertValidPostgresSchemaName(raw.sequence_name);
    diagnostics?.({ step: 'sequence', objectName: name });
    const state = await client.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called FROM ${qualified('public', name)}`,
    );
    const current = state.rows.at(0);
    if (!current) throw new Error(`PostgreSQL public sequence ${name} has no state`);
    const ownership = await client.query<{
      table_name: string;
      column_name: string;
      dependency_type: string;
    }>(`
      SELECT table_object.relname AS table_name, attribute.attname AS column_name,
             dependency.deptype AS dependency_type
      FROM pg_class sequence_object
      JOIN pg_namespace sequence_namespace ON sequence_namespace.oid = sequence_object.relnamespace
      JOIN pg_depend dependency
        ON dependency.classid = 'pg_class'::regclass
       AND dependency.objid = sequence_object.oid
       AND dependency.deptype IN ('a', 'i')
      JOIN pg_class table_object ON table_object.oid = dependency.refobjid
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_object.relnamespace
      JOIN pg_attribute attribute
        ON attribute.attrelid = table_object.oid
       AND attribute.attnum = dependency.refobjsubid
      WHERE sequence_namespace.nspname = 'public'
        AND sequence_object.relname = $1
        AND table_namespace.nspname = 'public'
    `, [name]);
    const ownershipRow = ownership.rows.at(0);
    if (ownershipRow?.dependency_type === 'i') {
      throw new Error(
        `PostgreSQL public adoption does not support identity-owned sequence ${name}`,
      );
    }
    const ownedBy = ownershipRow
      ? {
          table: assertValidPostgresSchemaName(ownershipRow.table_name),
          column: assertValidPostgresSchemaName(ownershipRow.column_name),
        }
      : undefined;
    const definition = {
      startValue: raw.start_value,
      minValue: raw.min_value,
      maxValue: raw.max_value,
      incrementBy: raw.increment_by,
      cacheSize: raw.cache_size,
      cycle: raw.cycle,
      ...(ownedBy ? { ownedBy } : {}),
    };
    const dataChecksum = sha256(JSON.stringify({
      lastValue: current.last_value,
      isCalled: current.is_called,
    }));
    objects.push({
      kind: 'sequence',
      name,
      definitionChecksum: sha256(JSON.stringify(definition)),
      rowCount: 1,
      dataChecksum,
      ...definition,
      lastValue: current.last_value,
      isCalled: current.is_called,
    });
  }

  for (const raw of tableRows.rows) {
    const name = assertValidPostgresSchemaName(raw.table_name);
    diagnostics?.({ step: 'table', objectName: name });
    const columns = await client.query<{
      column_name: string;
      ordinal_position: number;
      data_type: string;
      udt_schema: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
      identity_generation: string | null;
      is_generated: string;
      generation_expression: string | null;
    }>(`
      SELECT column_name, ordinal_position, data_type, udt_schema, udt_name,
             is_nullable, column_default, is_identity, identity_generation,
             is_generated, generation_expression
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [name]);
    const columnDefaults = columns.rows
      .filter(column => column.column_default !== null)
      .map(column => ({
        column: assertValidPostgresSchemaName(column.column_name),
        expression: column.column_default ?? '',
      }));
    const foreignKeys = await client.query<{ name: string; definition: string }>(`
      SELECT constraint_object.conname AS name,
             pg_get_constraintdef(constraint_object.oid, true) AS definition
      FROM pg_constraint constraint_object
      JOIN pg_class table_object ON table_object.oid = constraint_object.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_object.relnamespace
      WHERE namespace.nspname = 'public'
        AND table_object.relname = $1
        AND constraint_object.contype = 'f'
      ORDER BY constraint_object.conname
    `, [name]);
    const normalizedForeignKeys = foreignKeys.rows.map(foreignKey => ({
      name: assertValidPostgresSchemaName(foreignKey.name),
      definition: foreignKey.definition,
    }));
    const evidence = await relationContentEvidence(client, 'public', name);
    objects.push({
      kind: 'table',
      name,
      definitionChecksum: sha256(JSON.stringify({
        columns: columns.rows,
        foreignKeys: normalizedForeignKeys,
      })),
      ...evidence,
      columnDefaults,
      foreignKeys: normalizedForeignKeys,
    });
  }

  for (const raw of viewRows.rows) {
    const name = assertValidPostgresSchemaName(raw.table_name);
    diagnostics?.({ step: 'view', objectName: name });
    if (!raw.view_definition) {
      throw new Error(`PostgreSQL public view ${name} has no readable definition`);
    }
    const evidence = await relationContentEvidence(client, 'public', name);
    objects.push({
      kind: 'view',
      name,
      definitionChecksum: sha256(raw.view_definition),
      ...evidence,
      definition: raw.view_definition,
    });
  }

  return { sourceSchema: 'public', objects: objects.sort(stableObjectSort) };
}

/** Pure and deterministic: identical inventory + target yields byte-identical JSON. */
export function buildPublicAdoptionPlan(
  inventory: PublicAdoptionInventory,
  targetSchemaName: string,
): PublicAdoptionPlan {
  const targetSchema = assertValidPostgresSchemaName(targetSchemaName);
  if (['public', ADOPTION_METADATA_SCHEMA, 'extensions', 'shared'].includes(targetSchema)) {
    throw new Error(`PostgreSQL flagship adoption target schema ${targetSchema} is reserved`);
  }
  const objects = inventory.objects.map(object => ({
    ...object,
    name: assertValidPostgresSchemaName(object.name),
    ...(object.kind === 'table'
      ? {
          columnDefaults: object.columnDefaults.map(column => ({
            column: assertValidPostgresSchemaName(column.column),
            expression: column.expression,
          })),
          foreignKeys: object.foreignKeys.map(foreignKey => ({
            name: assertValidPostgresSchemaName(foreignKey.name),
            definition: foreignKey.definition,
          })),
        }
      : {}),
    ...(object.kind === 'sequence' && object.ownedBy
      ? {
          ownedBy: {
            table: assertValidPostgresSchemaName(object.ownedBy.table),
            column: assertValidPostgresSchemaName(object.ownedBy.column),
          },
        }
      : {}),
  })).sort(stableObjectSort);
  const names = new Set<string>();
  for (const object of objects) {
    const key = `${object.kind}:${object.name}`;
    if (names.has(key)) throw new Error(`PostgreSQL adoption inventory repeats ${key}`);
    names.add(key);
    if (object.kind === 'table') {
      const foreignKeyNames = new Set<string>();
      for (const foreignKey of object.foreignKeys) {
        if (foreignKeyNames.has(foreignKey.name)) {
          throw new Error(
            `PostgreSQL adoption inventory repeats foreign key ${object.name}.${foreignKey.name}`,
          );
        }
        foreignKeyNames.add(foreignKey.name);
      }
    }
  }
  const unsigned = {
    schemaVersion: ADOPTION_PLAN_VERSION as typeof ADOPTION_PLAN_VERSION,
    sourceSchema: 'public' as const,
    targetSchema,
    sourceInventoryChecksum: inventoryChecksum({ sourceSchema: 'public', objects }),
    objects,
    rollback: {
      metadataSchema: ADOPTION_METADATA_SCHEMA,
      sourceSchema: 'public' as const,
      targetSchema,
      sourcePreserved: true as const,
      rollbackAction: 'drop_target_schema' as const,
    },
  };
  return { ...unsigned, planChecksum: sha256(JSON.stringify(unsigned)) };
}

function assertPlanIntegrity(plan: PublicAdoptionPlan): void {
  const rebuilt = buildPublicAdoptionPlan(
    { sourceSchema: plan.sourceSchema, objects: plan.objects },
    plan.targetSchema,
  );
  if (rebuilt.planChecksum !== plan.planChecksum
    || rebuilt.sourceInventoryChecksum !== plan.sourceInventoryChecksum) {
    throw new Error('PostgreSQL public adoption plan checksum mismatch');
  }
}

function rewriteSourceSchema(expression: string, targetSchema: string): string {
  return expression
    .replaceAll(`'public.`, `'${targetSchema}.`)
    .replaceAll('public.', `${quotePostgresSchemaName(targetSchema)}.`)
    .replaceAll('"public".', `${quotePostgresSchemaName(targetSchema)}.`);
}

function normalizeForeignKeyDefinition(definition: string, targetSchema: string): string {
  return definition
    .replaceAll(`${quotePostgresSchemaName(targetSchema)}.`, '')
    .replaceAll(`${targetSchema}.`, '')
    .replaceAll('"public".', '')
    .replaceAll('public.', '')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function runTransaction<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'PostgreSQL public adoption failed and its transaction rollback also failed',
      );
    }
    throw error;
  }
}

async function applyObject(
  client: PoolClient,
  plan: PublicAdoptionPlan,
  object: PublicAdoptionInventoryObject,
): Promise<PublicAdoptionObjectResult> {
  const source = qualified('public', object.name);
  const target = qualified(plan.targetSchema, object.name);
  // Catalog expressions frequently omit `public` because it was on the legacy
  // session search path. Resolve those unqualified sequence/view dependencies
  // only inside the target schema; explicit public references are rewritten
  // below. This also makes a missed dependency fail closed instead of silently
  // rebinding the adopted object to legacy public state.
  await client.query(
    `SET LOCAL search_path TO ${quotePostgresSchemaName(plan.targetSchema)}, extensions`,
  );
  if (object.kind === 'sequence') {
    await client.query(`
      CREATE SEQUENCE ${target}
      INCREMENT BY ${object.incrementBy}
      MINVALUE ${object.minValue}
      MAXVALUE ${object.maxValue}
      START WITH ${object.startValue}
      CACHE ${object.cacheSize}
      ${object.cycle ? 'CYCLE' : 'NO CYCLE'}
    `);
    await client.query('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [
      `${plan.targetSchema}.${object.name}`,
      object.lastValue,
      object.isCalled,
    ]);
  } else if (object.kind === 'table') {
    await client.query(`CREATE TABLE ${target} (LIKE ${source} INCLUDING ALL)`);
    await client.query(`INSERT INTO ${target} SELECT * FROM ${source}`);
    for (const columnDefault of object.columnDefaults) {
      const expression = rewriteSourceSchema(columnDefault.expression, plan.targetSchema);
      await client.query(
        `ALTER TABLE ${target} ALTER COLUMN ${quoteObjectName(columnDefault.column)} SET DEFAULT ${expression}`,
      );
    }
  } else {
    await client.query(
      `CREATE VIEW ${target} AS ${rewriteSourceSchema(object.definition, plan.targetSchema)}`,
    );
  }
    const evidence = object.kind === 'sequence'
    ? {
        rowCount: 1,
        dataChecksum: sha256(JSON.stringify({
          lastValue: object.lastValue,
          isCalled: object.isCalled,
        })),
      }
    : await relationContentEvidence(client, plan.targetSchema, object.name);
  if (evidence.rowCount !== object.rowCount || evidence.dataChecksum !== object.dataChecksum) {
    throw new Error(`PostgreSQL public adoption verification failed for ${object.kind} ${object.name}`);
  }
  return { kind: object.kind, name: object.name, ...evidence, status: 'applied' };
}

async function applyAndVerifyDependencies(
  client: PoolClient,
  plan: PublicAdoptionPlan,
): Promise<void> {
  await client.query(
    `SET LOCAL search_path TO ${quotePostgresSchemaName(plan.targetSchema)}, extensions`,
  );
  for (const sequence of plan.objects.filter(
    (object): object is PublicAdoptionSequenceInventory => object.kind === 'sequence',
  )) {
    if (!sequence.ownedBy) continue;
    await client.query(
      `ALTER SEQUENCE ${qualified(plan.targetSchema, sequence.name)} OWNED BY `
      + `${qualified(plan.targetSchema, sequence.ownedBy.table)}.`
      + quoteObjectName(sequence.ownedBy.column),
    );
    const ownership = await client.query<{ table_schema: string; table_name: string; column_name: string }>(`
      SELECT table_namespace.nspname AS table_schema,
             table_object.relname AS table_name,
             attribute.attname AS column_name
      FROM pg_class sequence_object
      JOIN pg_namespace sequence_namespace ON sequence_namespace.oid = sequence_object.relnamespace
      JOIN pg_depend dependency
        ON dependency.classid = 'pg_class'::regclass
       AND dependency.objid = sequence_object.oid
       AND dependency.deptype IN ('a', 'i')
      JOIN pg_class table_object ON table_object.oid = dependency.refobjid
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_object.relnamespace
      JOIN pg_attribute attribute
        ON attribute.attrelid = table_object.oid
       AND attribute.attnum = dependency.refobjsubid
      WHERE sequence_namespace.nspname = $1 AND sequence_object.relname = $2
    `, [plan.targetSchema, sequence.name]);
    if (JSON.stringify(ownership.rows.at(0)) !== JSON.stringify({
      table_schema: plan.targetSchema,
      table_name: sequence.ownedBy.table,
      column_name: sequence.ownedBy.column,
    })) {
      throw new Error(`PostgreSQL public adoption sequence ownership failed for ${sequence.name}`);
    }
  }
  for (const table of plan.objects.filter(
    (object): object is PublicAdoptionTableInventory => object.kind === 'table',
  )) {
    for (const foreignKey of table.foreignKeys) {
      const existing = await client.query<{ exists: boolean }>(`
        SELECT TRUE AS exists
        FROM pg_constraint constraint_object
        JOIN pg_class table_object ON table_object.oid = constraint_object.conrelid
        JOIN pg_namespace namespace ON namespace.oid = table_object.relnamespace
        WHERE namespace.nspname = $1
          AND table_object.relname = $2
          AND constraint_object.conname = $3
          AND constraint_object.contype = 'f'
      `, [plan.targetSchema, table.name, foreignKey.name]);
      if (existing.rows.length === 0) {
        await client.query(
          `ALTER TABLE ${qualified(plan.targetSchema, table.name)} `
          + `ADD CONSTRAINT ${quoteObjectName(foreignKey.name)} `
          + rewriteSourceSchema(foreignKey.definition, plan.targetSchema),
        );
      }
      const verified = await client.query<{
        definition: string;
        referenced_schema: string;
      }>(`
        SELECT pg_get_constraintdef(constraint_object.oid, true) AS definition,
               referenced_namespace.nspname AS referenced_schema
        FROM pg_constraint constraint_object
        JOIN pg_class table_object ON table_object.oid = constraint_object.conrelid
        JOIN pg_namespace namespace ON namespace.oid = table_object.relnamespace
        JOIN pg_class referenced_table ON referenced_table.oid = constraint_object.confrelid
        JOIN pg_namespace referenced_namespace ON referenced_namespace.oid = referenced_table.relnamespace
        WHERE namespace.nspname = $1
          AND table_object.relname = $2
          AND constraint_object.conname = $3
          AND constraint_object.contype = 'f'
      `, [plan.targetSchema, table.name, foreignKey.name]);
      const evidence = verified.rows.at(0);
      if (!evidence
        || evidence.referenced_schema !== plan.targetSchema
        || normalizeForeignKeyDefinition(evidence.definition, plan.targetSchema)
          !== normalizeForeignKeyDefinition(foreignKey.definition, plan.targetSchema)) {
        throw new Error(
          `PostgreSQL public adoption foreign key ${table.name}.${foreignKey.name} escaped the target schema`,
        );
      }
    }
  }
}

/**
 * Explicit apply. Progress is committed object-by-object under one session
 * advisory lock; each object and its checkpoint share a transaction. A killed
 * run can therefore resume without duplicate objects or uncheckpointed writes.
 */
export async function applyPublicAdoptionPlan(
  pool: Pool,
  plan: PublicAdoptionPlan,
  options: {
    afterCommittedObject?: (result: PublicAdoptionObjectResult) => void | Promise<void>;
  } = {},
): Promise<PublicAdoptionApplyResult> {
  assertPlanIntegrity(plan);
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::integer, hashtext($2)::integer)', [
      ADOPTION_LOCK_CLASS,
      `public-adoption:${plan.targetSchema}`,
    ]);
    lockHeld = true;
    const before = buildPublicAdoptionPlan(
      await inventoryLegacyPublicSchema(client),
      plan.targetSchema,
    );
    if (before.sourceInventoryChecksum !== plan.sourceInventoryChecksum) {
      throw new Error('PostgreSQL public adoption source changed after the plan was produced');
    }

    await runTransaction(client, async () => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePostgresSchemaName(ADOPTION_METADATA_SCHEMA)}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_runs')} (
          plan_checksum TEXT PRIMARY KEY,
          source_inventory_checksum TEXT NOT NULL,
          target_schema TEXT NOT NULL UNIQUE,
          rollback_json JSONB NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('applying', 'complete', 'rolled_back')),
          started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          completed_at TIMESTAMPTZ
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_objects')} (
          plan_checksum TEXT NOT NULL REFERENCES ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_runs')}(plan_checksum),
          object_kind TEXT NOT NULL,
          object_name TEXT NOT NULL,
          row_count BIGINT NOT NULL,
          data_checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (plan_checksum, object_kind, object_name)
        )
      `);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePostgresSchemaName(plan.targetSchema)}`);
      await client.query(`
        INSERT INTO ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_runs')}
          (plan_checksum, source_inventory_checksum, target_schema, rollback_json, state)
        VALUES ($1, $2, $3, $4::jsonb, 'applying')
        ON CONFLICT (plan_checksum) DO NOTHING
      `, [
        plan.planChecksum,
        plan.sourceInventoryChecksum,
        plan.targetSchema,
        JSON.stringify(plan.rollback),
      ]);
      const run = await client.query<{
        source_inventory_checksum: string;
        target_schema: string;
        state: string;
      }>(`
        SELECT source_inventory_checksum, target_schema, state
        FROM ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_runs')}
        WHERE plan_checksum = $1
      `, [plan.planChecksum]);
      const current = run.rows.at(0);
      if (!current
        || current.source_inventory_checksum !== plan.sourceInventoryChecksum
        || current.target_schema !== plan.targetSchema
        || current.state === 'rolled_back') {
        throw new Error('PostgreSQL public adoption resume metadata does not match the plan');
      }
    });

    const results: PublicAdoptionObjectResult[] = [];
    let resumed = false;
    for (const object of plan.objects) {
      const existing = await client.query<{ row_count: string; data_checksum: string }>(`
        SELECT row_count::text, data_checksum
        FROM ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_objects')}
        WHERE plan_checksum = $1 AND object_kind = $2 AND object_name = $3
      `, [plan.planChecksum, object.kind, object.name]);
      if (existing.rows[0]) {
        const evidence = object.kind === 'sequence'
          ? await client.query<{ last_value: string; is_called: boolean }>(
              `SELECT last_value::text, is_called FROM ${qualified(plan.targetSchema, object.name)}`,
            ).then(result => {
              const row = result.rows.at(0);
              if (!row) throw new Error(`PostgreSQL adopted sequence ${object.name} has no state`);
              return {
                rowCount: 1,
                dataChecksum: sha256(JSON.stringify({
                  lastValue: row.last_value,
                  isCalled: row.is_called,
                })),
              };
            })
          : await relationContentEvidence(client, plan.targetSchema, object.name);
        if (evidence.rowCount !== object.rowCount || evidence.dataChecksum !== object.dataChecksum) {
          throw new Error(`PostgreSQL public adoption resume verification failed for ${object.name}`);
        }
        resumed = true;
        results.push({
          kind: object.kind,
          name: object.name,
          ...evidence,
          status: 'already_applied',
        });
        continue;
      }

      const applied = await runTransaction(client, async () => {
        const result = await applyObject(client, plan, object);
        await client.query(`
          INSERT INTO ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_objects')}
            (plan_checksum, object_kind, object_name, row_count, data_checksum)
          VALUES ($1, $2, $3, $4, $5)
        `, [plan.planChecksum, result.kind, result.name, result.rowCount, result.dataChecksum]);
        return result;
      });
      results.push(applied);
      await options.afterCommittedObject?.(applied);
    }

    await runTransaction(client, async () => {
      await applyAndVerifyDependencies(client, plan);
      await client.query(`
        UPDATE ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_runs')}
        SET state = 'complete', completed_at = clock_timestamp()
        WHERE plan_checksum = $1 AND state = 'applying'
      `, [plan.planChecksum]);
    });
    const after = buildPublicAdoptionPlan(
      await inventoryLegacyPublicSchema(client),
      plan.targetSchema,
    );
    if (after.sourceInventoryChecksum !== plan.sourceInventoryChecksum) {
      throw new Error('PostgreSQL public adoption modified the source inventory');
    }
    return {
      planChecksum: plan.planChecksum,
      sourceInventoryChecksumBefore: before.sourceInventoryChecksum,
      sourceInventoryChecksumAfter: after.sourceInventoryChecksum,
      targetSchema: plan.targetSchema,
      objects: results,
      rollback: plan.rollback,
      resumed,
    };
  } finally {
    if (lockHeld) {
      await client.query('SELECT pg_advisory_unlock($1::integer, hashtext($2)::integer)', [
        ADOPTION_LOCK_CLASS,
        `public-adoption:${plan.targetSchema}`,
      ]);
    }
    client.release();
  }
}

/** Explicit rollback for a previously applied plan; legacy public is untouched. */
export async function rollbackPublicAdoptionPlan(
  pool: Pool,
  plan: PublicAdoptionPlan,
): Promise<PublicAdoptionRollbackEvidence> {
  assertPlanIntegrity(plan);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::integer, hashtext($2)::integer)', [
      ADOPTION_LOCK_CLASS,
      `public-adoption:${plan.targetSchema}`,
    ]);
    await runTransaction(client, async () => {
      const run = await client.query<{ state: string }>(`
        SELECT state FROM ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_runs')}
        WHERE plan_checksum = $1 AND target_schema = $2
        FOR UPDATE
      `, [plan.planChecksum, plan.targetSchema]);
      const current = run.rows.at(0);
      if (!current || current.state === 'rolled_back') {
        throw new Error('PostgreSQL public adoption rollback has no active matching run');
      }
      await client.query(`DROP SCHEMA ${quotePostgresSchemaName(plan.targetSchema)} CASCADE`);
      await client.query(`
        DELETE FROM ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_objects')}
        WHERE plan_checksum = $1
      `, [plan.planChecksum]);
      await client.query(`
        UPDATE ${qualified(ADOPTION_METADATA_SCHEMA, 'public_adoption_runs')}
        SET state = 'rolled_back', completed_at = clock_timestamp()
        WHERE plan_checksum = $1
      `, [plan.planChecksum]);
    });
    return plan.rollback;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::integer, hashtext($2)::integer)', [
      ADOPTION_LOCK_CLASS,
      `public-adoption:${plan.targetSchema}`,
    ]);
    client.release();
  }
}
