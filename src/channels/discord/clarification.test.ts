import { describe, expect, it } from 'vitest';
import type { PendingClarification } from '../../boundary/gateway/protocol.js';
import {
  buildClarificationComponents,
  buildClarificationCustomId,
  clarificationCustomIdPrefix,
  deliverDiscordClarification,
  parseClarificationCustomId,
  type DiscordClarifyChannel,
  type DiscordClarifyInteraction,
  type DiscordClarifyMessageHandle,
} from './clarification.js';

const clarification: PendingClarification = {
  id: 'clar-1',
  question: 'Which draft should I send?',
  choices: ['The warm one', 'The concise one', 'Neither'],
};

describe('discord clarification rendering', () => {
  it('builds one button per choice with index-encoded custom ids', () => {
    const rows = buildClarificationComponents(clarification);
    expect(rows).toHaveLength(1);
    const buttons = rows[0]!.components;
    expect(buttons).toHaveLength(3);
    const json = buttons.map((b) => b.toJSON() as { custom_id: string; label: string });
    expect(json.map((b) => b.custom_id)).toEqual([
      'clarify:clar-1:0',
      'clarify:clar-1:1',
      'clarify:clar-1:2',
    ]);
    expect(json.map((b) => b.label)).toEqual(['The warm one', 'The concise one', 'Neither']);
  });

  it('truncates a display label past the discord 80-char limit but keeps the index authoritative', () => {
    const long = 'x'.repeat(200);
    const rows = buildClarificationComponents({ id: 'c', question: 'q', choices: [long, 'short'] });
    const label = (rows[0]!.components[0]!.toJSON() as { label: string }).label;
    expect(label.length).toBeLessThanOrEqual(80);
  });

  it('parses only custom ids belonging to this clarification and in range', () => {
    expect(parseClarificationCustomId('clarify:clar-1:1', clarification)).toBe(1);
    // wrong clarification id
    expect(parseClarificationCustomId('clarify:other:1', clarification)).toBeNull();
    // out of range
    expect(parseClarificationCustomId('clarify:clar-1:9', clarification)).toBeNull();
    // wrong prefix / shape
    expect(parseClarificationCustomId('approve:clar-1:1', clarification)).toBeNull();
    expect(parseClarificationCustomId('clarify:clar-1', clarification)).toBeNull();
    expect(parseClarificationCustomId('clarify:clar-1:-1', clarification)).toBeNull();
  });

  it('scopes the collector prefix to a single clarification', () => {
    expect(buildClarificationCustomId('clar-1', 2)).toBe('clarify:clar-1:2');
    expect('clarify:clar-1:2'.startsWith(clarificationCustomIdPrefix('clar-1'))).toBe(true);
    expect('clarify:other:2'.startsWith(clarificationCustomIdPrefix('clar-1'))).toBe(false);
  });

  it('round-trips clarification ids containing the wire separator', () => {
    const colonIdClarification: PendingClarification = {
      ...clarification,
      id: 'clar:session:1',
    };
    const customId = buildClarificationCustomId(colonIdClarification.id, 2);

    expect(customId).toBe('clarify:clar:session:1:2');
    expect(parseClarificationCustomId(customId, colonIdClarification)).toBe(2);
    expect(customId.startsWith(clarificationCustomIdPrefix(colonIdClarification.id))).toBe(true);
  });
});

function fakeChannel(handle: DiscordClarifyMessageHandle): DiscordClarifyChannel {
  return { present: async () => handle };
}

describe('deliverDiscordClarification', () => {
  it('resolves the clicked button to a verified selection', async () => {
    let acknowledged = false;
    const interaction: DiscordClarifyInteraction = {
      customId: 'clarify:clar-1:1',
      acknowledge: async () => {
        acknowledged = true;
      },
    };
    let disabled = false;
    const handle: DiscordClarifyMessageHandle = {
      awaitInteraction: async () => interaction,
      disable: async () => {
        disabled = true;
      },
    };

    const result = await deliverDiscordClarification(fakeChannel(handle), clarification, 'chan-9', 1000);

    expect(result).toEqual({
      status: 'resolved',
      channel: 'discord',
      target: 'chan-9',
      selection: {
        clarificationId: 'clar-1',
        selectedIndex: 1,
        selectedChoice: 'The concise one',
      },
    });
    expect(acknowledged).toBe(true);
    expect(disabled).toBe(false);
  });

  it('fails closed to a no-answer on timeout (no fabricated selection)', async () => {
    let disabled = false;
    const handle: DiscordClarifyMessageHandle = {
      awaitInteraction: async () => null,
      disable: async () => {
        disabled = true;
      },
    };

    const result = await deliverDiscordClarification(fakeChannel(handle), clarification, 'chan-9', 1000);

    expect(result).toEqual({ status: 'pending', channel: 'discord', target: 'chan-9' });
    expect(result.selection).toBeUndefined();
    expect(disabled).toBe(true);
  });

  it('fails closed when the clicked custom id does not name an in-range choice', async () => {
    const interaction: DiscordClarifyInteraction = {
      customId: 'clarify:clar-1:99',
      acknowledge: async () => undefined,
    };
    const handle: DiscordClarifyMessageHandle = {
      awaitInteraction: async () => interaction,
      disable: async () => undefined,
    };

    const result = await deliverDiscordClarification(fakeChannel(handle), clarification, 'chan-9', 1000);

    expect(result.status).toBe('pending');
    expect(result.selection).toBeUndefined();
  });
});
