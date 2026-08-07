import { describe, expect, it } from 'vitest';

import { parseMessageAddressingMetadata } from './message-addressing.js';

describe('message addressing contract', () => {
  it('normalizes a complete Discord group addressing envelope', () => {
    expect(parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'human-1', authorName: 'Vega' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [{ authorId: 'bot-2', authorName: 'Purrsephone' }],
      replyTarget: {
        messageId: 'message-7',
        author: { authorId: 'bot-2', authorName: 'Purrsephone' },
      },
      channel: { scope: 'group', channelId: 'channel-1', threadId: 'thread-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{
          authorId: 'bot-2',
          authorName: 'Purrsephone',
          evidence: ['mention', 'reply'],
        }],
      },
    })).toEqual({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'human-1', authorName: 'Vega' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [{ authorId: 'bot-2', authorName: 'Purrsephone' }],
      replyTarget: {
        messageId: 'message-7',
        author: { authorId: 'bot-2', authorName: 'Purrsephone' },
      },
      channel: { scope: 'group', channelId: 'channel-1', threadId: 'thread-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{
          authorId: 'bot-2',
          authorName: 'Purrsephone',
          evidence: ['mention', 'reply'],
        }],
      },
    });
  });

  it('rejects the legacy mentions-only schema instead of inventing missing context', () => {
    expect(() => parseMessageAddressingMetadata({
      schemaVersion: 1,
      mentionedTargets: [{ authorId: 'bot-2', authorName: 'Purrsephone' }],
    })).toThrow('schemaVersion 2');
  });

  it('rejects reply evidence that conflicts with the transport reply author', () => {
    expect(() => parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'human-1', authorName: 'Vega' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [],
      replyTarget: {
        messageId: 'message-7',
        author: { authorId: 'bot-2', authorName: 'Purrsephone' },
      },
      channel: { scope: 'group', channelId: 'channel-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{
          authorId: 'bot-3',
          authorName: 'Lyra',
          evidence: ['reply'],
        }],
      },
    })).toThrow('reply evidence must match replyTarget.author');
  });

  it('rejects a resolved display name that conflicts with mention evidence', () => {
    expect(() => parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'human-1', authorName: 'Vega' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [{ authorId: 'bot-2', authorName: 'Purrsephone' }],
      channel: { scope: 'group', channelId: 'channel-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{
          authorId: 'bot-2',
          authorName: 'Lyra',
          evidence: ['mention'],
        }],
      },
    })).toThrow('mention evidence must match mentionedTargets');
  });

  it('rejects a direct envelope whose resolved addressee is not the authenticated observer', () => {
    expect(() => parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'human-1', authorName: 'Vega' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [],
      channel: { scope: 'direct', channelId: 'dm-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{
          authorId: 'bot-2',
          authorName: 'Purrsephone',
          evidence: ['direct_message'],
        }],
      },
    })).toThrow('direct-message evidence must match observer');
  });
});
