import { performance } from 'node:perf_hooks';
import type {
  L01FixtureEpisode,
  L2FixtureMemory,
  MemoryBackupSnapshot,
  MemoryRegressionFixture,
  MemoryRegressionProvider,
  MemoryRetrievalObservation,
  MemoryRetrievalProbe,
  MemoryTrustLevel,
  MemoryWriteObservation,
  MemoryWriteOperation,
  MemoryMaintenanceObservation,
  L0FixtureEntry,
} from './types.js';

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'in',
  'is',
  'my',
  'of',
  'on',
  'the',
  'to',
  'with',
]);

const TRUST_RANK: Record<MemoryTrustLevel, number> = {
  untrusted: 0,
  regular: 1,
  trusted: 2,
  primary: 3,
};

const SENSITIVITY_TRUST_FLOOR = {
  public: 'untrusted',
  personal: 'regular',
  private: 'trusted',
  secret: 'primary',
} as const;

function cloneL0(entries: readonly L0FixtureEntry[]): L0FixtureEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function cloneEpisodes(episodes: readonly L01FixtureEpisode[]): L01FixtureEpisode[] {
  return episodes.map((episode) => ({
    ...episode,
    salientFacts: [...episode.salientFacts],
    provenanceRefs: [...episode.provenanceRefs],
  }));
}

function cloneMemories(memories: readonly L2FixtureMemory[]): L2FixtureMemory[] {
  return memories.map((memory) => ({
    ...memory,
    tags: [...memory.tags],
    sourceRefs: [...memory.sourceRefs],
    ...(memory.retrievalPolicy ? { retrievalPolicy: { ...memory.retrievalPolicy } } : {}),
  }));
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_/:-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function countApproxPromptTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3));
}

function similarityScore(query: string, memory: L2FixtureMemory): number {
  const queryTokens = tokenize(query);
  const memoryTokens = tokenize(`${memory.text} ${memory.tags.join(' ')}`);
  let score = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) score += 1;
  }
  return score;
}

function canRecall(memory: L2FixtureMemory, trustLevel: MemoryTrustLevel): boolean {
  if (memory.retrievalPolicy && !memory.retrievalPolicy.allowRecall) {
    return false;
  }
  const requiredTrust = SENSITIVITY_TRUST_FLOOR[memory.sensitivity];
  return TRUST_RANK[trustLevel] >= TRUST_RANK[requiredTrust];
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('\u0000');
}

function groupPairs(group: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let left = 0; left < group.length; left += 1) {
    for (let right = left + 1; right < group.length; right += 1) {
      const a = group[left];
      const b = group[right];
      if (a && b) pairs.push([a, b]);
    }
  }
  return pairs;
}

export class DeterministicMemoryRegressionProvider implements MemoryRegressionProvider {
  readonly id = 'deterministic-fixture-v1';

  protected l0Entries = new Map<string, L0FixtureEntry>();
  protected episodes = new Map<string, L01FixtureEpisode>();
  protected memories = new Map<string, L2FixtureMemory>();

  async seedFixture(fixture: MemoryRegressionFixture): Promise<void> {
    this.l0Entries = new Map(cloneL0(fixture.seed.l0Entries).map((entry) => [entry.id, entry]));
    this.episodes = new Map(cloneEpisodes(fixture.seed.l01Episodes).map((episode) => [episode.id, episode]));
    this.memories = new Map(cloneMemories(fixture.seed.l2Memories).map((memory) => [memory.id, memory]));
  }

  async writeMemory(operation: MemoryWriteOperation): Promise<MemoryWriteObservation> {
    const memory: L2FixtureMemory = {
      layer: 'L2',
      id: operation.createsMemoryId,
      text: operation.text,
      tags: [...operation.tags],
      sensitivity: operation.sensitivity,
      sourceRefs: [operation.sourceRef],
      createdAt: operation.timestamp,
      confidence: 0.9,
    };
    for (const supersededId of operation.expectedSupersededMemoryIds) {
      const existing = this.memories.get(supersededId);
      if (existing) {
        this.memories.set(supersededId, {
          ...existing,
          supersededBy: operation.createsMemoryId,
        });
      }
    }
    this.memories.set(memory.id, memory);
    return {
      operationId: operation.id,
      createdMemoryId: memory.id,
      supersededMemoryIds: [...operation.expectedSupersededMemoryIds],
    };
  }

  async runMaintenance(fixture: MemoryRegressionFixture): Promise<MemoryMaintenanceObservation> {
    const mergedEpisodePairs: Array<[string, string]> = [];
    for (const group of fixture.maintenance?.expectedEpisodeMergeGroups ?? []) {
      const canonicalId = group[0];
      if (!canonicalId) continue;
      for (const duplicateId of group.slice(1)) {
        if (this.episodes.has(canonicalId) && this.episodes.has(duplicateId)) {
          this.episodes.delete(duplicateId);
        }
      }
      mergedEpisodePairs.push(...groupPairs(group));
    }

    const queueAgeMs = (fixture.maintenance?.queueItems ?? []).map((item) => (
      Date.parse(item.processedAt) - Date.parse(item.enqueuedAt)
    ));

    return {
      fixtureId: fixture.id,
      mergedEpisodePairs: dedupePairs(mergedEpisodePairs),
      activeEpisodeIds: [...this.episodes.keys()].sort(),
      queueAgeMs,
    };
  }

  async retrieve(probe: MemoryRetrievalProbe): Promise<MemoryRetrievalObservation> {
    const startedAt = performance.now();
    const scored = [...this.memories.values()]
      .filter((memory) => !memory.supersededBy)
      .map((memory) => ({
        memory,
        score: similarityScore(probe.query, memory),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const createdDelta = Date.parse(b.memory.createdAt) - Date.parse(a.memory.createdAt);
        if (createdDelta !== 0) return createdDelta;
        return a.memory.id.localeCompare(b.memory.id);
      });

    const selected: L2FixtureMemory[] = [];
    const withheld: L2FixtureMemory[] = [];
    for (const candidate of scored) {
      if (canRecall(candidate.memory, probe.trustLevel)) {
        if (selected.length < probe.topK) selected.push(candidate.memory);
      } else {
        withheld.push(candidate.memory);
      }
    }

    const promptSnippet = selected.map((memory) => `<memory id="${memory.id}">${memory.text}</memory>`).join('\n');
    return {
      probeId: probe.id,
      selectedMemoryIds: selected.map((memory) => memory.id),
      withheldMemoryIds: withheld.map((memory) => memory.id),
      promptSnippet,
      promptTokenCount: countApproxPromptTokens(`${probe.query}\n${promptSnippet}`),
      latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    };
  }

  async backup(): Promise<MemoryBackupSnapshot> {
    return {
      l0Entries: cloneL0([...this.l0Entries.values()]),
      l01Episodes: cloneEpisodes([...this.episodes.values()]),
      l2Memories: cloneMemories([...this.memories.values()]),
    };
  }

  async restore(snapshot: MemoryBackupSnapshot): Promise<void> {
    this.l0Entries = new Map(cloneL0(snapshot.l0Entries).map((entry) => [entry.id, entry]));
    this.episodes = new Map(cloneEpisodes(snapshot.l01Episodes).map((episode) => [episode.id, episode]));
    this.memories = new Map(cloneMemories(snapshot.l2Memories).map((memory) => [memory.id, memory]));
  }
}

function dedupePairs(pairs: readonly Array<[string, string]>): Array<[string, string]> {
  const seen = new Set<string>();
  const deduped: Array<[string, string]> = [];
  for (const [a, b] of pairs) {
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push([a, b]);
  }
  return deduped;
}
