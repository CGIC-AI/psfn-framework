import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../event-bus.js';
import { SessionStore } from '../../session/store.js';
import type { SubstrateConfig } from '../../types.js';

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
      ClientReady: 'ready',
      VoiceStateUpdate: 'voiceStateUpdate',
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      DirectMessages: 8,
      GuildVoiceStates: 16,
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
