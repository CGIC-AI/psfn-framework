import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../core/session/types.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { buildCogSecTombstoneContent } from '../../core/cogsec/tombstones.js';
import {
  RECENT_ENTRIES_REF_FIELD,
  REDACTED_MESSAGE_PLACEHOLDER,
  slimTurnRecordSessionEntriesForAppend,
  resolveTurnRecordSessionEntries,
  type SessionEntryRangeResolver,
} from './turn-record-session-refs.js';

function entry(id: number, content: string, channelId = 'ch:a', role: SessionEntry['role'] = 'user'): SessionEntry {
  return { id, channelId, role, content, timestamp: id * 1_000 };
}

interface RecordShape {
  sessionContext?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  channelId?: string;
}

function buildRecord(shape: RecordShape): TurnRecord {
  const snapshot: Record<string, unknown> = {
    turnId: 'turn-1',
    requestId: 'req-1',
    channelId: shape.channelId ?? 'ch:a',
    capturedAt: 1,
    trustLevel: 'regular',
    ...(shape.sessionContext ? { sessionContext: shape.sessionContext } : {}),
    ...(shape.plan ? { plan: shape.plan } : {}),
  };
  return {
    schemaVersion: 1,
    turnId: 'turn-1',
    requestId: 'req-1',
    channelId: shape.channelId ?? 'ch:a',
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
    observability: { stages: [], retrievals: [], snapshot },
  } as unknown as TurnRecord;
}

function sessionContext(record: TurnRecord): Record<string, unknown> {
  return (record.observability!.snapshot as unknown as Record<string, unknown>).sessionContext as Record<string, unknown>;
}

function planMessages(record: TurnRecord): Array<Record<string, unknown>> {
  const plan = (record.observability!.snapshot as unknown as Record<string, unknown>).plan as Record<string, unknown>;
  return plan.messages as Array<Record<string, unknown>>;
}

/** Resolver over an in-memory L0: `${channelId}:${id}` → entry, inclusive-range filtered. */
function resolverFor(entries: SessionEntry[]): SessionEntryRangeResolver {
  return (channelId, min, max) => entries.filter(
    e => e.channelId === channelId && e.id >= min && e.id <= max,
  );
}

