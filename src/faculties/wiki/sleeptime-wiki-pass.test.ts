import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeterministicGateEvent } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { Episode } from '../../shared/contracts/episodic-memory.js';
import type { PurrMemory } from '../memory/types.js';
import type {
  EpisodicProcessingWatermark,
  EpisodicProcessingWatermarkScope,
  EpisodicProcessingWatermarkWriteInput,
  EpisodeTimeSearchOptions,
} from '../memory/episodic/store-port.js';
import { WikiStore } from './store.js';
import {
  SleeptimeWikiPass,
  filterPersonalFactProposals,
  isPersonalGuardMemory,
  isWorldCandidateMemory,
  parseWikiPassProposals,
  type WikiPassEpisodicReader,
  type WikiPassMemoryReader,
  type WikiPassProposal,
} from './sleeptime-wiki-pass.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-wiki-pass-'));
  tempDirs.push(dir);
  return dir;
}

function fakeEpisode(partial: Partial<Episode> & { id: string; createdAt: string }): Episode {
  return {
    schemaVersion: 1,
    title: partial.title ?? 'Episode',
    landmark: partial.landmark ?? 'landmark',
    startedAt: partial.startedAt ?? partial.createdAt,
    endedAt: partial.endedAt ?? partial.createdAt,
    participantContactIds: partial.participantContactIds ?? [],
    salience: { score: 0.5 },
    affect: {},
    themes: partial.themes ?? [],
    spanRefs: [],
    artifactRefs: [],
    provenanceRefs: [],
    createdAt: partial.createdAt,
    updatedAt: partial.updatedAt ?? partial.createdAt,
    ...partial,
  } as unknown as Episode;
}

function fakeMemory(partial: Partial<PurrMemory> & { id: string; text: string; extractedAt: number }): PurrMemory {
  return {
    type: partial.type ?? 'semantic',
    importance: 0.6,
    confidence: 0.8,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: 'test',
    lastAccessed: partial.extractedAt,
    accessCount: 0,
    tags: partial.tags ?? [],
    sensitivity: partial.sensitivity ?? 'personal',
    ...partial,
  } as unknown as PurrMemory;
}

class FakeEpisodicStore implements WikiPassEpisodicReader {
  episodes: Episode[] = [];
  watermarks = new Map<string, EpisodicProcessingWatermark>();

  searchByTime(options: EpisodeTimeSearchOptions = {}): Episode[] {
    const from = options.from ? Date.parse(options.from) : Number.NEGATIVE_INFINITY;
    const to = options.to ? Date.parse(options.to) : Number.POSITIVE_INFINITY;
    return this.episodes.filter((episode) => {
      const started = Date.parse(episode.startedAt);
      return started >= from && started <= to;
    });
  }

  getProcessingWatermark(scope: EpisodicProcessingWatermarkScope): EpisodicProcessingWatermark | undefined {
    return this.watermarks.get(`${scope.processor}:${scope.sourceRef}`);
  }

  upsertProcessingWatermark(input: EpisodicProcessingWatermarkWriteInput): EpisodicProcessingWatermark {
    const key = `${input.processor}:${input.sourceRef}`;
    const watermark = {
      id: input.id ?? `wm-${key}`,
      processor: input.processor,
      sourceRef: input.sourceRef,
      previousWatermarkJson: input.previousWatermarkJson ?? {},
      nextWatermarkJson: input.nextWatermarkJson ?? {},
      status: input.status ?? 'active',
      reconciliationStatus: input.reconciliationStatus ?? 'clean',
      artifactsJson: input.artifactsJson ?? {},
      lastProcessedAt: input.lastProcessedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as EpisodicProcessingWatermark;
    this.watermarks.set(key, watermark);
    return watermark;
  }
}

class FakeMemoryStore implements WikiPassMemoryReader {
  memories: PurrMemory[] = [];
  listActiveMemories(): PurrMemory[] {
    return this.memories;
  }
}

function fakeLlm(content: string): { provider: LLMProviderPort; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => ({ content }));
  return { provider: { complete } as unknown as LLMProviderPort, complete };
}

