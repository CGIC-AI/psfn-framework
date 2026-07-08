import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { Contact } from '../../../core/contacts/types.js';
import {
  createDefaultGroupMemorySettings,
  type ChannelGroupMemoryConfig,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import {
  classifyGroupMemoryChannel,
  resolveGroupMemorySettingsForChannel,
} from './group-classifier.js';

function entry(
  id: number,
  authorId: string,
  authorName: string,
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    id,
    channelId: 'discord-room',
    role: 'user',
    content: `message ${id}`,
    authorId,
    authorName,
    timestamp: id * 1_000,
    ...overrides,
  };
}

function contact(
  id: string,
  displayName: string,
  overrides: Partial<Contact> = {},
): Contact {
  return {
    id,
    displayName,
    trustLevel: 'regular',
    relationshipType: 'acquaintance',
    firstSeen: '2026-06-28T00:00:00.000Z',
    lastSeen: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function groupMemory(overrides: Partial<GroupMemorySettings> = {}): GroupMemorySettings {
  const defaults = createDefaultGroupMemorySettings();
  return {
    ...defaults,
    ...overrides,
    autoDetection: {
      ...defaults.autoDetection,
      ...(overrides.autoDetection ?? {}),
    },
    onlineExtraction: {
      ...defaults.onlineExtraction,
      ...(overrides.onlineExtraction ?? {}),
    },
    salience: {
      ...defaults.salience,
      ...(overrides.salience ?? {}),
    },
    writeCaps: {
      ...defaults.writeCaps,
      ...(overrides.writeCaps ?? {}),
    },
    profileRefresh: {
      ...defaults.profileRefresh,
      ...(overrides.profileRefresh ?? {}),
    },
    telemetry: {
      ...defaults.telemetry,
      ...(overrides.telemetry ?? {}),
    },
    backfill: {
      ...defaults.backfill,
      ...(overrides.backfill ?? {}),
    },
  };
}

describe('group memory classifier', () => {
  it('resolves settings, provider, and channel memory-mode precedence', () => {
    const settings = groupMemory({
      memoryMode: 'direct',
      autoDetection: {
        ...createDefaultGroupMemorySettings().autoDetection,
        recentParticipantWindowMessages: 100,
      },
    });
    const channelConfig: ChannelGroupMemoryConfig = {
      memoryMode: 'group',
      channelOverrides: {
        room: {
          memoryMode: 'auto',
          autoDetection: {
            recentParticipantWindowMessages: 60,
          },
        },
      },
    };

    const resolved = resolveGroupMemorySettingsForChannel({
      base: settings,
      channelConfig,
      channelId: 'room',
    });

    expect(resolved.settings.memoryMode).toBe('auto');
    expect(resolved.settings.autoDetection.recentParticipantWindowMessages).toBe(60);
    expect(resolved.configuredMemoryModeSource).toBe('channel');
    expect(resolved.manualOverrideSource).toBeUndefined();
    expect(resolved.channelOverrideApplied).toBe(true);
  });

  it('forces direct or group behavior from manual overrides', async () => {
    const direct = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      recentEntries: [entry(1, 'u1', 'User One'), entry(2, 'u2', 'User Two')],
      channelGroupMemory: {
        memoryMode: 'auto',
        channelOverrides: {
          'discord-room': { memoryMode: 'direct' },
        },
      },
    });
    expect(direct.mode).toBe('direct');
    expect(direct.reason).toBe('manual_direct');
    expect(direct.manualOverrideSource).toBe('channel');

    const group = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      recentEntries: [],
      channelGroupMemory: {
        memoryMode: 'group',
        channelOverrides: {},
      },
    });
    expect(group.mode).toBe('group');
    expect(group.reason).toBe('manual_group');
    expect(group.manualOverrideSource).toBe('provider');
  });

  it('classifies Discord private direct messages as direct', async () => {
    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-dm',
      channelType: 'discord',
      recentEntries: [entry(1, 'u1', 'User One')],
      channelTopology: {
        kind: 'direct_message',
        source: 'provider_metadata',
      },
    });

    expect(classification.mode).toBe('direct');
    expect(classification.reason).toBe('topology_direct');
    expect(classification.topology).toEqual({
      kind: 'direct_message',
      source: 'provider_metadata',
      isDirect: true,
      isGroupCapable: false,
    });
  });

  it('keeps group-capable one-speaker rooms on the direct-tail path', async () => {
    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      recentEntries: [
        entry(1, 'u1', 'User One'),
        entry(2, 'u1', 'User One Renamed'),
      ],
      channelTopology: {
        kind: 'group_channel',
        source: 'provider_metadata',
      },
    });

    expect(classification.mode).toBe('group_capable_direct_tail');
    expect(classification.reason).toBe('group_capable_single_recent_human');
    expect(classification.recentParticipantCount).toBe(1);
    expect(classification.recentParticipants[0]).toMatchObject({
      stableId: 'discord:u1',
      authorId: 'u1',
      source: 'channel_identity',
      entryIds: [1, 2],
    });
  });

  it('promotes group-capable rooms when the recent human threshold is met', async () => {
    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      recentEntries: [
        entry(1, 'u1', 'User One'),
        entry(2, 'u2', 'User Two'),
      ],
      channelTopology: {
        kind: 'thread',
        source: 'provider_metadata',
      },
    });

    expect(classification.mode).toBe('group');
    expect(classification.reason).toBe('recent_participant_threshold');
    expect(classification.recentParticipantCount).toBe(2);
    expect(classification.topology.kind).toBe('thread');
  });

  it('uses bounded recent reads from configured channel overrides', async () => {
    const getRecent = vi.fn(() => [
      entry(61, 'u1', 'User One'),
      entry(62, 'u2', 'User Two'),
    ]);

    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      sessionReader: { getRecent },
      channelTopology: {
        kind: 'group_channel',
      },
      channelGroupMemory: {
        channelOverrides: {
          'discord-room': {
            autoDetection: {
              recentParticipantWindowMessages: 60,
            },
          },
        },
      },
    });

    expect(getRecent).toHaveBeenCalledTimes(1);
    expect(getRecent).toHaveBeenCalledWith('discord-room', 60);
    expect(classification.participantWindow.requestedMessageLimit).toBe(60);
    expect(classification.mode).toBe('group');
  });

  it('counts merged contact identities once and reports canonical contact ids', async () => {
    const merged = contact('contact-alice', 'Alice');
    const contactStore = {
      getByChannelIdentity: vi.fn(async (_channel: string, userId: string) => (
        userId === 'alice-old' || userId === 'alice-new' ? merged : undefined
      )),
    };

    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      recentEntries: [
        entry(1, 'alice-old', 'Alice'),
        entry(2, 'alice-new', 'Alice Again'),
        entry(3, 'bob', 'Bob'),
      ],
      contactStore,
      channelTopology: {
        kind: 'group_channel',
      },
    });

    expect(classification.recentParticipantCount).toBe(2);
    expect(classification.recentParticipantContactIds).toEqual(['contact-alice']);
    expect(classification.recentParticipants.find(p => p.contactId === 'contact-alice')).toMatchObject({
      stableId: 'contact:contact-alice',
      entryIds: [1, 2],
      source: 'contact',
    });
  });

  it('tracks unknown speakers by stable channel identity', async () => {
    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      recentEntries: [
        entry(1, 'u1', 'Old Name'),
        entry(2, 'u1', 'New Name'),
        entry(3, 'u2', 'Other User'),
      ],
      channelTopology: {
        kind: 'group_channel',
      },
    });

    expect(classification.recentParticipantCount).toBe(2);
    expect(classification.recentParticipants.map(p => p.stableId)).toEqual([
      'discord:u1',
      'discord:u2',
    ]);
  });

  it('filters companion, bot, system, API principal, and AI companion participants by policy', async () => {
    const aiCompanion = contact('contact-vega', 'Vega', {
      relationshipType: 'ai_companion',
      isMachineIntelligence: true,
    });
    const contactStore = {
      getByChannelIdentity: vi.fn(async (_channel: string, userId: string) => (
        userId === 'vega' ? aiCompanion : undefined
      )),
    };

    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      contactStore,
      companionAuthorIds: ['companion-bot'],
      botAuthorIds: ['music-bot'],
      systemAuthorIds: ['system-user'],
      apiPrincipalAuthorIds: ['api-principal'],
      recentEntries: [
        entry(1, 'companion-bot', 'Carlini'),
        entry(2, 'music-bot', 'Music Bot'),
        entry(3, 'system-user', 'System'),
        entry(4, 'api-principal', 'API'),
        entry(5, 'vega', 'Vega'),
        entry(6, 'human-one', 'Human One'),
        entry(7, 'human-two', 'Human Two', {
          metadata: JSON.stringify({ authorIsBot: false }),
        }),
        entry(8, 'metadata-bot', 'Metadata Bot', {
          metadata: JSON.stringify({ authorIsBot: true }),
        }),
      ],
      channelTopology: {
        kind: 'group_channel',
      },
    });

    expect(classification.mode).toBe('group');
    expect(classification.recentParticipants.map(p => p.stableId)).toEqual([
      'discord:human-one',
      'discord:human-two',
    ]);
  });

  it('can include AI companions when explicitly configured', async () => {
    const aiCompanion = contact('contact-vega', 'Vega', {
      relationshipType: 'ai_companion',
      isMachineIntelligence: true,
    });
    const contactStore = {
      getByChannelIdentity: vi.fn(async () => aiCompanion),
    };

    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      groupMemory: groupMemory({
        autoDetection: {
          ...createDefaultGroupMemorySettings().autoDetection,
          includeAiCompanions: true,
        },
      }),
      contactStore,
      recentEntries: [entry(1, 'vega', 'Vega')],
      channelTopology: {
        kind: 'group_channel',
      },
    });

    expect(classification.recentParticipantCount).toBe(1);
    expect(classification.recentParticipants[0]).toMatchObject({
      stableId: 'contact:contact-vega',
      contactRelationshipType: 'ai_companion',
      isMachineIntelligence: true,
    });
  });

  it('uses the configured rolling time window', async () => {
    const classification = await classifyGroupMemoryChannel({
      channelId: 'discord-room',
      channelType: 'discord',
      groupMemory: groupMemory({
        autoDetection: {
          ...createDefaultGroupMemorySettings().autoDetection,
          recentParticipantWindowMs: 2_000,
        },
      }),
      nowMs: 5_000,
      recentEntries: [
        entry(1, 'too-old', 'Too Old', { timestamp: 2_999 }),
        entry(2, 'u1', 'User One', { timestamp: 3_000 }),
        entry(3, 'u2', 'User Two', { timestamp: 5_000 }),
      ],
      channelTopology: {
        kind: 'group_channel',
      },
    });

    expect(classification.recentParticipantCount).toBe(2);
    expect(classification.participantWindow.cutoffTimestamp).toBe(3_000);
    expect(classification.participantWindow.eligibleEntryCount).toBe(2);
  });
});
