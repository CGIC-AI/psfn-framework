import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SessionEntry } from '../session/types.js';
import type { NearTurnMemoryScope } from '../../faculties/memory/near-turn-memory-lane.js';
import { createDefaultPassiveNameCandidateSettings } from '../../system/config/participation-config.js';
import {
  PassiveNameCandidateBuilder,
  type ParticipationContextReader,
  type PassiveNameCandidateBuilderOptions,
} from './passive-name-candidate.js';
import type { PassiveNameCandidateDecision } from './types.js';

const COMPANION_NAME = 'Persephone';
const COMPANION_BOT_ID = 'bot-persephone';
const GROUP_CHANNEL = 'discord-lounge';
const NOW = 1_000_000;

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: GROUP_CHANNEL,
    channelType: 'discord',
    authorId: 'human-alice',
    authorName: 'Alice',
    content: 'I wonder what Persephone thinks about that',
    timestamp: new Date(NOW),
    ...overrides,
  };
}

function makeEntry(id: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: GROUP_CHANNEL,
    role: 'user',
    content: `line ${id}`,
    authorId: `human-${id}`,
    authorName: `Human ${id}`,
    timestamp: NOW - (100 - id) * 1_000,
    discordMessageId: `disc-${id}`,
    ...overrides,
  };
}

function stubContextReader(entries: SessionEntry[] = []): ParticipationContextReader {
  return { getRecent: () => entries };
}

function makeBuilder(
  overrides: Partial<PassiveNameCandidateBuilderOptions> = {},
): PassiveNameCandidateBuilder {
  const scope: NearTurnMemoryScope = 'group';
  return new PassiveNameCandidateBuilder({
    scopeClassifier: {
      classifyChannelMemoryScope: async () => scope,
    },
    contextReader: stubContextReader(),
    companionNames: [COMPANION_NAME],
    companionAuthorIds: [COMPANION_BOT_ID],
    nowMs: () => NOW,
    ...overrides,
  });
}

function scopeClassifier(scope: NearTurnMemoryScope) {
  return { classifyChannelMemoryScope: async () => scope };
}

function expectSuppressed(
  decision: PassiveNameCandidateDecision,
  reason: string,
): void {
  expect(decision.status).toBe('suppressed');
  if (decision.status === 'suppressed') {
    expect(decision.reason).toBe(reason);
  }
}

