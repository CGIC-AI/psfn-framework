import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../event-bus.js';
import { SessionStore } from '../../session/store.js';
import type { SubstrateConfig, SubstrateMessage } from '../../types.js';

const discordMock = vi.hoisted(() => {
  return {
    channelsById: new Map<string, unknown>(),
    createdClients: [] as any[],
  };
});

const voiceMock = vi.hoisted(() => {
  return {
    init: vi.fn(),
    stop: vi.fn(async () => {}),
  };
});

vi.mock('discord.js', () => {
  class MockClient {
    channels = {
      fetch: vi.fn(async (channelId: string) => {
        const value = discordMock.channelsById.get(channelId);
        if (value instanceof Error) throw value;
        return value ?? null;
      }),
    };

    on = vi.fn();
    once = vi.fn();
    login = vi.fn(async () => 'logged-in');
    destroy = vi.fn();

    constructor() {
      discordMock.createdClients.push(this);
    }
  }

    return {
      Client: MockClient,
      Events: {
        MessageCreate: 'messageCreate',
        MessageReactionAdd: 'messageReactionAdd',
        ClientReady: 'ready',
        VoiceStateUpdate: 'voiceStateUpdate',
      },
      GatewayIntentBits: {
        Guilds: 1,
        GuildMessages: 2,
        MessageContent: 4,
        DirectMessages: 8,
        GuildVoiceStates: 16,
        GuildMessageReactions: 32,
      },
      Partials: {
        Channel: 'channel',
        Message: 'message',
        Reaction: 'reaction',
      },
    };
  });

vi.mock('./voice.js', () => {
  return {
    DiscordVoiceRuntime: class MockVoiceRuntime {
      init(): void {
        voiceMock.init();
      }

      async stop(): Promise<void> {
        await voiceMock.stop();
      }
    },
  };
});

import { DiscordAdapter } from './adapter.js';

interface MockDiscordMessage {
  id: string;
  content: string;
  createdTimestamp: number;
  author: {
    id: string;
    username: string;
    displayName?: string;
    bot: boolean;
  };
}

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'test',
    primaryProvider: 'test',
    extractionModel: 'test',
    extractionProvider: 'test',
    primaryMaxTokens: 1024,
    extractionMaxTokens: 1024,
    discordToken: 'discord-token',
    discordBotId: 'bot-1',
    characterCardPath: '',
    dataDir: '',
    databasePath: '',
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'test', provider: 'test', maxTokens: 1024, contextWindow: 128_000 },
    },
    discordBackfillOnStartup: true,
    discordTriggerWords: [],
    discordTriggerReactions: ['👆'],
    discordTriggerListenWindowMs: 120_000,
    characterName: '',
    ...overrides,
  };
}

function makeMessage(
  id: string,
  timestamp: number,
  options?: { content?: string; bot?: boolean; authorId?: string; displayName?: string },
): MockDiscordMessage {
  return {
    id,
    content: options?.content ?? `content-${id}`,
    createdTimestamp: timestamp,
    author: {
      id: options?.authorId ?? `user-${id}`,
      username: `user-${id}`,
      displayName: options?.displayName ?? `User ${id}`,
      bot: options?.bot ?? false,
    },
  };
}

function makeTextChannel(messages: MockDiscordMessage[]) {
  const fetch = vi.fn(async () => {
    return new Map(messages.map(msg => [msg.id, msg]));
  });

  return {
    channel: {
      isTextBased: () => true,
      messages: { fetch },
    },
    fetch,
  };
}

