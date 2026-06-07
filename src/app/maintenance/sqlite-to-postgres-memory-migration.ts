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
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';

const MIGRATION_TABLES = [
  'l2_memories',
  'l2_memory_embeddings',
  'l2_memory_delete_versions',
  'l2_memory_patch_events',
  'l2_memory_maintenance_reviews',
  'memory_links',
  'scratchpad_entries',
  'l01_episodes',
  'l01_episode_arcs',
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
  table?: MigrationTableName;
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
  l2_memory_patch_events: ['id'],
  l2_memory_maintenance_reviews: ['id'],
  memory_links: ['id1', 'id2'],
  scratchpad_entries: ['id'],
  l01_episodes: ['id'],
  l01_episode_arcs: ['id'],
};

const APPLY_UNSUPPORTED_TABLES: readonly MigrationTableName[] = [
  'l2_memory_delete_versions',
  'l2_memory_patch_events',
  'l2_memory_maintenance_reviews',
  'memory_links',
];

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

function tableExists(db: Database.Database, tableName: MigrationTableName): boolean {
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

function addUnsupportedTableWarnings(report: SqliteToPostgresMemoryMigrationReport): void {
  for (const table of APPLY_UNSUPPORTED_TABLES) {
    const tableReport = report.tables[table];
    if (!tableReport.present || tableReport.rowCount === 0) continue;
    report.warnings.push({
      table,
      code: 'unsupported_apply_table',
      message: `${table} was read and checksummed but is not applied by this first migration deliverable`,
    });
    report.repairSuggestions.push(
      `Add ${table} upsert support before relying on this migration for full cutover state.`,
    );
  }
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
    await ensureSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    await validatePostgresTarget(pool);
    await transaction(pool, async (client) => {
      data.tables.l2_memories.appliedRows = await upsertMemories(
        client,
        data.rows.l2_memories,
        data.embeddingsByMemoryId,
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

  addUnsupportedTableWarnings(report);

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
