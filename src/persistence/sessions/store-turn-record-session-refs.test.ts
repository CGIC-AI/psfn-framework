import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionEntry } from '../../core/session/types.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { createTurnId } from '../../core/turns/id.js';
import { SessionStore } from './store.js';
import { REDACTED_MESSAGE_PLACEHOLDER } from './turn-record-session-refs.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-9ree-'));
  dirs.push(dir);
  return dir;
}

function readTurnRecordFile(dir: string): string {
  const turnDir = join(dir, '_turn_records');
  const files = readdirSync(turnDir).filter(name => name.endsWith('.jsonl'));
  return files.map(name => readFileSync(join(turnDir, name), 'utf8')).join('\n');
}

function message(entry: SessionEntry): Record<string, unknown> {
  return { role: entry.role, content: entry.content, provenance: { sourceEntryIds: [entry.id] } };
}

function buildTurnRecord(
  channelId: string,
  recentEntries: SessionEntry[],
  messages: Array<Record<string, unknown>>,
): TurnRecord {
  const turnId = createTurnId();
  return {
    schemaVersion: 1,
    turnId,
    requestId: `req-${turnId}`,
    channelId,
    channelType: 'api',
    startedAt: 1,
    completedAt: 2,
    status: 'completed',
    userMessage: { role: 'user', content: 'x', timestamp: 1 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
    observability: {
      stages: [],
      retrievals: [],
      snapshot: {
        turnId,
        requestId: `req-${turnId}`,
        channelId,
        capturedAt: 1,
        trustLevel: 'regular',
        sessionContext: { channelId, recentEntries },
        plan: { messages },
      },
    },
  } as unknown as TurnRecord;
}

describe('SessionStore turn-record session-entry diet (psfn-framework-9ree)', () => {
  it('erases the verbatim recentEntries copy from disk and reconstructs it from L0 on read', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:diet';
    store.append({ channelId, role: 'user', content: 'first partner line', timestamp: 1_000 });
    store.append({ channelId, role: 'assistant', content: 'first companion line', timestamp: 2_000 });
    store.append({ channelId, role: 'user', content: 'second partner line', timestamp: 3_000 });
    const entries = store.getRecent(channelId, 10);
    expect(entries).toHaveLength(3);

    // No plan.messages here so the ONLY copy of the bodies is recentEntries;
    // proving they vanish from the turn-record file proves the dedup.
    const record = buildTurnRecord(channelId, entries, []);
    store.appendTurnRecord(record);

    const persisted = readTurnRecordFile(dir);
    expect(persisted).toContain('recentEntriesRef');
    expect(persisted).not.toContain('first partner line');
    expect(persisted).not.toContain('first companion line');
    expect(persisted).not.toContain('second partner line');

    // On read: reconstructed transparently from the journal.
    const read = store.getRecentTurnRecords(channelId, 10);
    expect(read).toHaveLength(1);
    const ctx = (read[0]!.observability!.snapshot as unknown as { sessionContext: { recentEntries: SessionEntry[] } }).sessionContext;
    expect(ctx.recentEntries.map(e => e.content)).toEqual([
      'first partner line',
      'first companion line',
      'second partner line',
    ]);
    expect((ctx as unknown as Record<string, unknown>).recentEntriesRef).toBeUndefined();
  });

  it('never resurrects an entry that is gone from L0, and masks its rendered message', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:gone';
    store.append({ channelId, role: 'user', content: 'kept line', timestamp: 1_000 });
    const entries = store.getRecent(channelId, 10);
    // Reference a phantom entry (id absent from L0) carrying sensitive text.
    const phantom: SessionEntry = { id: 9_999, channelId, role: 'user', content: 'REDACTED SECRET', timestamp: 4_000 };
    const captured = [...entries, phantom];
    const record = buildTurnRecord(channelId, captured, captured.map(message));
    store.appendTurnRecord(record);

    // recentEntries never carries the phantom body verbatim — only its id.
    const persisted = readTurnRecordFile(dir);
    expect(persisted).toContain('"recentEntriesRef"');
    expect(persisted).toContain('9999');

    const read = store.getRecentTurnRecords(channelId, 10);
    const snapshot = read[0]!.observability!.snapshot as unknown as {
      sessionContext: { recentEntries: SessionEntry[] };
      plan: { messages: Array<{ content: string }> };
    };
    // recentEntries drops the unresolvable phantom; the kept entry survives.
    expect(snapshot.sessionContext.recentEntries.map(e => e.content)).toEqual(['kept line']);
    // The rendered view masks the phantom-backed message and keeps the live one.
    expect(snapshot.plan.messages.map(m => m.content)).toEqual(['kept line', REDACTED_MESSAGE_PLACEHOLDER]);
    expect(JSON.stringify(read)).not.toContain('REDACTED SECRET');
  });
});
