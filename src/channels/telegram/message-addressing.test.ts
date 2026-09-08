import { describe, expect, it } from 'vitest';
import { buildTelegramMessageAddressing } from './message-addressing.js';

const OBSERVER = { id: 9001, displayName: 'lyra_bot', username: 'lyra_bot' };
const AUTHOR = { id: 42, username: 'morgan' };

function groupInput(overrides: Partial<Parameters<typeof buildTelegramMessageAddressing>[0]> = {}) {
  return buildTelegramMessageAddressing({
    messageText: 'plain room chatter',
    entities: [],
    author: AUTHOR,
    authorName: 'morgan',
    observer: OBSERVER,
    channelId: 'telegram:-900',
    isDirectMessage: false,
    sourceClass: 'public_contact',
    ...overrides,
  });
}

describe('buildTelegramMessageAddressing', () => {
  it('resolves an @username mention entity as a direct address', () => {
    const text = 'hey @lyra_bot can you look at this';
    const result = groupInput({
      messageText: text,
      entities: [{ type: 'mention', offset: text.indexOf('@'), length: '@lyra_bot'.length }],
    });
    expect(result.addressesObserver).toBe(true);
    expect(result.addressing.resolvedAddressee).toEqual({
      kind: 'participants',
      participants: [{ authorId: '9001', authorName: 'lyra_bot', evidence: ['mention'] }],
    });
  });

  it('resolves a text_mention entity by numeric account id', () => {
    const result = groupInput({
      messageText: 'Lyra could you check',
      entities: [{
        type: 'text_mention',
        offset: 0,
        length: 4,
        user: { id: 9001, username: 'lyra_bot' },
      }],
    });
    expect(result.addressesObserver).toBe(true);
    expect(result.addressing.mentionedTargets)
      .toEqual([{ authorId: '9001', authorName: 'lyra_bot' }]);
  });

  it('resolves a reply to the companion and ignores a reply to anyone else', () => {
    const toCompanion = groupInput({
      replyTo: { messageId: 77, from: { id: 9001, username: 'lyra_bot' } },
    });
    expect(toCompanion.addressesObserver).toBe(true);
    expect(toCompanion.addressing.replyTarget)
      .toEqual({ messageId: '77', author: { authorId: '9001', authorName: 'lyra_bot' } });

    const toOther = groupInput({
      replyTo: { messageId: 78, from: { id: 43, username: 'sam' } },
    });
    expect(toOther.addressesObserver).toBe(false);
    expect(toOther.addressing.resolvedAddressee)
      .toEqual({ kind: 'unresolved_reply', messageId: '78' });
  });

  it('never treats a bare name in prose as an address', () => {
    const result = groupInput({ messageText: 'lyra_bot said something once' });
    expect(result.addressesObserver).toBe(false);
    expect(result.addressing.resolvedAddressee)
      .toEqual({ kind: 'room', channelId: 'telegram:-900' });
  });

  it('drops an unresolvable third-party @handle rather than guessing an identity', () => {
    const text = 'ask @someone_else about it';
    const result = groupInput({
      messageText: text,
      entities: [{ type: 'mention', offset: text.indexOf('@'), length: '@someone_else'.length }],
    });
    expect(result.addressing.mentionedTargets).toEqual([]);
    expect(result.addressesObserver).toBe(false);
  });

  it('reports unknown room role and size, and carries the connector trust class', () => {
    expect(groupInput().addressing.authorClass).toEqual({
      sourceClass: 'public_contact',
      roomRole: 'unknown',
      roomSize: 'unknown',
    });
  });

  it('carries a thread id on a group room and refuses one on a direct chat', () => {
    expect(groupInput({ threadId: '7' }).addressing.channel)
      .toEqual({ scope: 'group', channelId: 'telegram:-900', threadId: '7' });
    const direct = groupInput({
      isDirectMessage: true,
      threadId: '7',
      channelId: 'telegram:111',
      sourceClass: 'regular_contact',
    });
    expect(direct.addressing.channel).toEqual({ scope: 'direct', channelId: 'telegram:111' });
    // A DM addresses the companion by definition, but not by mention or reply.
    expect(direct.addressesObserver).toBe(false);
  });

  it('refuses to fabricate an observer display name', () => {
    expect(() => groupInput({ observer: { id: 9001, displayName: '  ' } }))
      .toThrow('authenticated companion display name');
  });
});
