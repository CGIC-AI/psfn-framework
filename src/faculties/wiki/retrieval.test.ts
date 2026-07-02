import { describe, expect, it, vi } from 'vitest';
import { countTokens } from '../../primitives/llm/tokens.js';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type { WikiRetrievalSettings } from '../../shared/context-budget.js';
import type { WikiProjectionPort, WikiSemanticMatch } from './pgvector-projection.js';
import {
  WIKI_CONTEXT_BLOCK_HEADER,
  WikiRetrievalService,
  buildWikiContextBlock,
  resolveWikiRetrievalPlan,
} from './retrieval.js';

function makeSettings(overrides: Partial<WikiRetrievalSettings> = {}): WikiRetrievalSettings {
  return {
    enabled: true,
    chatTokenCap: 1000,
    groupTokenCap: 400,
    focusTokenCap: 2000,
    similarityThreshold: 0.6,
    groupSimilarityThreshold: 0.78,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<WikiSemanticMatch> = {}): WikiSemanticMatch {
  return {
    documentId: overrides.documentId ?? 'doc-1',
    title: overrides.title ?? 'Doc One',
    path: overrides.path ?? 'documents/doc-1.md',
    sourceClass: overrides.sourceClass ?? 'companion_authored_note',
    sensitivity: overrides.sensitivity ?? 'personal',
    chunkIndex: overrides.chunkIndex ?? 0,
    chunkText: overrides.chunkText ?? 'Reference chunk text.',
    score: overrides.score ?? 0.9,
  };
}

const fakeEmbedding: EmbeddingProviderPort = {
  embed: async () => new Float32Array([1]),
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1])),
  dims: 1,
};

describe('resolveWikiRetrievalPlan (deterministic gate)', () => {
  it('returns null when wiki retrieval is disabled (does not run every turn)', () => {
    const plan = resolveWikiRetrievalPlan({
      settings: makeSettings({ enabled: false }),
      isDirectMessage: true,
      focusActive: false,
    });
    expect(plan).toBeNull();
  });

  it('uses the DM cap + base threshold for direct messages', () => {
    const plan = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: true,
      focusActive: false,
    });
    expect(plan).toEqual({ contextClass: 'dm', tokenCap: 1000, similarityThreshold: 0.6 });
  });

  it('uses the conservative group cap + stricter threshold for group chats', () => {
    const plan = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: false,
      focusActive: false,
    });
    expect(plan).toEqual({ contextClass: 'group', tokenCap: 400, similarityThreshold: 0.78 });
  });

  it('uses the higher focus cap for project/focus-scoped turns (wins over group)', () => {
    const plan = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: false,
      focusActive: true,
    });
    expect(plan).toEqual({ contextClass: 'focus', tokenCap: 2000, similarityThreshold: 0.6 });
  });

  it('returns null when the relevant context class cap is zero', () => {
    const plan = resolveWikiRetrievalPlan({
      settings: makeSettings({ groupTokenCap: 0 }),
      isDirectMessage: false,
      focusActive: false,
    });
    expect(plan).toBeNull();
  });
});

describe('buildWikiContextBlock (own bounded budget)', () => {
  it('labels the block distinctly so wiki is never conflated with memory', () => {
    const result = buildWikiContextBlock([makeMatch()], 1000);
    expect(result.block.startsWith(WIKI_CONTEXT_BLOCK_HEADER)).toBe(true);
    expect(result.selectedCount).toBe(1);
  });

  it('never exceeds its token cap even when many matches are supplied', () => {
    const matches = Array.from({ length: 20 }, (_unused, index) => makeMatch({
      documentId: `doc-${index}`,
      title: `Doc ${index}`,
      chunkText: `Reference chunk ${index} `.repeat(40),
    }));
    const cap = 300;
    const result = buildWikiContextBlock(matches, cap);
    expect(result.tokenCount).toBeLessThanOrEqual(cap);
    expect(countTokens(result.block)).toBeLessThanOrEqual(cap);
    expect(result.selectedCount).toBeLessThan(matches.length);
  });

  it('truncates a single oversized match to fit the cap rather than overflowing', () => {
    const huge = makeMatch({ chunkText: 'word '.repeat(5000) });
    const cap = 120;
    const result = buildWikiContextBlock([huge], cap);
    expect(result.selectedCount).toBe(1);
    expect(result.tokenCount).toBeLessThanOrEqual(cap);
  });

  it('returns an empty block for a zero cap', () => {
    const result = buildWikiContextBlock([makeMatch()], 0);
    expect(result).toEqual({ block: '', tokenCount: 0, selectedCount: 0 });
  });
});

describe('WikiRetrievalService', () => {
  function makeProjection(matches: WikiSemanticMatch[]): WikiProjectionPort {
    return {
      syncDocument: vi.fn(),
      removeDocument: vi.fn(),
      rebuild: vi.fn(),
      listProjectedShas: vi.fn(),
      search: vi.fn(async () => matches),
    } as unknown as WikiProjectionPort;
  }

  function recordingEventBus() {
    const events: Array<{ type: string; payload: any }> = [];
    return {
      events,
      emit: vi.fn(async (type: string, payload: any) => {
        events.push({ type, payload });
      }),
    };
  }

  it('skips and emits when disabled (never runs every turn)', async () => {
    const bus = recordingEventBus();
    const service = new WikiRetrievalService({
      projection: makeProjection([makeMatch()]),
      embedding: fakeEmbedding,
      eventBus: bus as any,
      getSettings: () => makeSettings({ enabled: false }),
    });
    const block = await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'anything',
      isDirectMessage: true,
      focusActive: false,
    });
    expect(block).toBe('');
    expect(bus.events[0]?.payload).toMatchObject({ outcome: 'skipped', reason: 'disabled' });
  });

  it('returns a capped, labeled block and emits ran when matches are found', async () => {
    const bus = recordingEventBus();
    const service = new WikiRetrievalService({
      projection: makeProjection([makeMatch({ chunkText: 'Gateways are separate from Garden.' })]),
      embedding: fakeEmbedding,
      eventBus: bus as any,
      getSettings: () => makeSettings(),
    });
    const block = await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'how do gateways relate to garden?',
      isDirectMessage: true,
      focusActive: false,
    });
    expect(block).toContain(WIKI_CONTEXT_BLOCK_HEADER);
    expect(countTokens(block)).toBeLessThanOrEqual(1000);
    expect(bus.events[0]?.payload).toMatchObject({ outcome: 'ran', contextClass: 'dm' });
  });

  it('fails closed to an empty block and emits degraded when search throws', async () => {
    const bus = recordingEventBus();
    const projection = makeProjection([]);
    (projection.search as any) = vi.fn(async () => {
      throw new Error('pgvector down');
    });
    const service = new WikiRetrievalService({
      projection,
      embedding: fakeEmbedding,
      eventBus: bus as any,
      getSettings: () => makeSettings(),
    });
    const block = await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true,
      focusActive: false,
    });
    expect(block).toBe('');
    expect(bus.events[0]?.payload).toMatchObject({ outcome: 'degraded' });
  });

  it('skips with below_threshold when no candidates clear the similarity gate', async () => {
    const bus = recordingEventBus();
    const service = new WikiRetrievalService({
      projection: makeProjection([]),
      embedding: fakeEmbedding,
      eventBus: bus as any,
      getSettings: () => makeSettings(),
    });
    const block = await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true,
      focusActive: false,
    });
    expect(block).toBe('');
    expect(bus.events[0]?.payload).toMatchObject({ outcome: 'skipped', reason: 'below_threshold' });
  });
});