const SESSION_ID = 'discord:123';
const NOW = Date.parse('2026-07-02T04:00:00.000Z');

function buildPass(options: {
  wikiStore: WikiStore;
  episodicStore: WikiPassEpisodicReader;
  memoryStore: WikiPassMemoryReader;
  llm: LLMProviderPort;
  gateEvents: DeterministicGateEvent[];
  now?: () => Date;
}): SleeptimeWikiPass {
  return new SleeptimeWikiPass({
    llmProvider: options.llm,
    wikiStore: options.wikiStore,
    episodicStore: options.episodicStore,
    memoryStore: options.memoryStore,
    now: options.now ?? (() => new Date(NOW)),
    onGateEvent: event => options.gateEvents.push(event),
  });
}

describe('SleeptimeWikiPass gating', () => {
  it('short-circuits with zero LLM spend on an empty day', async () => {
    const wikiStore = new WikiStore(makeWorkspace());
    const gateEvents: DeterministicGateEvent[] = [];
    const { provider, complete } = fakeLlm('{"proposals":[]}');
    const pass = buildPass({
      wikiStore,
      episodicStore: new FakeEpisodicStore(),
      memoryStore: new FakeMemoryStore(),
      llm: provider,
      gateEvents,
    });

    const result = await pass.run({ sessionId: SESSION_ID });

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('no_material');
    expect(complete).not.toHaveBeenCalled();
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({ lane: 'wiki_pass', outcome: 'skipped', reason: 'no_material' });
  });
});

describe('SleeptimeWikiPass writing', () => {
  it('creates a wiki entry with pass-attributed provenance and advances the watermark', async () => {
    const wikiStore = new WikiStore(makeWorkspace());
    const episodicStore = new FakeEpisodicStore();
    episodicStore.episodes.push(fakeEpisode({
      id: 'ep-1',
      title: 'Read about the Marais',
      themes: ['paris', 'history'],
      createdAt: new Date(NOW - 3_600_000).toISOString(),
    }));
    const memoryStore = new FakeMemoryStore();
    memoryStore.memories.push(fakeMemory({
      id: 'mem-1',
      type: 'semantic',
      text: 'The Marais is a historic district spanning the 3rd and 4th arrondissements of Paris.',
      sensitivity: 'public',
      extractedAt: NOW - 3_600_000,
    }));
    const gateEvents: DeterministicGateEvent[] = [];
    const { provider, complete } = fakeLlm(JSON.stringify({
      proposals: [{
        operation: 'create',
        title: 'The Marais',
        summary: 'Historic district of central Paris.',
        body: 'The Marais is a historic district in central Paris, spanning the 3rd and 4th arrondissements.',
        tags: ['paris', 'geography'],
        source_episode_ids: ['ep-1'],
        source_memory_ids: ['mem-1'],
        reason: 'General geographic knowledge, not a personal fact.',
      }],
    }));
    const pass = buildPass({ wikiStore, episodicStore, memoryStore, llm: provider, gateEvents });

    const result = await pass.run({ sessionId: SESSION_ID });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ran: true, entriesCreated: 1, entriesUpdated: 0, proposalsRejected: 0 });
    const docs = wikiStore.list();
    expect(docs).toHaveLength(1);
    const doc = wikiStore.get(docs[0].id);
    expect(doc).toMatchObject({
      title: 'The Marais',
      sourceClass: 'generated_synthesis',
      sensitivity: 'personal',
      updatedBy: 'sleeptime_wiki_pass',
    });
    expect(doc?.provenanceRefs).toEqual(expect.arrayContaining([
      `wiki_pass:${SESSION_ID}`,
      'episode:ep-1',
      'memory:mem-1',
    ]));
    expect(doc?.tags).toContain('wiki-pass');
    // W5b: the pass writes to the PERSONAL store — a sleeptime entry never targets
    // shared world scope (scope is absent == personal, never serialized shared).
    expect(doc).not.toHaveProperty('scope');
    // Watermark advanced so the same material is not re-reviewed next night.
    expect(episodicStore.getProcessingWatermark({ processor: 'wiki_pass', sourceRef: SESSION_ID })).toBeDefined();
    expect(gateEvents.some(event => event.outcome === 'ran' && event.lane === 'wiki_pass')).toBe(true);
  });

  it('prefers updating an existing entry over duplicating it', async () => {
    const workspace = makeWorkspace();
    const wikiStore = new WikiStore(workspace);
    wikiStore.upsert({
      title: 'Rust Ownership',
      body: 'Initial note about ownership.',
      sourceClass: 'companion_authored_note',
    });
    const episodicStore = new FakeEpisodicStore();
    episodicStore.episodes.push(fakeEpisode({ id: 'ep-2', createdAt: new Date(NOW - 3_600_000).toISOString() }));
    const memoryStore = new FakeMemoryStore();
    memoryStore.memories.push(fakeMemory({
      id: 'mem-2', type: 'semantic', sensitivity: 'public',
      text: 'Rust enforces single ownership of each value at compile time.',
      extractedAt: NOW - 3_600_000,
    }));
    const gateEvents: DeterministicGateEvent[] = [];
    const { provider } = fakeLlm(JSON.stringify({
      proposals: [{
        operation: 'update',
        title: 'Rust Ownership',
        body: 'Rust enforces single ownership of each value, checked by the borrow checker at compile time.',
        source_memory_ids: ['mem-2'],
      }],
    }));
    const pass = buildPass({ wikiStore, episodicStore, memoryStore, llm: provider, gateEvents });

    const result = await pass.run({ sessionId: SESSION_ID });

    expect(result).toMatchObject({ ran: true, entriesCreated: 0, entriesUpdated: 1 });
    expect(wikiStore.list()).toHaveLength(1);
    expect(wikiStore.get('rust-ownership')?.version).toBe(2);
  });
});

