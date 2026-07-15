import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type { ObservedMemory, ObservedScoredMemory } from '../../core/turns/observability.js';
import { createTurnId } from '../../core/turns/id.js';
import { SessionStore } from './store.js';
import {
  MEMORY_CANDIDATES_REF_FIELD,
  collectTurnRecordMemoryRefIds,
  resolveTurnRecordMemoryCandidates,
  slimTurnRecordMemoryCandidatesForAppend,
} from './turn-record-memory-refs.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-jsi9-'));
  dirs.push(dir);
  return dir;
}

function readTurnRecordFile(dir: string): string {
  const turnDir = join(dir, '_turn_records');
  const files = readdirSync(turnDir).filter(name => name.endsWith('.jsonl'));
  return files.map(name => readFileSync(join(turnDir, name), 'utf8')).join('\n');
}

function observed(id: string, text: string, overrides: Partial<ObservedMemory> = {}): ObservedMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.5,
    confidence: 0.6,
    emotionalValence: 0,
    salience: 0.7,
    sourceRef: 'source:test',
    extractedAt: 1,
    lastAccessed: 2,
    accessCount: 1,
    tags: ['t'],
    sensitivity: 'personal',
    ...overrides,
  } as ObservedMemory;
}

function scored(id: string, text: string, similarity: number): ObservedScoredMemory {
  return { ...observed(id, text), similarity };
}

function buildTurnRecord(channelId: string, memory: Record<string, unknown>): TurnRecord {
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
        memory: { channelId, versionPointer: 'memory-v1', ...memory },
      },
    },
  } as unknown as TurnRecord;
}

function fullMemory(): Record<string, unknown> {
  return {
    contactEmotionalMemories: [observed('mem-ce', 'contact emotional body')],
    semanticCandidates: [scored('mem-sem', 'semantic body', 0.91)],
    lexicalCandidates: [scored('mem-lex', 'lexical body', 0.42)],
    proactiveCandidates: [observed('mem-pro', 'proactive body')],
  };
}

function readSnapshotMemory(record: TurnRecord): Record<string, unknown> {
  return (record.observability!.snapshot as unknown as { memory: Record<string, unknown> }).memory;
}

