import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runSqliteToPostgresMemoryMigration,
} from './sqlite-to-postgres-memory-migration.js';

interface QueryRecord {
  text: string;
  values: readonly unknown[];
}

function queryResult<Row extends QueryResultRow>(rows: Row[] = []): QueryResult<Row> {
  return {
    rows,
    command: rows.length > 0 ? 'SELECT' : 'OK',
    rowCount: rows.length,
    oid: 0,
    fields: [],
  };
}

class FakeMigrationPool {
  readonly queries: QueryRecord[] = [];
  readonly memoryRows = new Map<string, readonly unknown[]>();
  readonly deleteVersionRows = new Map<string, readonly unknown[]>();
  readonly abstractionLinkRows = new Map<string, readonly unknown[]>();
  readonly patchEventRows = new Map<string, readonly unknown[]>();
  readonly maintenanceReviewRows = new Map<string, readonly unknown[]>();
  readonly memoryLinkRows = new Map<string, readonly unknown[]>();
  readonly genericRows = new Map<string, Map<string, readonly unknown[]>>();
  readonly contactProfileRows = new Map<string, readonly unknown[]>();
  readonly scratchpadRows = new Map<string, readonly unknown[]>();
  readonly episodeRows = new Map<string, readonly unknown[]>();
  readonly arcRows = new Map<string, readonly unknown[]>();
  released = 0;
  ended = false;

