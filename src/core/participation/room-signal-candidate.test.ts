import { describe, expect, it, vi } from 'vitest';
import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';
import type { ChannelType, SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  createDefaultRoomSignalSettings,
  type RoomSignalSettings,
} from '../../system/config/participation-config.js';
import {
  PassiveNameCandidateBuilder,
  type RoomSignalRuntime,
} from './passive-name-candidate.js';
import {
  RoomMessageFeatureExtractor,
  SharedRoomClassifier,
  type RoomAmbiguityClassifierPort,
  type RoomNomination,
} from './room-signal.js';
import type { PassiveNameCandidateDecision } from './types.js';

/**
 * Cross-connector, cost, and privacy coverage for the channel-neutral room
 * signal (jp36.5.6 acceptance #1/#2/#3/#5/#8).
 */

const COMPANION_ID = 'companion-1';
const COMPANION_NAME = 'Persephone';
const OBSERVER = { authorId: 'companion-account', authorName: COMPANION_NAME };
const NOW = 1_700_000_000_000;

function roomSignalSettings(overrides: Partial<RoomSignalSettings> = {}): RoomSignalSettings {
  return {
    ...createDefaultRoomSignalSettings(),
    enabled: true,
    topicTags: { persistence: ['migration'] },
    companionInterests: ['persistence'],
    ...overrides,
  };
}

interface ConnectorLineOptions {
  source: 'discord' | 'telegram' | 'buzz';
  channelType: ChannelType;
  content: string;
  messageId?: string;
  mention?: boolean;
  sourceClass?: 'primary_user' | 'public_contact';
  roomRole?: 'member' | 'unknown' | 'moderator';
}

/** The same physical room line, as each connector would hand it to the agent. */
function connectorLine(options: ConnectorLineOptions): SubstrateMessage {
  const mentionedTargets = options.mention ? [OBSERVER] : [];
  const addressing = parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: options.source,
    author: { authorId: 'human-alice', authorName: 'Alice' },
    observer: OBSERVER,
    mentionedTargets,
    channel: { scope: 'group', channelId: 'room-1' },
    resolvedAddressee: options.mention
      ? { kind: 'participants', participants: [{ ...OBSERVER, evidence: ['mention'] }] }
      : { kind: 'room', channelId: 'room-1' },
    authorClass: {
      sourceClass: options.sourceClass ?? 'primary_user',
      roomRole: options.roomRole ?? 'member',
      roomSize: 'unknown',
    },
  });
  return {
    id: options.messageId ?? 'msg-1',
    channelId: 'room-1',
    channelType: options.channelType,
    authorId: 'human-alice',
    authorName: 'Alice',
    content: options.content,
    timestamp: new Date(NOW),
    isDirectMessage: false,
    routing: { source: options.source, responseMode: 'observe', addressing },
  };
}

function makeRuntime(options: {
  settings?: RoomSignalSettings;
  classifier?: SharedRoomClassifier;
  onNomination?: (nomination: RoomNomination) => void;
} = {}): RoomSignalRuntime {
  const settings = options.settings ?? roomSignalSettings();
  return {
    extractor: new RoomMessageFeatureExtractor({ settings }),
    profile: {
      companionId: COMPANION_ID,
      aliases: [COMPANION_NAME],
      interests: settings.companionInterests,
    },
    settings,
    ...(options.classifier ? { classifier: options.classifier } : {}),
    ...(options.onNomination ? { onNomination: options.onNomination } : {}),
  };
}

function makeBuilder(roomSignal: RoomSignalRuntime): PassiveNameCandidateBuilder {
  return new PassiveNameCandidateBuilder({
    scopeClassifier: { classifyChannelMemoryScope: async () => 'group' },
    contextReader: { getRecent: () => [] },
    companionNames: [COMPANION_NAME],
    // Deliberately empty: the connector's own observer identity, not a
    // Discord-shaped bot id, is what makes a message "mine" now.
    companionAuthorIds: [],
    nowMs: () => NOW,
    roomSignal,
  });
}

function outcome(decision: PassiveNameCandidateDecision): string {
  return decision.status === 'created' ? `created:${decision.candidate.trigger}` : decision.reason;
}