describe('DiscordAdapter startup backfill', () => {
  let sessionsDir: string;
  let store: SessionStore;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-discord-adapter-'));
    store = new SessionStore(sessionsDir);
    discordMock.channelsById.clear();
    discordMock.createdClients.length = 0;
    voiceMock.init.mockReset();
    voiceMock.stop.mockReset();
    voiceMock.stop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('backfills only channels with existing discord sessions', async () => {
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'existing discord session',
      authorId: 'u1',
      authorName: 'User One',
      timestamp: 1000,
      discordMessageId: 'm-existing',
    });
    store.append({
      channelId: 'api:test-session',
      role: 'user',
      content: 'existing api session',
      authorId: 'api-user',
      authorName: 'API User',
      timestamp: 2000,
    });

    const textChannel = makeTextChannel([
      makeMessage('m-new-1', 3000, { content: 'new from discord' }),
    ]);
    discordMock.channelsById.set('123456789012345678', textChannel.channel);

    const adapter = new DiscordAdapter(makeConfig(), new EventBus(), { sessionStore: store });
    await adapter.start();

    const client = discordMock.createdClients[0];
    expect(client.channels.fetch).toHaveBeenCalledTimes(1);
    expect(client.channels.fetch).toHaveBeenCalledWith('123456789012345678');
    expect(store.count('123456789012345678')).toBe(2);
    expect(store.count('api:test-session')).toBe(1);
  });

  it('uses bounded backfill fetch, skips bot messages, and records missed messages', async () => {
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'old user',
      authorId: 'user-1',
      authorName: 'User One',
      timestamp: 1000,
      discordMessageId: 'm-old',
    });
    store.append({
      channelId: '123456789012345678',
      role: 'assistant',
      content: 'assistant response',
      timestamp: 1100,
    });

    const textChannel = makeTextChannel([
      makeMessage('m-bot', 1200, { bot: true }),
      makeMessage('m-new-2', 1400, { content: 'second new message' }),
      makeMessage('m-new-1', 1300, { content: 'first new message' }),
    ]);
    discordMock.channelsById.set('123456789012345678', textChannel.channel);

    const adapter = new DiscordAdapter(makeConfig(), new EventBus(), { sessionStore: store });
    await adapter.start();

    expect(textChannel.fetch).toHaveBeenCalledTimes(1);
    expect(textChannel.fetch).toHaveBeenCalledWith({ limit: 100, after: 'm-old' });

    const entries = store.getRecent('123456789012345678', 10);
    const appended = entries.filter(e => e.discordMessageId?.startsWith('m-new-'));
    expect(appended).toHaveLength(2);
    expect(appended[0].discordMessageId).toBe('m-new-1');
    expect(appended[1].discordMessageId).toBe('m-new-2');
    expect(appended[0].content).toBe('first new message');
    expect(appended[1].content).toBe('second new message');
  });

  it('deduplicates by discord message id before appending', async () => {
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'already have this',
      authorId: 'user-1',
      authorName: 'User One',
      timestamp: 1000,
      discordMessageId: 'm-dup',
    });

    const textChannel = makeTextChannel([
      makeMessage('m-dup', 1100, { content: 'duplicate payload' }),
      makeMessage('m-fresh', 1200, { content: 'fresh payload' }),
    ]);
    discordMock.channelsById.set('123456789012345678', textChannel.channel);

    const adapter = new DiscordAdapter(makeConfig(), new EventBus(), { sessionStore: store });
    await adapter.start();

    const entries = store.getRecent('123456789012345678', 10);
    const discordEntries = entries.filter(e => e.discordMessageId);
    expect(discordEntries).toHaveLength(2);
    expect(discordEntries[0].discordMessageId).toBe('m-dup');
    expect(discordEntries[1].discordMessageId).toBe('m-fresh');
  });

  it('isolates per-channel failures and continues backfill for other channels', async () => {
    store.append({
      channelId: '111111111111111111',
      role: 'user',
      content: 'channel one existing',
      authorId: 'user-1',
      authorName: 'User One',
      timestamp: 1000,
      discordMessageId: 'm-old-1',
    });
    store.append({
      channelId: '222222222222222222',
      role: 'user',
      content: 'channel two existing',
      authorId: 'user-2',
      authorName: 'User Two',
      timestamp: 2000,
      discordMessageId: 'm-old-2',
    });

    discordMock.channelsById.set('111111111111111111', new Error('fetch failed'));
    const channelTwo = makeTextChannel([
      makeMessage('m-new-2', 3000, { content: 'channel two backfill' }),
    ]);
    discordMock.channelsById.set('222222222222222222', channelTwo.channel);

    const adapter = new DiscordAdapter(makeConfig(), new EventBus(), { sessionStore: store });
    await adapter.start();

    expect(store.count('111111111111111111')).toBe(1);
    expect(store.count('222222222222222222')).toBe(2);
    expect(store.getLastEntry('222222222222222222')?.discordMessageId).toBe('m-new-2');
  });

  it('does not run startup backfill when disabled by config', async () => {
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'existing session',
      authorId: 'u1',
      authorName: 'User One',
      timestamp: 1000,
      discordMessageId: 'm-existing',
    });

    const textChannel = makeTextChannel([
      makeMessage('m-new', 1200, { content: 'should not backfill' }),
    ]);
    discordMock.channelsById.set('123456789012345678', textChannel.channel);

    const adapter = new DiscordAdapter(
      makeConfig({ discordBackfillOnStartup: false }),
      new EventBus(),
      { sessionStore: store },
    );
    await adapter.start();

    const client = discordMock.createdClients[0];
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(textChannel.fetch).not.toHaveBeenCalled();
    expect(store.count('123456789012345678')).toBe(1);
  });
});

