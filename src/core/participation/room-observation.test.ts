import { describe, expect, it } from 'vitest';
import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';
import type { ChannelType, SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  normalizeRoomObservation,
  toRoomParticipationObservation,
  type RoomObservation,
} from './room-observation.js';

const OBSERVER = { authorId: 'companion-account', authorName: 'Vega' };
const AUTHOR = { authorId: 'human-account', authorName: 'Rae' };

interface ConnectorFixtureOptions {
  source: 'discord' | 'buzz' | 'telegram';
  channelType: ChannelType;
  mention?: boolean;
  reply?: boolean;
  authorClass?: {
    sourceClass: 'primary_user' | 'public_contact';
    roomRole: 'member' | 'unknown';
    roomSize: 'small' | 'large' | 'unknown';
  };
}

/**
 * Build the SAME physical room line as each connector would hand it to the
 * agent: identical ids, timestamp, and body, differing only in the transport
 * label. Equivalent connector payloads must normalize to equivalent
 * participation inputs (acceptance #1).
 */
function connectorMessage(options: ConnectorFixtureOptions): SubstrateMessage {
  const mentionedTargets = options.mention ? [OBSERVER] : [];
  const replyTarget = options.reply
    ? { messageId: 'room-message-000', author: OBSERVER }
    : undefined;
  const evidence = [
    ...(options.mention ? ['mention' as const] : []),
    ...(options.reply ? ['reply' as const] : []),
  ];
  const addressing = parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: options.source,
    author: AUTHOR,
    observer: OBSERVER,
    mentionedTargets,
    ...(replyTarget ? { replyTarget } : {}),
    channel: { scope: 'group', channelId: 'room-1' },
    resolvedAddressee: evidence.length > 0
      ? { kind: 'participants', participants: [{ ...OBSERVER, evidence }] }
      : { kind: 'room', channelId: 'room-1' },
    ...(options.authorClass ? { authorClass: options.authorClass } : {}),
  });
  return {
    id: 'room-message-001',
    channelId: 'room-1',
    channelType: options.channelType,
    authorId: AUTHOR.authorId,
    authorName: AUTHOR.authorName,
    content: 'does anyone know how the lease watermark orders ties?',
    timestamp: new Date(1_700_000_000_000),
    isDirectMessage: false,
    ...(replyTarget ? { replyToMessageId: replyTarget.messageId } : {}),
    routing: {
      source: options.source,
      responseMode: 'observe',
      addressing,
    },
  };
}

/** The connector-independent part of the observation. */
function transportNeutralShape(observation: RoomObservation): Omit<
  RoomObservation,
  'connector' | 'channelType'
> {
  const { connector: _connector, channelType: _channelType, ...neutral } = observation;
  return neutral;
}

function expectObserved(message: SubstrateMessage): RoomObservation {
  const result = normalizeRoomObservation(message);
  expect(result.status).toBe('observed');
  if (result.status !== 'observed') throw new Error('unreachable');
  return result.observation;
}