describe('room signal through the participation candidate gate', () => {
  it('reaches the same decision for equivalent Discord, Telegram, and Buzz lines', async () => {
    const cases = [
      { label: 'ambient relevant topic', content: 'the migration is stuck again', expected: 'no_name_match' },
      { label: 'platform mention', content: 'can you look?', mention: true, expected: 'created:direct_mention' },
      { label: 'leading alias', content: 'Persephone can you look?', expected: 'created:direct_mention' },
      { label: 'ambient alias mention', content: 'I think Persephone knows', expected: 'created:passive_name' },
      { label: 'irrelevant chatter', content: 'lunch soon?', expected: 'no_name_match' },
    ] as const;

    for (const testCase of cases) {
      const decisions: string[] = [];
      for (const [index, connector] of ([
        { source: 'discord', channelType: 'discord' },
        { source: 'telegram', channelType: 'telegram' },
        { source: 'buzz', channelType: 'buzz' },
      ] as const).entries()) {
        // A fresh builder per connector: only the transport differs.
        const builder = makeBuilder(makeRuntime());
        decisions.push(outcome(await builder.build(connectorLine({
          source: connector.source,
          channelType: connector.channelType,
          content: testCase.content,
          messageId: `msg-${index}`,
          ...(testCase.mention ? { mention: true } : {}),
        }))));
      }
      expect(decisions, testCase.label)
        .toEqual([testCase.expected, testCase.expected, testCase.expected]);
    }
  });

  it('costs no lease read and no classifier call for an ineligible ambient line', async () => {
    const admitContinuation = vi.fn(async () => ({ outcome: 'absent' as const }));
    const classify = vi.fn<RoomAmbiguityClassifierPort['classify']>(
      async () => ({ relevant: true }),
    );
    const settings = roomSignalSettings({
      classifier: { ...createDefaultRoomSignalSettings().classifier, enabled: true },
    });
    const builder = new PassiveNameCandidateBuilder({
      scopeClassifier: { classifyChannelMemoryScope: async () => 'group' },
      contextReader: { getRecent: () => [] },
      companionNames: [COMPANION_NAME],
      companionAuthorIds: [],
      nowMs: () => NOW,
      roomParticipationLease: { admitContinuation },
      roomSignal: makeRuntime({
        settings,
        classifier: new SharedRoomClassifier({
          classifier: { classify },
          claims: { claim: async () => true },
          settings,
        }),
      }),
    });

    // An untrusted public member with no direct address is refused by the
    // deterministic gate, before any durable read or model call.
    const decision = await builder.build(connectorLine({
      source: 'discord',
      channelType: 'discord',
      content: 'the migration is stuck again',
      sourceClass: 'public_contact',
      roomRole: 'unknown',
    }));
    expect(outcome(decision)).toBe('untrusted_room_member');
    expect(admitContinuation).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it('classifies one physical message at most once across several companion matchers', async () => {
    const classify = vi.fn<RoomAmbiguityClassifierPort['classify']>(
      async () => ({ relevant: false }),
    );
    const settings = roomSignalSettings({
      topicTags: {},
      classifier: { ...createDefaultRoomSignalSettings().classifier, enabled: true },
    });
    // One extractor and one shared classifier, exactly as a fan-out over several
    // eligible companions in one process would share them.
    const extractor = new RoomMessageFeatureExtractor({ settings });
    const shared = new SharedRoomClassifier({
      classifier: { classify },
      claims: { claim: async () => true },
      settings,
    });
    const builders = ['companion-1', 'companion-2', 'companion-3'].map(companionId =>
      new PassiveNameCandidateBuilder({
        scopeClassifier: { classifyChannelMemoryScope: async () => 'group' },
        contextReader: { getRecent: () => [] },
        companionNames: [COMPANION_NAME],
        companionAuthorIds: [],
        nowMs: () => NOW,
        // Each companion already holds membership in this room, so the message
        // reaches the ambiguity stage rather than stopping at the lease.
        roomParticipationLease: { admitContinuation: async () => ({ outcome: 'admitted' }) },
        roomSignal: {
          extractor,
          profile: { companionId, aliases: [COMPANION_NAME], interests: ['persistence'] },
          settings,
          classifier: shared,
        },
      }));

    const message = connectorLine({
      source: 'telegram',
      channelType: 'telegram',
      content: 'what do we do about that thing',
    });
    const decisions = await Promise.all(builders.map(async builder => outcome(await builder.build(message))));

    expect(decisions).toEqual([
      'room_signal_ambiguous',
      'room_signal_ambiguous',
      'room_signal_ambiguous',
    ]);
    // Three companions, one physical message, one classifier evaluation.
    expect(classify).toHaveBeenCalledTimes(1);
    expect(extractor.has('room-1', 'msg-1')).toBe(true);
  });

  it('records a bounded content-free nomination and never the room text', async () => {
    const nominations: RoomNomination[] = [];
    const builder = makeBuilder(makeRuntime({
      onNomination: nomination => nominations.push(nomination),
    }));
    await builder.build(connectorLine({
      source: 'buzz',
      channelType: 'buzz',
      content: 'Persephone the migration is stuck again',
    }));

    expect(nominations).toHaveLength(1);
    const serialized = JSON.stringify(nominations[0]);
    for (const secret of ['migration', 'stuck', 'Persephone', 'Alice', 'persistence']) {
      expect(serialized).not.toContain(secret);
    }
    expect(nominations[0]).toMatchObject({
      companionId: COMPANION_ID,
      roomId: 'room-1',
      messageId: 'msg-1',
      connector: 'buzz',
      trigger: 'direct_mention',
      reasonCodes: ['alias_leading_address'],
      classifierConsulted: false,
    });
  });

  it('treats the connector observer identity as the companion\'s own message', async () => {
    const builder = makeBuilder(makeRuntime());
    const message = connectorLine({
      source: 'discord',
      channelType: 'discord',
      content: 'the migration is stuck again',
    });
    const decision = await builder.build({
      ...message,
      authorId: OBSERVER.authorId,
      authorName: OBSERVER.authorName,
    });
    expect(outcome(decision)).toBe('own_message');
  });
});