describe('SleeptimeWikiPass fail-closed on malformed output', () => {
  it('writes nothing and does NOT advance the watermark so the day is retried', async () => {
    const wikiStore = new WikiStore(makeWorkspace());
    const episodicStore = new FakeEpisodicStore();
    episodicStore.episodes.push(fakeEpisode({ id: 'ep-3', createdAt: new Date(NOW - 3_600_000).toISOString() }));
    const memoryStore = new FakeMemoryStore();
    const gateEvents: DeterministicGateEvent[] = [];
    const { provider, complete } = fakeLlm('the model rambled without any JSON at all');
    const pass = buildPass({ wikiStore, episodicStore, memoryStore, llm: provider, gateEvents });

    const result = await pass.run({ sessionId: SESSION_ID });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.skippedReason).toBe('malformed_output');
    expect(wikiStore.list()).toHaveLength(0);
    // Watermark NOT advanced: the same material is reviewed again next night.
    expect(episodicStore.getProcessingWatermark({ processor: 'wiki_pass', sourceRef: SESSION_ID })).toBeUndefined();
    expect(gateEvents.some(event => event.reason === 'malformed_output')).toBe(true);
  });
});

describe('SleeptimeWikiPass personal/world boundary', () => {
  it('does not duplicate a personal-fact bait proposal into the wiki', async () => {
    const wikiStore = new WikiStore(makeWorkspace());
    const episodicStore = new FakeEpisodicStore();
    episodicStore.episodes.push(fakeEpisode({ id: 'ep-4', createdAt: new Date(NOW - 3_600_000).toISOString() }));
    const memoryStore = new FakeMemoryStore();
    // A personal, contact-linked memory that must stay in memory, never the wiki.
    memoryStore.memories.push(fakeMemory({
      id: 'mem-personal',
      type: 'relational',
      contactId: 'contact-marie',
      sensitivity: 'personal',
      text: 'My partner Marie grew up in the Marais district of Paris and misses the bakeries there.',
      extractedAt: NOW - 3_600_000,
    }));
    const gateEvents: DeterministicGateEvent[] = [];
    const { provider } = fakeLlm(JSON.stringify({
      proposals: [{
        operation: 'create',
        title: 'Marie',
        body: 'My partner Marie grew up in the Marais district of Paris and misses the bakeries there.',
        source_memory_ids: ['mem-personal'],
      }],
    }));
    const pass = buildPass({ wikiStore, episodicStore, memoryStore, llm: provider, gateEvents });

    const result = await pass.run({ sessionId: SESSION_ID });

    expect(result.proposalsRejected).toBe(1);
    expect(result.entriesCreated).toBe(0);
    expect(wikiStore.list()).toHaveLength(0);
  });
});