  async connect(): Promise<PoolClient> {
    return {
      query: async (text: string, values?: readonly unknown[]) => await this.query(text, values),
      release: () => {
        this.released += 1;
      },
    } as PoolClient;
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return queryResult<Row>();
    }
    if (normalized.includes('from information_schema.tables')) {
      return queryResult<Row>();
    }
    if (normalized.includes('from information_schema.columns')) {
      return queryResult([
        {
          column_name: 'embedding',
          data_type: 'USER-DEFINED',
          udt_name: 'vector',
        } as Row,
      ]);
    }
    if (normalized.startsWith('insert into l2_memories')) {
      this.memoryRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into l2_memory_delete_versions')) {
      this.deleteVersionRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into l2_memory_abstraction_links')) {
      this.abstractionLinkRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into l2_memory_patch_events')) {
      this.patchEventRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into l2_memory_maintenance_reviews')) {
      this.maintenanceReviewRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into memory_links')) {
      this.memoryLinkRows.set(`${String(values[0])}::${String(values[1])}`, values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into contact_profiles')) {
      this.contactProfileRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into scratchpad_entries')) {
      this.scratchpadRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into l01_episodes')) {
      this.episodeRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into l01_episode_arcs')) {
      this.arcRows.set(String(values[0]), values);
      return queryResult<Row>();
    }
    if (normalized.startsWith('insert into ')) {
      const tableName = normalized.slice('insert into '.length).split(/[\s(]/, 1)[0];
      const tableRows = this.genericRows.get(tableName) ?? new Map<string, readonly unknown[]>();
      tableRows.set(String(values[0]), values);
      this.genericRows.set(tableName, tableRows);
      return queryResult<Row>();
    }
    if (normalized.startsWith('select setval(')) {
      return queryResult<Row>();
    }
    if (normalized.startsWith('select id from l2_memories')) {
      return {
        rows: [...this.memoryRows.keys()].map(id => ({ id })) as unknown as Row[],
        rowCount: this.memoryRows.size,
      } as QueryResult<Row>;
    }
    throw new Error(`Unhandled fake Postgres SQL: ${text}`);
  }
}

function float32Blob(values: readonly number[]): Buffer {
  const array = new Float32Array(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function createFixtureSqliteDatabase(root: string): string {
  const sqlitePath = join(root, 'legacy-memory.sqlite');
  const db = new Database(sqlitePath);
  const now = '2026-01-02T03:04:05.000Z';
  const episode = {
    schemaVersion: 1,
    id: 'episode-1',
    title: 'Migration fixture episode',
    landmark: 'The fixture preserves an episode',
    startedAt: now,
    endedAt: now,
    threadId: 'thread-1',
    channelId: 'api:test',
    participantContactIds: ['contact-1'],
    salience: { score: 0.8 },
    affect: { labels: ['focused'] },
    themes: ['migration'],
    spanRefs: [{ spanId: 'span-1' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
    createdAt: now,
    updatedAt: now,
  };
  const episode2 = {
    ...episode,
    id: 'episode-2',
    title: 'Migration fixture follow-up episode',
    landmark: 'The fixture preserves the arc target',
  };
  const arc = {
    schemaVersion: 1,
    id: 'arc-1',
    sourceEpisodeId: 'episode-1',
    targetEpisodeId: 'episode-2',
    arcKind: 'continuation',
    salience: 0.4,
    confidence: 0.9,
    themes: ['migration'],
    spanRefs: [{ spanId: 'span-1' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
    createdAt: now,
    updatedAt: now,
  };

  db.exec(`
    CREATE TABLE l2_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      type TEXT NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      emotional_valence REAL NOT NULL,
      formation_vad TEXT,
      salience REAL NOT NULL,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      extracted_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      access_count INTEGER NOT NULL,
      superseded_by TEXT,
      tags TEXT NOT NULL,
      scope_ref_kind TEXT,
      scope_ref_id TEXT,
      scope_ref_label TEXT,
      scope_tags TEXT NOT NULL,
      provenance_refs TEXT NOT NULL,
      retention_class TEXT,
      sensitivity TEXT NOT NULL,
      consent_flags TEXT NOT NULL,
      contact_id TEXT,
      deleted_at INTEGER,
      deleted_by TEXT,
      delete_reason TEXT
    );
    CREATE TABLE l2_memory_embeddings (
      memory_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL
    );
    CREATE TABLE l2_memory_delete_versions (
      delete_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      deleted_by TEXT,
      delete_reason TEXT,
      restored_at INTEGER,
      restored_by TEXT
    );
    CREATE TABLE l2_memory_abstraction_links (
      id TEXT PRIMARY KEY,
      source_memory_id TEXT NOT NULL,
      abstracted_memory_id TEXT NOT NULL,
      external_ref TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      reason TEXT
    );
    CREATE TABLE l2_memory_patch_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      reason TEXT,
      patch_json TEXT NOT NULL,
      previous_json TEXT NOT NULL,
      next_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE l2_memory_maintenance_reviews (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      subject_memory_id TEXT NOT NULL,
      candidate_memory_ids TEXT NOT NULL,
      state_json TEXT NOT NULL,
      quarantine_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE memory_links (
      id1 TEXT NOT NULL,
      id2 TEXT NOT NULL,
      link_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (id1, id2)
    );
    CREATE TABLE contact_profiles (
      contact_id TEXT PRIMARY KEY,
      summary_text TEXT NOT NULL,
      source_memory_ids TEXT NOT NULL,
      confidence_score REAL NOT NULL,
      novelty_score REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE gateway_audit (
      id INTEGER PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      method TEXT NOT NULL,
      decision TEXT NOT NULL
    );
    CREATE TABLE scratchpad_entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE l01_episodes (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      channel_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      salience_score REAL NOT NULL,
      episode_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE l01_episode_arcs (
      id TEXT PRIMARY KEY,
      source_episode_id TEXT NOT NULL,
      target_episode_id TEXT NOT NULL,
      arc_kind TEXT NOT NULL,
      salience_score REAL NOT NULL,
      confidence REAL NOT NULL,
      arc_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO l2_memories (
      id, text, type, importance, confidence, emotional_valence, formation_vad,
      salience, source_ref, source_type, provenance_json, extracted_at, last_accessed,
      access_count, superseded_by, tags, scope_ref_kind, scope_ref_id, scope_ref_label,
      scope_tags, provenance_refs, retention_class, sensitivity, consent_flags, contact_id,
      deleted_at, deleted_by, delete_reason
    )
    VALUES (
      'memory-1', 'Fixture memory', 'episodic', 0.9, 0.8, 0.2, '{"valence":0.2,"arousal":0.5,"dominance":0.6}',
      0.7, 'session:test', 'session', '{"source":"fixture"}', 100, 200, 3, NULL, '["fixture"]',
      'channel', 'api:test', 'API test', '["scope"]', '[{"kind":"turn","refId":"turn-1"}]',
      'durable', 'personal', '{"share":false}', 'contact-1', NULL, NULL, NULL
    )
  `).run();
  db.prepare(`
    INSERT INTO l2_memories (
      id, text, type, importance, confidence, emotional_valence, formation_vad,
      salience, source_ref, source_type, provenance_json, extracted_at, last_accessed,
      access_count, superseded_by, tags, scope_ref_kind, scope_ref_id, scope_ref_label,
      scope_tags, provenance_refs, retention_class, sensitivity, consent_flags, contact_id,
      deleted_at, deleted_by, delete_reason
    )
    VALUES (
      'memory-2', 'Fixture abstraction memory', 'semantic', 0.4, 0.9, 0.1, NULL,
      0.5, 'session:test', 'session', '{}', 101, 201, 1, NULL, '["fixture"]',
      NULL, NULL, NULL, '[]', '[]', NULL, 'personal', '{}', 'contact-1',
      NULL, NULL, NULL
    )
  `).run();
  db.prepare('INSERT INTO l2_memory_embeddings (memory_id, embedding) VALUES (?, ?)')
    .run('memory-1', float32Blob([0.25, 0.5, 0.75]));
  db.prepare('INSERT INTO l2_memory_embeddings (memory_id, embedding) VALUES (?, ?)')
    .run('memory-bad-dim', float32Blob([0.1, 0.2]));
  db.prepare(`
    INSERT INTO l2_memory_delete_versions (
      delete_id, memory_id, snapshot_json, deleted_at, deleted_by, delete_reason, restored_at, restored_by
    )
    VALUES ('delete-1', 'memory-1', '{"id":"memory-1"}', 300, 'operator', 'fixture', NULL, NULL)
  `).run();
  db.prepare(`
    INSERT INTO l2_memory_abstraction_links (
      id, source_memory_id, abstracted_memory_id, external_ref, created_at, created_by, reason
    )
    VALUES ('abstract-1', 'memory-1', 'memory-2', 'fixture:abstract-1', 310, 'operator', 'fixture abstraction')
  `).run();
  db.prepare(`
    INSERT INTO l2_memory_patch_events (
      id, memory_id, source_ref, source_type, provenance_json, reason,
      patch_json, previous_json, next_json, created_at
    )
    VALUES (
      'patch-1', 'memory-1', 'session:test', 'maintenance', '{"actor":"fixture"}',
      'fixture patch', '{"salience":0.7}', '{"salience":0.6}', '{"salience":0.7}', 320
    )
  `).run();
  db.prepare(`
    INSERT INTO l2_memory_maintenance_reviews (
      id, kind, status, subject_memory_id, candidate_memory_ids, state_json,
      quarantine_reason, created_at, updated_at
    )
    VALUES (
      'review-1', 'dedupe', 'pending', 'memory-1', '["memory-2"]',
      '{"decision":"review"}', NULL, 330, 340
    )
  `).run();
  db.prepare(`
    INSERT INTO memory_links (id1, id2, link_type, created_at)
    VALUES ('memory-1', 'memory-2', 'related', 350)
  `).run();
  db.prepare(`
    INSERT INTO contact_profiles (
      contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
    )
    VALUES ('contact-1', 'Contact fixture summary', '["memory-1"]', 0.8, 0.2, 360)
  `).run();
  db.prepare(`
    INSERT INTO gateway_audit (id, timestamp, method, decision)
    VALUES (1, 370, 'fs.read', 'allow')
  `).run();
  db.prepare(`
    INSERT INTO scratchpad_entries (id, content, created_at, updated_at)
    VALUES ('scratch-1', 'Scratch fixture', 400, 500)
  `).run();
  db.prepare(`
    INSERT INTO l01_episodes (
      id, thread_id, channel_id, started_at, ended_at, salience_score,
      episode_json, created_at, updated_at
    )
    VALUES ('episode-1', 'thread-1', 'api:test', ?, ?, 0.8, ?, ?, ?)
  `).run(now, now, JSON.stringify(episode), now, now);
  db.prepare(`
    INSERT INTO l01_episodes (
      id, thread_id, channel_id, started_at, ended_at, salience_score,
      episode_json, created_at, updated_at
    )
    VALUES ('episode-2', 'thread-1', 'api:test', ?, ?, 0.6, ?, ?, ?)
  `).run(now, now, JSON.stringify(episode2), now, now);
  db.prepare(`
    INSERT INTO l01_episode_arcs (
      id, source_episode_id, target_episode_id, arc_kind, salience_score,
      confidence, arc_json, created_at, updated_at
    )
    VALUES ('arc-1', 'episode-1', 'episode-2', 'continuation', 0.4, 0.9, ?, ?, ?)
  `).run(JSON.stringify(arc), now, now);
  db.close();
  return sqlitePath;
}

describe('runSqliteToPostgresMemoryMigration', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('builds a deterministic dry-run report without opening Postgres', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-sqlite-pg-memory-dry-'));
    dirs.push(root);
    const sqlitePath = createFixtureSqliteDatabase(root);
    let createPoolCalled = false;

    const report = await runSqliteToPostgresMemoryMigration({
      sqlitePath,
      postgresUrl: 'postgres://postgres:postgres@localhost:5432/psfn',
      dryRun: true,
      embeddingDims: 3,
      dependencies: {
        createPostgresPool: () => {
          createPoolCalled = true;
          return new FakeMigrationPool();
        },
      },
    });

    expect(createPoolCalled).toBe(false);
    expect(report.mode).toBe('dry-run');
    expect(report.tables.l2_memories.rowCount).toBe(2);
    expect(report.tables.l2_memories.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(report.tables.l2_memory_delete_versions.rowCount).toBe(1);
    expect(report.tables.l2_memory_abstraction_links.rowCount).toBe(1);
    expect(report.tables.l2_memory_patch_events.rowCount).toBe(1);
    expect(report.tables.l2_memory_maintenance_reviews.rowCount).toBe(1);
    expect(report.tables.memory_links.rowCount).toBe(1);
    expect(report.tables.contact_profiles.rowCount).toBe(1);
    expect(report.tables.scratchpad_entries.rowCount).toBe(1);
    expect(report.tables.l01_episodes.rowCount).toBe(2);
    expect(report.embeddings).toMatchObject({
      present: true,
      rowCount: 2,
      validCount: 1,
      invalidCount: 1,
      expectedDims: 3,
    });
    expect(report.embeddings.dimensions).toEqual({ '2': 1, '3': 1 });
    expect(report.warnings.some(warning => warning.code === 'unsupported_apply_table')).toBe(false);
    expect(report.warnings).toContainEqual({
      table: 'gateway_audit',
      code: 'out_of_scope_table',
      message: 'gateway_audit is present but is outside this memory migration deliverable',
    });
    expect(report.skippedRows).toContainEqual({
      table: 'l2_memory_embeddings',
      rowId: 'memory-bad-dim',
      reason: 'embedding dimension mismatch: expected 3, got 2',
    });
  });

  it('applies supported tables with schema validation and a transaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-sqlite-pg-memory-apply-'));
    dirs.push(root);
    const sqlitePath = createFixtureSqliteDatabase(root);
    const pool = new FakeMigrationPool();
    let ensuredSchema = false;

    const report = await runSqliteToPostgresMemoryMigration({
      sqlitePath,
      postgresUrl: 'postgres://postgres:postgres@localhost:5432/psfn',
      embeddingDims: 3,
      dependencies: {
        createPostgresPool: () => pool,
        ensurePostgresSchema: async (_pool, statements) => {
          ensuredSchema = statements.length > 0;
        },
      },
    });

    expect(ensuredSchema).toBe(true);
    expect(pool.queries.map(query => query.text.trim())).toContain('BEGIN');
    expect(pool.queries.map(query => query.text.trim())).toContain('COMMIT');
    expect(pool.released).toBe(1);
    expect(pool.ended).toBe(true);
    expect(report.mode).toBe('apply');
    expect(report.tables.l2_memories.appliedRows).toBe(2);
    expect(report.tables.l2_memory_delete_versions.appliedRows).toBe(1);
    expect(report.tables.l2_memory_abstraction_links.appliedRows).toBe(1);
    expect(report.tables.l2_memory_patch_events.appliedRows).toBe(1);
    expect(report.tables.l2_memory_maintenance_reviews.appliedRows).toBe(1);
    expect(report.tables.memory_links.appliedRows).toBe(1);
    expect(report.tables.contact_profiles.appliedRows).toBe(1);
    expect(report.tables.scratchpad_entries.appliedRows).toBe(1);
    expect(report.tables.l01_episodes.appliedRows).toBe(2);
    expect(report.tables.l01_episode_arcs.appliedRows).toBe(1);
    expect(pool.memoryRows.get('memory-1')?.[28]).toBe('[0.25,0.5,0.75]');
    expect(pool.deleteVersionRows.get('delete-1')?.[2]).toBe('{"id":"memory-1"}');
    expect(pool.abstractionLinkRows.get('abstract-1')?.[3]).toBe('fixture:abstract-1');
    expect(pool.patchEventRows.get('patch-1')?.[6]).toBe('{"salience":0.7}');
    expect(pool.maintenanceReviewRows.get('review-1')?.[4]).toBe('["memory-2"]');
    expect(pool.memoryLinkRows.get('memory-1::memory-2')?.[2]).toBe('related');
    expect(pool.contactProfileRows.get('contact-1')?.[1]).toBe('Contact fixture summary');
    expect(pool.scratchpadRows.get('scratch-1')?.[1]).toBe('Scratch fixture');
    expect(pool.episodeRows.get('episode-1')?.[2]).toBe('Migration fixture episode');
    expect(pool.arcRows.get('arc-1')?.[4]).toBe('continuation');
  });
});
