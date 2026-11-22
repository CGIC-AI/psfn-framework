import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { DecisionOutcome, DecisionRequest } from '../../../primitives/llm/decision/types.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import { buildMergeChains } from './sleep-consolidation.js';
import { EpisodicSynthesizer } from './synthesis.js';
import { findRelatedSource } from './synthesis/consolidation.js';
import {
  classifyEpisodeThemes,
  isBroadTaxonomyTheme,
  isNonSubstantiveTheme,
  type EpisodicThemeDecisionPort,
} from './theme-classification.js';
import { retrieveEpisodicChains } from '../retrieval/episodic.js';
import type { MemorySessionQuarantineFilter } from '../retrieval/session-quarantine.js';
import { resolveEpisodicChains } from '../retrieval/episodic-resolution.js';

function makeEntry(
  id: number,
  timestampIso: string,
  role: 'user' | 'assistant',
  content: string,
  channelId = 'discord:dm-1',
): SessionEntry {
  return {
    id,
    channelId,
    role,
    content,
    authorId: role === 'user' ? 'user-1' : 'assistant-1',
    authorName: role === 'user' ? 'Alex' : 'Companion',
    timestamp: Date.parse(timestampIso),
  };
}

function makeEpisode(overrides: Partial<Episode> & { id: string }): Episode {
  const startedAt = overrides.startedAt ?? '2026-06-10T10:00:00.000Z';
  const endedAt = overrides.endedAt ?? '2026-06-10T10:15:00.000Z';
  return {
    schemaVersion: 2,
    title: overrides.title ?? overrides.id,
    landmark: overrides.landmark ?? `Landmark for ${overrides.id}`,
    startedAt,
    endedAt,
    threadId: overrides.threadId ?? overrides.id,
    channelId: overrides.channelId ?? 'discord:dm-1',
    participantContactIds: overrides.participantContactIds ?? ['contact:alex'],
    salience: overrides.salience ?? { score: 0.7 },
    affect: overrides.affect ?? { labels: [] },
    themes: overrides.themes ?? ['paris-trip'],
    spanRefs: overrides.spanRefs ?? [{
      spanId: `span:${overrides.id}`,
      channelId: overrides.channelId ?? 'discord:dm-1',
      sessionId: overrides.channelId ?? 'discord:dm-1',
      startedAt,
      endedAt,
    }],
    artifactRefs: overrides.artifactRefs ?? [],
    provenanceRefs: overrides.provenanceRefs ?? [{
      kind: 'session',
      refId: overrides.channelId ?? 'discord:dm-1',
    }],
    createdAt: startedAt,
    updatedAt: endedAt,
    ...overrides,
  };
}

function makeDecisionPort(
  responder: (req: DecisionRequest) => Promise<DecisionOutcome> | DecisionOutcome,
  siteOverride?: { enabled?: boolean; threshold?: number },
): EpisodicThemeDecisionPort {
  return {
    decide: vi.fn(async (req: DecisionRequest) => await responder(req)),
    siteSettings: vi.fn(() => siteOverride),
  };
}