describe('PassiveNameCandidateBuilder', () => {
  it('creates a passive-name candidate for an ambient name reference in a group room', async () => {
    const builder = makeBuilder();
    const decision = await builder.build(makeMessage());
    expect(decision.status).toBe('created');
    if (decision.status === 'created') {
      expect(decision.candidate.trigger).toBe('passive_name');
      expect(decision.candidate.matchedName).toBe(true);
      expect(decision.candidate.matchedDirectAddress).toBe(false);
      expect(decision.candidate.sourceMessageId).toBe('msg-1');
      expect(decision.candidate.channelId).toBe(GROUP_CHANNEL);
    }
  });

  it('classifies a leading address as a direct mention', async () => {
    const builder = makeBuilder();
    const decision = await builder.build(
      makeMessage({ content: 'Persephone can you help?' }),
    );
    expect(decision.status).toBe('created');
    if (decision.status === 'created') {
      expect(decision.candidate.trigger).toBe('direct_mention');
      expect(decision.candidate.matchedDirectAddress).toBe(true);
    }
  });

  describe('suppression matrix', () => {
    it('suppresses the companion\'s own messages', async () => {
      const builder = makeBuilder();
      const decision = await builder.build(
        makeMessage({ authorId: COMPANION_BOT_ID, authorName: COMPANION_NAME }),
      );
      expectSuppressed(decision, 'own_message');
    });

    it('suppresses ICP inter-companion lane traffic', async () => {
      const builder = makeBuilder();
      const decision = await builder.build(makeMessage({ channelType: 'companion' }));
      expectSuppressed(decision, 'icp_lane');
    });

    it('suppresses direct/private messages', async () => {
      const builder = makeBuilder();
      const decision = await builder.build(makeMessage({ isDirectMessage: true }));
      expectSuppressed(decision, 'direct_message');
    });

    it('suppresses non-group (direct-scope) channels', async () => {
      const builder = makeBuilder({ scopeClassifier: scopeClassifier('direct') });
      const decision = await builder.build(makeMessage());
      expectSuppressed(decision, 'not_group');
    });

    it('suppresses messages that do not name the companion', async () => {
      const builder = makeBuilder();
      const decision = await builder.build(
        makeMessage({ content: 'just some ordinary chatter here' }),
      );
      expectSuppressed(decision, 'no_name_match');
    });

    it('suppresses passive-name triggers below the contextual autonomy level', async () => {
      const settings = createDefaultPassiveNameCandidateSettings();
      settings.defaultAutonomyLevel = 'directed';
      const builder = makeBuilder({ settings });
      const decision = await builder.build(makeMessage());
      expectSuppressed(decision, 'autonomy_disabled');
      if (decision.status === 'suppressed') {
        expect(decision.trigger).toBe('passive_name');
      }
    });

    it('still allows direct mentions at the directed autonomy level', async () => {
      const settings = createDefaultPassiveNameCandidateSettings();
      settings.defaultAutonomyLevel = 'directed';
      const builder = makeBuilder({ settings });
      const decision = await builder.build(
        makeMessage({ content: 'Persephone are you there?' }),
      );
      expect(decision.status).toBe('created');
    });

    it('suppresses everything when autonomy is off', async () => {
      const settings = createDefaultPassiveNameCandidateSettings();
      settings.defaultAutonomyLevel = 'off';
      const builder = makeBuilder({ settings });
      const decision = await builder.build(
        makeMessage({ content: 'Persephone are you there?' }),
      );
      expectSuppressed(decision, 'autonomy_disabled');
    });

    it('honours per-channel autonomy overrides', async () => {
      const settings = createDefaultPassiveNameCandidateSettings();
      settings.channelAutonomyLevels = { [GROUP_CHANNEL]: 'directed' };
      const builder = makeBuilder({ settings });
      const decision = await builder.build(makeMessage());
      expectSuppressed(decision, 'autonomy_disabled');
    });

    it('suppresses stale messages outside the staleness window', async () => {
      const settings = createDefaultPassiveNameCandidateSettings();
      const builder = makeBuilder({ settings });
      const stale = makeMessage({
        timestamp: new Date(NOW - settings.stalenessMs - 1),
      });
      const decision = await builder.build(stale);
      expectSuppressed(decision, 'stale');
    });

    it('suppresses when the gate is disabled', async () => {
      const settings = createDefaultPassiveNameCandidateSettings();
      settings.enabled = false;
      const builder = makeBuilder({ settings });
      const decision = await builder.build(makeMessage());
      expectSuppressed(decision, 'disabled');
    });
  });

  describe('one candidate per source message', () => {
    it('suppresses a redelivered source message as a duplicate', async () => {
      const builder = makeBuilder();
      const first = await builder.build(makeMessage());
      expect(first.status).toBe('created');
      const second = await builder.build(makeMessage());
      expectSuppressed(second, 'duplicate');
    });

    it('creates independent candidates for distinct source messages', async () => {
      const builder = makeBuilder();
      const first = await builder.build(makeMessage({ id: 'msg-a' }));
      const second = await builder.build(makeMessage({ id: 'msg-b' }));
      expect(first.status).toBe('created');
      expect(second.status).toBe('created');
    });

    it('does not consume the dedup slot when a message is suppressed for another reason', async () => {
      const builder = makeBuilder({ scopeClassifier: scopeClassifier('direct') });
      // A suppressed (not_group) message must not poison the dedup ring.
      await builder.build(makeMessage({ id: 'msg-x' }));
      const groupBuilder = makeBuilder();
      const created = await groupBuilder.build(makeMessage({ id: 'msg-x' }));
      expect(created.status).toBe('created');
    });

    it('evicts old source ids once the per-channel dedup ring is full', async () => {
      const settings = createDefaultPassiveNameCandidateSettings();
      settings.dedupeHistoryPerChannel = 2;
      const builder = makeBuilder({ settings });
      await builder.build(makeMessage({ id: 'm1' }));
      await builder.build(makeMessage({ id: 'm2' }));
      await builder.build(makeMessage({ id: 'm3' })); // evicts m1
      const reprocessedEvicted = await builder.build(makeMessage({ id: 'm1' }));
      expect(reprocessedEvicted.status).toBe('created');
      const reprocessedRetained = await builder.build(makeMessage({ id: 'm3' }));
      expectSuppressed(reprocessedRetained, 'duplicate');
    });
  });

  describe('surrounding context for same-name disambiguation', () => {
    it('attaches bounded preceding room messages in chronological order', async () => {
      const settings = createDefaultPassiveNameCandidateSettings();
      settings.precedingContextMessages = 2;
      const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
      const builder = makeBuilder({
        settings,
        contextReader: stubContextReader(entries),
      });
      const decision = await builder.build(makeMessage());
      expect(decision.status).toBe('created');
      if (decision.status === 'created') {
        expect(decision.candidate.precedingContext).toHaveLength(2);
        expect(
          decision.candidate.precedingContext.map((m) => m.messageId),
        ).toEqual(['disc-2', 'disc-3']);
        expect(decision.candidate.precedingContext[0].timestampMs)
          .toBeLessThanOrEqual(decision.candidate.precedingContext[1].timestampMs);
      }
    });

    it('excludes the trigger message and future entries from the context', async () => {
      const entries = [
        makeEntry(1),
        makeEntry(2, { discordMessageId: 'msg-1' }), // the source itself
        makeEntry(3, { timestamp: NOW + 5_000 }), // arrives after the trigger
      ];
      const builder = makeBuilder({ contextReader: stubContextReader(entries) });
      const decision = await builder.build(makeMessage());
      expect(decision.status).toBe('created');
      if (decision.status === 'created') {
        const ids = decision.candidate.precedingContext.map((m) => m.messageId);
        expect(ids).toContain('disc-1');
        expect(ids).not.toContain('msg-1');
        expect(ids).not.toContain('disc-3');
      }
    });
  });
});
