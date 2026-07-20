import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import { buildSessionMetadataWithTurn } from '../../core/session/turn-provenance.js';
import type { SessionEntry } from '../../core/session/types.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import { FakeEpisodicPool } from '../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from './episodic/postgres-store.js';
import { createMemoryTool, type MemoryToolOptions } from './tools.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type { MemoryWriter } from './writer.js';

const CHANNEL_ID = 'api:episode-tool';
const TURN_ID = '00000000-0000-7000-a000-000000000001' as TurnID;

function resultText(result: AgentToolResult<{ isError?: boolean }>): string {
  return result.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

function sessionEntry(): SessionEntry {
  return {
    id: 1,
    channelId: CHANNEL_ID,
    role: 'user',
    content: 'Journal-current episode evidence.',
    timestamp: Date.UTC(2026, 6, 18, 12),
    metadata: buildSessionMetadataWithTurn(undefined, {
      turnId: TURN_ID,
      requestId: 'request-episode-tool',
      role: 'user',
    }),
  };
}

describe('memory action=get', () => {
  it('publishes the rich catalog contract and expands an exact episode id', async () => {
    const store = new PostgresEpisodicStore(
      new FakeEpisodicPool() as unknown as Pool,
      { now: () => new Date('2026-07-18T12:00:00.000Z') },
    );
    await store.createEpisode({
      id: 'episode-tool-id',
      title: 'A precise remembered exchange',
      landmark: 'The exchange that should be drilled into by id.',
      startedAt: '2026-07-18T12:00:00.000Z',
      endedAt: '2026-07-18T12:00:00.000Z',
      threadId: 'thread:episode-tool',
      channelId: CHANNEL_ID,
      participantContactIds: ['contact:current'],
      salience: { score: 0.8 },
      affect: { labels: ['focused'] },
      themes: ['precision'],
      spanRefs: [{
        spanId: 'span-episode-tool',
        sessionId: 'session:episode-tool',
        startTurnId: TURN_ID,
        endTurnId: TURN_ID,
      }],
      artifactRefs: [],
      provenanceRefs: [],
    });
    const getRecent = vi.fn(() => [sessionEntry()]);
    const tool = createMemoryTool(
      {} as MemoryWriter,
      {} as MemoryStorePort,
      {
        episodicStore: store,
        sessionReader: { getRecent },
      },
    );

    const schema = tool.parameters as {
      properties: {
        action: { enum: string[] };
        episode_id: { description: string };
      };
    };
    expect(schema.properties.action.enum).toContain('get');
    expect(schema.properties.episode_id.description).toContain('Exact episode ID');
    expect(tool.description).toBe(CANONICAL_TOOL_SURFACE_DESCRIPTIONS.memory);
    expect(tool.description).toContain('action=get');
    expect(tool.description).toContain('journal-current source turns');

    const result = await tool.execute('memory-get-call', {
      action: 'get',
      episode_id: 'episode-tool-id',
      channel_id: CHANNEL_ID,
      trust_level: 'trusted',
      channel_visibility: 'private',
    });

    expect(resultText(result)).toContain('A precise remembered exchange');
    expect(resultText(result)).toContain('Journal-current episode evidence.');
    expect(getRecent).toHaveBeenCalledWith('session:episode-tool', Number.MAX_SAFE_INTEGER);
  });

  it('requires an episode id and configured drill-down authorities', async () => {
    const unconfigured = createMemoryTool({} as MemoryWriter, {} as MemoryStorePort);
    const missingAuthorities = await unconfigured.execute('memory-get-unconfigured', {
      action: 'get',
      episode_id: 'episode-id',
    });
    expect(resultText(missingAuthorities)).toContain(
      'episodic store and session reader are required',
    );

    const configured = createMemoryTool({} as MemoryWriter, {} as MemoryStorePort, {
      episodicStore: {} as NonNullable<MemoryToolOptions['episodicStore']>,
      sessionReader: { getRecent: vi.fn(() => []) },
    });
    const missingId = await configured.execute('memory-get-missing-id', {
      action: 'get',
    });
    expect(resultText(missingId)).toContain('episode_id is required');
  });
});
