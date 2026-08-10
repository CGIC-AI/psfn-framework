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
  drift = new Map<string, { reason: string | null; markedAt: number; kind: string }>();
  failWriteForChannel: string | null = null;
  failDeleteForChannel: string | null = null;
  failDriftInsertForChannel: string | null = null;
  /** When > 0, decremented on each forced failure; failures stop at 0. */
  remainingForcedFailures = Number.POSITIVE_INFINITY;
  readonly statements: string[] = [];

  private consumeForcedFailure(channelId: string): void {
    if (this.remainingForcedFailures <= 0) return;
    this.remainingForcedFailures -= 1;
    throw new Error(`forced write failure for ${channelId}`);
  }

  async connect(): Promise<PoolClient> {
    return {
      query: async (text: string, values?: unknown[]) => await this.query(text, values),
      release: () => undefined,
    } as PoolClient;
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    this.statements.push(normalized);
    if (
      normalized === 'begin'
      || normalized === 'commit'
      || normalized === 'rollback'
      || normalized.startsWith('create table')
      || normalized.startsWith('create index')
      || normalized.startsWith('alter table')
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

    if (normalized.startsWith('select channel_id, count(*) as message_count, max(message_id) as max_message_id')) {
      const byChannel = new Map<string, number[]>();
      for (const record of this.records) {
        const messageIds = byChannel.get(record.channelId) ?? [];
        messageIds.push(record.messageId);
        byChannel.set(record.channelId, messageIds);
      }
      const rows = [...byChannel.entries()].map(([channelId, messageIds]) => ({
        channel_id: channelId,
        message_count: String(messageIds.length),
        max_message_id: String(Math.max(...messageIds)),
      }));
      return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('select channel_id, reason, marked_at, kind from session_projection_drift')) {
      const rows = [...this.drift.entries()].map(([channelId, value]) => ({
        channel_id: channelId,
        reason: value.reason,
        marked_at: value.markedAt,
        kind: value.kind,
      }));
      return {
        rows,
        command: 'SELECT',
        rowCount: rows.length,
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('delete from session_messages_projection where channel_id =') && normalized.includes('and message_id =')) {
      const channelId = String(values[0] ?? '');
      if (this.failDeleteForChannel === channelId) {
        this.consumeForcedFailure(channelId);
      }
      const messageId = Number(values[1] ?? 0);
      const previousRecordCount = this.records.length;
      this.records = this.records.filter(record => (
        record.channelId !== channelId || record.messageId !== messageId
      ));
      return {
        rows: [],
        command: 'DELETE',
        rowCount: previousRecordCount - this.records.length,
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('delete from session_messages_projection where channel_id =')) {
      const channelId = String(values[0] ?? '');
      if (this.failDeleteForChannel === channelId) {
        this.consumeForcedFailure(channelId);
      }
      this.records = this.records.filter(record => record.channelId !== channelId);
      return { rows: [], command: 'DELETE', rowCount: 1, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into session_messages_projection')) {
      const channelId = String(values[0] ?? '');
      if (this.failWriteForChannel === channelId) {
        this.consumeForcedFailure(channelId);
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
      return {
        rows: [{ inserted: existingIndex < 0 }],
        command: 'INSERT',
        rowCount: 1,
        oid: 0,
        fields: [],
      } as QueryResult;
    }

    if (normalized.startsWith('delete from session_projection_drift where channel_id =')) {
      const channelId = String(values[0] ?? '');
      const existing = this.drift.get(channelId);
      // Mirrors the production `AND kind <> 'redaction'` guard used by
      // ordinary-write drift clearing.
      if (existing && !(normalized.includes("kind <> 'redaction'") && existing.kind === 'redaction')) {
        this.drift.delete(channelId);
      }
      return { rows: [], command: 'DELETE', rowCount: 1, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('insert into session_projection_drift')) {
      const channelId = String(values[0] ?? '');
      if (this.failDriftInsertForChannel === channelId) {
        throw new Error(`forced drift insert failure for ${channelId}`);
      }
      const existing = this.drift.get(channelId);
      const incomingKind = values[3] == null ? 'sync' : String(values[3]);
      this.drift.set(channelId, {
        reason: values[1] == null ? null : String(values[1]),
        markedAt: Number(values[2] ?? Date.now()),
        // Mirrors the production no-downgrade conflict clause.
        kind: existing?.kind === 'redaction' ? 'redaction' : incomingKind,
      });
      return { rows: [], command: 'INSERT', rowCount: 1, oid: 0, fields: [] } as QueryResult;
    }

    if (normalized.startsWith('select channel_id, message_id, role,')) {
      const query = String(values[0] ?? '').toLowerCase();
      const tokens = query.split(/\s+/).filter(Boolean);
      const scopedChannelId = values[2] == null ? null : String(values[2]);
      const firstMessageId = values[3] == null ? null : Number(values[3]);
      const lastMessageId = values[4] == null ? null : Number(values[4]);
      const matches = this.records
        .filter(record => scopedChannelId === null || record.channelId === scopedChannelId)
        .filter(record => firstMessageId === null || record.messageId >= firstMessageId)
        .filter(record => lastMessageId === null || record.messageId <= lastMessageId)
        // Mirrors the production NOT EXISTS redaction-drift predicate.
        .filter(record => this.drift.get(record.channelId)?.kind !== 'redaction')
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

  it('does not preload every projected message id at boot', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-boot-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    pool.records.push(
      {
        channelId: 'api:boot-a',
        messageId: 1,
        role: 'user',
        authorId: null,
        authorName: null,
        content: 'first',
        timestamp: 1_000,
        channelVisibility: 'private',
      },
      {
        channelId: 'api:boot-a',
        messageId: 2,
        role: 'assistant',
        authorId: null,
        authorName: null,
        content: 'second',
        timestamp: 2_000,
        channelVisibility: 'private',
      },
    );

    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    expect(pool.statements).not.toContain(
      'select channel_id, message_id from session_messages_projection order by channel_id asc, message_id asc',
    );
    expect(pool.statements).toContain(
      'select channel_id, count(*) as message_count, max(message_id) as max_message_id from session_messages_projection group by channel_id order by channel_id asc',
    );
    expect(adapters.transcriptProjection.countProjectedMessages('api:boot-a')).toBe(2);
  });

  it('queues one projection statement for a clean-channel message write', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-clean-write-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });
    pool.statements.length = 0;

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId: 'api:clean-write',
      role: 'user',
      content: 'one statement',
      timestamp: 1_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    const projectionStatements = pool.statements.filter(statement => (
      statement.includes('session_messages_projection')
      || statement.includes('session_projection_drift')
    ));
    expect(projectionStatements).toHaveLength(1);
    expect(projectionStatements[0]).toMatch(/^insert into session_messages_projection /);
  });

  it('clears the persisted drift row when a tracked-drift channel is written', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-drift-clear-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });
    adapters.transcriptProjection.markProjectionDrift('api:tracked-drift', 'repair needed');
    await adapters.transcriptProjection.flushPendingWrites?.();
    pool.statements.length = 0;

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId: 'api:tracked-drift',
      role: 'assistant',
      content: 'drift repaired',
      timestamp: 1_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    const projectionStatements = pool.statements.filter(statement => (
      statement.includes('session_messages_projection')
      || statement.includes('session_projection_drift')
    ));
    expect(projectionStatements).toHaveLength(2);
    expect(projectionStatements[0]).toMatch(/^insert into session_messages_projection /);
    expect(projectionStatements[1]).toMatch(/^delete from session_projection_drift /);
    expect(pool.drift.has('api:tracked-drift')).toBe(false);
  });

  it('keeps replacement metadata after an ambiguous insert was already queued', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-insert-replace-'));
    dirs.push(sessionsDir);
    const channelId = 'api:insert-before-replace';
    const pool = new FakePostgresPool();
    pool.records.push(
      {
        channelId,
        messageId: 1,
        role: 'user',
        authorId: null,
        authorName: null,
        content: 'first persisted message',
        timestamp: 1_000,
        channelVisibility: 'private',
      },
      {
        channelId,
        messageId: 3,
        role: 'assistant',
        authorId: null,
        authorName: null,
        content: 'third persisted message',
        timestamp: 3_000,
        channelVisibility: 'private',
      },
    );
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 2,
      channelId,
      role: 'user',
      content: 'fills the persisted id gap',
      timestamp: 2_000,
    });
    adapters.transcriptProjection.replaceChannelEntries(channelId, [{
      id: 4,
      channelId,
      role: 'assistant',
      content: 'replacement message',
      timestamp: 4_000,
    }]);
    await adapters.transcriptProjection.flushPendingWrites?.();

    expect(pool.records
      .filter(record => record.channelId === channelId)
      .map(record => record.messageId)).toEqual([4]);
    expect(adapters.transcriptProjection.countProjectedMessages(channelId)).toBe(1);
  });

  it('keeps replacement metadata after a missing delete was already queued', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-delete-replace-'));
    dirs.push(sessionsDir);
    const channelId = 'api:delete-before-replace';
    const pool = new FakePostgresPool();
    pool.records.push({
      channelId,
      messageId: 3,
      role: 'assistant',
      authorId: null,
      authorName: null,
      content: 'third persisted message',
      timestamp: 3_000,
      channelVisibility: 'private',
    });
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 2,
      channelId,
      role: 'user',
      content: '[CogSec redaction: cogsec_20260714T000000Z_missing]',
      metadata: JSON.stringify({
        kind: 'cogsec_l0_tombstone',
        caseId: 'cogsec_20260714T000000Z_missing',
        redactedAt: '2026-07-14T00:00:00.000Z',
      }),
      timestamp: 2_000,
    });
    adapters.transcriptProjection.replaceChannelEntries(channelId, [{
      id: 4,
      channelId,
      role: 'assistant',
      content: 'replacement message',
      timestamp: 4_000,
    }]);
    await adapters.transcriptProjection.flushPendingWrites?.();

    expect(pool.records
      .filter(record => record.channelId === channelId)
      .map(record => record.messageId)).toEqual([4]);
    expect(adapters.transcriptProjection.countProjectedMessages(channelId)).toBe(1);
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

  it('scopes keyword search to a single channel when requested', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-scoped-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId: 'api:scoped-target',
      role: 'user',
      content: 'shared scoped needle in target',
      timestamp: 1_000,
    });
    adapters.transcriptProjection.upsertSessionEntry({
      id: 2,
      channelId: 'api:scoped-other',
      role: 'user',
      content: 'shared scoped needle in other',
      timestamp: 2_000,
    });
    adapters.transcriptProjection.upsertSessionEntry({
      id: 3,
      channelId: 'api:scoped-target',
      role: 'assistant',
      content: 'shared scoped needle outside bounded source',
      timestamp: 3_000,
    });

    const unscoped = await adapters.transcriptSearch.searchByKeywords('scoped needle');
    expect(unscoped).toHaveLength(3);

    const scoped = await adapters.transcriptSearch.searchByKeywords('scoped needle', 10, {
      channelId: 'api:scoped-target',
    });
    expect(scoped).toHaveLength(2);
    expect(scoped.every(hit => hit.channelId === 'api:scoped-target')).toBe(true);

    const bounded = await adapters.transcriptSearch.searchByKeywords('scoped needle', 10, {
      channelId: 'api:scoped-target',
      firstMessageId: 1,
      lastMessageId: 1,
    });
    expect(bounded).toHaveLength(1);
    expect(bounded[0]?.channelId).toBe('api:scoped-target');
    expect(bounded[0]?.messageId).toBe(1);
  });

  it('replaces channels, normalizes visibility, and supports explicit drift lifecycle operations', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-session-adapters-replace-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId: 'api:postgres-replace',
      role: 'assistant',
      content: 'old projection needle',
      timestamp: 1_000,
      channelVisibility: 'not-a-valid-visibility',
    });
    await adapters.transcriptSearch.searchByKeywords('old needle');
    expect(pool.records).toHaveLength(1);
    expect(pool.records[0].channelVisibility).toBe('private');

    adapters.transcriptProjection.replaceChannelEntries('api:postgres-replace', [{
      id: 2,
      channelId: 'api:postgres-replace',
      role: 'user',
      content: 'new projection needle',
      timestamp: 2_000,
      channelVisibility: 'invite_only',
    }]);

    expect(adapters.transcriptProjection.countProjectedMessages('api:postgres-replace')).toBe(1);
    await expect(adapters.transcriptSearch.searchByKeywords('old needle')).resolves.toHaveLength(0);
    const replacementHits = await adapters.transcriptSearch.searchByKeywords('new needle');
    expect(replacementHits).toHaveLength(1);
    expect(replacementHits[0]).toEqual(expect.objectContaining({
      channelId: 'api:postgres-replace',
      messageId: 2,
      channelVisibility: 'invite_only',
    }));

    adapters.transcriptProjection.markProjectionDrift('api:postgres-replace', 'manual drift');
    expect(adapters.transcriptProjection.listProjectionDrift()).toEqual([
      expect.objectContaining({
        channelId: 'api:postgres-replace',
        reason: 'manual drift',
      }),
    ]);

    adapters.transcriptProjection.clearProjectionDrift('api:postgres-replace');
    expect(adapters.transcriptProjection.listProjectionDrift()).toEqual([]);
    await adapters.transcriptSearch.searchByKeywords('new needle');
    expect(pool.drift.size).toBe(0);
  });

  it('excludes CogSec tombstones from postgres projection writes and replacement rebuilds', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-cogsec-projection-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId: 'api:postgres-cogsec',
      role: 'user',
      content: 'postgres dirty search needle',
      timestamp: 1_000,
    });
    await expect(adapters.transcriptSearch.searchByKeywords('dirty needle')).resolves.toHaveLength(1);

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId: 'api:postgres-cogsec',
      role: 'user',
      content: '[CogSec redaction: cogsec_20260701T000000Z_pg]',
      metadata: JSON.stringify({
        kind: 'cogsec_l0_tombstone',
        caseId: 'cogsec_20260701T000000Z_pg',
        redactedAt: '2026-07-01T00:00:00.000Z',
      }),
      timestamp: 1_000,
    });

    expect(adapters.transcriptProjection.countProjectedMessages('api:postgres-cogsec')).toBe(0);
    await expect(adapters.transcriptSearch.searchByKeywords('dirty needle')).resolves.toHaveLength(0);
    await expect(adapters.transcriptSearch.searchByKeywords('CogSec redaction')).resolves.toHaveLength(0);

    adapters.transcriptProjection.replaceChannelEntries('api:postgres-cogsec', [
      {
        id: 1,
        channelId: 'api:postgres-cogsec',
        role: 'user',
        content: '[CogSec redaction: cogsec_20260701T000000Z_pg]',
        timestamp: 1_000,
      },
      {
        id: 2,
        channelId: 'api:postgres-cogsec',
        role: 'assistant',
        content: 'clean postgres replacement',
        timestamp: 2_000,
      },
    ]);

    expect(adapters.transcriptProjection.countProjectedMessages('api:postgres-cogsec')).toBe(1);
    await expect(adapters.transcriptSearch.searchByKeywords('clean postgres')).resolves.toHaveLength(1);
    await expect(adapters.transcriptSearch.searchByKeywords('cogsec_20260701T000000Z_pg')).resolves.toHaveLength(0);
  });

  it('fails closed when a redaction projection delete keeps failing: durable redaction drift and search exclusion', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-redaction-drift-'));
    dirs.push(sessionsDir);
    const channelId = 'api:redaction-drift';
    const pool = new FakePostgresPool();
    const observed: Array<{ channelId: string; reason: string }> = [];
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
      redactionDriftObserver: {
        recordRedactionProjectionDrift: event => {
          observed.push({ channelId: event.channelId, reason: event.reason });
        },
      },
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId,
      role: 'user',
      content: 'secret leaked needle',
      timestamp: 1_000,
    });
    adapters.transcriptProjection.upsertSessionEntry({
      id: 2,
      channelId: 'api:redaction-drift-other',
      role: 'user',
      content: 'unrelated healthy needle',
      timestamp: 2_000,
    });
    await expect(adapters.transcriptSearch.searchByKeywords('needle')).resolves.toHaveLength(2);

    // The exact leak mechanism: the redaction tombstone's projection DELETE
    // fails, so the original content row SURVIVES in the projection table.
    pool.failDeleteForChannel = channelId;
    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId,
      role: 'user',
      content: '[CogSec redaction: cogsec_20260722T000000Z_leak]',
      metadata: JSON.stringify({
        kind: 'cogsec_l0_tombstone',
        caseId: 'cogsec_20260722T000000Z_leak',
        redactedAt: '2026-07-22T00:00:00.000Z',
      }),
      timestamp: 1_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    // Original row survived in the store...
    expect(pool.records.some(record => record.channelId === channelId && record.messageId === 1)).toBe(true);
    // ...but search fails closed for the channel instead of serving it.
    const hits = await adapters.transcriptSearch.searchByKeywords('needle');
    expect(hits.map(hit => hit.channelId)).toEqual(['api:redaction-drift-other']);
    // The drift record is durable (survives restarts) and redaction-kind.
    expect(pool.drift.get(channelId)?.kind).toBe('redaction');
    expect(adapters.transcriptProjection.listProjectionDrift()).toEqual([
      expect.objectContaining({ channelId, kind: 'redaction' }),
    ]);
    // Operator incident seam observed the failure.
    expect(observed).toEqual([
      expect.objectContaining({ channelId, reason: expect.stringContaining('forced write failure') }),
    ]);

    // An ordinary successful append does NOT clear redaction drift.
    pool.failDeleteForChannel = null;
    adapters.transcriptProjection.upsertSessionEntry({
      id: 3,
      channelId,
      role: 'assistant',
      content: 'later ordinary needle',
      timestamp: 3_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();
    expect(pool.drift.get(channelId)?.kind).toBe('redaction');
    await expect(adapters.transcriptSearch.searchByKeywords('needle')).resolves.toEqual([
      expect.objectContaining({ channelId: 'api:redaction-drift-other' }),
    ]);

    // Repair-equivalent full replacement from canon clears the drift and
    // restores search for the channel without the redacted content.
    adapters.transcriptProjection.replaceChannelEntries(channelId, [
      {
        id: 1,
        channelId,
        role: 'user',
        content: '[CogSec redaction: cogsec_20260722T000000Z_leak]',
        timestamp: 1_000,
      },
      {
        id: 3,
        channelId,
        role: 'assistant',
        content: 'later ordinary needle',
        timestamp: 3_000,
      },
    ]);
    await adapters.transcriptProjection.flushPendingWrites?.();
    expect(pool.drift.has(channelId)).toBe(false);
    const repaired = await adapters.transcriptSearch.searchByKeywords('needle');
    expect(repaired.map(hit => `${hit.channelId}:${hit.messageId}`).sort()).toEqual([
      'api:redaction-drift-other:2',
      `${channelId}:3`,
    ]);
    await expect(adapters.transcriptSearch.searchByKeywords('secret leaked')).resolves.toHaveLength(0);
  });

  it('recovers a transiently failing redaction delete with one bounded retry and records no drift', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-redaction-retry-'));
    dirs.push(sessionsDir);
    const channelId = 'api:redaction-retry';
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId,
      role: 'user',
      content: 'transient retry needle',
      timestamp: 1_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    pool.failDeleteForChannel = channelId;
    pool.remainingForcedFailures = 1;
    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId,
      role: 'user',
      content: '[CogSec redaction: cogsec_20260722T000000Z_retry]',
      metadata: JSON.stringify({
        kind: 'cogsec_l0_tombstone',
        caseId: 'cogsec_20260722T000000Z_retry',
        redactedAt: '2026-07-22T00:00:00.000Z',
      }),
      timestamp: 1_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    expect(pool.records.filter(record => record.channelId === channelId)).toHaveLength(0);
    expect(adapters.transcriptProjection.listProjectionDrift()).toEqual([]);
    await expect(adapters.transcriptSearch.searchByKeywords('transient retry')).resolves.toHaveLength(0);
  });

  it('keeps in-process search fail-closed and retries durability when the drift row write itself fails', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-redaction-pending-'));
    dirs.push(sessionsDir);
    const channelId = 'api:redaction-pending';
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId,
      role: 'user',
      content: 'pending durable needle',
      timestamp: 1_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    pool.failDeleteForChannel = channelId;
    pool.failDriftInsertForChannel = channelId;
    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId,
      role: 'user',
      content: '[CogSec redaction: cogsec_20260722T000000Z_pending]',
      metadata: JSON.stringify({
        kind: 'cogsec_l0_tombstone',
        caseId: 'cogsec_20260722T000000Z_pending',
        redactedAt: '2026-07-22T00:00:00.000Z',
      }),
      timestamp: 1_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    // Durable row could not land, but the in-memory record still fail-closes
    // in-process search.
    expect(pool.drift.has(channelId)).toBe(false);
    await expect(adapters.transcriptSearch.searchByKeywords('pending durable')).resolves.toHaveLength(0);

    // Once the database accepts writes again, the next search flushes the
    // pending durable record.
    pool.failDriftInsertForChannel = null;
    await adapters.transcriptSearch.searchByKeywords('pending durable');
    expect(pool.drift.get(channelId)?.kind).toBe('redaction');
  });

  it('keeps ordinary append failures best-effort: sync drift, search still serves the channel', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-sync-drift-'));
    dirs.push(sessionsDir);
    const channelId = 'api:sync-drift';
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.upsertSessionEntry({
      id: 1,
      channelId,
      role: 'user',
      content: 'existing best effort needle',
      timestamp: 1_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    pool.failWriteForChannel = channelId;
    adapters.transcriptProjection.upsertSessionEntry({
      id: 2,
      channelId,
      role: 'assistant',
      content: 'lost append',
      timestamp: 2_000,
    });
    await adapters.transcriptProjection.flushPendingWrites?.();

    expect(adapters.transcriptProjection.listProjectionDrift()).toEqual([
      expect.objectContaining({ channelId, kind: 'sync' }),
    ]);
    // Best-effort semantics preserved: the channel's existing rows still serve.
    await expect(adapters.transcriptSearch.searchByKeywords('best effort')).resolves.toEqual([
      expect.objectContaining({ channelId, messageId: 1 }),
    ]);
  });

  it('never downgrades redaction drift through markProjectionDrift and re-surfaces it to a fresh adapter', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-pg-redaction-restart-'));
    dirs.push(sessionsDir);
    const channelId = 'api:redaction-restart';
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
    });

    adapters.transcriptProjection.markProjectionDrift(channelId, 'redaction failed', 'redaction');
    await adapters.transcriptProjection.flushPendingWrites?.();
    expect(pool.drift.get(channelId)?.kind).toBe('redaction');

    adapters.transcriptProjection.markProjectionDrift(channelId, 'later ordinary drift');
    await adapters.transcriptProjection.flushPendingWrites?.();
    expect(pool.drift.get(channelId)?.kind).toBe('redaction');
    expect(adapters.transcriptProjection.listProjectionDrift()).toEqual([
      expect.objectContaining({ channelId, kind: 'redaction' }),
    ]);

    // "Restart": a fresh adapter over the same database preloads the durable
    // record, keeps search fail-closed, and re-notifies the operator seam.
    const observed: string[] = [];
    const restarted = await createDefaultPostgresSessionAdapters('postgres://unused', {
      sessionsDir,
      pool: pool as unknown as Pool,
      redactionDriftObserver: {
        recordRedactionProjectionDrift: event => {
          observed.push(event.channelId);
        },
      },
    });
    expect(observed).toEqual([channelId]);
    expect(restarted.transcriptProjection.listProjectionDrift()).toEqual([
      expect.objectContaining({ channelId, kind: 'redaction' }),
    ]);
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
