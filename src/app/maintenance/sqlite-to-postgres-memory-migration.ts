import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import * as sqliteVec from 'sqlite-vec';
import {
  createPostgresPool,
  ensurePostgresSchema,
  withPostgresClient,
} from '../../persistence/postgres.js';
import {
  POSTGRES_CONTACT_MIGRATIONS,
  POSTGRES_INTENTION_MIGRATIONS,
  POSTGRES_MEMORY_MIGRATIONS,
  POSTGRES_REFLECTION_MIGRATIONS,
} from '../../persistence/postgres/migrations.js';

const MIGRATION_TABLES = [
  'l2_memories',
  'l2_memory_embeddings',
  'l2_memory_delete_versions',
  'l2_memory_abstraction_links',
  'l2_memory_patch_events',
  'l2_memory_maintenance_reviews',
  'memory_links',
  'contact_profiles',
  'scratchpad_entries',
  'l01_episodes',
  'l01_episode_arcs',
  'contacts',
  'contact_channel_ids',
  'contact_channel_activity',
  'contact_identity_link_verifications',
  'contact_mutation_audit',
  'social_graph_entities',
  'social_relationship_edges',
  'active_concerns',
  'intention_pending_follow_ups',
  'intention_pending_follow_up_quarantine',
  'behavioral_pattern_events',
  'reflections',
] as const;

const OUT_OF_SCOPE_TABLES = [
  'gateway_audit',
] as const;

type MigrationTableName = typeof MIGRATION_TABLES[number];
type MigrationMode = 'dry-run' | 'apply';
type MigrationStatus = 'ok' | 'failed';
type SqliteRow = Record<string, unknown>;

interface PostgresPoolLike {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  connect(): Promise<PoolClient>;
  end?(): Promise<void>;
}

export interface SqliteToPostgresMemoryMigrationWarning {
  code: string;
  message: string;
  table?: string;
  rowId?: string;
}

export interface SqliteToPostgresMemoryMigrationSkippedRow {
  table: MigrationTableName;
  rowId: string;
  reason: string;
}

export interface SqliteMigrationTableReport {
  present: boolean;
  rowCount: number;
  checksum: string | null;
  appliedRows: number;
}

export interface SqliteMigrationEmbeddingReport {
  present: boolean;
  rowCount: number;
  validCount: number;
  invalidCount: number;
  expectedDims: number;
  dimensions: Record<string, number>;
  checksum: string | null;
}

export interface SqliteToPostgresMemoryMigrationReport {
  status: MigrationStatus;
  mode: MigrationMode;
  sqlitePath: string;
  postgresUrl: string;
  embeddingDims: number;
  tables: Record<MigrationTableName, SqliteMigrationTableReport>;
  embeddings: SqliteMigrationEmbeddingReport;
  warnings: SqliteToPostgresMemoryMigrationWarning[];
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[];
  repairSuggestions: string[];
}

export interface SqliteToPostgresMemoryMigrationDependencies {
  createPostgresPool?: (postgresUrl: string) => PostgresPoolLike;
  ensurePostgresSchema?: (
    pool: PostgresPoolLike,
    statements: readonly string[],
  ) => Promise<void>;
  withPostgresClient?: <T>(
    pool: PostgresPoolLike,
    handler: (client: PoolClient) => Promise<T>,
  ) => Promise<T>;
}

export interface SqliteToPostgresMemoryMigrationOptions {
  sqlitePath: string;
  postgresUrl: string;
  dryRun?: boolean;
  embeddingDims: number;
  jsonReport?: boolean;
  dependencies?: SqliteToPostgresMemoryMigrationDependencies;
}

interface LoadedSqliteData {
  rows: Record<MigrationTableName, SqliteRow[]>;
  tables: Record<MigrationTableName, SqliteMigrationTableReport>;
  tableColumns: Record<MigrationTableName, Set<string>>;
  embeddingsByMemoryId: Map<string, string>;
  embeddingReport: SqliteMigrationEmbeddingReport;
  warnings: SqliteToPostgresMemoryMigrationWarning[];
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[];
}

interface PostgresSchemaTableRow extends QueryResultRow {
  table_name: string;
}

interface PostgresSchemaColumnRow extends QueryResultRow {
  column_name: string;
  data_type: string;
  udt_name: string;
}

const TABLE_ORDER_COLUMNS: Record<MigrationTableName, readonly string[]> = {
  l2_memories: ['id'],
  l2_memory_embeddings: ['memory_id'],
  l2_memory_delete_versions: ['delete_id'],
  l2_memory_abstraction_links: ['id'],
  l2_memory_patch_events: ['id'],
  l2_memory_maintenance_reviews: ['id'],
  memory_links: ['id1', 'id2'],
  contact_profiles: ['contact_id'],
  scratchpad_entries: ['id'],
  l01_episodes: ['id'],
  l01_episode_arcs: ['id'],
  contacts: ['id'],
  contact_channel_ids: ['channel', 'channel_user_id'],
  contact_channel_activity: ['contact_id', 'channel', 'channel_id'],
  contact_identity_link_verifications: ['id'],
  contact_mutation_audit: ['id'],
  social_graph_entities: ['id'],
  social_relationship_edges: ['id'],
  active_concerns: ['id'],
  intention_pending_follow_ups: ['id'],
  intention_pending_follow_up_quarantine: ['id'],
  behavioral_pattern_events: ['id'],
  reflections: ['id'],
};

function createEmptyTableReport(present = false): SqliteMigrationTableReport {
  return {
    present,
    rowCount: 0,
    checksum: null,
    appliedRows: 0,
  };
}

function createInitialTablesReport(): Record<MigrationTableName, SqliteMigrationTableReport> {
  return Object.fromEntries(
    MIGRATION_TABLES.map(table => [table, createEmptyTableReport()]),
  ) as Record<MigrationTableName, SqliteMigrationTableReport>;
}

function normalizeSqlitePath(sqlitePath: string): string {
  const normalized = sqlitePath.trim();
  if (!normalized) {
    throw new Error('--sqlite-path is required');
  }
  const resolvedPath = resolve(normalized);
  if (!existsSync(resolvedPath)) {
    throw new Error(`SQLite database does not exist: ${resolvedPath}`);
  }
  const stat = statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`SQLite path must be a file: ${resolvedPath}`);
  }
  return resolvedPath;
}

function normalizePostgresUrl(postgresUrl: string): string {
  const normalized = postgresUrl.trim();
  if (!normalized) {
    throw new Error('--postgres-url is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new Error(`--postgres-url must be a valid URL: ${String(error)}`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('--postgres-url must use postgres:// or postgresql://');
  }
  if (!parsed.hostname) {
    throw new Error('--postgres-url must include a host');
  }
  return normalized;
}

function normalizeEmbeddingDims(embeddingDims: number): number {
  if (!Number.isInteger(embeddingDims) || embeddingDims <= 0) {
    throw new Error('--embedding-dims must be a positive integer');
  }
  return embeddingDims;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { name: string } | undefined;
  return row?.name === tableName;
}

function readTableColumns(db: Database.Database, tableName: MigrationTableName): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map(row => row.name));
}

function readRows(
  db: Database.Database,
  tableName: MigrationTableName,
  columns: ReadonlySet<string>,
): SqliteRow[] {
  const orderColumns = TABLE_ORDER_COLUMNS[tableName].filter(column => columns.has(column));
  const orderClause = orderColumns.length > 0
    ? ` ORDER BY ${orderColumns.map(quoteIdentifier).join(', ')}`
    : '';
  return db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}${orderClause}`)
    .all() as SqliteRow[];
}

function normalizeChecksumValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { __bufferHex: value.toString('hex') };
  }
  if (value instanceof Float32Array) {
    return { __float32: Array.from(value) };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeChecksumValue);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeChecksumValue(nestedValue)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function checksumRows(rows: readonly SqliteRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(JSON.stringify(normalizeChecksumValue(row)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function decodeJsonValue(
  raw: unknown,
  fallback: unknown,
  context: string,
): { value: unknown; warning?: string } {
  if (raw === undefined || raw === null) {
    return { value: fallback };
  }
  if (typeof raw !== 'string') {
    return { value: raw };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { value: fallback };
  }
  try {
    return { value: JSON.parse(trimmed) as unknown };
  } catch {
    return {
      value: fallback,
      warning: `${context} contains malformed JSON and used a default value`,
    };
  }
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

function getString(row: SqliteRow, field: string): string | null {
  const value = row[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getOptionalString(row: SqliteRow, field: string): string | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return String(value);
}

function getNumber(row: SqliteRow, field: string, fallback: number): number {
  const value = row[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getNullableNumber(row: SqliteRow, field: string): number | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function rowIdentifier(row: SqliteRow, fallback: string): string {
  const id = getOptionalString(row, 'id')
    ?? getOptionalString(row, 'memory_id')
    ?? getOptionalString(row, 'delete_id');
  return id ?? fallback;
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.map(value => Number(value).toString()).join(',')}]`;
}

