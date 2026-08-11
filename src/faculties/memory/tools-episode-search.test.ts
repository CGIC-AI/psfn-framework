import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { FakeEpisodicPool } from '../../test-support/fake-postgres-episodic-pool.js';
import type { MemoryStorePort } from './memory-store-port.js';
import { PostgresEpisodicStore } from './episodic/postgres-store.js';
import { createMemoryTool } from './tools.js';
import type { MemoryWriter } from './writer.js';
import { COMPANION_SELF_REFLECTION_RETRIEVAL_PURPOSE } from './retrieval/access-scope.js';

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

  it('honors an explicitly authorized companion-self reflection access scope', async () => {
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
        episodicAccessScope: () => 'companion_self_reflection',
      },
    );
    const reflectionChannel = 'internal:reflection:daily';

    const result = await runWithRequestContext({
      channelId: reflectionChannel,
      viewerTrustLevel: 'regular',
      viewerChannelPrivacy: 'private',
      requesterProvenance: 'self_directed',
      callType: 'background',
      originType: 'background',
      purpose: COMPANION_SELF_REFLECTION_RETRIEVAL_PURPOSE,
      originStage: COMPANION_SELF_REFLECTION_RETRIEVAL_PURPOSE,
    }, () => tool.execute('memory-episode-search-reflection', {
      action: 'episode_search',
      query: 'ceramic restoration',
    }));

    expect(resultText(result)).toContain('cross-channel-self-episode');
  });
});
