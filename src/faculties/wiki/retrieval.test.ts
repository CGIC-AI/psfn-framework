import { describe, expect, it, vi } from 'vitest';
import { countTokens } from '../../primitives/llm/tokens.js';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import type { WikiRetrievalSettings } from '../../shared/context-budget.js';
import type { WikiProjectionPort, WikiSemanticMatch } from './pgvector-projection.js';
import type { SharedWikiSearchPort } from './shared-pgvector-projection.js';
import {
  WIKI_CONTEXT_BLOCK_HEADER,
  WikiRetrievalService,
  buildWikiContextBlock,
  mergeWikiSemanticMatches,
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
    scope: overrides.scope ?? 'personal',
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

  // ── W5b scope dimension ──

  it('flag-off carries NO scope restriction (byte-identical to pre-W5b)', () => {
    const off = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: true,
      focusActive: false,
      // multiCompanion omitted → off
      currentSiteId: 'studio', // present but ignored while flag is off
    });
    expect(off).toEqual({ contextClass: 'dm', tokenCap: 1000, similarityThreshold: 0.6 });
    expect(off).not.toHaveProperty('allowedScopes');
  });

  it('under the flag WITH a current site: personal + that site shared scope', () => {
    const plan = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: true,
      focusActive: false,
      multiCompanion: true,
      currentSiteId: 'studio',
    });
    expect(plan?.allowedScopes).toEqual(['personal', 'shared_world:studio']);
  });

  it('under the flag WITHOUT a current site: personal-only (shared does not participate)', () => {
    const plan = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: true,
      focusActive: false,
      multiCompanion: true,
      // no currentSiteId
    });
    expect(plan?.allowedScopes).toEqual(['personal']);
  });

  it('personal scope is ALWAYS present, across every context class', () => {
    for (const turn of [
      { isDirectMessage: true, focusActive: false },
      { isDirectMessage: false, focusActive: false },
      { isDirectMessage: false, focusActive: true },
    ]) {
      const plan = resolveWikiRetrievalPlan({
        settings: makeSettings(),
        ...turn,
        multiCompanion: true,
        currentSiteId: 'studio',
      });
      expect(plan?.allowedScopes).toContain('personal');
    }
  });

  it('swaps the shared scope when the current site changes (personal untouched)', () => {
    const atStudio = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: true,
      focusActive: false,
      multiCompanion: true,
      currentSiteId: 'studio',
    });
    const atCabin = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: true,
      focusActive: false,
      multiCompanion: true,
      currentSiteId: 'cabin',
    });
    expect(atStudio?.allowedScopes).toEqual(['personal', 'shared_world:studio']);
    expect(atCabin?.allowedScopes).toEqual(['personal', 'shared_world:cabin']);
  });

  it('ignores a syntactically invalid current siteId (personal-only, fail closed)', () => {
    const plan = resolveWikiRetrievalPlan({
      settings: makeSettings(),
      isDirectMessage: true,
      focusActive: false,
      multiCompanion: true,
      currentSiteId: 'bad site!', // space + bang are not valid ID token chars
    });
    expect(plan?.allowedScopes).toEqual(['personal']);
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

  // ── W5b scope forwarding: the plan's allowedScopes reach the projection ──

  it('flag-off forwards NO scope filter to the projection (byte-identical query path)', async () => {
    const projection = makeProjection([makeMatch({ chunkText: 'World facts.' })]);
    const service = new WikiRetrievalService({
      projection,
      embedding: fakeEmbedding,
      getSettings: () => makeSettings(),
      // getMultiCompanion omitted → off
    });
    await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true,
      focusActive: false,
      currentSiteId: 'studio',
    });
    // 4th positional arg (scopes) must be undefined → unrestricted, as today.
    expect((projection.search as any).mock.calls[0][3]).toBeUndefined();
  });

  it('under the flag forwards personal + the current site shared scope', async () => {
    const projection = makeProjection([makeMatch({ chunkText: 'World facts.' })]);
    const service = new WikiRetrievalService({
      projection,
      embedding: fakeEmbedding,
      getSettings: () => makeSettings(),
      getMultiCompanion: () => true,
    });
    await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true,
      focusActive: false,
      currentSiteId: 'studio',
    });
    expect((projection.search as any).mock.calls[0][3]).toEqual(['personal', 'shared_world:studio']);
  });

  it('under the flag with no current site forwards personal-only', async () => {
    const projection = makeProjection([makeMatch({ chunkText: 'World facts.' })]);
    const service = new WikiRetrievalService({
      projection,
      embedding: fakeEmbedding,
      getSettings: () => makeSettings(),
      getMultiCompanion: () => true,
    });
    await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true,
      focusActive: false,
    });
    expect((projection.search as any).mock.calls[0][3]).toEqual(['personal']);
  });

  // ── s10f9 retrieval union: shared-schema chunks join personal results ──

  function makeSharedProjection(matches: WikiSemanticMatch[]): SharedWikiSearchPort {
    return { search: vi.fn(async () => matches) };
  }

  it('unions shared-schema matches with personal matches when a shared scope is granted', async () => {
    const personal = makeMatch({ documentId: 'p-doc', score: 0.8, chunkText: 'Personal note.' });
    const shared = makeMatch({
      documentId: 'site-overview',
      scope: 'shared_world:studio',
      score: 0.95,
      chunkText: 'The studio has a satellite in the kitchen.',
    });
    const sharedProjection = makeSharedProjection([shared]);
    const bus = recordingEventBus();
    const service = new WikiRetrievalService({
      projection: makeProjection([personal]),
      sharedProjection,
      embedding: fakeEmbedding,
      eventBus: bus as any,
      getSettings: () => makeSettings(),
      getMultiCompanion: () => true,
    });
    const block = await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'what is in the studio kitchen?',
      isDirectMessage: true,
      focusActive: false,
      currentSiteId: 'studio',
    });
    // Shared search receives ONLY the shared scopes, never personal.
    expect((sharedProjection.search as any).mock.calls[0][3]).toEqual(['shared_world:studio']);
    // Both slices contribute; the higher-scoring shared match ranks first.
    expect(block).toContain('site-overview');
    expect(block).toContain('p-doc');
    expect(block.indexOf('site-overview')).toBeLessThan(block.indexOf('p-doc'));
    expect(bus.events[0]?.payload).toMatchObject({ outcome: 'ran', candidateCount: 2 });
  });

  it('flag-off NEVER consults the shared projection (personal path byte-identical)', async () => {
    const sharedProjection: SharedWikiSearchPort = {
      search: vi.fn(async () => {
        throw new Error('shared projection must not be queried flag-off');
      }),
    };
    const bus = recordingEventBus();
    const personalMatch = makeMatch({ chunkText: 'Personal only.' });
    const withShared = new WikiRetrievalService({
      projection: makeProjection([personalMatch]),
      sharedProjection,
      embedding: fakeEmbedding,
      eventBus: bus as any,
      getSettings: () => makeSettings(),
      // getMultiCompanion omitted → off
    });
    const withoutShared = new WikiRetrievalService({
      projection: makeProjection([personalMatch]),
      embedding: fakeEmbedding,
      getSettings: () => makeSettings(),
    });
    const request = {
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true as const,
      focusActive: false,
      currentSiteId: 'studio',
    };
    const blockWith = await withShared.retrieveContextBlock(request);
    const blockWithout = await withoutShared.retrieveContextBlock(request);
    expect(sharedProjection.search).not.toHaveBeenCalled();
    expect(blockWith).toBe(blockWithout);
    expect(bus.events[0]?.payload).toMatchObject({ outcome: 'ran' });
  });

  it('under the flag with no current site (personal-only grant) skips the shared projection', async () => {
    const sharedProjection = makeSharedProjection([makeMatch({ scope: 'shared_world:studio' })]);
    const service = new WikiRetrievalService({
      projection: makeProjection([makeMatch()]),
      sharedProjection,
      embedding: fakeEmbedding,
      getSettings: () => makeSettings(),
      getMultiCompanion: () => true,
    });
    await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true,
      focusActive: false,
    });
    expect(sharedProjection.search).not.toHaveBeenCalled();
  });

  it('serves personal matches and emits degraded when the shared search throws (partial fail-closed)', async () => {
    const sharedProjection: SharedWikiSearchPort = {
      search: vi.fn(async () => {
        throw new Error('shared schema down');
      }),
    };
    const bus = recordingEventBus();
    const service = new WikiRetrievalService({
      projection: makeProjection([makeMatch({ chunkText: 'Personal still serves.' })]),
      sharedProjection,
      embedding: fakeEmbedding,
      eventBus: bus as any,
      getSettings: () => makeSettings(),
      getMultiCompanion: () => true,
    });
    const block = await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true,
      focusActive: false,
      currentSiteId: 'studio',
    });
    expect(block).toContain(WIKI_CONTEXT_BLOCK_HEADER);
    expect(bus.events[0]?.payload).toMatchObject({ outcome: 'degraded', reason: 'shared_search_failed' });
  });

  it('emits degraded when a shared scope is granted but no shared projection is wired', async () => {
    const bus = recordingEventBus();
    const service = new WikiRetrievalService({
      projection: makeProjection([makeMatch({ chunkText: 'Personal still serves.' })]),
      embedding: fakeEmbedding,
      eventBus: bus as any,
      getSettings: () => makeSettings(),
      getMultiCompanion: () => true,
    });
    const block = await service.retrieveContextBlock({
      channelId: 'c1',
      queryText: 'query',
      isDirectMessage: true,
      focusActive: false,
      currentSiteId: 'studio',
    });
    expect(block).toContain(WIKI_CONTEXT_BLOCK_HEADER);
    expect(bus.events[0]?.payload).toMatchObject({
      outcome: 'degraded',
      reason: 'shared_projection_unavailable',
    });
  });
});

