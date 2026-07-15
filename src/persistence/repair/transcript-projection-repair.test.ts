import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createDefaultPostgresSessionAdapters } from '../sessions/postgres-adapters.js';
import {
  buildMessageJournalEntry,
  buildSessionHmacKeyring,
  signJournalEntry,
} from '../journals/journal-utils.js';
import { createKeyringIntegrityProvider } from '../sessions/store-primitives.js';
import { makeRolledFilePath } from '../sessions/store/channel-filenames.js';
import { runTranscriptProjectionRepair } from './transcript-projection-repair.js';

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

describe('runTranscriptProjectionRepair', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('rebuilds postgres projection state and clears drift from authoritative JSONL sessions', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-transcript-repair-postgres-'));
    dirs.push(sessionsDir);
    const pool = new FakePostgresPool();
    const adapters = await createDefaultPostgresSessionAdapters('postgres://unused', {
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

    const report = runTranscriptProjectionRepair({
      sessionsDir,
      transcriptProjection: adapters.transcriptProjection,
    });

    expect(report).toMatchObject({
      scannedFiles: 1,
      rebuiltChannels: 1,
      driftBefore: 1,
      driftAfter: 0,
    });
    const hits = await adapters.transcriptSearch.searchByKeywords('repair needle');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.channelId).toBe('api:postgres-repair');
    expect(pool.drift.size).toBe(0);
  });

  it('rebuilds one projection from every segment in a signed logical session chain', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-transcript-repair-chain-'));
    dirs.push(sessionsDir);
    const adapters = createDefaultSQLiteSessionAdapters(sessionsDir, { enableSearchIndex: true });
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:projection-chain-key',
      activeVersion: 'v1',
    });
    expect(keyring).not.toBeNull();

    const rootPath = join(sessionsDir, '20260325_api-projection-chain_user_000001.jsonl');
    const segmentPath = makeRolledFilePath(rootPath, 2);
    const rootEntry = signJournalEntry(buildMessageJournalEntry(1, {
      channelId: 'api:projection-chain',
      role: 'user',
      content: 'root-only projection needle',
      timestamp: 1_000,
    }), keyring!, null);
    const segmentEntry = signJournalEntry(buildMessageJournalEntry(2, {
      channelId: 'api:projection-chain',
      role: 'assistant',
      content: 'segment-only projection needle',
      timestamp: 2_000,
    }), keyring!, rootEntry._hmac ?? null);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(rootPath, `${JSON.stringify(rootEntry)}\n`, 'utf8');
    writeFileSync(segmentPath, `${JSON.stringify(segmentEntry)}\n`, 'utf8');

    const report = runTranscriptProjectionRepair({
      sessionsDir,
      transcriptProjection: adapters.transcriptProjection!,
      integrityProvider: createKeyringIntegrityProvider(keyring),
    });

    expect(report).toMatchObject({
      scannedFiles: 2,
      rebuiltChannels: 1,
      driftAfter: 0,
      failures: [],
    });
    expect(await adapters.transcriptSearch!.searchByKeywords('root-only needle')).toHaveLength(1);
    expect(await adapters.transcriptSearch!.searchByKeywords('segment-only needle')).toHaveLength(1);
  });

  it('keeps the runtime session id when an incomplete chain shares its channel', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-transcript-repair-incomplete-'));
    dirs.push(sessionsDir);
    const adapters = createDefaultSQLiteSessionAdapters(sessionsDir, { enableSearchIndex: true });
    const validPath = join(sessionsDir, '20260325_api-shared_user_000001.jsonl');
    const orphanSegmentPath = join(sessionsDir, '20260325_api-shared_user_000002.segment-0002.jsonl');
    const validEntry = buildMessageJournalEntry(1, {
      channelId: 'api:shared',
      role: 'user',
      content: 'valid unsuffixed projection needle',
      timestamp: 1_000,
    });
    const orphanEntry = buildMessageJournalEntry(2, {
      channelId: 'api:shared',
      role: 'assistant',
      content: 'orphan segment must not replace valid projection',
      timestamp: 2_000,
    });
    writeFileSync(validPath, `${JSON.stringify(validEntry)}\n`, 'utf8');
    writeFileSync(orphanSegmentPath, `${JSON.stringify(orphanEntry)}\n`, 'utf8');

    const report = runTranscriptProjectionRepair({
      sessionsDir,
      transcriptProjection: adapters.transcriptProjection!,
    });

    expect(report.rebuiltChannels).toBe(1);
    expect(report.failures).toEqual([
      expect.objectContaining({
        channelId: 'api:shared#20260325_api-shared_user_000002',
      }),
    ]);
    const hits = await adapters.transcriptSearch!.searchByKeywords('valid unsuffixed needle');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.channelId).toBe('api:shared');
  });
});