describe('personal-fact guard (pure)', () => {
  const guardMemory = fakeMemory({
    id: 'g-1',
    type: 'relational',
    text: 'My partner Marie grew up in the Marais district of Paris.',
    extractedAt: NOW,
  });

  function proposal(partial: Partial<WikiPassProposal>): WikiPassProposal {
    return {
      operation: 'create',
      title: partial.title ?? 'Title',
      body: partial.body ?? 'body text',
      tags: [],
      sourceEpisodeIds: [],
      sourceMemoryIds: [],
      ...partial,
    };
  }

  it('rejects a proposal that cites a personal memory as its source', () => {
    const result = filterPersonalFactProposals(
      [proposal({ body: 'A neutral looking entry.', sourceMemoryIds: ['g-1'] })],
      [guardMemory],
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toContain('cites personal memory');
  });

  it('rejects a proposal containing a first-person relational marker', () => {
    const result = filterPersonalFactProposals(
      [proposal({ body: 'My partner enjoys long walks by the river.' })],
      [guardMemory],
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toContain('relational marker');
  });

  it('rejects a proposal that substantially restates a personal memory', () => {
    const result = filterPersonalFactProposals(
      [proposal({ body: 'Marie grew up in the Marais district of Paris.' })],
      [guardMemory],
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toContain('restates personal memory');
  });

  it('accepts general world knowledge that only shares place names', () => {
    const result = filterPersonalFactProposals(
      [proposal({
        title: 'The Marais',
        body: 'The Marais is a historic district in central Paris, known for its medieval streets and museums.',
      })],
      [guardMemory],
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });
});

describe('wiki-pass classifiers and parsing', () => {
  it('classifies world-candidate vs personal-guard memories', () => {
    expect(isWorldCandidateMemory(fakeMemory({ id: 'a', text: 't', type: 'semantic', sensitivity: 'public', extractedAt: NOW }))).toBe(true);
    expect(isWorldCandidateMemory(fakeMemory({ id: 'b', text: 't', type: 'procedural', sensitivity: 'personal', extractedAt: NOW }))).toBe(true);
    expect(isWorldCandidateMemory(fakeMemory({ id: 'c', text: 't', type: 'semantic', sensitivity: 'confidential', extractedAt: NOW }))).toBe(false);
    expect(isWorldCandidateMemory(fakeMemory({ id: 'd', text: 't', type: 'semantic', sensitivity: 'public', contactId: 'x', extractedAt: NOW }))).toBe(false);
    expect(isPersonalGuardMemory(fakeMemory({ id: 'e', text: 't', type: 'relational', sensitivity: 'personal', extractedAt: NOW }))).toBe(true);
    expect(isPersonalGuardMemory(fakeMemory({ id: 'f', text: 't', type: 'semantic', sensitivity: 'intimate', extractedAt: NOW }))).toBe(true);
  });

  it('parses a valid proposal envelope and an empty one, and fails closed on malformed output', () => {
    expect(parseWikiPassProposals('{"proposals":[]}')).toEqual([]);
    const parsed = parseWikiPassProposals(JSON.stringify({
      proposals: [{ operation: 'create', title: 'T', body: 'B', tags: ['x'], source_episode_ids: ['e1'] }],
    }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ operation: 'create', title: 'T', body: 'B', sourceEpisodeIds: ['e1'] });
    expect(() => parseWikiPassProposals('not json')).toThrow();
    expect(() => parseWikiPassProposals('{"nope":1}')).toThrow('missing the proposals array');
  });
});