describe('turn-record session-entry diet (psfn-framework-9ree)', () => {
  describe('recentEntries slim + resolve', () => {
    it('replaces verbatim recentEntries with an id-range ref and never persists the body', () => {
      const entries = [entry(1, 'hello'), entry(2, 'there'), entry(3, 'friend')];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: entries } });
      const slim = slimTurnRecordSessionEntriesForAppend(record);
      const ctx = sessionContext(slim);
      expect(ctx.recentEntries).toBeUndefined();
      expect(ctx[RECENT_ENTRIES_REF_FIELD]).toEqual({ v: 1, channelId: 'ch:a', items: [1, 2, 3] });
      // Redaction-safety: no verbatim body in the persisted shape.
      expect(JSON.stringify(slim)).not.toContain('hello');
      expect(JSON.stringify(slim)).not.toContain('friend');
    });

    it('reconstructs recentEntries from L0 in captured order', () => {
      const entries = [entry(1, 'hello'), entry(2, 'there'), entry(3, 'friend')];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: entries } });
      const slim = slimTurnRecordSessionEntriesForAppend(record);
      const resolved = resolveTurnRecordSessionEntries(slim, resolverFor(entries));
      expect(sessionContext(resolved).recentEntries).toEqual(entries);
      expect(sessionContext(resolved)[RECENT_ENTRIES_REF_FIELD]).toBeUndefined();
    });

    it('drops an entry that is now absent from L0 (redacted-as-tombstone / rolled off) without resurrecting it', () => {
      const captured = [entry(1, 'keep'), entry(2, 'SECRET'), entry(3, 'keep2')];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: captured } });
      const slim = slimTurnRecordSessionEntriesForAppend(record);
      // L0 no longer has entry 2.
      const resolved = resolveTurnRecordSessionEntries(slim, resolverFor([entry(1, 'keep'), entry(3, 'keep2')]));
      const recent = sessionContext(resolved).recentEntries as SessionEntry[];
      expect(recent.map(e => e.id)).toEqual([1, 3]);
      expect(JSON.stringify(resolved)).not.toContain('SECRET');
    });

    it('surfaces the CogSec redaction marker from L0, never the captured plaintext', () => {
      const captured = [entry(2, 'original text')];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: captured } });
      const slim = slimTurnRecordSessionEntriesForAppend(record);
      const marker = buildCogSecTombstoneContent('cogsec_case123');
      const resolved = resolveTurnRecordSessionEntries(slim, resolverFor([entry(2, marker)]));
      const recent = sessionContext(resolved).recentEntries as SessionEntry[];
      expect(recent[0]!.content).toBe(marker);
      expect(JSON.stringify(resolved)).not.toContain('original text');
    });

    it('keeps an entry with no positive L0 id inline as a divergence delta', () => {
      const synthetic = { id: 0, channelId: 'ch:a', role: 'system' as const, content: 'synthetic', timestamp: 5 };
      const captured = [entry(1, 'real'), synthetic];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: captured } });
      const slim = slimTurnRecordSessionEntriesForAppend(record);
      const ref = sessionContext(slim)[RECENT_ENTRIES_REF_FIELD] as { items: unknown[] };
      expect(ref.items[0]).toBe(1);
      expect(ref.items[1]).toEqual({ delta: synthetic });
      const resolved = resolveTurnRecordSessionEntries(slim, resolverFor([entry(1, 'real')]));
      expect(sessionContext(resolved).recentEntries).toEqual([entry(1, 'real'), synthetic]);
    });

    it('leaves the record unchanged when no entry can be referenced (all deltas)', () => {
      const captured = [{ id: 0, channelId: 'ch:a', role: 'system' as const, content: 's', timestamp: 5 }];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: captured } });
      const slim = slimTurnRecordSessionEntriesForAppend(record);
      expect(sessionContext(slim).recentEntries).toEqual(captured);
      expect(sessionContext(slim)[RECENT_ENTRIES_REF_FIELD]).toBeUndefined();
    });

    it('redaction-gates an old fat record (inline entries, no ref) against L0 on read', () => {
      // hgw3.10: an old fat record whose inline entry is still live in L0 keeps
      // its content, but the gating DOES re-read L0 (no longer a blind passthrough).
      const entries = [entry(1, 'hello')];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: entries } });
      const resolve = vi.fn(resolverFor(entries));
      const resolved = resolveTurnRecordSessionEntries(record, resolve);
      expect(sessionContext(resolved).recentEntries).toEqual(entries);
      expect(resolve).toHaveBeenCalledWith('ch:a', 1, 1);
    });

    it('passes an old fat record with only divergence deltas (no L0 id) through untouched', () => {
      // All entries lack a positive L0 id → nothing is CogSec-redactable → no read.
      const captured = [{ id: 0, channelId: 'ch:a', role: 'system' as const, content: 'synthetic', timestamp: 5 }];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: captured } });
      const resolve = vi.fn(resolverFor([]));
      const resolved = resolveTurnRecordSessionEntries(record, resolve);
      expect(sessionContext(resolved).recentEntries).toEqual(captured);
      expect(resolve).not.toHaveBeenCalled();
    });

    it('never resurrects an old fat record\'s inline plaintext after its L0 entry is redacted', () => {
      // hgw3.10 regression: pre-9ree record froze verbatim plaintext inline. Once
      // L0 entry 2 is CogSec-tombstoned, the read MUST surface the marker, never
      // the captured plaintext.
      const captured = [entry(1, 'keep'), entry(2, 'SECRET plaintext'), entry(3, 'keep2')];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: captured } });
      const marker = buildCogSecTombstoneContent('cogsec_case_oldfat');
      const resolved = resolveTurnRecordSessionEntries(
        record,
        resolverFor([entry(1, 'keep'), entry(2, marker), entry(3, 'keep2')]),
      );
      const recent = sessionContext(resolved).recentEntries as SessionEntry[];
      expect(recent.map(e => e.content)).toEqual(['keep', marker, 'keep2']);
      expect(JSON.stringify(resolved)).not.toContain('SECRET plaintext');
    });

    it('drops (heals) an old fat record\'s inline entry that is now absent from L0, no resurrection', () => {
      const captured = [entry(1, 'keep'), entry(2, 'GONE secret'), entry(3, 'keep2')];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: captured } });
      // L0 no longer holds entry 2 (redacted-as-tombstone / rolled off).
      const resolved = resolveTurnRecordSessionEntries(record, resolverFor([entry(1, 'keep'), entry(3, 'keep2')]));
      const recent = sessionContext(resolved).recentEntries as SessionEntry[];
      expect(recent.map(e => e.id)).toEqual([1, 3]);
      expect(JSON.stringify(resolved)).not.toContain('GONE secret');
    });

    it('emits a heal-drop signal for an old fat inline drop and a ref-backed drop', () => {
      // Old fat inline drop.
      const inlineDrops: unknown[] = [];
      const fat = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: [entry(1, 'a'), entry(2, 'gone')] } });
      resolveTurnRecordSessionEntries(fat, resolverFor([entry(1, 'a')]), d => inlineDrops.push(d));
      expect(inlineDrops).toEqual([
        { channelId: 'ch:a', entryId: 2, source: 'inline-old-fat', turnId: 'turn-1' },
      ]);

      // Ref-backed drop (slim first, then drop entry 2 from L0).
      const refDrops: unknown[] = [];
      const slim = slimTurnRecordSessionEntriesForAppend(
        buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: [entry(1, 'a'), entry(2, 'gone')] } }),
      );
      resolveTurnRecordSessionEntries(slim, resolverFor([entry(1, 'a')]), d => refDrops.push(d));
      expect(refDrops).toEqual([
        { channelId: 'ch:a', entryId: 2, source: 'ref-backed', turnId: 'turn-1' },
      ]);
    });

    it('does not emit a heal-drop when an entry resolves to a redaction marker (present, not dropped)', () => {
      const drops: unknown[] = [];
      const record = buildRecord({ sessionContext: { channelId: 'ch:a', recentEntries: [entry(2, 'original')] } });
      const marker = buildCogSecTombstoneContent('cogsec_present');
      resolveTurnRecordSessionEntries(record, resolverFor([entry(2, marker)]), d => drops.push(d));
      expect(drops).toEqual([]);
    });

    it('fails closed when a record carries BOTH inline recentEntries and a ref', () => {
      const record = buildRecord({
        sessionContext: {
          channelId: 'ch:a',
          recentEntries: [entry(1, 'hi')],
          [RECENT_ENTRIES_REF_FIELD]: { v: 1, channelId: 'ch:a', items: [1] },
        },
      });
      expect(() => resolveTurnRecordSessionEntries(record, resolverFor([entry(1, 'hi')]))).toThrow(/both inline recentEntries/);
    });

    it('fails closed on a structurally corrupt ref', () => {
      const badVersion = buildRecord({
        sessionContext: { channelId: 'ch:a', [RECENT_ENTRIES_REF_FIELD]: { v: 2, channelId: 'ch:a', items: [1] } },
      });
      expect(() => resolveTurnRecordSessionEntries(badVersion, resolverFor([]))).toThrow(/\.v/);

      const badId = buildRecord({
        sessionContext: { channelId: 'ch:a', [RECENT_ENTRIES_REF_FIELD]: { v: 1, channelId: 'ch:a', items: [-4] } },
      });
      expect(() => resolveTurnRecordSessionEntries(badId, resolverFor([]))).toThrow(/positive integer/);

      const badChannel = buildRecord({
        sessionContext: { channelId: 'ch:a', [RECENT_ENTRIES_REF_FIELD]: { v: 1, channelId: '', items: [1] } },
      });
      expect(() => resolveTurnRecordSessionEntries(badChannel, resolverFor([]))).toThrow(/channelId/);
    });
  });

  it('leaves continuityEntries inline (cross-channel dedup is out of scope)', () => {
    const continuity = [entry(7, 'from-a', 'ch:a'), entry(4, 'from-b', 'ch:b')];
    const record = buildRecord({ sessionContext: { channelId: 'ch:a', continuityEntries: continuity } });
    const slim = slimTurnRecordSessionEntriesForAppend(record);
    expect(sessionContext(slim).continuityEntries).toEqual(continuity);
  });

  describe('plan.messages redaction gating', () => {
    function message(content: string, sourceEntryIds?: number[]): Record<string, unknown> {
      return {
        role: 'user',
        content,
        ...(sourceEntryIds ? { provenance: { sourceEntryIds } } : {}),
      };
    }

    it('masks a message whose backing L0 entry is now absent', () => {
      const record = buildRecord({
        channelId: 'ch:a',
        sessionContext: { channelId: 'ch:a' },
        plan: { messages: [message('gone', [2]), message('kept', [1])] },
      });
      const resolved = resolveTurnRecordSessionEntries(record, resolverFor([entry(1, 'kept')]));
      const msgs = planMessages(resolved);
      expect(msgs[0]!.content).toBe(REDACTED_MESSAGE_PLACEHOLDER);
      expect(msgs[1]!.content).toBe('kept');
      expect(JSON.stringify(resolved)).not.toContain('gone');
    });

    it('masks a message whose backing L0 entry resolves to a redaction marker', () => {
      const record = buildRecord({
        channelId: 'ch:a',
        sessionContext: { channelId: 'ch:a' },
        plan: { messages: [message('secret body', [5])] },
      });
      const marker = buildCogSecTombstoneContent('cogsec_case9');
      const resolved = resolveTurnRecordSessionEntries(record, resolverFor([entry(5, marker)]));
      expect(planMessages(resolved)[0]!.content).toBe(REDACTED_MESSAGE_PLACEHOLDER);
      expect(JSON.stringify(resolved)).not.toContain('secret body');
    });

    it('masks a merged multi-id message when any backing id is gone', () => {
      const record = buildRecord({
        channelId: 'ch:a',
        sessionContext: { channelId: 'ch:a' },
        plan: { messages: [message('a\nb', [1, 2])] },
      });
      const resolved = resolveTurnRecordSessionEntries(record, resolverFor([entry(1, 'a')]));
      expect(planMessages(resolved)[0]!.content).toBe(REDACTED_MESSAGE_PLACEHOLDER);
    });

    it('leaves synthetic (no sourceEntryIds) and still-live messages untouched', () => {
      const record = buildRecord({
        channelId: 'ch:a',
        sessionContext: { channelId: 'ch:a' },
        plan: { messages: [message('summary'), message('live', [1])] },
      });
      const resolved = resolveTurnRecordSessionEntries(record, resolverFor([entry(1, 'live')]));
      const msgs = planMessages(resolved);
      expect(msgs[0]!.content).toBe('summary');
      expect(msgs[1]!.content).toBe('live');
    });

    it('falls back to the record channelId when sessionContext has none', () => {
      const record = buildRecord({
        channelId: 'ch:z',
        plan: { messages: [message('kept', [1])] },
      });
      const resolve = vi.fn(resolverFor([entry(1, 'kept', 'ch:z')]));
      resolveTurnRecordSessionEntries(record, resolve);
      expect(resolve).toHaveBeenCalledWith('ch:z', 1, 1);
    });
  });
});
