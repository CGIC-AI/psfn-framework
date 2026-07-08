import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createDefaultPostgresSessionAdapters } from '../../persistence/sessions/postgres-adapters.js';
import { resolveSessionsDir } from '../../persistence/layout.js';
import { runTranscriptProjectionRepairCommand } from './transcript-projection-repair.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

interface ProjectedMessageRecord {
  channelId: string;
  messageId: number;
  role: 'user' | 'assistant' | 'system';
  authorId: string | null;
  authorName: string | null;
  content: string;
  timestamp: number;
  channelVisibility: string;
}

class FakePostgresPool {
  records: ProjectedMessageRecord[] = [];
  drift = new Map<string, { reason: string | null; markedAt: number }>();

  async connect(): Promise<PoolClient> {
    return {
      query: async (text: string, values?: readonly unknown[]) => await this.query(text, values),
      release: () => undefined,
    } as PoolClient;
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (
      normalized === 'begin'
      || normalized === 'commit'
      || normalized === 'rollback'
      || normalized.startsWith('create table')
      || normalized.startsWith('create index')
    ) {
      return { rows: [], command: 'OK', rowCount: 0, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('select channel_id, message_id from session_messages_projection')) {
      return {
        rows: this.records.map(record => ({
          channel_id: record.channelId,
          message_id: record.messageId,
        })),
        command: 'SELECT',
        rowCount: this.records.length,
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('select channel_id, reason, marked_at from session_projection_drift')) {
      const rows = [...this.drift.entries()].map(([channelId, drift]) => ({
        channel_id: channelId,
        reason: drift.reason,
        marked_at: drift.markedAt,
      }));
      return {
        rows,
        command: 'SELECT',
        rowCount: rows.length,
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('delete from session_messages_projection where channel_id =')) {
      const channelId = String(values[0] ?? '');
      this.records = this.records.filter(record => record.channelId !== channelId);
      return { rows: [], command: 'DELETE', rowCount: 1, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into session_messages_projection')) {
      const next: ProjectedMessageRecord = {
        channelId: String(values[0] ?? ''),
        messageId: Number(values[1] ?? 0),
        role: values[2] as ProjectedMessageRecord['role'],
        authorId: values[3] == null ? null : String(values[3]),
        authorName: values[4] == null ? null : String(values[4]),
        content: String(values[5] ?? ''),
        timestamp: Number(values[6] ?? 0),
        channelVisibility: String(values[7] ?? 'public'),
      };
      const existingIndex = this.records.findIndex(record => (
        record.channelId === next.channelId && record.messageId === next.messageId
      ));
      if (existingIndex >= 0) {
        this.records[existingIndex] = next;
      } else {
        this.records.push(next);
      }
      return { rows: [], command: 'INSERT', rowCount: 1, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('delete from session_projection_drift where channel_id =')) {
      this.drift.delete(String(values[0] ?? ''));
      return { rows: [], command: 'DELETE', rowCount: 1, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into session_projection_drift')) {
      this.drift.set(String(values[0] ?? ''), {
        reason: values[1] == null ? null : String(values[1]),
        markedAt: Number(values[2] ?? Date.now()),
      });
      return { rows: [], command: 'INSERT', rowCount: 1, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('select channel_id, message_id, role,')) {
      const query = String(values[0] ?? '').toLowerCase();
      const tokens = query.split(/\s+/).filter(Boolean);
      const matches = this.records
        .filter(record => tokens.every(token => record.content.toLowerCase().includes(token)))
        .map(record => ({
          channel_id: record.channelId,
          message_id: record.messageId,
          role: record.role,
          author_id: record.authorId,
          author_name: record.authorName,
          content: record.content,
          timestamp: record.timestamp,
          channel_visibility: record.channelVisibility,
          score: 1,
          snippet: record.content,
        }));
      return {
        rows: matches,
        command: 'SELECT',
        rowCount: matches.length,
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    throw new Error(`Unhandled SQL in FakePostgresPool: ${text}`);
  }
}

describe('runTranscriptProjectionRepairCommand', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('targets postgres projection even when config backend is sqlite and leaves legacy sqlite search absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-transcript-repair-cli-postgres-only-'));
    dirs.push(root);
    const dataDir = join(root, 'data');
    const sessionsDir = resolveSessionsDir(dataDir);
    const pool = new FakePostgresPool();
    const postgresUrl = 'postgres://unused';

    const adapters = await createDefaultPostgresSessionAdapters(postgresUrl, {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.sessionArchivePort.writeImportedSession({
      sessionsDir,
      channelId: 'api:postgres-only-repair',
      seedTimestamp: 1_000,
      messages: [{
        role: 'assistant',
        content: 'postgres only projection repair needle',
        timestamp: 1_000,
      }],
    });

    const config: SubstrateConfig = {
      dataDir,
      persistenceBackend: 'sqlite',
      postgresDatabaseUrl: postgresUrl,
    } as SubstrateConfig;

    const report = await runTranscriptProjectionRepairCommand({
      config,
      dataDir,
      dependencies: {
        createPostgresSessionAdapters: async () => createDefaultPostgresSessionAdapters(postgresUrl, {
          sessionsDir,
          pool: pool as unknown as Pool,
        }),
        resolveIntegrityProvider: () => null,
      },
    });

    expect(report).toMatchObject({
      scannedFiles: 1,
      rebuiltChannels: 1,
      driftBefore: 0,
      driftAfter: 0,
      persistenceBackend: 'postgres',
    });

    const reloaded = await createDefaultPostgresSessionAdapters(postgresUrl, {
      sessionsDir,
      pool: pool as unknown as Pool,
    });
    const hits = await reloaded.transcriptSearch.searchByKeywords('repair needle');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.channelId).toBe('api:postgres-only-repair');
    expect(existsSync(join(sessionsDir, 'session-search.sqlite'))).toBe(false);
  });

  it('rebuilds postgres transcript projection state from authoritative JSONL sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-transcript-repair-cli-postgres-'));
    dirs.push(root);
    const dataDir = join(root, 'data');
    const sessionsDir = resolveSessionsDir(dataDir);
    const pool = new FakePostgresPool();
    const postgresUrl = 'postgres://unused';

    const adapters = await createDefaultPostgresSessionAdapters(postgresUrl, {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.sessionArchivePort.writeImportedSession({
      sessionsDir,
      channelId: 'api:postgres-repair',
      seedTimestamp: 2_000,
      messages: [{
        role: 'user',
        content: 'postgres projection repair needle',
        timestamp: 2_000,
      }],
    });
    adapters.transcriptProjection.markProjectionDrift('api:postgres-repair', 'forced drift');

    const config: SubstrateConfig = {
      dataDir,
      persistenceBackend: 'postgres',
      postgresDatabaseUrl: postgresUrl,
    } as SubstrateConfig;

    const report = await runTranscriptProjectionRepairCommand({
      config,
      dataDir,
      dependencies: {
        createPostgresSessionAdapters: async () => createDefaultPostgresSessionAdapters(postgresUrl, {
          sessionsDir,
          pool: pool as unknown as Pool,
        }),
        resolveIntegrityProvider: () => null,
      },
    });

    expect(report).toMatchObject({
      scannedFiles: 1,
      rebuiltChannels: 1,
      driftBefore: 1,
      driftAfter: 0,
      persistenceBackend: 'postgres',
    });

    const reloaded = await createDefaultPostgresSessionAdapters(postgresUrl, {
      sessionsDir,
      pool: pool as unknown as Pool,
    });
    const hits = await reloaded.transcriptSearch.searchByKeywords('repair needle');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.channelId).toBe('api:postgres-repair');
    expect(pool.drift.size).toBe(0);
  });

  it('fails closed when postgres transcript projection wiring is invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-transcript-repair-cli-invalid-postgres-'));
    dirs.push(root);
    const dataDir = join(root, 'data');
    const sessionsDir = resolveSessionsDir(dataDir);
    const config: SubstrateConfig = {
      dataDir,
      persistenceBackend: 'sqlite',
    } as SubstrateConfig;

    await expect(runTranscriptProjectionRepairCommand({
      config,
      dataDir,
      dependencies: {
        resolveIntegrityProvider: () => null,
      },
    })).rejects.toThrow('requires config.postgresDatabaseUrl');
    expect(existsSync(join(sessionsDir, 'session-search.sqlite'))).toBe(false);
  });
});