describe('mergeWikiSemanticMatches (union re-rank)', () => {
  it('re-ranks the union by score with the projection comparator, not blind concatenation', () => {
    const merged = mergeWikiSemanticMatches(
      [makeMatch({ documentId: 'p-low', score: 0.5 }), makeMatch({ documentId: 'p-high', score: 0.9 })],
      [makeMatch({ documentId: 's-mid', scope: 'shared_world:studio', score: 0.7 })],
      10,
    );
    expect(merged.map(match => match.documentId)).toEqual(['p-high', 's-mid', 'p-low']);
  });

  it('trims to the candidate limit AFTER re-ranking so weak personal never displaces strong shared', () => {
    const merged = mergeWikiSemanticMatches(
      [makeMatch({ documentId: 'p-weak', score: 0.4 })],
      [makeMatch({ documentId: 's-strong', scope: 'shared_world:studio', score: 0.9 })],
      1,
    );
    expect(merged.map(match => match.documentId)).toEqual(['s-strong']);
  });

  it('dedups on (scope, documentId): same id in different scopes are distinct documents', () => {
    const merged = mergeWikiSemanticMatches(
      [makeMatch({ documentId: 'site-overview', scope: 'personal', score: 0.8 })],
      [makeMatch({ documentId: 'site-overview', scope: 'shared_world:studio', score: 0.7 })],
      10,
    );
    expect(merged).toHaveLength(2);
  });

  it('keeps the best-scoring entry when the same (scope, documentId) appears twice', () => {
    const merged = mergeWikiSemanticMatches(
      [makeMatch({ documentId: 'dup', scope: 'shared_world:studio', score: 0.6, chunkIndex: 1 })],
      [makeMatch({ documentId: 'dup', scope: 'shared_world:studio', score: 0.9, chunkIndex: 2 })],
      10,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.chunkIndex).toBe(2);
  });
});