describe('Phase 2.1 episodic theme classification & bounded consolidation (psfn-framework-eoj3s.1)', () => {
  it('classifies semantic life themes via decision model in one batched call and preserves topic slug', async () => {
    const decisions = makeDecisionPort((req) => {
      expect(req.siteId).toBe('memory.episodic_themes');
      expect(Object.keys(req.questions)).toContain('planning_and_events');
      expect(Object.keys(req.questions)).toContain('romance_and_affection');
      expect(Object.keys(req.questions)).toContain('future_and_goals');
      return {
        ok: true,
        backend: 'jev',
        probabilitySource: 'jev',
        latencyMs: 12,
        answers: {
          planning_and_events: { type: 'noul', pYes: 0.91 },
          romance_and_affection: { type: 'noul', pYes: 0.78 },
          future_and_goals: { type: 'noul', pYes: 0.62 },
          career_and_work: { type: 'noul', pYes: 0.08 },
        },
      };
    });

    const themes = await classifyEpisodeThemes({
      sessionId: 'discord:dm-1',
      channelId: 'discord:dm-1',
      topic: 'Paris autumn trip planning',
      entries: [
        makeEntry(1, '2026-06-10T10:00:00.000Z', 'user', 'I think we should really make time for our Paris trip together.'),
        makeEntry(2, '2026-06-10T10:02:00.000Z', 'assistant', 'I would love walking by the Seine with you this autumn.'),
      ],
      decisions,
    });

    expect(themes).toEqual([
      'paris-autumn-trip-planning',
      'planning_and_events',
      'romance_and_affection',
      'future_and_goals',
    ]);
    expect(isBroadTaxonomyTheme('planning_and_events')).toBe(true);
    expect(isBroadTaxonomyTheme('paris-autumn-trip-planning')).toBe(false);
  });

  it('never promotes conversational filler words as fallback themes', async () => {
    const themes = await classifyEpisodeThemes({
      sessionId: 'discord:dm-1',
      channelId: 'discord:dm-1',
      entries: [
        makeEntry(1, '2026-06-10T10:00:00.000Z', 'user', 'Yeah I really think I know good time want make going things right okay.'),
        makeEntry(2, '2026-06-10T10:02:00.000Z', 'assistant', 'Sure really think good time want make going things.'),
      ],
    });

    expect(themes).toEqual(['conversation']);
    for (const filler of ['think', 'know', 'really', 'good', 'time', 'yeah', 'want', 'make', 'going', 'things']) {
      expect(isNonSubstantiveTheme(filler)).toBe(true);
    }
  });

  it('marks internal channels companion_private on decision correlation and falls back cleanly on error', async () => {
    let seenVisibility: string | undefined;
    const decisions = makeDecisionPort((req) => {
      seenVisibility = req.workSpec.correlation?.telemetryVisibility;
      return { ok: false, reason: 'error', backend: 'local', latencyMs: 5 };
    });

    const themes = await classifyEpisodeThemes({
      sessionId: 'internal:free-time:wandering',
      channelId: 'internal:free-time:wandering',
      entries: [
        makeEntry(1, '2026-06-10T10:00:00.000Z', 'assistant', 'Drafting watercolor sketches of coastal lighthouses.', 'internal:free-time:wandering'),
      ],
      decisions,
    });

    expect(seenVisibility).toBe('companion_private');
    expect(themes).toContain('watercolor');
    expect(themes).toContain('lighthouses');
  });

  it('runs topic segmentation before the 14-entry cap and preserves segment.topic as episode title and theme', async () => {
    const pool = new FakeEpisodicPool();
    const store = new PostgresEpisodicStore(pool as unknown as Pool);
    const entries: SessionEntry[] = [];
    for (let i = 1; i <= 18; i++) {
      const minute = String(i).padStart(2, '0');
      entries.push(makeEntry(
        i,
        `2026-06-10T10:${minute}:00.000Z`,
        i % 2 === 1 ? 'user' : 'assistant',
        i <= 10
          ? `Discussing Kyoto rail pass routes and hotel neighborhoods turn ${i}`
          : `Designing the new greenhouse watering sensor circuit turn ${i}`,
      ));
    }

    let seenChunkCount = 0;
    const llmProvider = {
      complete: vi.fn(async () => {
        seenChunkCount += 1;
        return {
          content: JSON.stringify({
            segments: [
              { start_index: 0, end_index: 9, topic: 'Kyoto rail and hotel itinerary', status: 'closed' },
              { start_index: 10, end_index: 17, topic: 'Greenhouse irrigation sensor design', status: 'closed' },
            ],
          }),
        };
      }),
    };

    const synthesizer = new EpisodicSynthesizer(store, { getRecentMessages: () => entries }, {
      maxEntriesPerEpisode: 14,
      topicSegmentation: { enabled: true, llmProvider },
    });

    const result = await synthesizer.run({ sessionId: 'discord:dm-1' });

    // All 18 entries were segmented in ONE sitting call instead of pre-chopped at 14.
    expect(seenChunkCount).toBe(1);
    expect(result.createdEpisodes).toHaveLength(2);
    expect(result.createdEpisodes[0]?.title).toBe('Kyoto rail and hotel itinerary');
    expect(result.createdEpisodes[0]?.themes[0]).toBe('kyoto-rail-and-hotel-itinerary');
    expect(result.createdEpisodes[1]?.title).toBe('Greenhouse irrigation sensor design');
    expect(result.createdEpisodes[1]?.themes[0]).toBe('greenhouse-irrigation-sensor-design');
    // Unrelated topics must not link into a single thread.
    expect(result.linkedArcs).toHaveLength(0);
  });

  it('prevents cross-channel and single-broad-bucket arc linking', () => {
    const priorDifferentChannel = makeEpisode({
      id: 'ep-other-channel',
      startedAt: '2026-06-09T10:00:00.000Z',
      endedAt: '2026-06-09T10:15:00.000Z',
      channelId: 'discord:group-99',
      participantContactIds: ['contact:other'],
      themes: ['paris-trip', 'planning_and_events', 'flights'],
    });
    const priorSameChannelBroadOnly = makeEpisode({
      id: 'ep-broad-only',
      startedAt: '2026-06-09T12:00:00.000Z',
      endedAt: '2026-06-09T12:15:00.000Z',
      channelId: 'discord:dm-1',
      participantContactIds: ['contact:alex'],
      themes: ['planning_and_events', 'dentist-appointment'],
    });
    const target = makeEpisode({
      id: 'ep-target',
      startedAt: '2026-06-10T10:00:00.000Z',
      endedAt: '2026-06-10T10:15:00.000Z',
      channelId: 'discord:dm-1',
      participantContactIds: ['contact:alex'],
      themes: ['planning_and_events', 'paris-trip'],
    });

    expect(findRelatedSource(target, [priorDifferentChannel, priorSameChannelBroadOnly])).toBeNull();
  });

  it('bounds buildMergeChains by episode count, total duration, and topic continuity', () => {
    const ep1 = makeEpisode({
      id: 'ep-1',
      startedAt: '2026-06-10T09:00:00.000Z',
      endedAt: '2026-06-10T09:30:00.000Z',
      themes: ['kubernetes-rollout'],
    });
    const ep2 = makeEpisode({
      id: 'ep-2',
      startedAt: '2026-06-10T09:40:00.000Z',
      endedAt: '2026-06-10T10:10:00.000Z',
      themes: ['kubernetes-rollout'],
    });
    const ep3DifferentTopic = makeEpisode({
      id: 'ep-3',
      startedAt: '2026-06-10T10:20:00.000Z',
      endedAt: '2026-06-10T10:50:00.000Z',
      themes: ['paris-dinner-plans'],
    });
    const ep4ExceedsCount = makeEpisode({
      id: 'ep-4',
      startedAt: '2026-06-10T10:55:00.000Z',
      endedAt: '2026-06-10T11:20:00.000Z',
      themes: ['paris-dinner-plans'],
    });
    const ep5ExceedsCount = makeEpisode({
      id: 'ep-5',
      startedAt: '2026-06-10T11:25:00.000Z',
      endedAt: '2026-06-10T11:50:00.000Z',
      themes: ['paris-dinner-plans'],
    });

    const chains = buildMergeChains(
      [ep1, ep2, ep3DifferentTopic, ep4ExceedsCount, ep5ExceedsCount],
      45 * 60_000,
      { maxChainEpisodes: 2, maxChainDurationMs: 2 * 60 * 60_000, requireTopicContinuity: true },
    );

    expect(chains.map(chain => chain.map(ep => ep.id))).toEqual([
      ['ep-1', 'ep-2'],
      ['ep-3', 'ep-4'],
      ['ep-5'],
    ]);
  });

  it('lists newest episodes first when order=desc so recent episodes are not starved past scanLimit', async () => {
    const pool = new FakeEpisodicPool();
    const store = new PostgresEpisodicStore(pool as unknown as Pool);
    await store.createEpisode(makeEpisode({
      id: 'ep-old',
      title: 'Ancient greenhouse setup',
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:15:00.000Z',
      themes: ['greenhouse', 'sensors'],
    }));
    await store.createEpisode(makeEpisode({
      id: 'ep-recent',
      title: 'Recent greenhouse automation breakthrough',
      startedAt: '2026-06-10T10:00:00.000Z',
      endedAt: '2026-06-10T10:15:00.000Z',
      themes: ['greenhouse', 'automation'],
    }));

    const newest = await store.listEpisodes({ limit: 1, order: 'desc' });
    expect(newest.map(ep => ep.id)).toEqual(['ep-recent']);

    const chains = await retrieveEpisodicChains(store, {
      contextText: 'greenhouse automation',
      channelId: 'discord:dm-1',
      trustLevel: 'primary',
      channelDisclosure: { channelVisibility: 'private', broadcast: false },
      canonicalContactId: 'contact:alex',
      scanLimit: 1,
    });
    expect(chains).toHaveLength(1);
    expect(chains[0]?.rootEpisodeId).toBe('ep-recent');
  });

  it('filters quarantined neighbors before BFS so clean chains survive beside a retired session (ik47b.4)', async () => {
    const pool = new FakeEpisodicPool();
    const store = new PostgresEpisodicStore(pool as unknown as Pool);
    const cleanRoot = await store.createEpisode(makeEpisode({
      id: 'ep-clean-root',
      title: 'Paris museum itinerary',
      startedAt: '2026-06-10T10:00:00.000Z',
      endedAt: '2026-06-10T10:15:00.000Z',
      themes: ['paris-trip', 'museums'],
      spanRefs: [{ spanId: 'span-root', channelId: 'discord:dm-1', sessionId: 'discord:dm-1' }],
      provenanceRefs: [{ kind: 'session', refId: 'discord:dm-1' }],
    }));
    const cleanNeighbor = await store.createEpisode(makeEpisode({
      id: 'ep-clean-neighbor',
      title: 'Paris hotel reservations',
      startedAt: '2026-06-09T10:00:00.000Z',
      endedAt: '2026-06-09T10:15:00.000Z',
      themes: ['paris-trip', 'hotels'],
      spanRefs: [{ spanId: 'span-clean', channelId: 'discord:dm-1', sessionId: 'discord:dm-1' }],
      provenanceRefs: [{ kind: 'session', refId: 'discord:dm-1' }],
    }));
    const quarantinedNeighbor = await store.createEpisode(makeEpisode({
      id: 'ep-retired-neighbor',
      title: 'Retired session Paris note',
      startedAt: '2026-06-08T10:00:00.000Z',
      endedAt: '2026-06-08T10:15:00.000Z',
      themes: ['paris-trip', 'retired'],
      spanRefs: [{ spanId: 'span-retired', channelId: 'discord:dm-1', sessionId: 'discord:retired-1' }],
      provenanceRefs: [{ kind: 'session', refId: 'discord:retired-1' }],
    }));

    await store.writeEpisodeArc({
      id: 'arc-clean',
      sourceEpisodeId: cleanNeighbor.id,
      targetEpisodeId: cleanRoot.id,
      arcKind: 'continuation',
      salience: 0.8,
      confidence: 0.85,
      themes: ['paris-trip'],
      spanRefs: cleanRoot.spanRefs,
      artifactRefs: [],
      provenanceRefs: cleanRoot.provenanceRefs,
    });
    await store.writeEpisodeArc({
      id: 'arc-retired',
      sourceEpisodeId: quarantinedNeighbor.id,
      targetEpisodeId: cleanRoot.id,
      arcKind: 'continuation',
      salience: 0.8,
      confidence: 0.85,
      themes: ['paris-trip'],
      spanRefs: cleanRoot.spanRefs,
      artifactRefs: [],
      provenanceRefs: cleanRoot.provenanceRefs,
    });

    const quarantineFilter: MemorySessionQuarantineFilter = {
      isSessionRetiredOrQuarantined: (sessionId: string) => sessionId === 'discord:retired-1',
    };

    const chains = await resolveEpisodicChains({
      episodicStore: store,
      sessionQuarantineFilter: quarantineFilter,
      request: {
        contextText: 'Paris museum itinerary',
        channelId: 'discord:dm-1',
        trustLevel: 'primary',
        channelDisclosure: { channelVisibility: 'private', broadcast: false },
        canonicalContactId: 'contact:alex',
      },
      wrapError: err => (err instanceof Error ? err : new Error(String(err))),
    });

    expect(chains).toHaveLength(1);
    const returnedIds = chains[0]?.episodes.map(ep => ep.id).sort();
    expect(returnedIds).toEqual(['ep-clean-neighbor', 'ep-clean-root']);
    expect(returnedIds).not.toContain('ep-retired-neighbor');
  });
});