interface MockSentMessage {
  content: string;
  edit: (next: string) => Promise<MockSentMessage>;
  delete: () => Promise<void>;
}

function makeInteractiveTextChannel() {
  const sent: string[] = [];
  const edits: string[] = [];
  const deleted: string[] = [];
  let typingCalls = 0;

  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: vi.fn(async () => new Map()),
    },
    sendTyping: vi.fn(async () => { typingCalls++; }),
    send: vi.fn(async (content: string) => {
      const message: MockSentMessage = {
        content,
        edit: async (next: string) => {
          message.content = next;
          edits.push(next);
          return message;
        },
        delete: async () => {
          deleted.push(message.content);
        },
      };
      sent.push(content);
      return message;
    }),
  };

  return { channel, sent, edits, deleted, get typingCalls() { return typingCalls; } };
}

function makeDiscordIncomingMessage(
  channelId: string,
  channel: any,
  overrides?: {
    id?: string;
    content?: string;
    guildId?: string | null;
    mentioned?: boolean;
    authorId?: string;
    authorDisplayName?: string;
    bot?: boolean;
  },
) {
  const guildId = overrides?.guildId ?? null;
  const mentioned = overrides?.mentioned ?? false;

  return {
    id: overrides?.id ?? 'msg-1',
    channelId,
    channel,
    guild: guildId ? { id: guildId } : null,
    content: overrides?.content ?? 'hello',
    createdAt: new Date(),
    author: {
      id: overrides?.authorId ?? 'user-1',
      bot: overrides?.bot ?? false,
      username: 'User',
      displayName: overrides?.authorDisplayName ?? 'User',
    },
    mentions: { has: () => mentioned },
    reply: vi.fn(async () => {}),
  };
}

function makeReactionTargetMessage(
  channelId: string,
  channel: any,
  overrides?: {
    id?: string;
    content?: string;
    guildId?: string | null;
    authorId?: string;
    authorDisplayName?: string;
    bot?: boolean;
  },
) {
  return {
    ...makeDiscordIncomingMessage(channelId, channel, {
      ...overrides,
      mentioned: false,
    }),
    partial: false,
    delete: vi.fn(async () => {}),
  };
}

function makeReactionPayload(targetMessage: any, options?: { emojiName?: string; emojiId?: string | null }) {
  return {
    emoji: {
      name: options?.emojiName ?? '👆',
      id: options?.emojiId ?? null,
    },
    partial: false,
    message: targetMessage,
    fetch: vi.fn(async () => null),
    remove: vi.fn(async () => {}),
  };
}

