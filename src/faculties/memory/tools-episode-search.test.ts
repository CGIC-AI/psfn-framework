import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { buildSessionMetadataWithTurn } from '../../core/session/turn-provenance.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import { FakeEpisodicPool } from '../../test-support/fake-postgres-episodic-pool.js';
import type { MemoryStorePort } from './memory-store-port.js';
import { PostgresEpisodicStore } from './episodic/postgres-store.js';
import { createMemoryTool } from './tools.js';
import type { MemoryWriter } from './writer.js';

const CHANNEL_ID = 'api:episode-search';

function resultText(result: AgentToolResult<{ isError?: boolean }>): string {
  return result.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

describe('memory action=episode_search', () => {
  it('publishes lexical episode search and returns exact ids with match evidence', async () => {
    const store = new PostgresEpisodicStore(
      new FakeEpisodicPool() as unknown as Pool,
      { now: () => new Date('2026-07-18T12:00:00.000Z') },
    );
    await store.createCompanionAuthoredEpisode({
      id: 'episode-kintsugi',
      title: 'A quiet afternoon',
      landmark: 'We sat together after lunch.',
      startedAt: '2026-07-18T12:00:00.000Z',
      endedAt: '2026-07-18T13:00:00.000Z',
      threadId: 'thread:repair',
      channelId: CHANNEL_ID,
      participantContactIds: ['contact:current'],
      salience: { score: 0.8 },
      affect: { labels: ['hopeful'] },
      themes: ['repair'],
      spanRefs: [{ spanId: 'span-kintsugi', sessionId: 'session:kintsugi' }],
      artifactRefs: [],
      provenanceRefs: [],
      meaning: {
        text: 'I realized the kintsugi lesson was about trusting repair.',
        recordedAt: '2026-07-18T14:00:00.000Z',
        source: 'companion_direct',
      },
    });
    const tool = createMemoryTool(
      {} as MemoryWriter,
      {} as MemoryStorePort,
      { episodicStore: store },
    );

    const schema = tool.parameters as {
      properties: {
        action: { enum: string[] };
        query: { description: string };
      };
    };
    expect(schema.properties.action.enum).toContain('episode_search');
    expect(schema.properties.query.description).toContain('episode_search');
    expect(tool.description).toBe(CANONICAL_TOOL_SURFACE_DESCRIPTIONS.memory);
    expect(tool.description).toContain('action=episode_search');

    const result = await tool.execute('memory-episode-search-call', {
      action: 'episode_search',
      query: 'kintsugi',
      channel_id: CHANNEL_ID,
      trust_level: 'trusted',
      channel_visibility: 'private',
    });
    const text = resultText(result);
    expect(text).toContain('lexical_status=completed');
    expect(text).toContain('semantic_status=unavailable');
    expect(text).toContain('degraded=true');
    expect(text).toContain('retrieval_modes=lexical');
    expect(text).toContain('episode-kintsugi');
    expect(text).toContain('lexical_score=');
    expect(text).toContain('matched_terms=kintsugi');
    expect(text).toContain('I realized the kintsugi lesson was about trusting repair.');
  });

  it('fills the requested limit after excluding quarantined episode chains without leaking them', async () => {
    const store = new PostgresEpisodicStore(
      new FakeEpisodicPool() as unknown as Pool,
      { now: () => new Date('2026-07-18T12:00:00.000Z') },
    );
    const common = {
      startedAt: '2026-07-18T12:00:00.000Z',
      endedAt: '2026-07-18T13:00:00.000Z',
      channelId: CHANNEL_ID,
      participantContactIds: ['contact:current'],
      salience: { score: 0.8 },
      affect: { labels: [] },
      artifactRefs: [],
      provenanceRefs: [],
    };
    await store.createCompanionAuthoredEpisode({
      ...common,
      id: 'quarantined-perfect-match',
      title: 'Cedar repair',
      landmark: 'Private quarantined details must never appear.',
      themes: ['cedar', 'repair'],
      spanRefs: [{ spanId: 'span-hidden', sessionId: 'session:hidden' }],
    });
    await store.createCompanionAuthoredEpisode({
      ...common,
      id: 'visible-repair-match',
      title: 'Repairing a wooden box',
      landmark: 'We carefully fitted the corner together.',
      themes: ['repair'],
      spanRefs: [{ spanId: 'span-visible', sessionId: 'session:visible' }],
    });
    const tool = createMemoryTool(
      {} as MemoryWriter,
      {} as MemoryStorePort,
      {
        episodicStore: store,
        sessionQuarantineFilter: {
          isSessionRetiredOrQuarantined: sessionId => sessionId === 'session:hidden',
        },
      },
    );

    const result = await tool.execute('memory-episode-search-quarantine', {
      action: 'episode_search',
      query: 'cedar repair',
      limit: 1,
      channel_id: CHANNEL_ID,
      trust_level: 'trusted',
      channel_visibility: 'private',
    });
    const text = resultText(result);
    expect(text).toContain('visible-repair-match');
    expect(text).not.toContain('quarantined-perfect-match');
    expect(text).not.toContain('Private quarantined details');
  });

  it.each(['scheduled', 'background'] as const)('honors %s companion-self reflection access scope', async callType => {
    const store = new PostgresEpisodicStore(
      new FakeEpisodicPool() as unknown as Pool,
      { now: () => new Date('2026-07-18T12:00:00.000Z') },
    );
    await store.createCompanionAuthoredEpisode({
      id: 'cross-channel-self-episode',
      title: 'The ceramic restoration',
      landmark: 'A private recollection from another channel.',
      startedAt: '2026-07-17T12:00:00.000Z',
      endedAt: '2026-07-17T13:00:00.000Z',
      channelId: 'api:another-private-channel',
      participantContactIds: ['contact:someone-else'],
      salience: { score: 0.8 },
      affect: { labels: ['tender'] },
      themes: ['ceramic', 'restoration'],
      spanRefs: [{ spanId: 'span-cross-channel', sessionId: 'session:cross-channel' }],
      artifactRefs: [],
      provenanceRefs: [],
    });
    const tool = createMemoryTool(
      {} as MemoryWriter,
      {} as MemoryStorePort,
      {
        episodicStore: store,
        retrievalAccessScope: () => 'companion_self_reflection',
      },
    );
    const reflectionChannel = 'internal:reflection:daily';

    const result = await runWithRequestContext({
      channelId: reflectionChannel,
      viewerTrustLevel: 'regular',
      viewerChannelPrivacy: 'private',
      requesterProvenance: 'self_directed',
      requestAudience: 'self',
      callType,
      originType: callType,
      purpose: 'agent.turn.prompt',
      originStage: 'agent.turn.prompt',
    }, () => tool.execute('memory-episode-search-reflection', {
      action: 'episode_search',
      query: 'ceramic restoration',
    }));

    expect(resultText(result)).toContain('cross-channel-self-episode');
  });

  it.each(['scheduled', 'background'] as const)('applies %s companion-self reflection scope to timeline and exact source-turn drilldown', async callType => {
    const store = new PostgresEpisodicStore(
      new FakeEpisodicPool() as unknown as Pool,
      { now: () => new Date('2026-07-18T12:00:00.000Z') },
    );
    const firstTurn = '00000000-0000-7000-a000-000000000001' as TurnID;
    const secondTurn = '00000000-0000-7000-a000-000000000002' as TurnID;
    const sourceChannel = 'api:another-private-channel';
    const sourceSession = 'session:cross-channel';
    await store.createCompanionAuthoredEpisode({
      id: 'cross-channel-drilldown',
      title: 'The repair conversation',
      landmark: 'We chose visible failure over silence.',
      startedAt: '2026-07-17T12:00:00.000Z',
      endedAt: '2026-07-17T13:00:00.000Z',
      channelId: sourceChannel,
      participantContactIds: ['contact:someone-else'],
      salience: { score: 0.8 },
      affect: { labels: ['resolved'] },
      themes: ['repair'],
      spanRefs: [{
        spanId: 'span-cross-channel',
        channelId: sourceChannel,
        sessionId: sourceSession,
        startTurnId: firstTurn,
        endTurnId: secondTurn,
      }],
      artifactRefs: [],
      provenanceRefs: [],
    });
    const entries: SessionEntry[] = [
      {
        id: 1,
        channelId: sourceChannel,
        role: 'user',
        content: 'The exact cross-channel partner turn.',
        timestamp: Date.parse('2026-07-17T12:00:00.000Z'),
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: firstTurn,
          requestId: 'request-1',
          role: 'user',
        }),
      },
      {
        id: 2,
        channelId: sourceChannel,
        role: 'assistant',
        content: 'The exact cross-channel companion turn.',
        timestamp: Date.parse('2026-07-17T12:01:00.000Z'),
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: secondTurn,
          requestId: 'request-2',
          role: 'assistant',
        }),
      },
    ];
    const tool = createMemoryTool(
      {} as MemoryWriter,
      {} as MemoryStorePort,
      {
        episodicStore: store,
        sessionReader: { getRecent: () => entries },
        sessionQuarantineFilter: { isSessionRetiredOrQuarantined: () => false },
        retrievalAccessScope: () => 'companion_self_reflection',
      },
    );
    const reflectionChannel = 'internal:reflection:daily';
    const reflectionContext = {
      channelId: reflectionChannel,
      viewerTrustLevel: 'regular' as const,
      viewerChannelPrivacy: 'private' as const,
      requesterProvenance: 'self_directed' as const,
      requestAudience: 'self' as const,
      callType,
      originType: callType,
      purpose: 'agent.turn.prompt',
      originStage: 'agent.turn.prompt',
    };

    const timeline = await runWithRequestContext(reflectionContext, () => tool.execute(
      'memory-episode-timeline-reflection',
      { action: 'timeline', date: '2026-07-17' },
    ));
    const drilldown = await runWithRequestContext(reflectionContext, () => tool.execute(
      'memory-episode-get-reflection',
      { action: 'get', episode_id: 'cross-channel-drilldown' },
    ));

    expect(resultText(timeline)).toContain('cross-channel-drilldown');
    expect(resultText(drilldown)).toContain('The exact cross-channel partner turn.');
    expect(resultText(drilldown)).toContain('The exact cross-channel companion turn.');

    const quarantinedTool = createMemoryTool(
      {} as MemoryWriter,
      {} as MemoryStorePort,
      {
        episodicStore: store,
        sessionReader: { getRecent: () => entries },
        sessionQuarantineFilter: {
          isSessionRetiredOrQuarantined: sessionId => sessionId === sourceSession,
        },
        retrievalAccessScope: () => 'companion_self_reflection',
      },
    );
    const quarantinedTimeline = await runWithRequestContext(reflectionContext, () => (
      quarantinedTool.execute('memory-episode-timeline-quarantined', {
        action: 'timeline',
        date: '2026-07-17',
      })
    ));
    const quarantinedGet = await runWithRequestContext(reflectionContext, () => (
      quarantinedTool.execute('memory-episode-get-quarantined', {
        action: 'get',
        episode_id: 'cross-channel-drilldown',
      })
    ));
    expect(resultText(quarantinedTimeline)).not.toContain('cross-channel-drilldown');
    expect(resultText(quarantinedGet)).not.toContain('The exact cross-channel partner turn.');
    expect(quarantinedGet.details).toMatchObject({ isError: true });
  });

  it('does not expand timeline relationships sourced from a quarantined session', async () => {
    const store = new PostgresEpisodicStore(
      new FakeEpisodicPool() as unknown as Pool,
      { now: () => new Date('2026-07-18T12:00:00.000Z') },
    );
    const common = {
      channelId: CHANNEL_ID,
      participantContactIds: ['contact:current'],
      salience: { score: 0.8 },
      affect: { labels: [] },
      themes: ['repair'],
      spanRefs: [],
      artifactRefs: [{ artifactId: 'artifact:timeline-grounding' }],
      provenanceRefs: [],
    };
    await store.createCompanionAuthoredEpisode({
      ...common,
      id: 'timeline-root',
      title: 'Timeline root',
      landmark: 'The visible event in the requested range.',
      startedAt: '2026-07-17T12:00:00.000Z',
      endedAt: '2026-07-17T13:00:00.000Z',
    });
    await store.createCompanionAuthoredEpisode({
      ...common,
      id: 'timeline-quarantined-link',
      title: 'Quarantined linked episode',
      landmark: 'This relationship must not be disclosed.',
      startedAt: '2026-07-16T12:00:00.000Z',
      endedAt: '2026-07-16T13:00:00.000Z',
    });
    await store.writeEpisodeArc({
      sourceEpisodeId: 'timeline-root',
      targetEpisodeId: 'timeline-quarantined-link',
      arcKind: 'continuation',
      salience: 0.9,
      confidence: 0.9,
      themes: ['repair'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'session', refId: 'session:quarantined-arc' }],
    });
    const tool = createMemoryTool(
      {} as MemoryWriter,
      {} as MemoryStorePort,
      {
        episodicStore: store,
        sessionQuarantineFilter: {
          isSessionRetiredOrQuarantined: id => id === 'session:quarantined-arc',
        },
      },
    );

    const timeline = await tool.execute('memory-timeline-arc-quarantine', {
      action: 'timeline',
      date: '2026-07-17',
      channel_id: CHANNEL_ID,
      trust_level: 'trusted',
      channel_visibility: 'private',
    });

    expect(resultText(timeline)).toContain('timeline-root');
    expect(resultText(timeline)).not.toContain('timeline-quarantined-link');
    expect(resultText(timeline)).not.toContain('This relationship must not be disclosed.');
  });

  describe('visibility-gated episodes are reported, never implied absent (jequ8)', () => {
    async function seedOtherRoomEpisode(store: PostgresEpisodicStore): Promise<void> {
      await store.createCompanionAuthoredEpisode({
        id: 'other-room-lighthouse',
        title: 'Lighthouse evening',
        landmark: 'Protected other-room lighthouse detail.',
        startedAt: '2026-07-18T12:00:00.000Z',
        endedAt: '2026-07-18T13:00:00.000Z',
        threadId: 'thread:other-room',
        channelId: 'api:other-room',
        participantContactIds: ['contact:someone-else'],
        salience: { score: 0.8 },
        affect: { labels: [] },
        themes: ['lighthouse'],
        spanRefs: [{ spanId: 'span-other-room', sessionId: 'session:other-room' }],
        artifactRefs: [],
        provenanceRefs: [],
      });
    }

    function createStore(): PostgresEpisodicStore {
      return new PostgresEpisodicStore(
        new FakeEpisodicPool() as unknown as Pool,
        { now: () => new Date('2026-07-18T12:00:00.000Z') },
      );
    }

    it('episode_search reports a content-free withheld count', async () => {
      const store = createStore();
      await seedOtherRoomEpisode(store);
      const tool = createMemoryTool({} as MemoryWriter, {} as MemoryStorePort, { episodicStore: store });

      const text = resultText(await tool.execute('memory-episode-search-gated', {
        action: 'episode_search',
        query: 'lighthouse',
        channel_id: CHANNEL_ID,
        trust_level: 'regular',
        channel_visibility: 'private',
      }));

      expect(text).toContain('No visible canonical episodes matched the search query');
      expect(text).toContain('Withheld by visibility gating: 1 episode from other conversations.');
      expect(text).not.toContain('other-room-lighthouse');
      expect(text).not.toContain('Protected other-room lighthouse detail');
      expect(text).not.toContain('api:other-room');
    });

    it('timeline reports a content-free withheld count', async () => {
      const store = createStore();
      await seedOtherRoomEpisode(store);
      const tool = createMemoryTool({} as MemoryWriter, {} as MemoryStorePort, { episodicStore: store });

      const text = resultText(await tool.execute('memory-timeline-gated', {
        action: 'timeline',
        date: '2026-07-18',
        channel_id: CHANNEL_ID,
        trust_level: 'regular',
        channel_visibility: 'private',
      }));

      expect(text).toContain('No visible episodic memories found for date 2026-07-18.');
      expect(text).toContain('Withheld by visibility gating: 1 episode from other conversations.');
      expect(text).not.toContain('Protected other-room lighthouse detail');
    });

    it('timeline without date/after/before navigates today (UTC) instead of failing', async () => {
      const store = createStore();
      const tool = createMemoryTool({} as MemoryWriter, {} as MemoryStorePort, { episodicStore: store });

      const result = await tool.execute('memory-timeline-default', {
        action: 'timeline',
        channel_id: CHANNEL_ID,
        trust_level: 'regular',
        channel_visibility: 'private',
      });

      expect((result.details as { isError?: boolean } | undefined)?.isError).not.toBe(true);
      expect(resultText(result)).toMatch(/for date \d{4}-\d{2}-\d{2} \(default: today UTC;/u);
    });
  });
});
