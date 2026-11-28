import { describe, expect, it } from 'vitest';
import { createInitialHubStreamState, type HubStreamMessage } from './hub-stream.js';
import { hydrateThreadHistory } from './thread-history.js';

function message(id: string, content: string): HubStreamMessage {
  return { id, role: 'user', content, live: false, final: true, sequence: 1, receivedAt: '2026-11-28T00:00:00.000Z' };
}

describe('hydrateThreadHistory (jtr6e)', () => {
  const history = [
    { role: 'user' as const, content: 'durable question', createdAt: 1_800_000_000_000 },
    { role: 'assistant' as const, content: 'durable answer', createdAt: 1_800_000_000_005 },
  ];

  it('replaces the remembered prefix and keeps messages produced on this connection after it', () => {
    const state = {
      ...createInitialHubStreamState(),
      messages: [message('remembered:1:user', 'durable question'), message('live:7', 'sent after reload')],
    };
    expect(hydrateThreadHistory(state, history).messages.map(value => [value.id, value.content])).toEqual([
      ['history:1:user', 'durable question'],
      ['history:2:assistant', 'durable answer'],
      ['live:7', 'sent after reload'],
    ]);
  });

  it('leaves a selected shard thread untouched', () => {
    const state = { ...createInitialHubStreamState(), session: { activeShardId: 'shard-1' }, messages: [] };
    expect(hydrateThreadHistory(state, history)).toBe(state);
  });

  it('an empty authorized history clears remembered text the server no longer holds', () => {
    const state = { ...createInitialHubStreamState(), messages: [message('remembered:1:user', 'revoked turn')] };
    expect(hydrateThreadHistory(state, []).messages).toEqual([]);
  });
});