describe('DiscordAdapter DM routing', () => {
  beforeEach(() => {
    discordMock.channelsById.clear();
    discordMock.createdClients.length = 0;
    voiceMock.init.mockReset();
    voiceMock.stop.mockReset();
    voiceMock.stop.mockResolvedValue(undefined);
  });

  it('routes DMs without requiring a bot mention', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-channel';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'dm reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-1',
        content: 'hello from dm',
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      channelId,
      isDirectMessage: true,
      content: 'hello from dm',
    }));
    expect(interactive.sent).toContain('dm reply');
  });

  it('requires mentions in guild channels and strips bot mention text', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'guild-channel';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'guild reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'guild-1',
        guildId: 'guild-1',
        content: 'hello without mention',
        mentioned: false,
      }),
    );
    expect(handler).not.toHaveBeenCalled();

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'guild-2',
        guildId: 'guild-1',
        content: '<@!bot-1> hello with mention',
        mentioned: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      channelId,
      isDirectMessage: false,
      content: 'hello with mention',
    }));
    expect(interactive.sent).toContain('guild reply');
  });

  it('responds to guild messages without mention when character name trigger matches', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig({ characterName: 'Purrsephone' }), eventBus);
    await adapter.init();

    const channelId = 'guild-channel-trigger-char';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'triggered reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'guild-trigger-1',
        guildId: 'guild-1',
        content: 'hey purrsephone, are you there?',
        mentioned: false,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(interactive.sent).toContain('triggered reply');
  });

  it('responds to guild messages when configured trigger words match case-insensitively', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig({
      discordTriggerWords: ['pixie', 'wake up'],
    }), eventBus);
    await adapter.init();

    const channelId = 'guild-channel-trigger-word';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'keyword reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'guild-trigger-word-1',
        guildId: 'guild-1',
        content: 'WAKE UP please',
        mentioned: false,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(interactive.sent).toContain('keyword reply');
  });

  it('falls back to live client user id for mention stripping when config bot id is missing', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig({ discordBotId: '' }), eventBus);
    await adapter.init();

    const client = discordMock.createdClients[0];
    client.user = { id: 'bot-runtime' };

    const channelId = 'guild-channel-runtime-bot';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'runtime id reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'guild-runtime-1',
        guildId: 'guild-1',
        content: '<@!bot-runtime> hello',
        mentioned: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      content: 'hello',
    }));
  });

  it('extends listening windows after trigger and honors !i opt-out', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const eventBus = new EventBus();
      const adapter = new DiscordAdapter(makeConfig({
        discordTriggerWords: ['summon'],
        discordTriggerListenWindowMs: 10_000,
      }), eventBus);
      await adapter.init();

      const channelId = 'guild-channel-listening';
      const interactive = makeInteractiveTextChannel();
      discordMock.channelsById.set(channelId, interactive.channel);

      const handler = vi.fn(async (message: SubstrateMessage) => {
        return {
          content: `reply-${message.id}`,
          channelId,
          metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
        };
      });
      adapter.onMessage(handler);

      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'guild-listen-1',
          guildId: 'guild-1',
          authorId: 'user-listen',
          content: 'please summon her',
          mentioned: false,
        }),
      );
      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'guild-listen-2',
          guildId: 'guild-1',
          authorId: 'user-listen',
          content: 'follow-up without keywords',
          mentioned: false,
        }),
      );
      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'guild-listen-3',
          guildId: 'guild-1',
          authorId: 'user-listen',
          content: '!i skip this one',
          mentioned: false,
        }),
      );

      vi.advanceTimersByTime(10_001);
      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'guild-listen-4',
          guildId: 'guild-1',
          authorId: 'user-listen',
          content: 'window should be expired now',
          mentioned: false,
        }),
      );

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls.map((call) => call[0].id)).toEqual(['guild-listen-1', 'guild-listen-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invokes bot on target message when default 👆 reaction trigger is used', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'guild-channel-reaction';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'reaction reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    const targetMessage = makeReactionTargetMessage(channelId, interactive.channel, {
      id: 'reaction-target-1',
      guildId: 'guild-1',
      authorId: 'user-target',
      content: 'react to this message',
    });
    const reaction = makeReactionPayload(targetMessage, { emojiName: '👆' });

    await (adapter as any).onReactionAdd(reaction, {
      id: 'reactor-1',
      bot: false,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      id: 'reaction-target-1',
      content: 'react to this message',
    }));
    expect(targetMessage.reply).toHaveBeenCalledWith('reaction reply');
    expect(reaction.remove).toHaveBeenCalledTimes(1);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'reaction-followup-1',
        guildId: 'guild-1',
        authorId: 'reactor-1',
        content: 'follow-up after reaction trigger',
        mentioned: false,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('deletes bot-authored message when ❌ reaction is added', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const handler = vi.fn(async () => {
      return {
        content: 'should not run',
        channelId: 'guild-channel-delete',
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    const channelId = 'guild-channel-delete';
    const interactive = makeInteractiveTextChannel();
    const targetMessage = makeReactionTargetMessage(channelId, interactive.channel, {
      id: 'reaction-delete-target',
      guildId: 'guild-1',
      authorId: 'bot-1',
      bot: true,
      content: 'bot message',
    });
    const reaction = makeReactionPayload(targetMessage, { emojiName: '❌' });

    await (adapter as any).onReactionAdd(reaction, {
      id: 'reactor-2',
      bot: false,
    });

    expect(targetMessage.delete).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses live config updates for trigger words, reaction triggers, and listening window duration', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      const eventBus = new EventBus();
      const config = makeConfig({
        discordTriggerWords: ['alpha'],
        discordTriggerReactions: ['👆'],
        discordTriggerListenWindowMs: 120_000,
      });
      const adapter = new DiscordAdapter(config, eventBus);
      await adapter.init();

      const channelId = 'guild-channel-live-config';
      const interactive = makeInteractiveTextChannel();
      discordMock.channelsById.set(channelId, interactive.channel);

      const handler = vi.fn(async (message: SubstrateMessage) => {
        return {
          content: `live-${message.id}`,
          channelId,
          metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
        };
      });
      adapter.onMessage(handler);

      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'live-word-1',
          guildId: 'guild-1',
          authorId: 'user-live-1',
          content: 'beta ping',
          mentioned: false,
        }),
      );
      expect(handler).not.toHaveBeenCalled();

      config.discordTriggerWords = ['beta'];
      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'live-word-2',
          guildId: 'guild-1',
          authorId: 'user-live-1',
          content: 'beta ping',
          mentioned: false,
        }),
      );
      expect(handler).toHaveBeenCalledTimes(1);

      config.discordTriggerListenWindowMs = 10_000;
      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'live-window-1',
          guildId: 'guild-1',
          authorId: 'user-live-2',
          content: 'beta opens window',
          mentioned: false,
        }),
      );
      expect(handler).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(10_001);
      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'live-window-2',
          guildId: 'guild-1',
          authorId: 'user-live-2',
          content: 'no trigger after expiry',
          mentioned: false,
        }),
      );
      expect(handler).toHaveBeenCalledTimes(2);

      config.discordTriggerReactions = ['🔥'];
      const targetMessage = makeReactionTargetMessage(channelId, interactive.channel, {
        id: 'live-reaction-target',
        guildId: 'guild-1',
        authorId: 'user-live-3',
        content: 'reaction target',
      });
      const oldReaction = makeReactionPayload(targetMessage, { emojiName: '👆' });
      await (adapter as any).onReactionAdd(oldReaction, { id: 'reactor-live', bot: false });
      expect(handler).toHaveBeenCalledTimes(2);

      const newReaction = makeReactionPayload(targetMessage, { emojiName: '🔥' });
      await (adapter as any).onReactionAdd(newReaction, { id: 'reactor-live', bot: false });
      expect(handler).toHaveBeenCalledTimes(3);
      expect(targetMessage.reply).toHaveBeenCalledWith('live-live-reaction-target');
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues contended messages in gateway mode when no direct agent is attached', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-queue-channel';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    let releaseFirst: (() => void) | null = null;
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const handler = vi.fn(async (message: SubstrateMessage) => {
      if (message.id === 'dm-1') {
        await firstTurn;
      }
      return {
        content: `reply-${message.id}`,
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    const firstDispatch = (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-1',
        content: 'first',
      }),
    );

    await Promise.resolve();

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-2',
        content: 'second',
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await firstDispatch;
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });
    expect(handler.mock.calls.map((call) => call[0].id)).toEqual(['dm-1', 'dm-2']);
  });
});