describe('turn-record retrieved-memory diet (psfn-framework-jsi9)', () => {
  it('erases verbatim memory text from disk and keeps ids+scores; hot-path read stays slim', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:mem-diet';
    store.append({ channelId, role: 'user', content: 'hello', timestamp: 1_000 });

    store.appendTurnRecord(buildTurnRecord(channelId, fullMemory()));

    const persisted = readTurnRecordFile(dir);
    // Every verbatim memory body is gone from disk...
    expect(persisted).not.toContain('contact emotional body');
    expect(persisted).not.toContain('semantic body');
    expect(persisted).not.toContain('lexical body');
    expect(persisted).not.toContain('proactive body');
    // ...replaced by the id+score ref.
    expect(persisted).toContain(MEMORY_CANDIDATES_REF_FIELD);
    expect(persisted).toContain('mem-sem');
    expect(persisted).toContain('0.91');

    // The live-agent hot path (getRecentTurnRecords) does NOT resolve memory:
    // it returns the slim record with the ref and no candidate arrays.
    const [read] = store.getRecentTurnRecords(channelId, 10);
    const memory = readSnapshotMemory(read!);
    expect(memory[MEMORY_CANDIDATES_REF_FIELD]).toBeDefined();
    expect(memory.semanticCandidates).toBeUndefined();
    expect(memory.contactEmotionalMemories).toBeUndefined();
  });

  it('leaves records with no candidates untouched (nothing to slim)', () => {
    const channelId = 'api:empty';
    const record = buildTurnRecord(channelId, {
      contactEmotionalMemories: [],
      semanticCandidates: [],
      lexicalCandidates: [],
      proactiveCandidates: [],
    });
    const slimmed = slimTurnRecordMemoryCandidatesForAppend(record);
    expect(slimmed).toBe(record);
    expect(readSnapshotMemory(slimmed)[MEMORY_CANDIDATES_REF_FIELD]).toBeUndefined();
  });

  it('round-trips candidate text/order via the live-store resolver', () => {
    const channelId = 'api:roundtrip';
    const slimmed = slimTurnRecordMemoryCandidatesForAppend(
      buildTurnRecord(channelId, fullMemory()),
    );
    expect(collectTurnRecordMemoryRefIds(slimmed).sort()).toEqual(
      ['mem-ce', 'mem-lex', 'mem-pro', 'mem-sem'],
    );

    const live = new Map<string, ObservedMemory>([
      ['mem-ce', observed('mem-ce', 'CURRENT contact emotional')],
      ['mem-sem', observed('mem-sem', 'CURRENT semantic')],
      ['mem-lex', observed('mem-lex', 'CURRENT lexical')],
      ['mem-pro', observed('mem-pro', 'CURRENT proactive')],
    ]);
    const resolved = resolveTurnRecordMemoryCandidates(slimmed, id => live.get(id));
    const memory = readSnapshotMemory(resolved);
    expect(memory[MEMORY_CANDIDATES_REF_FIELD]).toBeUndefined();
    // Text is the CURRENT store truth, not the frozen capture-time text.
    expect((memory.contactEmotionalMemories as ObservedMemory[]).map(m => m.text)).toEqual(['CURRENT contact emotional']);
    expect((memory.proactiveCandidates as ObservedMemory[]).map(m => m.text)).toEqual(['CURRENT proactive']);
    // Scored arrays keep the retrieval-time similarity from the ref.
    const sem = memory.semanticCandidates as ObservedScoredMemory[];
    expect(sem).toEqual([expect.objectContaining({ id: 'mem-sem', text: 'CURRENT semantic', similarity: 0.91 })]);
    const lex = memory.lexicalCandidates as ObservedScoredMemory[];
    expect(lex).toEqual([expect.objectContaining({ id: 'mem-lex', text: 'CURRENT lexical', similarity: 0.42 })]);
  });

  it('heals (drops) a memory that is absent/deleted at read time — no resurrection', () => {
    const channelId = 'api:deleted';
    const slimmed = slimTurnRecordMemoryCandidatesForAppend(
      buildTurnRecord(channelId, {
        contactEmotionalMemories: [],
        semanticCandidates: [scored('mem-kept', 'kept body', 0.8), scored('mem-gone', 'SECRET deleted body', 0.7)],
        lexicalCandidates: [],
        proactiveCandidates: [],
      }),
    );
    // The resolver returns the kept memory but treats the deleted one as absent.
    const live = new Map<string, ObservedMemory>([['mem-kept', observed('mem-kept', 'kept body')]]);
    const resolved = resolveTurnRecordMemoryCandidates(slimmed, id => live.get(id));
    const sem = readSnapshotMemory(resolved).semanticCandidates as ObservedScoredMemory[];
    expect(sem.map(m => m.id)).toEqual(['mem-kept']);
    expect(JSON.stringify(resolved)).not.toContain('SECRET deleted body');
  });

  it('fails closed on an ambiguous ref+inline record', () => {
    const channelId = 'api:ambiguous';
    const slimmed = slimTurnRecordMemoryCandidatesForAppend(
      buildTurnRecord(channelId, fullMemory()),
    );
    // Re-introduce an inline array alongside the ref.
    readSnapshotMemory(slimmed).semanticCandidates = [scored('mem-x', 'x', 0.1)];
    expect(() => resolveTurnRecordMemoryCandidates(slimmed, () => undefined)).toThrow(/both inline/);
  });

  it('fails closed on a structurally corrupt ref (bad version)', () => {
    const channelId = 'api:corrupt';
    const slimmed = slimTurnRecordMemoryCandidatesForAppend(
      buildTurnRecord(channelId, fullMemory()),
    );
    (readSnapshotMemory(slimmed)[MEMORY_CANDIDATES_REF_FIELD] as Record<string, unknown>).v = 999;
    expect(() => resolveTurnRecordMemoryCandidates(slimmed, () => undefined)).toThrow(/\.v must be/);
  });

  it('passes old fat records (no ref) through resolution untouched', () => {
    const channelId = 'api:legacy';
    const record = buildTurnRecord(channelId, fullMemory());
    expect(collectTurnRecordMemoryRefIds(record)).toEqual([]);
    const resolved = resolveTurnRecordMemoryCandidates(record, () => undefined);
    expect(resolved).toBe(record);
  });
});
