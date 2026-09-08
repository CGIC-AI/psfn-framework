import { describe, expect, it } from 'vitest';

import { parseMessageAddressingMetadata } from './message-addressing.js';

describe('message addressing contract', () => {
  it('normalizes a complete Discord group addressing envelope', () => {
    expect(parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'human-1', authorName: 'Morgan' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [{ authorId: 'bot-2', authorName: 'Companion' }],
      replyTarget: {
        messageId: 'message-7',
        author: { authorId: 'bot-2', authorName: 'Companion' },
      },
      channel: { scope: 'group', channelId: 'channel-1', threadId: 'thread-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{
          authorId: 'bot-2',
          authorName: 'Companion',
          evidence: ['mention', 'reply'],
        }],
      },
    })).toEqual({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'human-1', authorName: 'Morgan' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [{ authorId: 'bot-2', authorName: 'Companion' }],
      replyTarget: {
        messageId: 'message-7',
        author: { authorId: 'bot-2', authorName: 'Companion' },
      },
      channel: { scope: 'group', channelId: 'channel-1', threadId: 'thread-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{
          authorId: 'bot-2',
          authorName: 'Companion',
          evidence: ['mention', 'reply'],
        }],
      },
    });
  });

  it('rejects the legacy mentions-only schema instead of inventing missing context', () => {
    expect(() => parseMessageAddressingMetadata({
      schemaVersion: 1,
      mentionedTargets: [{ authorId: 'bot-2', authorName: 'Companion' }],
    })).toThrow('schemaVersion 2');
  });

  it('rejects reply evidence that conflicts with the transport reply author', () => {
    expect(() => parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'discord',
      author: { authorId: 'human-1', authorName: 'Morgan' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [],
      replyTarget: {
        messageId: 'message-7',
        author: { authorId: 'bot-2', authorName: 'Companion' },
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
      author: { authorId: 'human-1', authorName: 'Morgan' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [{ authorId: 'bot-2', authorName: 'Companion' }],
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
      author: { authorId: 'human-1', authorName: 'Morgan' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [],
      channel: { scope: 'direct', channelId: 'dm-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{
          authorId: 'bot-2',
          authorName: 'Companion',
          evidence: ['direct_message'],
        }],
      },
    })).toThrow('direct-message evidence must match observer');
  });

  it('accepts a telegram group envelope with a connector-translated author class', () => {
    const parsed = parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'telegram',
      author: { authorId: 'tg-9', authorName: 'Morgan' },
      observer: { authorId: 'tg-bot', authorName: 'Lyra' },
      mentionedTargets: [{ authorId: 'tg-bot', authorName: 'Lyra' }],
      channel: { scope: 'group', channelId: 'tg-chat-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{ authorId: 'tg-bot', authorName: 'Lyra', evidence: ['mention'] }],
      },
      authorClass: { sourceClass: 'primary_user', roomRole: 'member', roomSize: 'small' },
    });
    expect(parsed.source).toBe('telegram');
    expect(parsed.authorClass)
      .toEqual({ sourceClass: 'primary_user', roomRole: 'member', roomSize: 'small' });
  });

  it('omits an unasserted author class instead of inventing a trusted default', () => {
    const parsed = parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'buzz',
      author: { authorId: 'npub-1', authorName: 'Morgan' },
      observer: { authorId: 'npub-bot', authorName: 'Lyra' },
      mentionedTargets: [],
      channel: { scope: 'group', channelId: 'buzz-1' },
      resolvedAddressee: { kind: 'room', channelId: 'buzz-1' },
    });
    expect(parsed.authorClass).toBeUndefined();
  });

  it('rejects an unknown addressing source and an unknown author class member', () => {
    const base = {
      schemaVersion: 2,
      author: { authorId: 'human-1', authorName: 'Morgan' },
      observer: { authorId: 'bot-1', authorName: 'Lyra' },
      mentionedTargets: [],
      channel: { scope: 'group', channelId: 'channel-1' },
      resolvedAddressee: { kind: 'room', channelId: 'channel-1' },
    };
    expect(() => parseMessageAddressingMetadata({ ...base, source: 'slack' }))
      .toThrow('source must be one of discord, buzz, telegram');
    expect(() => parseMessageAddressingMetadata({
      ...base,
      source: 'discord',
      authorClass: { sourceClass: 'web_fetch', roomRole: 'member', roomSize: 'small' },
    })).toThrow('authorClass.sourceClass');
    expect(() => parseMessageAddressingMetadata({
      ...base,
      source: 'discord',
      authorClass: { sourceClass: 'primary_user', roomRole: 'admin', roomSize: 'small' },
    })).toThrow('authorClass.roomRole');
  });
});