describe('DiscordAdapter status visibility', () => {
  beforeEach(() => {
    discordMock.channelsById.clear();
    discordMock.createdClients.length = 0;
    voiceMock.init.mockReset();
    voiceMock.stop.mockReset();
    voiceMock.stop.mockResolvedValue(undefined);
  });

  it('exposes composable channel adapter facets', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);

    expect(adapter.id).toBe('discord');
    expect(adapter.name).toBe('discord');
    expect(adapter.meta.label).toBe('Discord');
    expect(adapter.capabilities.promptChannelType).toBe('discord_text');
    expect(adapter.gateway).toBe(adapter);
    expect(adapter.outbound.textChunkLimit).toBe(2000);
    expect(adapter.security?.requiresMentionForChannelMessages).toBe(true);

    const promptTextType = adapter.prompt?.resolveChannelType({
      id: 'msg-1',
      channelId: '123456789012345678',
      channelType: 'discord',
      authorId: 'u1',
      authorName: 'User',
      content: 'hello',
      timestamp: new Date(),
    } satisfies SubstrateMessage);
    const promptVoiceType = adapter.prompt?.resolveChannelType({
      id: 'msg-2',
      channelId: 'discord-voice:guild-1',
      channelType: 'discord',
      authorId: 'u1',
      authorName: 'User',
      content: 'hello',
      timestamp: new Date(),
    } satisfies SubstrateMessage);

    expect(promptTextType).toBe('discord_text');
    expect(promptVoiceType).toBe('discord_voice');

    const channelId = 'facet-channel';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    await adapter.outbound.sendText({ channelId }, 'facet reply');
    await adapter.streaming?.sendTyping(channelId);

    expect(interactive.sent).toContain('facet reply');
    expect(interactive.typingCalls).toBeGreaterThan(0);
  });

  it('shows and clears compaction status messages', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch1';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    adapter.onMessage(async () => {
      await eventBus.emit('agent.compaction.start', {
        channelId,
        reason: 'threshold',
        tokensBefore: 2000,
        tokenBudget: 1500,
      });
      await eventBus.emit('agent.compaction.end', {
        channelId,
        tokensBefore: 2000,
        tokensAfter: 1200,
      });
      return {
        content: 'final reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });

    await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

    expect(interactive.typingCalls).toBeGreaterThan(0);
    expect(interactive.sent).toContain('Organizing context to stay within token budget...');
    expect(interactive.deleted).toContain('Organizing context to stay within token budget...');
    expect(interactive.sent).toContain('final reply');
  });

  it('surfaces retry status updates and failure notice', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch2';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    adapter.onMessage(async () => {
      await eventBus.emit('agent.retry.start', {
        channelId,
        attempt: 2,
        maxAttempts: 3,
        delayMs: 250,
        error: '429 rate limit',
      });
      await eventBus.emit('agent.retry.end', {
        channelId,
        success: false,
        attempt: 2,
      });
      return {
        content: 'final reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });

    await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

    expect(interactive.sent.some(msg => msg.includes('Connection hiccup, retrying (2/3)'))).toBe(true);
    expect(interactive.edits).toContain('Having trouble reaching my thoughts. Please try again.');
  });

  it('emits queue telemetry for lock acquisition, contention, and release', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch-queue';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const queueEvents: any[] = [];
    (eventBus as any).on('channel.queue.telemetry', (event: any) => {
      queueEvents.push(event);
    });

    let releaseFirstTurn: (() => void) | null = null;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });

    adapter.onMessage(async () => {
      await firstTurnGate;
      return {
        content: 'final reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });

    const steerSpy = vi.fn();
    (adapter as any).agent = { steer: steerSpy };

    const firstTurn = (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, { id: 'msg-1', content: 'first' }),
    );
    await Promise.resolve();
    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, { id: 'msg-2', content: 'second' }),
    );

    expect(steerSpy).toHaveBeenCalledTimes(1);
    expect(queueEvents.some(event =>
      event.phase === 'acquired'
      && event.queueDepth === 0
      && event.policy === 'steer'
      && event.source === 'discord'
    )).toBe(true);
    expect(queueEvents.some(event =>
      event.phase === 'contended'
      && event.queueDepth === 1
      && event.policy === 'steer'
      && event.source === 'discord'
    )).toBe(true);

    releaseFirstTurn?.();
    await firstTurn;

    expect(queueEvents.some(event =>
      event.phase === 'released'
      && event.waitMs >= 0
      && event.policy === 'steer'
      && event.source === 'discord'
    )).toBe(true);
  });

  it('suppresses empty handler responses instead of sending empty Discord messages', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch-empty';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    adapter.onMessage(async () => {
      return {
        content: '   ',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });

    await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

    expect(interactive.sent).toHaveLength(0);
  });
});