function decodeFloat32Buffer(buffer: Buffer): number[] {
  if (buffer.byteLength % 4 !== 0) {
    throw new Error(`embedding blob byte length ${buffer.byteLength} is not divisible by 4`);
  }
  const values: number[] = [];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let offset = 0; offset < buffer.byteLength; offset += 4) {
    const value = view.getFloat32(offset, true);
    if (!Number.isFinite(value)) {
      throw new Error('embedding blob contains a non-finite float');
    }
    values.push(value);
  }
  return values;
}

function parseEmbeddingText(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('embedding text is empty');
  }
  const parsed = trimmed.startsWith('[')
    ? JSON.parse(trimmed) as unknown
    : trimmed.split(',').map(part => Number(part.trim()));
  if (!Array.isArray(parsed)) {
    throw new Error('embedding text must decode to an array');
  }
  return parsed.map((entry) => {
    const numeric = typeof entry === 'number' ? entry : Number(entry);
    if (!Number.isFinite(numeric)) {
      throw new Error('embedding text contains a non-finite number');
    }
    return numeric;
  });
}

function decodeEmbeddingValue(value: unknown): number[] {
  if (Buffer.isBuffer(value)) {
    return decodeFloat32Buffer(value);
  }
  if (value instanceof Float32Array) {
    return Array.from(value);
  }
  if (typeof value === 'string') {
    return parseEmbeddingText(value);
  }
  throw new Error(`unsupported embedding storage type: ${typeof value}`);
}

function buildEmbeddingReport(
  rows: readonly SqliteRow[],
  expectedDims: number,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): { report: SqliteMigrationEmbeddingReport; embeddingsByMemoryId: Map<string, string> } {
  const embeddingsByMemoryId = new Map<string, string>();
  const dimensions: Record<string, number> = {};
  let validCount = 0;
  let invalidCount = 0;

  for (const [index, row] of rows.entries()) {
    const memoryId = getOptionalString(row, 'memory_id') ?? `row:${index}`;
    try {
      const values = decodeEmbeddingValue(row.embedding);
      const dimension = values.length;
      dimensions[String(dimension)] = (dimensions[String(dimension)] ?? 0) + 1;
      if (dimension !== expectedDims) {
        invalidCount += 1;
        const reason = `embedding dimension mismatch: expected ${expectedDims}, got ${dimension}`;
        skippedRows.push({ table: 'l2_memory_embeddings', rowId: memoryId, reason });
        warnings.push({
          table: 'l2_memory_embeddings',
          rowId: memoryId,
          code: 'embedding_dimension_mismatch',
          message: reason,
        });
        continue;
      }
      validCount += 1;
      embeddingsByMemoryId.set(memoryId, vectorLiteral(values));
    } catch (error) {
      invalidCount += 1;
      const reason = `unable to decode embedding: ${String(error)}`;
      skippedRows.push({ table: 'l2_memory_embeddings', rowId: memoryId, reason });
      warnings.push({
        table: 'l2_memory_embeddings',
        rowId: memoryId,
        code: 'embedding_decode_failed',
        message: reason,
      });
    }
  }

  return {
    embeddingsByMemoryId,
    report: {
      present: rows.length > 0,
      rowCount: rows.length,
      validCount,
      invalidCount,
      expectedDims,
      dimensions,
      checksum: rows.length > 0 ? checksumRows(rows) : null,
    },
  };
}

function maybeLoadSqliteVec(db: Database.Database, warnings: SqliteToPostgresMemoryMigrationWarning[]): void {
  try {
    sqliteVec.load(db);
  } catch (error) {
    warnings.push({
      table: 'l2_memory_embeddings',
      code: 'sqlite_vec_load_failed',
      message: `sqlite-vec extension could not be loaded before reading embeddings: ${String(error)}`,
    });
  }
}

function loadSqliteData(sqlitePath: string, embeddingDims: number): LoadedSqliteData {
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const rows = Object.fromEntries(
    MIGRATION_TABLES.map(table => [table, []]),
  ) as Record<MigrationTableName, SqliteRow[]>;
  const tables = createInitialTablesReport();
  const tableColumns = Object.fromEntries(
    MIGRATION_TABLES.map(table => [table, new Set<string>()]),
  ) as Record<MigrationTableName, Set<string>>;
  const warnings: SqliteToPostgresMemoryMigrationWarning[] = [];
  const skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[] = [];

  try {
    for (const table of MIGRATION_TABLES) {
      if (!tableExists(db, table)) continue;
      if (table === 'l2_memory_embeddings') {
        maybeLoadSqliteVec(db, warnings);
      }
      const columns = readTableColumns(db, table);
      tableColumns[table] = columns;
      const tableRows = readRows(db, table, columns);
      rows[table] = tableRows;
      tables[table] = {
        present: true,
        rowCount: tableRows.length,
        checksum: checksumRows(tableRows),
        appliedRows: 0,
      };
    }
    for (const table of OUT_OF_SCOPE_TABLES) {
      if (!tableExists(db, table)) continue;
      warnings.push({
        table,
        code: 'out_of_scope_table',
        message: `${table} is present but is outside this memory migration deliverable`,
      });
    }
  } finally {
    db.close();
  }

  if (!tables.l2_memories.present) {
    throw new Error('SQLite source is missing required l2_memories table');
  }

  const { report: embeddingReport, embeddingsByMemoryId } = buildEmbeddingReport(
    rows.l2_memory_embeddings,
    embeddingDims,
    warnings,
    skippedRows,
  );
  tables.l2_memory_embeddings = {
    present: tables.l2_memory_embeddings.present,
    rowCount: rows.l2_memory_embeddings.length,
    checksum: embeddingReport.checksum,
    appliedRows: 0,
  };

  return {
    rows,
    tables,
    tableColumns,
    embeddingsByMemoryId,
    embeddingReport: {
      ...embeddingReport,
      present: tables.l2_memory_embeddings.present,
    },
    warnings,
    skippedRows,
  };
}

