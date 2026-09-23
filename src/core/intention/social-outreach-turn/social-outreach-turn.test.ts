import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../contacts/types.js';
import type { SessionEntry } from '../../session/types.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime-base.js';
import { gatherSocialOutreachTurnContext, type SocialOutreachContextPorts } from './context.js';
import { createSocialOutreachDraftRegistry } from './drafts.js';
import { createSocialOutreachTurnEvaluator } from './evaluator.js';
import { buildSocialOutreachTurnPrompt } from './prompt.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-23T15:00:00.000Z');
const DM = '123456789012345678';

const contact: Contact = {
  id: 'contact-human',
  displayName: 'Morgan Example',
  nickname: 'Mo',
  trustLevel: 'primary',
  relationshipType: 'partner',
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-09-21T20:00:00.000Z',
  conversationChannels: [{
    channel: 'discord', channelId: DM,
    firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-09-21T20:00:00.000Z',
  }],
};

function entry(id: number, role: SessionEntry['role'], content: string, timestamp: number): SessionEntry {
  return { id, channelId: DM, role, content, timestamp };
}

function ports(overrides: Partial<SocialOutreachContextPorts> = {}): SocialOutreachContextPorts {
  const dmEntries = [
    entry(1, 'user', 'I am heading to the coast this weekend', NOW - 44 * HOUR),
    entry(2, 'assistant', 'Oh lovely, send me a picture of the sea!', NOW - 43 * HOUR),
    entry(3, 'system', 'internal bookkeeping', NOW - 43 * HOUR),
  ];
  return {
    contacts: { getById: async id => (id === contact.id ? contact : undefined) },
    sessions: {
      findLatestEntries: (channelId, predicate, limit) => (
        channelId === DM ? dmEntries.filter(predicate).reverse().slice(0, limit) : []
      ),
      listSessionsByRecentActivity: (limit, offset) => [
        { channelId: 'internal:free-time:watercolor-garden', lastActivityAt: NOW - 5 * HOUR },
        { channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', lastActivityAt: NOW - 6 * HOUR },
        { channelId: 'internal:heartbeat', lastActivityAt: NOW - 7 * HOUR },
        { channelId: DM, lastActivityAt: NOW - 43 * HOUR },
        { channelId: '999999999999999999', lastActivityAt: NOW - 60 * HOUR },
      ].slice(offset, offset + limit),
    },
    readEmotion: () => ({
      vad: { valence: 0.2, arousal: 0.1, dominance: 0 },
      mood: { valence: 0.31, arousal: -0.12, dominance: 0 },
      discrete: { joy: 0.4, longing: 0.62, anger: 0 },
      confidence: 0.8,
    }),
    limits: { excerptMessages: 6, excerptMaxChars: 900, activityMaxItems: 6 },
    ...overrides,
  };
}

describe('per-contact outreach turn context and prompt', () => {
  it('names the contact, when you last talked, the last exchange, what you did since, and how you feel', async () => {
    const context = await gatherSocialOutreachTurnContext(ports(), {
      contactId: contact.id, conversationChannelId: DM, companionTarget: false, nowMs: NOW,
    });
    expect(context).toMatchObject({
      contactName: 'Mo',
      relationship: 'partner',
      lastTalkedAtMs: NOW - 43 * HOUR,
      excerpt: [
        { speaker: 'them', text: 'I am heading to the coast this weekend' },
        { speaker: 'you', text: 'Oh lovely, send me a picture of the sea!' },
      ],
      activitiesSince: ['spent free time on watercolor garden', 'talked with another companion'],
    });
    const prompt = buildSocialOutreachTurnPrompt({ context, orientation: 'warm', nowMs: NOW });
    expect(prompt).toContain('You have been thinking about Mo (your partner, a person in your life).');
    expect(prompt).toContain('You last talked about 43 hours ago');
    expect(prompt).toContain('  Mo: I am heading to the coast this weekend');
    expect(prompt).toContain('  You: Oh lovely, send me a picture of the sea!');
    expect(prompt).toContain('Since then you have: spent free time on watercolor garden; talked with another companion.');
    expect(prompt).toContain('strongest feelings: longing 0.62, joy 0.40.');
    expect(prompt).toContain('Do you want to message Mo?');
    expect(prompt).toContain('action=outreach_send');
    expect(prompt).not.toContain('internal bookkeeping');
    expect(prompt).not.toMatch(/destination|opportunity|room/i);
  });

  it('keeps the most recent part of a long exchange inside the character budget', async () => {
    const context = await gatherSocialOutreachTurnContext(
      ports({ limits: { excerptMessages: 6, excerptMaxChars: 20, activityMaxItems: 1 } }),
      { contactId: contact.id, conversationChannelId: DM, companionTarget: false, nowMs: NOW },
    );
    expect(context.excerpt).toEqual([
      expect.objectContaining({ speaker: 'you', text: '… picture of the sea!' }),
    ]);
    expect(context.activitiesSince).toHaveLength(1);
  });

  it('carries an optional occasion such as a due concern', () => {
    const prompt = buildSocialOutreachTurnPrompt({
      context: {
        contactName: 'Mo', relationship: null, companionTarget: true, lastTalkedAtMs: null,
        excerpt: [], activitiesSince: [], emotion: null,
      },
      orientation: 'repair',
      reason: 'You wanted to ask how the interview went.',
      nowMs: NOW,
    });
    expect(prompt).toContain('another companion');
    expect(prompt).toContain('On your mind: You wanted to ask how the interview went.');
    expect(prompt).toContain('You have not talked with them before.');
    expect(prompt).toContain('through companion messaging');
  });
});

describe('outreach turn evaluator', () => {
  function evaluatorWith(onTurn: (message: SubstrateMessage) => Promise<void>) {
    const drafts = createSocialOutreachDraftRegistry();
    const handleMessage = vi.fn(async (message: SubstrateMessage) => {
      await onTurn(message);
      return { content: '__no_reply__' };
    });
    const evaluator = createSocialOutreachTurnEvaluator({
      turns: { handleMessage }, drafts, context: ports(), companionName: 'Companion', now: () => NOW,
    });
    return { drafts, handleMessage, evaluator };
  }
  const input = {
    contactId: contact.id,
    contactName: 'Mo',
    orientation: 'warm' as const,
    pressure: { warm: 0.8, repair: 0, total: 0.8, dominantOrientation: 'warm' as const },
    channelId: DM,
    channelType: 'discord' as const,
    companionTarget: false,
  };

  it('runs one fresh private turn in the contact channel and returns exactly the written words', async () => {
    const { drafts, handleMessage, evaluator } = evaluatorWith(async message => {
      await runWithRequestContext({ channelId: message.channelId }, async () => {
        drafts.submit(message.channelId, { kind: 'message', text: 'Did you get to see the sea?' });
      });
    });
    await expect(evaluator.evaluate(input)).resolves.toEqual({
      action: 'message', content: 'Did you get to see the sea?',
    });
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'internal:social-outreach:contact-human',
      authorId: 'system:social-outreach',
      routing: { source: 'terminal', privateTurnTrigger: true },
    }));
    // The slot is closed after the turn: a late tool call cannot answer it.
    expect(() => drafts.submit('internal:social-outreach:contact-human', { kind: 'later' }))
      .toThrow(/live social outreach turn/);
  });

  it('treats later as defer and silence as decline', async () => {
    const later = evaluatorWith(async message => {
      later.drafts.submit(message.channelId, { kind: 'later' });
    });
    await expect(later.evaluator.evaluate(input)).resolves.toEqual({ action: 'defer' });
    const silent = evaluatorWith(async () => undefined);
    await expect(silent.evaluator.evaluate(input)).resolves.toEqual({ action: 'decline' });
  });

  it('rejects a second concurrent turn for the same contact and answers from other channels', () => {
    const drafts = createSocialOutreachDraftRegistry();
    const slot = drafts.open('contact-human');
    expect(() => drafts.open('contact-human')).toThrow(/already live/);
    expect(() => drafts.submit(DM, { kind: 'later' })).toThrow(/live social outreach turn/);
    expect(() => drafts.submit(slot.channelId, { kind: 'message', text: '   ' })).toThrow(/words/);
    slot.close();
  });
});
