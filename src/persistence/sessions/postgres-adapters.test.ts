import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createDefaultPostgresSessionAdapters } from './postgres-adapters.js';

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
  failWriteForChannel: string | null = null;

  async connect(): Promise<PoolClient> {
    return {
      query: async (text: string, values?: unknown[]) => await this.query(text, values),
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
      const rows = [...this.drift.entries()].map(([channelId, value]) => ({
        channel_id: channelId,
        reason: value.reason,
        marked_at: value.markedAt,
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
      const channelId = String(values[0] ?? '');
      if (this.failWriteForChannel === channelId) {
        throw new Error(`forced write failure for ${channelId}`);
      }
      const next: ProjectedMessageRecord = {
        channelId,
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
        .filter(record => {
          const haystack = record.content.toLowerCase();
          return tokens.every(token => haystack.includes(token));
        })
        .sort((left, right) => right.timestamp - left.timestamp || right.messageId - left.messageId)
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

describe('postgres session adapters', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('queues projection writes and exposes async keyword search through the adapter', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId: 'api:postgres-search',
      role: 'assistant',
      content: 'postgres projection search needle',
      timestamp: 1_000,
    });

    expect(adapters.transcriptProjection.countProjectedMessages('api:postgres-search')).toBe(1);
    const hits = await adapters.transcriptSearch.searchByKeywords('search needle');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.channelId).toBe('api:postgres-search');
    expect(pool.records).toHaveLength(1);
  });

  it('tracks projection drift when queued postgres writes fail', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-drift-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    pool.failWriteForChannel = 'api:projection-drift';

    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId: 'api:projection-drift',
      role: 'user',
      content: 'this write will fail',
      timestamp: 1_000,
    });

    await adapters.transcriptSearch.searchByKeywords('fail');
    expect(adapters.transcriptProjection.listProjectionDrift()).toEqual([
      expect.objectContaining({
        channelId: 'api:projection-drift',
      }),
    ]);
  });
});