async function validatePostgresTarget(pool: PostgresPoolLike): Promise<void> {
  const legacyEmbeddingTables = await pool.query<PostgresSchemaTableRow>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'l2_memory_embeddings'
  `);
  if (legacyEmbeddingTables.rows.length > 0) {
    throw new Error(
      'Unsupported PostgreSQL target: l2_memory_embeddings exists; embeddings must live on l2_memories.embedding',
    );
  }

  const memoryColumns = await pool.query<PostgresSchemaColumnRow>(`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'l2_memories'
  `);
  const embeddingColumn = memoryColumns.rows.find(column => column.column_name === 'embedding');
  if (!embeddingColumn) {
    throw new Error('Unsupported PostgreSQL target: l2_memories.embedding is missing');
  }
  if (embeddingColumn.udt_name !== 'vector') {
    throw new Error(
      `Unsupported PostgreSQL target: l2_memories.embedding must use pgvector, got ${embeddingColumn.udt_name || embeddingColumn.data_type}`,
    );
  }
}

function addJsonWarning(
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  table: MigrationTableName,
  rowId: string,
  field: string,
  warning: string | undefined,
): void {
  if (!warning) return;
  warnings.push({
    table,
    rowId,
    code: 'malformed_json_defaulted',
    message: `${field}: ${warning}`,
  });
}

function prepareMemoryValues(
  row: SqliteRow,
  embeddingsByMemoryId: ReadonlyMap<string, string>,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
): readonly unknown[] | null {
  const id = getString(row, 'id');
  const text = getString(row, 'text') ?? getString(row, 'content');
  const type = getString(row, 'type');
  const sourceRef = getString(row, 'source_ref');
  if (!id || !text || !type || !sourceRef) {
    return null;
  }

  if (!getString(row, 'text') && getString(row, 'content')) {
    warnings.push({
      table: 'l2_memories',
      rowId: id,
      code: 'legacy_content_column_used',
      message: 'used legacy l2_memories.content as memory text',
    });
  }

  const formationVad = decodeJsonValue(row.formation_vad, null, `memory ${id} formation_vad`);
  const provenanceJson = decodeJsonValue(row.provenance_json, {}, `memory ${id} provenance_json`);
  const tags = decodeJsonValue(row.tags, [], `memory ${id} tags`);
  const scopeTags = decodeJsonValue(row.scope_tags, [], `memory ${id} scope_tags`);
  const provenanceRefs = decodeJsonValue(row.provenance_refs, [], `memory ${id} provenance_refs`);
  const consentFlags = decodeJsonValue(row.consent_flags, {}, `memory ${id} consent_flags`);

  addJsonWarning(warnings, 'l2_memories', id, 'formation_vad', formationVad.warning);
  addJsonWarning(warnings, 'l2_memories', id, 'provenance_json', provenanceJson.warning);
  addJsonWarning(warnings, 'l2_memories', id, 'tags', tags.warning);
  addJsonWarning(warnings, 'l2_memories', id, 'scope_tags', scopeTags.warning);
  addJsonWarning(warnings, 'l2_memories', id, 'provenance_refs', provenanceRefs.warning);
  addJsonWarning(warnings, 'l2_memories', id, 'consent_flags', consentFlags.warning);

  return [
    id,
    text,
    type,
    getNumber(row, 'importance', 0.5),
    getNumber(row, 'confidence', 0.7),
    getNumber(row, 'emotional_valence', 0),
    jsonParam(formationVad.value),
    getNumber(row, 'salience', 0.5),
    sourceRef,
    getOptionalString(row, 'source_type') ?? 'unknown',
    jsonParam(provenanceJson.value),
    getNumber(row, 'extracted_at', 0),
    getNumber(row, 'last_accessed', 0),
    Math.trunc(getNumber(row, 'access_count', 1)),
    getOptionalString(row, 'superseded_by'),
    jsonParam(tags.value),
    getOptionalString(row, 'scope_ref_kind'),
    getOptionalString(row, 'scope_ref_id'),
    getOptionalString(row, 'scope_ref_label'),
    jsonParam(scopeTags.value),
    jsonParam(provenanceRefs.value),
    getOptionalString(row, 'retention_class'),
    getOptionalString(row, 'sensitivity') ?? 'personal',
    jsonParam(consentFlags.value),
    getOptionalString(row, 'contact_id'),
    getNullableNumber(row, 'deleted_at'),
    getOptionalString(row, 'deleted_by'),
    getOptionalString(row, 'delete_reason'),
    embeddingsByMemoryId.get(id) ?? null,
  ];
}

function prepareScratchpadValues(row: SqliteRow): readonly unknown[] | null {
  const id = getString(row, 'id');
  const content = getString(row, 'content');
  if (!id || !content) return null;
  return [
    id,
    content,
    getNumber(row, 'created_at', 0),
    getNumber(row, 'updated_at', 0),
  ];
}

function prepareDeleteVersionValues(
  row: SqliteRow,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
): readonly unknown[] | null {
  const deleteId = getString(row, 'delete_id');
  const memoryId = getString(row, 'memory_id');
  if (!deleteId || !memoryId) return null;
  const snapshot = decodeJsonValue(row.snapshot_json, null, `delete version ${deleteId} snapshot_json`);
  if (snapshot.warning || snapshot.value === null) {
    warnings.push({
      table: 'l2_memory_delete_versions',
      rowId: deleteId,
      code: 'malformed_required_json',
      message: snapshot.warning ?? 'snapshot_json is required',
    });
    return null;
  }
  return [
    deleteId,
    memoryId,
    jsonParam(snapshot.value),
    getNumber(row, 'deleted_at', 0),
    getOptionalString(row, 'deleted_by'),
    getOptionalString(row, 'delete_reason'),
    getNullableNumber(row, 'restored_at'),
    getOptionalString(row, 'restored_by'),
  ];
}

function prepareAbstractionLinkValues(row: SqliteRow): readonly unknown[] | null {
  const id = getString(row, 'id');
  const sourceMemoryId = getString(row, 'source_memory_id');
  const abstractedMemoryId = getString(row, 'abstracted_memory_id');
  const externalRef = getString(row, 'external_ref');
  if (!id || !sourceMemoryId || !abstractedMemoryId || !externalRef) return null;
  return [
    id,
    sourceMemoryId,
    abstractedMemoryId,
    externalRef,
    getNumber(row, 'created_at', 0),
    getOptionalString(row, 'created_by'),
    getOptionalString(row, 'reason'),
  ];
}

function preparePatchEventValues(
  row: SqliteRow,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
): readonly unknown[] | null {
  const id = getString(row, 'id');
  const memoryId = getString(row, 'memory_id');
  const sourceRef = getString(row, 'source_ref');
  const sourceType = getString(row, 'source_type');
  if (!id || !memoryId || !sourceRef || !sourceType) return null;

  const provenanceJson = decodeJsonValue(row.provenance_json, {}, `patch event ${id} provenance_json`);
  const patchJson = decodeJsonValue(row.patch_json, null, `patch event ${id} patch_json`);
  const previousJson = decodeJsonValue(row.previous_json, null, `patch event ${id} previous_json`);
  const nextJson = decodeJsonValue(row.next_json, null, `patch event ${id} next_json`);

  addJsonWarning(warnings, 'l2_memory_patch_events', id, 'provenance_json', provenanceJson.warning);
  for (const [field, decoded] of [
    ['patch_json', patchJson],
    ['previous_json', previousJson],
    ['next_json', nextJson],
  ] as const) {
    if (decoded.warning || decoded.value === null) {
      warnings.push({
        table: 'l2_memory_patch_events',
        rowId: id,
        code: 'malformed_required_json',
        message: decoded.warning ?? `${field} is required`,
      });
      return null;
    }
  }

  return [
    id,
    memoryId,
    sourceRef,
    sourceType,
    jsonParam(provenanceJson.value),
    getOptionalString(row, 'reason'),
    jsonParam(patchJson.value),
    jsonParam(previousJson.value),
    jsonParam(nextJson.value),
    getNumber(row, 'created_at', 0),
  ];
}

function prepareMaintenanceReviewValues(
  row: SqliteRow,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
): readonly unknown[] | null {
  const id = getString(row, 'id');
  const kind = getString(row, 'kind');
  const status = getString(row, 'status');
  const subjectMemoryId = getString(row, 'subject_memory_id');
  if (!id || !kind || !status || !subjectMemoryId) return null;

  const candidateMemoryIds = decodeJsonValue(
    row.candidate_memory_ids,
    [],
    `maintenance review ${id} candidate_memory_ids`,
  );
  const stateJson = decodeJsonValue(row.state_json, null, `maintenance review ${id} state_json`);
  addJsonWarning(
    warnings,
    'l2_memory_maintenance_reviews',
    id,
    'candidate_memory_ids',
    candidateMemoryIds.warning,
  );
  if (stateJson.warning || stateJson.value === null) {
    warnings.push({
      table: 'l2_memory_maintenance_reviews',
      rowId: id,
      code: 'malformed_required_json',
      message: stateJson.warning ?? 'state_json is required',
    });
    return null;
  }

  return [
    id,
    kind,
    status,
    subjectMemoryId,
    jsonParam(candidateMemoryIds.value),
    jsonParam(stateJson.value),
    getOptionalString(row, 'quarantine_reason'),
    getNumber(row, 'created_at', 0),
    getNumber(row, 'updated_at', 0),
  ];
}

function prepareMemoryLinkValues(row: SqliteRow): readonly unknown[] | null {
  const id1 = getString(row, 'id1');
  const id2 = getString(row, 'id2');
  if (!id1 || !id2) return null;
  return [
    id1,
    id2,
    getOptionalString(row, 'link_type') ?? 'related',
    getNumber(row, 'created_at', 0),
  ];
}

function prepareContactProfileValues(
  row: SqliteRow,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
): readonly unknown[] | null {
  const contactId = getString(row, 'contact_id');
  const summaryText = getString(row, 'summary_text') ?? getString(row, 'summary') ?? getString(row, 'profile_json');
  if (!contactId || !summaryText) return null;
  if (!getString(row, 'summary_text')) {
    warnings.push({
      table: 'contact_profiles',
      rowId: contactId,
      code: 'legacy_contact_profile_shape',
      message: 'used legacy contact profile text column as summary_text',
    });
  }
  const sourceMemoryIds = decodeJsonValue(
    row.source_memory_ids,
    [],
    `contact profile ${contactId} source_memory_ids`,
  );
  addJsonWarning(warnings, 'contact_profiles', contactId, 'source_memory_ids', sourceMemoryIds.warning);
  return [
    contactId,
    summaryText,
    jsonParam(sourceMemoryIds.value),
    getNumber(row, 'confidence_score', 0),
    getNumber(row, 'novelty_score', 0),
    getNumber(row, 'updated_at', 0),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return asRecord(raw);
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function prepareEpisodeValues(
  row: SqliteRow,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
): readonly unknown[] | null {
  const id = getString(row, 'id');
  if (!id) return null;
  const episode = parseJsonRecord(row.episode_json);
  if (!episode) {
    warnings.push({
      table: 'l01_episodes',
      rowId: id,
      code: 'malformed_episode_json',
      message: 'episode_json could not be parsed; row was skipped',
    });
    return null;
  }

  const salience = asRecord(episode.salience) ?? { score: getNumber(row, 'salience_score', 0) };
  const affect = asRecord(episode.affect) ?? { labels: [] };
  const startedAt = stringValue(episode.startedAt) ?? getString(row, 'started_at');
  const endedAt = stringValue(episode.endedAt) ?? getString(row, 'ended_at');
  const createdAt = stringValue(episode.createdAt) ?? getString(row, 'created_at');
  const updatedAt = stringValue(episode.updatedAt) ?? getString(row, 'updated_at');
  if (!startedAt || !endedAt || !createdAt || !updatedAt) {
    return null;
  }

  return [
    id,
    Math.trunc(getNumber(row, 'schema_version', getNumber(episode, 'schemaVersion', 1))),
    stringValue(episode.title) ?? id,
    stringValue(episode.landmark) ?? stringValue(episode.title) ?? id,
    getOptionalString(row, 'status') ?? 'canonical',
    getOptionalString(row, 'canonical_episode_id'),
    getOptionalString(row, 'merged_into_episode_id'),
    getOptionalString(row, 'superseded_by_episode_id'),
    stringValue(episode.threadId) ?? getOptionalString(row, 'thread_id'),
    stringValue(episode.channelId) ?? getOptionalString(row, 'channel_id'),
    startedAt,
    endedAt,
    jsonParam(arrayValue(episode.participantContactIds)),
    getNumber(row, 'salience_score', getNumber(salience, 'score', 0)),
    jsonParam(salience),
    jsonParam(affect),
    jsonParam(arrayValue(episode.themes)),
    jsonParam(arrayValue(episode.artifactRefs)),
    jsonParam(arrayValue(episode.provenanceRefs)),
    jsonParam({ spanRefs: arrayValue(episode.spanRefs) }),
    jsonParam({}),
    null,
    jsonParam(episode),
    createdAt,
    updatedAt,
  ];
}

function prepareEpisodeArcValues(
  row: SqliteRow,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
): readonly unknown[] | null {
  const id = getString(row, 'id');
  if (!id) return null;
  const arc = parseJsonRecord(row.arc_json);
  if (!arc) {
    warnings.push({
      table: 'l01_episode_arcs',
      rowId: id,
      code: 'malformed_arc_json',
      message: 'arc_json could not be parsed; row was skipped',
    });
    return null;
  }

  const sourceEpisodeId = stringValue(arc.sourceEpisodeId) ?? getString(row, 'source_episode_id');
  const targetEpisodeId = stringValue(arc.targetEpisodeId) ?? getString(row, 'target_episode_id');
  const arcKind = stringValue(arc.arcKind) ?? getString(row, 'arc_kind');
  const createdAt = stringValue(arc.createdAt) ?? getString(row, 'created_at');
  const updatedAt = stringValue(arc.updatedAt) ?? getString(row, 'updated_at');
  if (!sourceEpisodeId || !targetEpisodeId || !arcKind || !createdAt || !updatedAt) {
    return null;
  }

  return [
    id,
    Math.trunc(getNumber(row, 'schema_version', getNumber(arc, 'schemaVersion', 1))),
    sourceEpisodeId,
    targetEpisodeId,
    arcKind,
    getOptionalString(row, 'status') ?? 'canonical',
    getOptionalString(row, 'canonical_arc_id'),
    getOptionalString(row, 'merged_into_arc_id'),
    getOptionalString(row, 'superseded_by_arc_id'),
    getNumber(row, 'salience_score', getNumber(arc, 'salience', 0)),
    getNumber(row, 'confidence', getNumber(arc, 'confidence', 1)),
    jsonParam(arrayValue(arc.themes)),
    jsonParam(arrayValue(arc.spanRefs)),
    jsonParam(arrayValue(arc.artifactRefs)),
    jsonParam(arrayValue(arc.provenanceRefs)),
    jsonParam(arc),
    createdAt,
    updatedAt,
  ];
}

async function upsertMemories(
  client: PoolClient,
  rows: readonly SqliteRow[],
  embeddingsByMemoryId: ReadonlyMap<string, string>,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = prepareMemoryValues(row, embeddingsByMemoryId, warnings);
    if (!values) {
      const reason = 'required l2_memories fields are missing or invalid';
      skippedRows.push({ table: 'l2_memories', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO l2_memories (
        id, text, type, importance, confidence, emotional_valence, formation_vad, salience,
        source_ref, source_type, provenance_json, extracted_at, last_accessed, access_count,
        superseded_by, tags, scope_ref_kind, scope_ref_id, scope_ref_label, scope_tags,
        provenance_refs, retention_class, sensitivity, consent_flags, contact_id, deleted_at,
        deleted_by, delete_reason, embedding
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,
        $17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24::jsonb,$25,$26,$27,$28,$29::vector
      )
      ON CONFLICT (id) DO UPDATE SET
        text = EXCLUDED.text,
        type = EXCLUDED.type,
        importance = EXCLUDED.importance,
        confidence = EXCLUDED.confidence,
        emotional_valence = EXCLUDED.emotional_valence,
        formation_vad = EXCLUDED.formation_vad,
        salience = EXCLUDED.salience,
        source_ref = EXCLUDED.source_ref,
        source_type = EXCLUDED.source_type,
        provenance_json = EXCLUDED.provenance_json,
        extracted_at = EXCLUDED.extracted_at,
        last_accessed = EXCLUDED.last_accessed,
        access_count = EXCLUDED.access_count,
        superseded_by = EXCLUDED.superseded_by,
        tags = EXCLUDED.tags,
        scope_ref_kind = EXCLUDED.scope_ref_kind,
        scope_ref_id = EXCLUDED.scope_ref_id,
        scope_ref_label = EXCLUDED.scope_ref_label,
        scope_tags = EXCLUDED.scope_tags,
        provenance_refs = EXCLUDED.provenance_refs,
        retention_class = EXCLUDED.retention_class,
        sensitivity = EXCLUDED.sensitivity,
        consent_flags = EXCLUDED.consent_flags,
        contact_id = EXCLUDED.contact_id,
        deleted_at = EXCLUDED.deleted_at,
        deleted_by = EXCLUDED.deleted_by,
        delete_reason = EXCLUDED.delete_reason,
        embedding = EXCLUDED.embedding
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertScratchpadEntries(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = prepareScratchpadValues(row);
    if (!values) {
      const reason = 'required scratchpad_entries fields are missing or invalid';
      skippedRows.push({ table: 'scratchpad_entries', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO scratchpad_entries (id, content, created_at, updated_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertDeleteVersions(
  client: PoolClient,
  rows: readonly SqliteRow[],
  migratedMemoryIds: ReadonlySet<string>,
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = prepareDeleteVersionValues(row, warnings);
    if (!values) {
      const reason = 'required l2_memory_delete_versions fields are missing or malformed';
      skippedRows.push({ table: 'l2_memory_delete_versions', rowId, reason });
      continue;
    }
    const memoryId = getString(row, 'memory_id');
    if (!memoryId || !migratedMemoryIds.has(memoryId)) {
      skippedRows.push({
        table: 'l2_memory_delete_versions',
        rowId,
        reason: 'tombstone references a memory absent from l2_memories; snapshot remains in the SQLite source and backups',
      });
      continue;
    }
    await client.query(`
      INSERT INTO l2_memory_delete_versions (
        delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason, restored_at, restored_by
      ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
      ON CONFLICT (delete_id) DO UPDATE SET
        memory_id = EXCLUDED.memory_id,
        snapshot_json = EXCLUDED.snapshot_json,
        deleted_at = EXCLUDED.deleted_at,
        deleted_by = EXCLUDED.deleted_by,
        delete_reason = EXCLUDED.delete_reason,
        restored_at = EXCLUDED.restored_at,
        restored_by = EXCLUDED.restored_by
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertAbstractionLinks(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = prepareAbstractionLinkValues(row);
    if (!values) {
      const reason = 'required l2_memory_abstraction_links fields are missing or invalid';
      skippedRows.push({ table: 'l2_memory_abstraction_links', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO l2_memory_abstraction_links (
        id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET
        source_memory_id = EXCLUDED.source_memory_id,
        abstracted_memory_id = EXCLUDED.abstracted_memory_id,
        external_ref = EXCLUDED.external_ref,
        created_at = EXCLUDED.created_at,
        created_by = EXCLUDED.created_by,
        reason = EXCLUDED.reason
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertPatchEvents(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = preparePatchEventValues(row, warnings);
    if (!values) {
      const reason = 'required l2_memory_patch_events fields are missing or malformed';
      skippedRows.push({ table: 'l2_memory_patch_events', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO l2_memory_patch_events (
        id, memory_id, source_ref, source_type, provenance_json, reason,
        patch_json, previous_json, next_json, created_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)
      ON CONFLICT (id) DO UPDATE SET
        memory_id = EXCLUDED.memory_id,
        source_ref = EXCLUDED.source_ref,
        source_type = EXCLUDED.source_type,
        provenance_json = EXCLUDED.provenance_json,
        reason = EXCLUDED.reason,
        patch_json = EXCLUDED.patch_json,
        previous_json = EXCLUDED.previous_json,
        next_json = EXCLUDED.next_json,
        created_at = EXCLUDED.created_at
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertMaintenanceReviews(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = prepareMaintenanceReviewValues(row, warnings);
    if (!values) {
      const reason = 'required l2_memory_maintenance_reviews fields are missing or malformed';
      skippedRows.push({ table: 'l2_memory_maintenance_reviews', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO l2_memory_maintenance_reviews (
        id, kind, status, subject_memory_id, candidate_memory_ids, state_json,
        quarantine_reason, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        subject_memory_id = EXCLUDED.subject_memory_id,
        candidate_memory_ids = EXCLUDED.candidate_memory_ids,
        state_json = EXCLUDED.state_json,
        quarantine_reason = EXCLUDED.quarantine_reason,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertMemoryLinks(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = `${getOptionalString(row, 'id1') ?? 'missing'}::${getOptionalString(row, 'id2') ?? `row:${index}`}`;
    const values = prepareMemoryLinkValues(row);
    if (!values) {
      const reason = 'required memory_links fields are missing or invalid';
      skippedRows.push({ table: 'memory_links', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO memory_links (id1, id2, link_type, created_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (id1, id2) DO UPDATE SET
        link_type = EXCLUDED.link_type,
        created_at = EXCLUDED.created_at
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertContactProfiles(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = prepareContactProfileValues(row, warnings);
    if (!values) {
      const reason = 'required contact_profiles fields are missing or invalid';
      skippedRows.push({ table: 'contact_profiles', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO contact_profiles (
        contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
      ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
      ON CONFLICT (contact_id) DO UPDATE SET
        summary_text = EXCLUDED.summary_text,
        source_memory_ids = EXCLUDED.source_memory_ids,
        confidence_score = EXCLUDED.confidence_score,
        novelty_score = EXCLUDED.novelty_score,
        updated_at = EXCLUDED.updated_at
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertEpisodes(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = prepareEpisodeValues(row, warnings);
    if (!values) {
      const reason = 'required l01_episodes fields are missing or malformed';
      skippedRows.push({ table: 'l01_episodes', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO l01_episodes (
        id, schema_version, title, landmark, status, canonical_episode_id,
        merged_into_episode_id, superseded_by_episode_id, thread_id, channel_id,
        started_at, ended_at, participant_contact_ids, salience_score, salience_json,
        affect_json, themes, artifact_refs, provenance_refs, scope_json,
        consent_flags, embedding, episode_json, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16::jsonb,
        $17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::vector,$23::jsonb,$24,$25
      )
      ON CONFLICT (id) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        title = EXCLUDED.title,
        landmark = EXCLUDED.landmark,
        status = EXCLUDED.status,
        canonical_episode_id = EXCLUDED.canonical_episode_id,
        merged_into_episode_id = EXCLUDED.merged_into_episode_id,
        superseded_by_episode_id = EXCLUDED.superseded_by_episode_id,
        thread_id = EXCLUDED.thread_id,
        channel_id = EXCLUDED.channel_id,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        participant_contact_ids = EXCLUDED.participant_contact_ids,
        salience_score = EXCLUDED.salience_score,
        salience_json = EXCLUDED.salience_json,
        affect_json = EXCLUDED.affect_json,
        themes = EXCLUDED.themes,
        artifact_refs = EXCLUDED.artifact_refs,
        provenance_refs = EXCLUDED.provenance_refs,
        scope_json = EXCLUDED.scope_json,
        consent_flags = EXCLUDED.consent_flags,
        embedding = EXCLUDED.embedding,
        episode_json = EXCLUDED.episode_json,
        updated_at = EXCLUDED.updated_at
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertEpisodeArcs(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const values = prepareEpisodeArcValues(row, warnings);
    if (!values) {
      const reason = 'required l01_episode_arcs fields are missing or malformed';
      skippedRows.push({ table: 'l01_episode_arcs', rowId, reason });
      continue;
    }
    await client.query(`
      INSERT INTO l01_episode_arcs (
        id, schema_version, source_episode_id, target_episode_id, arc_kind, status,
        canonical_arc_id, merged_into_arc_id, superseded_by_arc_id, salience_score,
        confidence, themes, span_refs, artifact_refs, provenance_refs, arc_json,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
        $16::jsonb,$17,$18
      )
      ON CONFLICT (id) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        source_episode_id = EXCLUDED.source_episode_id,
        target_episode_id = EXCLUDED.target_episode_id,
        arc_kind = EXCLUDED.arc_kind,
        status = EXCLUDED.status,
        canonical_arc_id = EXCLUDED.canonical_arc_id,
        merged_into_arc_id = EXCLUDED.merged_into_arc_id,
        superseded_by_arc_id = EXCLUDED.superseded_by_arc_id,
        salience_score = EXCLUDED.salience_score,
        confidence = EXCLUDED.confidence,
        themes = EXCLUDED.themes,
        span_refs = EXCLUDED.span_refs,
        artifact_refs = EXCLUDED.artifact_refs,
        provenance_refs = EXCLUDED.provenance_refs,
        arc_json = EXCLUDED.arc_json,
        updated_at = EXCLUDED.updated_at
    `, values);
    appliedRows += 1;
  }
  return appliedRows;
}

function jsonParamOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function getBooleanOrNull(row: SqliteRow, field: string): boolean | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1') return true;
    if (trimmed === 'false' || trimmed === '0') return false;
  }
  return null;
}

async function upsertContacts(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const displayName = getString(row, 'display_name');
    const firstSeen = getString(row, 'first_seen');
    const lastSeen = getString(row, 'last_seen');
    if (!id || !displayName || !firstSeen || !lastSeen) {
      skippedRows.push({ table: 'contacts', rowId, reason: 'required contacts fields are missing or invalid' });
      continue;
    }
    const baseline = decodeJsonValue(row.emotional_baseline, {}, 'contacts.emotional_baseline');
    addJsonWarning(warnings, 'contacts', rowId, 'emotional_baseline', baseline.warning);
    const timeSeries = decodeJsonValue(row.emotional_time_series, [], 'contacts.emotional_time_series');
    addJsonWarning(warnings, 'contacts', rowId, 'emotional_time_series', timeSeries.warning);
    await client.query(`
      INSERT INTO contacts (
        id, discord_user_id, display_name, nickname, trust_level, relationship_type,
        emotional_baseline, emotional_time_series, first_seen, last_seen, notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        discord_user_id = EXCLUDED.discord_user_id,
        display_name = EXCLUDED.display_name,
        nickname = EXCLUDED.nickname,
        trust_level = EXCLUDED.trust_level,
        relationship_type = EXCLUDED.relationship_type,
        emotional_baseline = EXCLUDED.emotional_baseline,
        emotional_time_series = EXCLUDED.emotional_time_series,
        first_seen = EXCLUDED.first_seen,
        last_seen = EXCLUDED.last_seen,
        notes = EXCLUDED.notes
    `, [
      id,
      getOptionalString(row, 'discord_user_id'),
      displayName,
      getOptionalString(row, 'nickname'),
      getString(row, 'trust_level') ?? 'regular',
      getString(row, 'relationship_type') ?? 'stranger',
      jsonParam(baseline.value),
      jsonParam(timeSeries.value),
      firstSeen,
      lastSeen,
      getOptionalString(row, 'notes'),
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertContactChannelIds(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const contactId = getString(row, 'contact_id');
    const channel = getString(row, 'channel');
    const channelUserId = getString(row, 'channel_user_id');
    const firstSeen = getString(row, 'first_seen');
    const lastSeen = getString(row, 'last_seen');
    if (!contactId || !channel || !channelUserId || !firstSeen || !lastSeen) {
      skippedRows.push({
        table: 'contact_channel_ids',
        rowId: `row:${index}`,
        reason: 'required contact_channel_ids fields are missing or invalid',
      });
      continue;
    }
    await client.query(`
      INSERT INTO contact_channel_ids (
        contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (channel, channel_user_id) DO UPDATE SET
        contact_id = EXCLUDED.contact_id,
        privacy_level = EXCLUDED.privacy_level,
        first_seen = EXCLUDED.first_seen,
        last_seen = EXCLUDED.last_seen
    `, [
      contactId,
      channel,
      channelUserId,
      getString(row, 'privacy_level') ?? 'semi_private',
      firstSeen,
      lastSeen,
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertContactChannelActivity(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const contactId = getString(row, 'contact_id');
    const channel = getString(row, 'channel');
    const channelId = getString(row, 'channel_id');
    const firstSeen = getString(row, 'first_seen');
    const lastSeen = getString(row, 'last_seen');
    if (!contactId || !channel || !channelId || !firstSeen || !lastSeen) {
      skippedRows.push({
        table: 'contact_channel_activity',
        rowId: `row:${index}`,
        reason: 'required contact_channel_activity fields are missing or invalid',
      });
      continue;
    }
    await client.query(`
      INSERT INTO contact_channel_activity (
        contact_id, channel, channel_id, privacy_level, first_seen, last_seen
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (contact_id, channel, channel_id) DO UPDATE SET
        privacy_level = EXCLUDED.privacy_level,
        first_seen = EXCLUDED.first_seen,
        last_seen = EXCLUDED.last_seen
    `, [
      contactId,
      channel,
      channelId,
      getOptionalString(row, 'privacy_level'),
      firstSeen,
      lastSeen,
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertContactIdentityLinkVerifications(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const contactId = getString(row, 'contact_id');
    const sourceChannel = getString(row, 'source_channel');
    const sourceUserId = getString(row, 'source_user_id');
    const targetChannel = getString(row, 'target_channel');
    const targetUserId = getString(row, 'target_user_id');
    const nonce = getString(row, 'nonce');
    const expiresAt = getString(row, 'expires_at');
    const signature = getString(row, 'signature');
    const createdAt = getString(row, 'created_at');
    const updatedAt = getString(row, 'updated_at');
    if (!id || !contactId || !sourceChannel || !sourceUserId || !targetChannel
      || !targetUserId || !nonce || !expiresAt || !signature || !createdAt || !updatedAt) {
      skippedRows.push({
        table: 'contact_identity_link_verifications',
        rowId,
        reason: 'required contact_identity_link_verifications fields are missing or invalid',
      });
      continue;
    }
    await client.query(`
      INSERT INTO contact_identity_link_verifications (
        id, contact_id, source_channel, source_user_id, target_channel, target_user_id,
        nonce, expires_at, signature, status, created_at, updated_at, verified_at, failure_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        verified_at = EXCLUDED.verified_at,
        failure_reason = EXCLUDED.failure_reason
    `, [
      id, contactId, sourceChannel, sourceUserId, targetChannel, targetUserId,
      nonce, expiresAt, signature,
      getString(row, 'status') ?? 'pending',
      createdAt, updatedAt,
      getOptionalString(row, 'verified_at'),
      getOptionalString(row, 'failure_reason'),
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertContactMutationAudit(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const id = getNullableNumber(row, 'id');
    const contactId = getString(row, 'contact_id');
    const actor = getString(row, 'actor');
    const field = getString(row, 'field');
    const timestamp = getString(row, 'timestamp');
    if (id === null || !contactId || !actor || !field || !timestamp) {
      skippedRows.push({
        table: 'contact_mutation_audit',
        rowId: `row:${index}`,
        reason: 'required contact_mutation_audit fields are missing or invalid',
      });
      continue;
    }
    await client.query(`
      INSERT INTO contact_mutation_audit (id, contact_id, actor, field, old_value, new_value, timestamp)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO NOTHING
    `, [
      id, contactId, actor, field,
      getOptionalString(row, 'old_value'),
      getOptionalString(row, 'new_value'),
      timestamp,
    ]);
    appliedRows += 1;
  }
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('contact_mutation_audit', 'id'),
      GREATEST((SELECT COALESCE(MAX(id), 0) FROM contact_mutation_audit), 1)
    )
  `);
  return appliedRows;
}

async function upsertSocialGraphEntities(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const displayName = getString(row, 'display_name');
    const createdAt = getString(row, 'created_at');
    const updatedAt = getString(row, 'updated_at');
    if (!id || !displayName || !createdAt || !updatedAt) {
      skippedRows.push({
        table: 'social_graph_entities',
        rowId,
        reason: 'required social_graph_entities fields are missing or invalid',
      });
      continue;
    }
    const provenance = decodeJsonValue(row.provenance_refs, [], 'social_graph_entities.provenance_refs');
    addJsonWarning(warnings, 'social_graph_entities', rowId, 'provenance_refs', provenance.warning);
    await client.query(`
      INSERT INTO social_graph_entities (
        id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
        confidence, source, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET
        entity_kind = EXCLUDED.entity_kind,
        display_name = EXCLUDED.display_name,
        contact_id = EXCLUDED.contact_id,
        sensitivity = EXCLUDED.sensitivity,
        provenance_refs = EXCLUDED.provenance_refs,
        confidence = EXCLUDED.confidence,
        source = EXCLUDED.source,
        updated_at = EXCLUDED.updated_at
    `, [
      id,
      getString(row, 'entity_kind') ?? 'person',
      displayName,
      getOptionalString(row, 'contact_id'),
      getString(row, 'sensitivity') ?? 'personal',
      jsonParam(provenance.value),
      getNumber(row, 'confidence', 1),
      getString(row, 'source') ?? 'contact',
      createdAt,
      updatedAt,
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertSocialRelationshipEdges(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const sourceEntityId = getString(row, 'source_entity_id');
    const targetEntityId = getString(row, 'target_entity_id');
    const relationshipType = getString(row, 'relationship_type');
    const createdAt = getString(row, 'created_at');
    const updatedAt = getString(row, 'updated_at');
    if (!id || !sourceEntityId || !targetEntityId || !relationshipType || !createdAt || !updatedAt) {
      skippedRows.push({
        table: 'social_relationship_edges',
        rowId,
        reason: 'required social_relationship_edges fields are missing or invalid',
      });
      continue;
    }
    const provenance = decodeJsonValue(row.provenance_refs, [], 'social_relationship_edges.provenance_refs');
    addJsonWarning(warnings, 'social_relationship_edges', rowId, 'provenance_refs', provenance.warning);
    const evidence = decodeJsonValue(row.evidence_memory_ids, [], 'social_relationship_edges.evidence_memory_ids');
    addJsonWarning(warnings, 'social_relationship_edges', rowId, 'evidence_memory_ids', evidence.warning);
    await client.query(`
      INSERT INTO social_relationship_edges (
        id, source_entity_id, target_entity_id, relationship_type, directional,
        sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        source_entity_id = EXCLUDED.source_entity_id,
        target_entity_id = EXCLUDED.target_entity_id,
        relationship_type = EXCLUDED.relationship_type,
        directional = EXCLUDED.directional,
        sensitivity = EXCLUDED.sensitivity,
        provenance_refs = EXCLUDED.provenance_refs,
        evidence_memory_ids = EXCLUDED.evidence_memory_ids,
        confidence = EXCLUDED.confidence,
        updated_at = EXCLUDED.updated_at
    `, [
      id, sourceEntityId, targetEntityId, relationshipType,
      getBooleanOrNull(row, 'directional') ?? true,
      getString(row, 'sensitivity') ?? 'personal',
      jsonParam(provenance.value),
      jsonParam(evidence.value),
      getNumber(row, 'confidence', 0.7),
      createdAt, updatedAt,
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertActiveConcerns(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const text = getString(row, 'text');
    const priority = getString(row, 'priority');
    const source = getString(row, 'source');
    const createdAt = getString(row, 'created_at');
    const expiresAt = getString(row, 'expires_at');
    if (!id || !text || !priority || !source || !createdAt || !expiresAt) {
      skippedRows.push({ table: 'active_concerns', rowId, reason: 'required active_concerns fields are missing or invalid' });
      continue;
    }
    const formationVad = decodeJsonValue(row.formation_vad, null, 'active_concerns.formation_vad');
    const evidenceRefs = decodeJsonValue(row.evidence_refs, [], 'active_concerns.evidence_refs');
    const resolutionEvidenceRefs = decodeJsonValue(
      row.resolution_evidence_refs,
      [],
      'active_concerns.resolution_evidence_refs',
    );
    const mergedFromIds = decodeJsonValue(row.merged_from_ids, [], 'active_concerns.merged_from_ids');
    addJsonWarning(warnings, 'active_concerns', rowId, 'formation_vad', formationVad.warning);
    addJsonWarning(warnings, 'active_concerns', rowId, 'evidence_refs', evidenceRefs.warning);
    addJsonWarning(
      warnings,
      'active_concerns',
      rowId,
      'resolution_evidence_refs',
      resolutionEvidenceRefs.warning,
    );
    addJsonWarning(warnings, 'active_concerns', rowId, 'merged_from_ids', mergedFromIds.warning);
    await client.query(`
      INSERT INTO active_concerns (
        id, text, priority, source, status, created_at, expires_at,
        salience, sensitivity, owner, evidence_refs, resolution_evidence_refs,
        resolved_at, resolution_outcome, contact_id, formation_vad,
        last_reviewed_at, next_review_at, merged_from_ids, split_from_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16::jsonb,$17,$18,$19::jsonb,$20)
      ON CONFLICT (id) DO UPDATE SET
        text = EXCLUDED.text,
        priority = EXCLUDED.priority,
        source = EXCLUDED.source,
        status = EXCLUDED.status,
        expires_at = EXCLUDED.expires_at,
        salience = EXCLUDED.salience,
        sensitivity = EXCLUDED.sensitivity,
        owner = EXCLUDED.owner,
        evidence_refs = EXCLUDED.evidence_refs,
        resolution_evidence_refs = EXCLUDED.resolution_evidence_refs,
        resolved_at = EXCLUDED.resolved_at,
        resolution_outcome = EXCLUDED.resolution_outcome,
        contact_id = EXCLUDED.contact_id,
        formation_vad = EXCLUDED.formation_vad,
        last_reviewed_at = EXCLUDED.last_reviewed_at,
        next_review_at = EXCLUDED.next_review_at,
        merged_from_ids = EXCLUDED.merged_from_ids,
        split_from_id = EXCLUDED.split_from_id
    `, [
      id, text, priority, source,
      getString(row, 'status') ?? (getOptionalString(row, 'resolved_at') ? 'resolved' : 'active'),
      createdAt, expiresAt,
      getNumber(row, 'salience', 0.5),
      getString(row, 'sensitivity') ?? 'personal',
      getString(row, 'owner') ?? 'companion',
      jsonParamOrNull(evidenceRefs.value),
      jsonParamOrNull(resolutionEvidenceRefs.value),
      getOptionalString(row, 'resolved_at'),
      getOptionalString(row, 'resolution_outcome'),
      getOptionalString(row, 'contact_id'),
      jsonParamOrNull(formationVad.value),
      getOptionalString(row, 'last_reviewed_at') ?? createdAt,
      getOptionalString(row, 'next_review_at'),
      jsonParamOrNull(mergedFromIds.value),
      getOptionalString(row, 'split_from_id'),
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertIntentionPendingFollowUps(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const content = getString(row, 'content');
    const priority = getString(row, 'priority');
    const timing = getString(row, 'timing');
    const createdAt = getString(row, 'created_at');
    const channelId = getString(row, 'channel_id');
    const channelType = getString(row, 'channel_type');
    const authorId = getString(row, 'author_id');
    const authorName = getString(row, 'author_name');
    if (!id || !content || !priority || !timing || !createdAt || !channelId || !channelType || !authorId || !authorName) {
      skippedRows.push({
        table: 'intention_pending_follow_ups',
        rowId,
        reason: 'required intention_pending_follow_ups fields are missing or invalid',
      });
      continue;
    }
    await client.query(`
      INSERT INTO intention_pending_follow_ups (
        id, content, priority, timing, created_at, channel_id, channel_type,
        author_id, author_name, due_at, contact_id, source_message_id,
        context_summary, wake_conditions, activated_at, activation_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        priority = EXCLUDED.priority,
        timing = EXCLUDED.timing,
        due_at = EXCLUDED.due_at,
        contact_id = EXCLUDED.contact_id,
        source_message_id = EXCLUDED.source_message_id,
        context_summary = EXCLUDED.context_summary,
        wake_conditions = EXCLUDED.wake_conditions,
        activated_at = EXCLUDED.activated_at,
        activation_reason = EXCLUDED.activation_reason
    `, [
      id, content, priority, timing, createdAt, channelId, channelType, authorId, authorName,
      getOptionalString(row, 'due_at'),
      getOptionalString(row, 'contact_id'),
      getOptionalString(row, 'source_message_id'),
      getOptionalString(row, 'context_summary'),
      getOptionalString(row, 'wake_conditions'),
      getOptionalString(row, 'activated_at'),
      getOptionalString(row, 'activation_reason'),
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertIntentionFollowUpQuarantine(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const reason = getString(row, 'reason');
    const rawEntry = getOptionalString(row, 'raw_entry');
    const quarantinedAt = getString(row, 'quarantined_at');
    if (!id || !reason || rawEntry === null || !quarantinedAt) {
      skippedRows.push({
        table: 'intention_pending_follow_up_quarantine',
        rowId,
        reason: 'required intention_pending_follow_up_quarantine fields are missing or invalid',
      });
      continue;
    }
    await client.query(`
      INSERT INTO intention_pending_follow_up_quarantine (
        id, follow_up_id, reason, source, raw_entry, quarantined_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO NOTHING
    `, [
      id,
      getOptionalString(row, 'follow_up_id'),
      reason,
      getOptionalString(row, 'source'),
      rawEntry,
      quarantinedAt,
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertBehavioralPatternEvents(
  client: PoolClient,
  rows: readonly SqliteRow[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const contactId = getString(row, 'contact_id');
    const sourceMessageId = getString(row, 'source_message_id');
    const strategy = getString(row, 'strategy');
    const responseExcerpt = getOptionalString(row, 'response_excerpt');
    const createdAt = getString(row, 'created_at');
    if (!id || !contactId || !sourceMessageId || !strategy || responseExcerpt === null || !createdAt) {
      skippedRows.push({
        table: 'behavioral_pattern_events',
        rowId,
        reason: 'required behavioral_pattern_events fields are missing or invalid',
      });
      continue;
    }
    await client.query(`
      INSERT INTO behavioral_pattern_events (
        id, contact_id, source_message_id, strategy, response_excerpt, created_at,
        outcome_score, outcome_observed_at, outcome_source_message_id, promoted_at, promoted_memory_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        outcome_score = EXCLUDED.outcome_score,
        outcome_observed_at = EXCLUDED.outcome_observed_at,
        outcome_source_message_id = EXCLUDED.outcome_source_message_id,
        promoted_at = EXCLUDED.promoted_at,
        promoted_memory_id = EXCLUDED.promoted_memory_id
    `, [
      id, contactId, sourceMessageId, strategy, responseExcerpt, createdAt,
      getNullableNumber(row, 'outcome_score'),
      getOptionalString(row, 'outcome_observed_at'),
      getOptionalString(row, 'outcome_source_message_id'),
      getOptionalString(row, 'promoted_at'),
      getOptionalString(row, 'promoted_memory_id'),
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function upsertReflections(
  client: PoolClient,
  rows: readonly SqliteRow[],
  warnings: SqliteToPostgresMemoryMigrationWarning[],
  skippedRows: SqliteToPostgresMemoryMigrationSkippedRow[],
): Promise<number> {
  let appliedRows = 0;
  for (const [index, row] of rows.entries()) {
    const rowId = rowIdentifier(row, `row:${index}`);
    const id = getString(row, 'id');
    const kind = getString(row, 'kind');
    const occurredAt = getString(row, 'occurred_at');
    const initiatorSurface = getString(row, 'initiator_surface');
    const initiatedBy = getString(row, 'initiated_by');
    const mirroredAt = getString(row, 'mirrored_at');
    if (!id || !kind || !occurredAt || !initiatorSurface || !initiatedBy || !mirroredAt) {
      skippedRows.push({ table: 'reflections', rowId, reason: 'required reflections fields are missing or invalid' });
      continue;
    }
    const payload = decodeJsonValue(row.payload_json, null, 'reflections.payload_json');
    addJsonWarning(warnings, 'reflections', rowId, 'payload_json', payload.warning);
    if (payload.value === null) {
      skippedRows.push({ table: 'reflections', rowId, reason: 'reflections.payload_json is missing or malformed' });
      continue;
    }
    const metacognitiveFlags = decodeJsonValue(row.metacognitive_flags_json, [], 'reflections.metacognitive_flags_json');
    addJsonWarning(warnings, 'reflections', rowId, 'metacognitive_flags_json', metacognitiveFlags.warning);
    const mutationBefore = decodeJsonValue(row.mutation_before_json, null, 'reflections.mutation_before_json');
    addJsonWarning(warnings, 'reflections', rowId, 'mutation_before_json', mutationBefore.warning);
    const mutationAfter = decodeJsonValue(row.mutation_after_json, null, 'reflections.mutation_after_json');
    addJsonWarning(warnings, 'reflections', rowId, 'mutation_after_json', mutationAfter.warning);
    const deliberation = decodeJsonValue(row.deliberation_json, null, 'reflections.deliberation_json');
    addJsonWarning(warnings, 'reflections', rowId, 'deliberation_json', deliberation.warning);
    const provenanceRefs = decodeJsonValue(
      row.substrate_provenance_refs_json,
      [],
      'reflections.substrate_provenance_refs_json',
    );
    addJsonWarning(warnings, 'reflections', rowId, 'substrate_provenance_refs_json', provenanceRefs.warning);
    await client.query(`
      INSERT INTO reflections (
        id, kind, occurred_at, template_id, template_name, execution_source,
        initiator_surface, initiated_by, reason, channel_id, send_to_discord_effective,
        mode, internal_state_snapshot_ref, metacognitive_flags, reflection_journal_entry_id,
        daily_journal_entry_id, process_id, mutation_before, mutation_after, prompt,
        reflection, deliberation, substrate_boundary, substrate_provenance_refs,
        payload, mirrored_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,
        $18::jsonb,$19::jsonb,$20,$21,$22::jsonb,$23,$24::jsonb,$25::jsonb,$26
      )
      ON CONFLICT (id) DO NOTHING
    `, [
      id, kind, occurredAt,
      getOptionalString(row, 'template_id'),
      getOptionalString(row, 'template_name'),
      getOptionalString(row, 'execution_source'),
      initiatorSurface, initiatedBy,
      getOptionalString(row, 'reason'),
      getOptionalString(row, 'channel_id'),
      getBooleanOrNull(row, 'send_to_discord_effective'),
      getOptionalString(row, 'mode'),
      getOptionalString(row, 'internal_state_snapshot_ref'),
      jsonParam(metacognitiveFlags.value),
      getOptionalString(row, 'reflection_journal_entry_id'),
      getOptionalString(row, 'daily_journal_entry_id'),
      getOptionalString(row, 'process_id'),
      jsonParamOrNull(mutationBefore.value),
      jsonParamOrNull(mutationAfter.value),
      getOptionalString(row, 'prompt'),
      getOptionalString(row, 'reflection'),
      jsonParamOrNull(deliberation.value),
      getOptionalString(row, 'substrate_boundary'),
      jsonParam(provenanceRefs.value),
      jsonParam(payload.value),
      mirroredAt,
    ]);
    appliedRows += 1;
  }
  return appliedRows;
}

async function applyMigration(
  data: LoadedSqliteData,
  postgresUrl: string,
  dependencies: SqliteToPostgresMemoryMigrationDependencies | undefined,
): Promise<void> {
  const createPool = dependencies?.createPostgresPool
    ?? ((url: string): PostgresPoolLike => createPostgresPool(url, {
      applicationName: 'psfn-sqlite-memory-migration',
      allowExitOnIdle: true,
      max: 1,
    }));
  const ensureSchema = dependencies?.ensurePostgresSchema
    ?? (async (pool: PostgresPoolLike, statements: readonly string[]): Promise<void> => {
      await ensurePostgresSchema(pool as Pool, statements);
    });
  const transaction = dependencies?.withPostgresClient
    ?? (async <T>(pool: PostgresPoolLike, handler: (client: PoolClient) => Promise<T>): Promise<T> => (
      await withPostgresClient(pool as Pool, handler)
    ));

  const pool = createPool(postgresUrl);
  try {
    await ensureSchema(pool, [
      ...POSTGRES_MEMORY_MIGRATIONS,
      ...POSTGRES_CONTACT_MIGRATIONS,
      ...POSTGRES_INTENTION_MIGRATIONS,
      ...POSTGRES_REFLECTION_MIGRATIONS,
    ]);
    await validatePostgresTarget(pool);
    await transaction(pool, async (client) => {
      data.tables.l2_memories.appliedRows = await upsertMemories(
        client,
        data.rows.l2_memories,
        data.embeddingsByMemoryId,
        data.warnings,
        data.skippedRows,
      );
      const presentMemoryIdRows = await client.query<{ id: string } & QueryResultRow>(
        'SELECT id FROM l2_memories',
      );
      const migratedMemoryIds = new Set(presentMemoryIdRows.rows.map(row => row.id));
      data.tables.l2_memory_delete_versions.appliedRows = await upsertDeleteVersions(
        client,
        data.rows.l2_memory_delete_versions,
        migratedMemoryIds,
        data.warnings,
        data.skippedRows,
      );
      data.tables.l2_memory_abstraction_links.appliedRows = await upsertAbstractionLinks(
        client,
        data.rows.l2_memory_abstraction_links,
        data.skippedRows,
      );
      data.tables.l2_memory_patch_events.appliedRows = await upsertPatchEvents(
        client,
        data.rows.l2_memory_patch_events,
        data.warnings,
        data.skippedRows,
      );
      data.tables.l2_memory_maintenance_reviews.appliedRows = await upsertMaintenanceReviews(
        client,
        data.rows.l2_memory_maintenance_reviews,
        data.warnings,
        data.skippedRows,
      );
      data.tables.memory_links.appliedRows = await upsertMemoryLinks(
        client,
        data.rows.memory_links,
        data.skippedRows,
      );
      data.tables.contact_profiles.appliedRows = await upsertContactProfiles(
        client,
        data.rows.contact_profiles,
        data.warnings,
        data.skippedRows,
      );
      data.tables.scratchpad_entries.appliedRows = await upsertScratchpadEntries(
        client,
        data.rows.scratchpad_entries,
        data.skippedRows,
      );
      data.tables.l01_episodes.appliedRows = await upsertEpisodes(
        client,
        data.rows.l01_episodes,
        data.warnings,
        data.skippedRows,
      );
      data.tables.l01_episode_arcs.appliedRows = await upsertEpisodeArcs(
        client,
        data.rows.l01_episode_arcs,
        data.warnings,
        data.skippedRows,
      );
      data.tables.contacts.appliedRows = await upsertContacts(
        client,
        data.rows.contacts,
        data.warnings,
        data.skippedRows,
      );
      data.tables.contact_channel_ids.appliedRows = await upsertContactChannelIds(
        client,
        data.rows.contact_channel_ids,
        data.skippedRows,
      );
      data.tables.contact_channel_activity.appliedRows = await upsertContactChannelActivity(
        client,
        data.rows.contact_channel_activity,
        data.skippedRows,
      );
      data.tables.contact_identity_link_verifications.appliedRows = await upsertContactIdentityLinkVerifications(
        client,
        data.rows.contact_identity_link_verifications,
        data.skippedRows,
      );
      data.tables.contact_mutation_audit.appliedRows = await upsertContactMutationAudit(
        client,
        data.rows.contact_mutation_audit,
        data.skippedRows,
      );
      data.tables.social_graph_entities.appliedRows = await upsertSocialGraphEntities(
        client,
        data.rows.social_graph_entities,
        data.warnings,
        data.skippedRows,
      );
      data.tables.social_relationship_edges.appliedRows = await upsertSocialRelationshipEdges(
        client,
        data.rows.social_relationship_edges,
        data.warnings,
        data.skippedRows,
      );
      data.tables.active_concerns.appliedRows = await upsertActiveConcerns(
        client,
        data.rows.active_concerns,
        data.warnings,
        data.skippedRows,
      );
      data.tables.intention_pending_follow_ups.appliedRows = await upsertIntentionPendingFollowUps(
        client,
        data.rows.intention_pending_follow_ups,
        data.skippedRows,
      );
      data.tables.intention_pending_follow_up_quarantine.appliedRows = await upsertIntentionFollowUpQuarantine(
        client,
        data.rows.intention_pending_follow_up_quarantine,
        data.skippedRows,
      );
      data.tables.behavioral_pattern_events.appliedRows = await upsertBehavioralPatternEvents(
        client,
        data.rows.behavioral_pattern_events,
        data.skippedRows,
      );
      data.tables.reflections.appliedRows = await upsertReflections(
        client,
        data.rows.reflections,
        data.warnings,
        data.skippedRows,
      );
    });
  } finally {
    await pool.end?.();
  }
}

export async function runSqliteToPostgresMemoryMigration(
  options: SqliteToPostgresMemoryMigrationOptions,
): Promise<SqliteToPostgresMemoryMigrationReport> {
  const sqlitePath = normalizeSqlitePath(options.sqlitePath);
  const postgresUrl = normalizePostgresUrl(options.postgresUrl);
  const embeddingDims = normalizeEmbeddingDims(options.embeddingDims);
  const mode: MigrationMode = options.dryRun ? 'dry-run' : 'apply';
  const data = loadSqliteData(sqlitePath, embeddingDims);

  const report: SqliteToPostgresMemoryMigrationReport = {
    status: 'ok',
    mode,
    sqlitePath,
    postgresUrl,
    embeddingDims,
    tables: data.tables,
    embeddings: data.embeddingReport,
    warnings: data.warnings,
    skippedRows: data.skippedRows,
    repairSuggestions: [],
  };

  if (mode === 'apply') {
    await applyMigration(data, postgresUrl, options.dependencies);
  }

  if (report.embeddings.invalidCount > 0) {
    report.repairSuggestions.push(
      'Re-embed skipped memory embeddings with the configured embedding model after migration.',
    );
  }

  return report;
}

interface ParsedCliOptions {
  sqlitePath?: string;
  postgresUrl?: string;
  dryRun: boolean;
  embeddingDims?: number;
  jsonReport: boolean;
}

function parseCliArgs(argv: readonly string[]): ParsedCliOptions {
  const parsed: ParsedCliOptions = {
    dryRun: false,
    jsonReport: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--json-report') {
      parsed.jsonReport = true;
    } else if (arg === '--sqlite-path') {
      index += 1;
      parsed.sqlitePath = argv[index];
    } else if (arg === '--postgres-url') {
      index += 1;
      parsed.postgresUrl = argv[index];
    } else if (arg === '--embedding-dims') {
      index += 1;
      parsed.embeddingDims = Number(argv[index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function renderTextReport(report: SqliteToPostgresMemoryMigrationReport): string {
  const tableLines = MIGRATION_TABLES
    .filter(table => report.tables[table].present)
    .map((table) => {
      const tableReport = report.tables[table];
      return `${table}: rows=${tableReport.rowCount} applied=${tableReport.appliedRows} checksum=${tableReport.checksum}`;
    });
  return [
    `status=${report.status}`,
    `mode=${report.mode}`,
    `sqlitePath=${report.sqlitePath}`,
    `embeddingDims=${report.embeddingDims}`,
    `embeddingRows=${report.embeddings.rowCount}`,
    `embeddingValid=${report.embeddings.validCount}`,
    `embeddingInvalid=${report.embeddings.invalidCount}`,
    ...tableLines,
    `warnings=${report.warnings.length}`,
    `skippedRows=${report.skippedRows.length}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const report = await runSqliteToPostgresMemoryMigration({
    sqlitePath: parsed.sqlitePath ?? '',
    postgresUrl: parsed.postgresUrl ?? '',
    dryRun: parsed.dryRun,
    embeddingDims: parsed.embeddingDims ?? Number.NaN,
    jsonReport: parsed.jsonReport,
  });
  const output = parsed.jsonReport
    ? JSON.stringify(report, null, 2)
    : renderTextReport(report);
  process.stdout.write(`${output}\n`);
}

if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