describe('normalizeRoomObservation', () => {
  it('normalizes equivalent Discord, Telegram, Buzz, and future-connector lines identically', () => {
    const authorClass = {
      sourceClass: 'primary_user' as const,
      roomRole: 'member' as const,
      roomSize: 'small' as const,
    };
    const discord = expectObserved(connectorMessage({
      source: 'discord',
      channelType: 'discord',
      mention: true,
      authorClass,
    }));
    const telegram = expectObserved(connectorMessage({
      source: 'telegram',
      channelType: 'telegram',
      mention: true,
      authorClass,
    }));
    const buzz = expectObserved(connectorMessage({
      source: 'buzz',
      channelType: 'buzz',
      mention: true,
      authorClass,
    }));
    // A connector that does not exist yet: same addressing contract, a channel
    // type participation policy has never heard of.
    const future = expectObserved(connectorMessage({
      source: 'buzz',
      channelType: 'multica',
      mention: true,
      authorClass,
    }));

    expect(transportNeutralShape(telegram)).toEqual(transportNeutralShape(discord));
    expect(transportNeutralShape(buzz)).toEqual(transportNeutralShape(discord));
    expect(transportNeutralShape(future)).toEqual(transportNeutralShape(discord));
    // The connector identity itself stays at the boundary, where it belongs.
    expect([discord.connector, telegram.connector, buzz.connector])
      .toEqual(['discord', 'telegram', 'buzz']);
    expect(discord.addressedByMention).toBe(true);
    expect(discord.addressedByReply).toBe(false);
  });

  it('resolves a reply to the companion from connector addressing on every connector', () => {
    for (const source of ['discord', 'telegram', 'buzz'] as const) {
      const observation = expectObserved(connectorMessage({
        source,
        channelType: source === 'buzz' ? 'buzz' : source,
        reply: true,
      }));
      expect(observation.addressedByReply).toBe(true);
      expect(observation.addressedByMention).toBe(false);
      expect(observation.replyToMessageId).toBe('room-message-000');
    }
  });

  it('falls closed when the connector asserted no addressing at all', () => {
    const observation = expectObserved({
      id: 'room-message-002',
      channelId: 'room-1',
      channelType: 'telegram',
      authorId: AUTHOR.authorId,
      authorName: AUTHOR.authorName,
      content: 'ambient chatter',
      timestamp: new Date(1_700_000_000_000),
      isDirectMessage: false,
    });
    expect(observation).toMatchObject({
      connector: 'unknown',
      roomVerified: false,
      roomSize: 'unknown',
      addressedByMention: false,
      addressedByReply: false,
      author: {
        isMachine: false,
        isObserver: false,
        sourceClass: 'public_contact',
        roomRole: 'unknown',
      },
    });
  });

  it('recognizes the observing companion as the author across connectors', () => {
    const message = connectorMessage({ source: 'discord', channelType: 'discord' });
    const observation = expectObserved({
      ...message,
      authorId: OBSERVER.authorId,
      authorName: OBSERVER.authorName,
    });
    expect(observation.author.isObserver).toBe(true);
  });

  it('rejects direct conversations from either the message flag or the addressing scope', () => {
    const message = connectorMessage({ source: 'discord', channelType: 'discord' });
    expect(normalizeRoomObservation({ ...message, isDirectMessage: true }))
      .toEqual({ status: 'rejected', reason: 'direct_message' });

    const directAddressing = parseMessageAddressingMetadata({
      schemaVersion: 2,
      source: 'discord',
      author: AUTHOR,
      observer: OBSERVER,
      mentionedTargets: [],
      channel: { scope: 'direct', channelId: 'dm-1' },
      resolvedAddressee: {
        kind: 'participants',
        participants: [{ ...OBSERVER, evidence: ['direct_message'] }],
      },
    });
    expect(normalizeRoomObservation({
      ...message,
      isDirectMessage: false,
      routing: { ...message.routing, addressing: directAddressing },
    })).toEqual({ status: 'rejected', reason: 'direct_message' });
  });

  it('rejects unusable identity and time rather than inventing them', () => {
    const message = connectorMessage({ source: 'buzz', channelType: 'buzz' });
    expect(normalizeRoomObservation({ ...message, id: '   ' }))
      .toEqual({ status: 'rejected', reason: 'invalid_identity' });
    expect(normalizeRoomObservation({ ...message, timestamp: new Date(Number.NaN) }))
      .toEqual({ status: 'rejected', reason: 'invalid_timestamp' });
  });
});

describe('toRoomParticipationObservation', () => {
  it('projects the lease gate input without carrying room text', () => {
    const observation = expectObserved(connectorMessage({
      source: 'telegram',
      channelType: 'telegram',
    }));
    const projected = toRoomParticipationObservation({
      ...observation,
      content: '  padded body  ',
      author: { ...observation.author, isMachine: true },
    });
    expect(projected).toEqual({
      messageId: 'room-message-001',
      timestampMs: 1_700_000_000_000,
      authorIsMachine: true,
      contentLength: 'padded body'.length,
    });
    expect(Object.keys(projected)).not.toContain('content');
  });
});
