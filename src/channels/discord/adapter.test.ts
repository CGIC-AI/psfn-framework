import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../shared/event-bus.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { IntentionalNoReplyMetadata, SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  resetRuntimeChannelEnvelopeLabels,
  setRuntimeChannelEnvelopeLabels,
} from '../../system/trust/runtime-channel-labels.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../shared/logger.js';

const discordMock = vi.hoisted(() => {
  return {
    channelsById: new Map<string, unknown>(),
    channelsCacheById: new Map<string, unknown>(),
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
    constructor(readonly options: unknown) {
      discordMock.createdClients.push(this);
    }

    channels = {
      fetch: vi.fn(async (channelId: string) => {
        const value = discordMock.channelsById.get(channelId);
        if (value instanceof Error) throw value;
        return value ?? null;
      }),
      cache: {
        get: (channelId: string) => discordMock.channelsCacheById.get(channelId) ?? undefined,
      },
    };
    user = null;
    isReady = vi.fn(() => false);

    on = vi.fn();
    once = vi.fn();
    login = vi.fn(async () => 'logged-in');
    destroy = vi.fn();

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
        GuildMembers: 64,
      },
      Partials: {
        Channel: 'channel',
        Message: 'message',
        Reaction: 'reaction',
        GuildMember: 'guild-member',
        ThreadMember: 'thread-member',
      },
    };
  });

// The SSRF-guarded attachment/media fetch path (safe-fetch.ts) resolves
// hostnames before fetching. Pin DNS to a public address so tests never
// touch the live resolver network.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    lookup: vi.fn(async () => ({ address: '93.184.216.34', family: 4 })),
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
import { STANDARD_REACTION_SUBSET } from '../shared/reaction-surface.js';

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

interface MockDiscordAttachment {
  id: string;
  name?: string;
  url: string;
  proxyURL?: string;
  contentType?: string;
  size?: number;
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
  it('requests privileged member observation only when evidence mappings enable it', async () => {
    new DiscordAdapter(makeConfig(), new EventBus());
    const disabledClient = discordMock.createdClients.at(-1) as {
      options: { intents: number[]; partials: string[] };
    };
    expect(disabledClient.options.intents).not.toContain(64);
    expect(disabledClient.options.partials).not.toContain('guild-member');
    expect(disabledClient.options.partials).not.toContain('thread-member');

    const enabled = new DiscordAdapter(makeConfig(), new EventBus(), {
      enableDiscordEvidenceLifecycle: true,
    });
    const enabledClient = discordMock.createdClients.at(-1) as {
      options: { intents: number[]; partials: string[] };
    };
    expect(enabledClient.options.intents).toContain(64);
    expect(enabledClient.options.partials).toContain('guild-member');
    expect(enabledClient.options.partials).toContain('thread-member');
    expect(() => enabled.discordEvidence.subscribeDiscordEvidenceLifecycle(() => undefined))
      .not.toThrow();
    await expect(enabled.discordEvidence.observeDiscordEvidence({
      providerSubjectId: '100000000000000001',
      targets: [],
    })).resolves.toEqual({ status: 'bot_absent' });
  });

  let sessionsDir: string;
  let store: SessionStore;

  beforeEach(() => {
    resetRuntimeChannelEnvelopeLabels();
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

  it('does not throw when discord token is missing', async () => {
    const adapter = new DiscordAdapter(makeConfig({ discordToken: '' }), new EventBus(), { sessionStore: store });

    await expect(adapter.start()).resolves.toBeUndefined();

    const client = discordMock.createdClients[0];
    expect(client.login).not.toHaveBeenCalled();
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

  it('records allowlisted companion bot messages during startup backfill', async () => {
    store.append({
      channelId: '123456789012345678',
      role: 'user',
      content: 'old user',
      authorId: 'user-1',
      authorName: 'User One',
      timestamp: 1000,
      discordMessageId: 'm-old',
    });

    const textChannel = makeTextChannel([
      makeMessage('m-self', 1200, { bot: true, authorId: 'bot-1', content: 'own prior reply' }),
      makeMessage('m-other-bot', 1300, { bot: true, authorId: 'untrusted-bot', content: 'untrusted bot' }),
      makeMessage('m-companion-bot', 1400, {
        bot: true,
        authorId: 'companion-bot',
        displayName: 'Purrsephone',
        content: 'companion prior message',
      }),
    ]);
    discordMock.channelsById.set('123456789012345678', textChannel.channel);

    const adapter = new DiscordAdapter(makeConfig(), new EventBus(), {
      sessionStore: store,
      allowedBotUserIds: ['companion-bot'],
    });
    await adapter.start();

    const entries = store.getRecent('123456789012345678', 10);
    const appended = entries.filter(e => e.discordMessageId?.startsWith('m-'));
    expect(appended.map(entry => entry.discordMessageId)).toEqual(['m-old', 'm-companion-bot']);
    expect(appended.at(-1)).toEqual(expect.objectContaining({
      content: 'companion prior message',
      authorId: 'companion-bot',
      authorName: 'Purrsephone',
    }));
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
  const sentPayloads: unknown[] = [];
  const edits: string[] = [];
  const deleted: string[] = [];
  let typingCalls = 0;

  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: vi.fn(async () => new Map()),
    },
    sendTyping: vi.fn(async () => { typingCalls++; }),
    send: vi.fn(async (content: any) => {
      const message: MockSentMessage = {
        content: typeof content === 'string' ? content : JSON.stringify(content),
        edit: async (next: string) => {
          message.content = next;
          edits.push(next);
          return message;
        },
        delete: async () => {
          deleted.push(message.content);
        },
      };
      if (typeof content === 'string') {
        sent.push(content);
      }
      sentPayloads.push(content);
      return message;
    }),
  };

  return { channel, sent, sentPayloads, edits, deleted, get typingCalls() { return typingCalls; } };
}

// jp36.3.1.1: a text channel whose `messages.fetch(id)` resolves a single
// message exposing a `react` mock, so outbound reaction delivery can be
// asserted end-to-end (including permission/emoji failures that must surface).
function makeReactableTextChannel(options?: {
  reacted?: string[];
  reactError?: Error;
  fetchError?: Error;
  isTextBased?: boolean;
}) {
  const reacted = options?.reacted ?? [];
  const react = vi.fn(async (emoji: string) => {
    if (options?.reactError) throw options.reactError;
    reacted.push(emoji);
    return { emoji };
  });
  const messageFetch = vi.fn(async (messageId: string) => {
    if (options?.fetchError) throw options.fetchError;
    return { id: messageId, react };
  });
  const channel = {
    isTextBased: () => options?.isTextBased ?? true,
    messages: { fetch: messageFetch },
  };
  return { channel, reacted, react, messageFetch };
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
    attachments?: MockDiscordAttachment[];
  },
) {
  const guildId = overrides?.guildId ?? null;
  const mentioned = overrides?.mentioned ?? false;
  const attachments = new Map(
    (overrides?.attachments ?? []).map((attachment) => [attachment.id, attachment]),
  );

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
    attachments,
    reply: vi.fn(async () => {}),
  };
}

function makeNoReplyMetadata(channelId: string): IntentionalNoReplyMetadata {
  return {
    schemaVersion: 1,
    disposition: 'intentional_no_reply',
    source: 'response_control_tool',
    auditId: `no-reply:test-turn:${channelId}`,
    decidedAt: Date.parse('2026-03-08T12:00:00Z'),
    turnId: '018f0000-0000-7000-9000-000000000001' as IntentionalNoReplyMetadata['turnId'],
    requestId: 'msg-no-reply',
    channelId,
    toolCallId: 'tool-call-no-reply',
    reason: 'resting intentionally',
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

  it('does not register duplicate Discord listeners when initialized twice', async () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());

    await adapter.init();
    await adapter.init();

    const client = discordMock.createdClients.at(-1);
    expect(client).toBeDefined();
    expect(client.on.mock.calls.filter((call: unknown[]) => call[0] === 'messageCreate')).toHaveLength(1);
    expect(client.on.mock.calls.filter((call: unknown[]) => call[0] === 'messageReactionAdd')).toHaveLength(1);
    expect(client.once.mock.calls.filter((call: unknown[]) => call[0] === 'ready')).toHaveLength(1);
    expect(voiceMock.init).toHaveBeenCalledTimes(1);
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
      routing: expect.objectContaining({ channelPrivacy: 'private' }),
    }));
    expect(interactive.sent).toContain('dm reply');
  });

  it('marks allowlisted companion-bot messages as machine intelligence in routing metadata (E7.3)', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus, { allowedBotUserIds: ['companion-bot'] });
    await adapter.init();

    const channelId = 'guild-room';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async (message: SubstrateMessage) => ({
      content: '',
      channelId: message.channelId,
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
    }));
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'bot-msg',
        content: 'peer companion says hi',
        guildId: 'guild-1',
        authorId: 'companion-bot',
        authorDisplayName: 'Purrsephone',
        bot: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const message = handler.mock.calls[0][0] as SubstrateMessage;
    expect(message.routing?.authorIsMachineIntelligence).toBe(true);
    expect(message.routing?.responseMode).toBe('observe');
  });

  it('does not mark human-authored messages as machine intelligence (E7.3)', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-human';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async (message: SubstrateMessage) => ({
      content: 'ok',
      channelId: message.channelId,
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
    }));
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, { id: 'h1', content: 'hi there' }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const message = handler.mock.calls[0][0] as SubstrateMessage;
    expect(message.routing?.authorIsMachineIntelligence).toBeUndefined();
  });

  it('keeps DM ingress responsive across channels while another DM turn is in flight', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const busyChannelId = 'dm-busy-channel';
    const fastChannelId = 'dm-fast-channel';
    const busyChannel = makeInteractiveTextChannel();
    const fastChannel = makeInteractiveTextChannel();
    discordMock.channelsById.set(busyChannelId, busyChannel.channel);
    discordMock.channelsById.set(fastChannelId, fastChannel.channel);

    let releaseBusyTurn: (() => void) | null = null;
    let markBusyTurnStarted: (() => void) | null = null;
    const busyTurnStarted = new Promise<void>((resolve) => {
      markBusyTurnStarted = resolve;
    });

    const handler = vi.fn(async (message: SubstrateMessage) => {
      if (message.channelId === busyChannelId) {
        markBusyTurnStarted?.();
        await new Promise<void>((resolve) => {
          releaseBusyTurn = resolve;
        });
      }
      return {
        content: `reply-${message.id}`,
        channelId: message.channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    const busyDispatch = (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(busyChannelId, busyChannel.channel, {
        id: 'dm-busy-1',
        content: 'busy turn',
      }),
    );
    await busyTurnStarted;

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(fastChannelId, fastChannel.channel, {
        id: 'dm-fast-1',
        content: 'quick follow-up',
      }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(fastChannel.sent).toContain('reply-dm-fast-1');
    expect(busyChannel.sent).toHaveLength(0);

    releaseBusyTurn?.();
    await busyDispatch;
    expect(busyChannel.sent).toContain('reply-dm-busy-1');
  });

  it('extracts image attachments into substrate messages', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-channel-attachments';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'image received',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-image-1',
        content: 'check this image',
        attachments: [
          {
            id: 'att-image-1',
            name: 'cat.png',
            url: 'https://cdn.discordapp.com/attachments/a/b/cat.png',
            contentType: 'image/png',
            size: 64_000,
          },
          {
            id: 'att-doc-1',
            name: 'notes.txt',
            url: 'https://cdn.discordapp.com/attachments/a/b/notes.txt',
            contentType: 'text/plain',
            size: 1_024,
          },
        ],
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      channelId,
      attachments: [
        {
          url: 'https://cdn.discordapp.com/attachments/a/b/cat.png',
          contentType: 'image/png',
          name: 'cat.png',
        },
      ],
    }));
  });

  it('saves and parses Discord text attachments when a personal files root is configured', async () => {
    const personalFilesDir = mkdtempSync(join(tmpdir(), 'psfn-discord-docs-'));
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response('# Field notes\n\nThe artifact is in the garden.', {
      headers: { 'content-type': 'text/markdown' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const eventBus = new EventBus();
      const adapter = new DiscordAdapter(makeConfig(), eventBus, { personalFilesDir });
      await adapter.init();

      const channelId = 'dm-channel-docs';
      const interactive = makeInteractiveTextChannel();
      discordMock.channelsById.set(channelId, interactive.channel);

      const handler = vi.fn(async () => {
        return {
          content: 'document received',
          channelId,
          metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
        };
      });
      adapter.onMessage(handler);

      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'dm-doc-1',
          content: 'please read this',
          attachments: [
            {
              id: 'att-doc-md',
              name: 'field-notes.md',
              url: 'https://cdn.discordapp.com/attachments/a/b/field-notes.md',
              contentType: 'text/markdown',
              size: 64,
            },
          ],
        }),
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://cdn.discordapp.com/attachments/a/b/field-notes.md',
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(handler).toHaveBeenCalledTimes(1);
      const message = handler.mock.calls[0][0] as SubstrateMessage;
      expect(message.content).toContain('please read this');
      expect(message.content).toContain('The artifact is in the garden.');
      expect(message.attachments).toHaveLength(1);
      const attachment = message.attachments?.[0];
      expect(attachment).toEqual(expect.objectContaining({
        url: 'https://cdn.discordapp.com/attachments/a/b/field-notes.md',
        contentType: 'text/markdown',
        name: 'field-notes.md',
      }));
      expect(attachment?.localPath).toContain(join(personalFilesDir, 'downloads', 'discord'));
      expect(attachment?.localPath && existsSync(attachment.localPath)).toBe(true);
      expect(attachment?.parsedTextPath && existsSync(attachment.parsedTextPath)).toBe(true);
      expect(readFileSync(attachment!.localPath!, 'utf8')).toBe('# Field notes\n\nThe artifact is in the garden.');
      expect(readFileSync(attachment!.parsedTextPath!, 'utf8')).toContain('The artifact is in the garden.');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      rmSync(personalFilesDir, { recursive: true, force: true });
    }
  });

  it('quarantines spoofed image-looking scripts before image attachment context', async () => {
    const personalFilesDir = mkdtempSync(join(tmpdir(), 'psfn-discord-quarantine-adapter-'));
    const originalFetch = globalThis.fetch;
    const script = '#!/bin/sh\necho DO_NOT_PROMPT\n';
    const fetchMock = vi.fn(async () => new Response(script, {
      headers: { 'content-type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const eventBus = new EventBus();
      const adapter = new DiscordAdapter(makeConfig(), eventBus, { personalFilesDir });
      await adapter.init();

      const channelId = 'dm-channel-quarantine-spoof';
      const interactive = makeInteractiveTextChannel();
      discordMock.channelsById.set(channelId, interactive.channel);

      const handler = vi.fn(async () => {
        return {
          content: 'quarantine noted',
          channelId,
          metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
        };
      });
      adapter.onMessage(handler);

      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'dm-spoof-1',
          content: 'this is probably an image?',
          attachments: [
            {
              id: 'att-spoof-image-script',
              name: 'photo.png',
              url: 'https://cdn.discordapp.com/attachments/a/b/photo.png',
              contentType: 'text/plain',
              size: script.length,
            },
          ],
        }),
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://cdn.discordapp.com/attachments/a/b/photo.png',
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(handler).toHaveBeenCalledTimes(1);
      const message = handler.mock.calls[0][0] as SubstrateMessage;
      expect(message.attachments).toBeUndefined();
      expect(message.content).toContain('[Attached file quarantined: photo.png]');
      expect(message.content).toContain('declared_extension_mismatch:declared=text/plain;expected=image/png');
      expect(message.content).toContain('shebang');
      expect(message.content).not.toContain('DO_NOT_PROMPT');
      const quarantineRoot = join(personalFilesDir, 'downloads', 'quarantine', 'discord');
      expect(message.content).not.toContain(quarantineRoot);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      rmSync(personalFilesDir, { recursive: true, force: true });
    }
  });

  it('keeps image attachments visible when Discord declares a different image subtype', async () => {
    const personalFilesDir = mkdtempSync(join(tmpdir(), 'psfn-discord-image-mismatch-'));
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      { headers: { 'content-type': 'image/png' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const eventBus = new EventBus();
      const adapter = new DiscordAdapter(makeConfig(), eventBus, { personalFilesDir });
      await adapter.init();

      const channelId = 'dm-channel-image-type-mismatch';
      const interactive = makeInteractiveTextChannel();
      discordMock.channelsById.set(channelId, interactive.channel);

      const handler = vi.fn(async () => {
        return {
          content: 'image received',
          channelId,
          metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
        };
      });
      adapter.onMessage(handler);

      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'dm-image-mismatch-1',
          content: '',
          attachments: [
            {
              id: 'att-image-mismatch',
              name: 'image.png',
              url: 'https://cdn.discordapp.com/attachments/a/b/image.png',
              contentType: 'image/webp',
              size: 251_293,
            },
          ],
        }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
      const message = handler.mock.calls[0][0] as SubstrateMessage;
      expect(message.content).toBe('(image attachment)');
      expect(message.content).not.toContain('quarantined');
      expect(message.attachments).toEqual([
        {
          url: 'https://cdn.discordapp.com/attachments/a/b/image.png',
          contentType: 'image/webp',
          name: 'image.png',
        },
      ]);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      rmSync(personalFilesDir, { recursive: true, force: true });
    }
  });

  it('prefers canonical Discord attachment URLs over proxy URLs for image attachments', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-channel-attachments-prefer-cdn';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'image received',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-image-cdn-1',
        content: '',
        attachments: [
          {
            id: 'att-image-cdn-1',
            name: 'photo.jpg',
            url: 'https://cdn.discordapp.com/attachments/a/b/photo.jpg',
            proxyURL: 'https://media.discordapp.net/attachments/a/b/photo.jpg?width=1410&height=1880',
            contentType: 'image/jpeg',
            size: 190_580,
          },
        ],
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      channelId,
      content: '(image attachment)',
      attachments: [
        {
          url: 'https://cdn.discordapp.com/attachments/a/b/photo.jpg',
          contentType: 'image/jpeg',
          name: 'photo.jpg',
        },
      ],
    }));
  });

  it('infers image attachment type from extension when contentType is missing', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-channel-attachments-inferred';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'image inferred',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-image-inferred',
        content: 'check this one too',
        attachments: [
          {
            id: 'att-image-jpg',
            name: 'cat.JPG',
            url: 'https://cdn.discordapp.com/attachments/a/b/cat.JPG?quality=lossless',
            size: 65_000,
          },
          {
            id: 'att-doc-2',
            name: 'notes.txt',
            url: 'https://cdn.discordapp.com/attachments/a/b/notes.txt',
            size: 1_024,
          },
        ],
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      channelId,
      attachments: [
        {
          url: 'https://cdn.discordapp.com/attachments/a/b/cat.JPG?quality=lossless',
          contentType: 'image/jpeg',
          name: 'cat.JPG',
        },
      ],
    }));
  });

  it('promotes Discord CDN image links in message content to vision attachments', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-channel-inline-webp';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'inline image noted',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-inline-link-1',
        content: 'check this https://cdn.discordapp.com/attachments/a/b/cat.webp?width=1024',
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      channelId,
      attachments: [
        {
          url: 'https://cdn.discordapp.com/attachments/a/b/cat.webp?width=1024',
          contentType: 'image/webp',
          name: 'cat.webp',
        },
      ],
    }));
  });

  it('uses image-attachment placeholder content for image-only messages', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-channel-image-only';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'image only received',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-image-only-1',
        content: '',
        attachments: [
          {
            id: 'att-image-only-1',
            name: 'cat.png',
            url: 'https://cdn.discordapp.com/attachments/a/b/cat.png',
            contentType: 'image/png',
            size: 42_000,
          },
        ],
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      channelId,
      content: '(image attachment)',
      attachments: [
        {
          url: 'https://cdn.discordapp.com/attachments/a/b/cat.png',
          contentType: 'image/png',
          name: 'cat.png',
        },
      ],
    }));
  });

  it('observes guild channel messages but only replies to direct mentions', async () => {
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
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      channelId,
      isDirectMessage: false,
      content: 'hello without mention',
      routing: expect.objectContaining({
        source: 'discord',
        responseMode: 'observe',
        channelPrivacy: 'invite_only',
      }),
    }));
    expect(interactive.sent).toHaveLength(0);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'guild-2',
        guildId: 'guild-1',
        content: '<@!bot-1> hello with mention',
        mentioned: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toEqual(expect.objectContaining({
      channelId,
      isDirectMessage: false,
      content: 'hello with mention',
      routing: expect.objectContaining({
        source: 'discord',
        responseMode: 'respond',
        channelPrivacy: 'invite_only',
      }),
    }));
    expect(interactive.sent).toContain('guild reply');
  });

  it('stamps a configured public channel label as trusted ingress privacy provenance', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();
    const channelId = 'guild-public-channel';
    setRuntimeChannelEnvelopeLabels({ [channelId]: { privacy: 'public' } });
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);
    const handler = vi.fn(async (message: SubstrateMessage) => ({
      content: '',
      channelId: message.channelId,
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
    }));
    adapter.onMessage(handler);

    try {
      await (adapter as any).onDiscordMessage(
        makeDiscordIncomingMessage(channelId, interactive.channel, {
          id: 'guild-public-1',
          guildId: 'guild-1',
          content: '<@!bot-1> public planning question',
          mentioned: true,
        }),
      );
      expect(handler.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        isDirectMessage: false,
        routing: expect.objectContaining({
          source: 'discord',
          channelPrivacy: 'public',
        }),
      }));
    } finally {
      resetRuntimeChannelEnvelopeLabels();
    }
  });

  it('ignores bot-authored guild mentions unless the bot is allowlisted', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'guild-channel-untrusted-bot';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async () => {
      return {
        content: 'bot reply',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'guild-bot-mention-1',
        guildId: 'guild-1',
        authorId: 'untrusted-bot',
        bot: true,
        content: '<@!bot-1> hello from a random bot',
        mentioned: true,
      }),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(interactive.sent).toHaveLength(0);
  });

  it('observes configured companion bot guild messages and replies only to mentions', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(
      makeConfig({ discordTriggerWords: ['artie'] }),
      eventBus,
      { allowedBotUserIds: ['companion-bot'] },
    );
    await adapter.init();

    const channelId = 'guild-channel-companion-bot';
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
        id: 'guild-companion-trigger-word',
        guildId: 'guild-1',
        authorId: 'companion-bot',
        authorDisplayName: 'Purrsephone',
        bot: true,
        content: 'artie without a mention',
        mentioned: false,
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      id: 'guild-companion-trigger-word',
      authorId: 'companion-bot',
      authorName: 'Purrsephone',
      content: 'artie without a mention',
      routing: expect.objectContaining({
        source: 'discord',
        responseMode: 'observe',
      }),
    }));
    expect(interactive.sent).toHaveLength(0);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'guild-companion-mention',
        guildId: 'guild-1',
        authorId: 'companion-bot',
        authorDisplayName: 'Purrsephone',
        bot: true,
        content: '<@!bot-1> hello from Purrsephone',
        mentioned: true,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toEqual(expect.objectContaining({
      id: 'guild-companion-mention',
      channelId,
      authorId: 'companion-bot',
      authorName: 'Purrsephone',
      content: 'hello from Purrsephone',
      routing: expect.objectContaining({
        source: 'discord',
        responseMode: 'respond',
      }),
    }));
    expect(interactive.sent).toContain('reply-guild-companion-mention');
  });

  it('observes character name trigger matches without replying when unmentioned', async () => {
    const eventBus = new EventBus();
    const characterName = 'Companion';
    const adapter = new DiscordAdapter(makeConfig({ characterName }), eventBus);
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
        content: `hey ${characterName.toLowerCase()}, are you there?`,
        mentioned: false,
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      routing: expect.objectContaining({
        source: 'discord',
        responseMode: 'observe',
      }),
    }));
    expect(interactive.sent).toHaveLength(0);
  });

  it('observes configured trigger word matches without replying when unmentioned', async () => {
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
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      routing: expect.objectContaining({
        source: 'discord',
        responseMode: 'observe',
      }),
    }));
    expect(interactive.sent).toHaveLength(0);
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

  it('observes trigger/listening/opt-out guild text without mention-only egress', async () => {
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

      expect(handler).toHaveBeenCalledTimes(4);
      expect(handler.mock.calls.map((call) => call[0].id)).toEqual([
        'guild-listen-1',
        'guild-listen-2',
        'guild-listen-3',
        'guild-listen-4',
      ]);
      for (const call of handler.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({
          routing: expect.objectContaining({
            source: 'discord',
            responseMode: 'observe',
          }),
        }));
      }
      expect(interactive.sent).toHaveLength(0);
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

  it('uses live reaction trigger config while guild text remains passive unless mentioned', async () => {
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
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
        id: 'live-word-1',
        routing: expect.objectContaining({
          source: 'discord',
          responseMode: 'observe',
        }),
      }));
      expect(interactive.sent).toHaveLength(0);

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
      expect(handler).toHaveBeenCalledTimes(2);

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
      expect(handler).toHaveBeenCalledTimes(3);

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
      expect(handler).toHaveBeenCalledTimes(4);

      config.discordTriggerReactions = ['🔥'];
      const targetMessage = makeReactionTargetMessage(channelId, interactive.channel, {
        id: 'live-reaction-target',
        guildId: 'guild-1',
        authorId: 'user-live-3',
        content: 'reaction target',
      });
      const oldReaction = makeReactionPayload(targetMessage, { emojiName: '👆' });
      await (adapter as any).onReactionAdd(oldReaction, { id: 'reactor-live', bot: false });
      expect(handler).toHaveBeenCalledTimes(4);

      const newReaction = makeReactionPayload(targetMessage, { emojiName: '🔥' });
      await (adapter as any).onReactionAdd(newReaction, { id: 'reactor-live', bot: false });
      expect(handler).toHaveBeenCalledTimes(5);
      expect(targetMessage.reply).toHaveBeenCalledWith('live-live-reaction-target');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces queued contended messages into one deferred turn in gateway mode', async () => {
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
    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'dm-3',
        content: 'third',
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await firstDispatch;
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });
    expect(handler.mock.calls.map((call) => call[0].id)).toEqual(['dm-1', 'dm-3']);
    expect(handler.mock.calls[1]?.[0].content).toBe('second\nthird');
    await vi.waitFor(() => {
      expect(interactive.sent).toEqual(['reply-dm-1', 'reply-dm-3']);
    });
  });

  it('never merges queued messages from different authors into one attributed turn', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'dm-mixed-author-channel';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    let releaseFirst: (() => void) | null = null;
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const handler = vi.fn(async (message: SubstrateMessage) => {
      if (message.id === 'mix-1') {
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
        id: 'mix-1',
        content: 'first',
        authorId: 'author-a',
      }),
    );

    await Promise.resolve();

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'mix-2',
        content: 'from author a',
        authorId: 'author-a',
      }),
    );
    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'mix-3',
        content: 'also from author a',
        authorId: 'author-a',
      }),
    );
    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'mix-4',
        content: 'from author b',
        authorId: 'author-b',
        authorDisplayName: 'AuthorB',
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await firstDispatch;
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(3);
    });

    const deferredTurns = handler.mock.calls.slice(1).map((call) => call[0]);
    expect(deferredTurns.map((turn) => turn.authorId)).toEqual(['author-a', 'author-b']);
    expect(deferredTurns[0]?.content).toBe('from author a\nalso from author a');
    expect(deferredTurns[1]?.content).toBe('from author b');
    await vi.waitFor(() => {
      expect(interactive.sent).toEqual(['reply-mix-1', 'reply-mix-3', 'reply-mix-4']);
    });
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
    expect(adapter.security.requiresMentionForChannelMessages).toBe(true);

    const promptTextType = adapter.prompt.resolveChannelType({
      id: 'msg-1',
      channelId: '123456789012345678',
      channelType: 'discord',
      authorId: 'u1',
      authorName: 'User',
      content: 'hello',
      timestamp: new Date(),
    } satisfies SubstrateMessage);
    const promptVoiceType = adapter.prompt.resolveChannelType({
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
    await adapter.streaming.sendTyping(channelId);

    expect(interactive.sent).toContain('facet reply');
    expect(interactive.typingCalls).toBeGreaterThan(0);
  });

  it('sends media attachments through the outbound facet', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'facet-media-channel';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    await adapter.outbound.sendMedia?.(
      { channelId },
      {
        url: 'https://images.example.test/purr.png',
        contentType: 'image/png',
        name: 'purr.png',
        dataBase64: Buffer.from('png-bytes').toString('base64'),
      },
    );

    expect(interactive.sentPayloads).toHaveLength(1);
    expect(interactive.sentPayloads[0]).toEqual(expect.objectContaining({
      files: [{ attachment: Buffer.from('png-bytes'), name: 'purr.png' }],
    }));
  });

  it('refuses to open an unmaterialized local attachment path', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();
    const channelId = 'facet-local-path-denied';
    discordMock.channelsById.set(channelId, makeInteractiveTextChannel().channel);

    await expect(adapter.outbound.sendMedia?.({ channelId }, {
      url: 'https://images.example.test/peer.png',
      contentType: 'image/png',
      name: 'peer.png',
      localPath: '/tmp/peer-workspace/peer.png',
    })).rejects.toThrow(/refuses unmaterialized localPath/);
  });

  // ── Sprint-10 6ny2: outbound media fetch is SSRF-guarded and byte-capped ──

  it('denies outbound media fetches to internal addresses', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'facet-media-ssrf-channel';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    for (const blockedUrl of [
      'https://192.168.1.10/internal.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://[fd00:ec2::254]/imds.png',
    ]) {
      await expect(adapter.outbound.sendMedia?.(
        { channelId },
        {
          url: blockedUrl,
          contentType: 'image/png',
          name: 'internal.png',
        },
      )).rejects.toThrow(/blocked/);
    }

    expect(interactive.sentPayloads).toHaveLength(0);
  });

  it('byte-caps outbound media fetches while streaming', async () => {
    const originalFetch = globalThis.fetch;
    // One byte over the 25 MiB outbound cap, served without a trustworthy
    // content-length (Response streams it).
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    const fetchMock = vi.fn(async () => new Response(oversized, {
      headers: { 'content-type': 'image/png' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const eventBus = new EventBus();
      const adapter = new DiscordAdapter(makeConfig(), eventBus);
      await adapter.init();

      const channelId = 'facet-media-cap-channel';
      const interactive = makeInteractiveTextChannel();
      discordMock.channelsById.set(channelId, interactive.channel);

      await expect(adapter.outbound.sendMedia?.(
        { channelId },
        {
          url: 'https://images.example.test/huge.png',
          contentType: 'image/png',
          name: 'huge.png',
        },
      )).rejects.toThrow(/too large/);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://images.example.test/huge.png',
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(interactive.sentPayloads).toHaveLength(0);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('sends response attachments after text replies', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'discord-attachment-reply';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    adapter.onMessage(async () => ({
      content: 'here you go',
      channelId,
      attachments: [{
        url: 'https://images.example.test/purr.png',
        contentType: 'image/png',
        name: 'purr.png',
        dataBase64: Buffer.from('png-bytes').toString('base64'),
      }],
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
    }));

    await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

    expect(interactive.sent).toContain('here you go');
    expect(interactive.sentPayloads).toEqual(expect.arrayContaining([
      'here you go',
      expect.objectContaining({
        files: [{ attachment: Buffer.from('png-bytes'), name: 'purr.png' }],
      }),
    ]));
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

  it('shows rate-limited long-running analysis status updates and clears them on completion', async () => {
    vi.useFakeTimers();
    try {
      const eventBus = new EventBus();
      const adapter = new DiscordAdapter(makeConfig(), eventBus);
      await adapter.init();

      const channelId = 'ch-analysis';
      const interactive = makeInteractiveTextChannel();
      discordMock.channelsById.set(channelId, interactive.channel);

      adapter.onMessage(async () => {
        await eventBus.emit('agent.tool.start', {
          channelId,
          toolCallId: 'analysis-call-1',
          toolName: 'analysis_workbench',
        });
        await vi.advanceTimersByTimeAsync(16_000);
        await vi.advanceTimersByTimeAsync(25_000);
        await eventBus.emit('agent.tool.end', {
          channelId,
          toolCallId: 'analysis-call-1',
          toolName: 'analysis_workbench',
          outcome: 'success',
          isError: false,
        });
        return {
          content: 'final reply',
          channelId,
          metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
        };
      });

      await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

      const longRunningSends = interactive.sent.filter(msg => msg.includes('Still analyzing large-context material'));
      expect(longRunningSends).toHaveLength(1);
      expect(interactive.edits.some(msg => msg.includes('Still analyzing large-context material'))).toBe(true);
      expect(interactive.deleted.some(msg => msg.includes('Still analyzing large-context material'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it('reports empty handler responses instead of silently treating them as no-reply', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch-empty';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);
    const diagnostics: any[] = [];
    (eventBus as any).on('channel.message.error', (event: any) => {
      diagnostics.push(event);
    });

    adapter.onMessage(async () => {
      return {
        content: '   ',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
      };
    });

    await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

    expect(interactive.sent).toHaveLength(0);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      channelId,
      channelType: 'discord',
      phase: 'handler',
      error: 'empty_agent_response_without_suppression_marker',
    }));
  });

  it('accepts gateway notification acknowledgements without reporting an empty model response', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch-notification-ack';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);
    const sentEvents: any[] = [];
    const diagnostics: any[] = [];
    (eventBus as any).on('message.sent', (event: any) => {
      sentEvents.push(event);
    });
    (eventBus as any).on('channel.message.error', (event: any) => {
      diagnostics.push(event);
    });

    adapter.onMessage(async () => {
      return {
        content: '',
        channelId,
        metadata: {
          model: '',
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          notificationAck: {
            schemaVersion: 1,
            disposition: 'notification_ack',
            outcome: 'forwarded_to_agent',
          },
        },
      };
    });

    await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

    expect(interactive.sent).toHaveLength(0);
    expect(sentEvents).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('suppresses Discord output for structured intentional no-reply responses', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch-no-reply';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);
    const sentEvents: any[] = [];
    const diagnostics: any[] = [];
    (eventBus as any).on('message.sent', (event: any) => {
      sentEvents.push(event);
    });
    (eventBus as any).on('channel.message.error', (event: any) => {
      diagnostics.push(event);
    });

    adapter.onMessage(async () => {
      return {
        content: '',
        channelId,
        metadata: {
          model: 'test',
          inputTokens: 3,
          outputTokens: 1,
          durationMs: 1,
          noReply: makeNoReplyMetadata(channelId),
        },
      };
    });

    await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

    expect(interactive.sent).toHaveLength(0);
    expect(sentEvents).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('treats literal NO_REPLY text as normal Discord content', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch-literal-no-reply';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    adapter.onMessage(async () => {
      return {
        content: 'NO_REPLY',
        channelId,
        metadata: { model: 'test', inputTokens: 0, outputTokens: 1, durationMs: 1 },
      };
    });

    await (adapter as any).onDiscordMessage(makeDiscordIncomingMessage(channelId, interactive.channel));

    expect(interactive.sent).toContain('NO_REPLY');
  });

  it('emits channel.message.error diagnostics without sending canned fallback text when handler throws', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();

    const channelId = 'ch-handler-error';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const diagnostics: any[] = [];
    (eventBus as any).on('channel.message.error', (event: any) => {
      diagnostics.push(event);
    });

    adapter.onMessage(async () => {
      throw new Error('discord handler exploded');
    });

    const incoming = makeDiscordIncomingMessage(channelId, interactive.channel, { id: 'msg-error-1' });
    await (adapter as any).onDiscordMessage(incoming);

    expect(interactive.sent).toHaveLength(0);
    expect((incoming.reply as any).mock.calls.length).toBe(0);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      channelId,
      channelType: 'discord',
      messageId: 'msg-error-1',
      phase: 'handler',
      error: expect.stringContaining('discord handler exploded'),
    }));
  });
});

describe('DiscordAdapter outbound reactions (jp36.3.1.1)', () => {
  beforeEach(() => {
    discordMock.channelsById.clear();
    discordMock.createdClients.length = 0;
  });

  it('advertises the reaction capability on the channel adapter', () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    expect(adapter.capabilities.reactions).toBe(true);
    expect(typeof adapter.outbound.sendReaction).toBe('function');
  });

  it('delivers a reaction to the target message through the outbound seam', async () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    const channelId = 'reaction-channel';
    const reactable = makeReactableTextChannel();
    discordMock.channelsById.set(channelId, reactable.channel);

    await adapter.outbound.sendReaction?.({ channelId }, 'msg-42', '👍');

    expect(reactable.messageFetch).toHaveBeenCalledWith('msg-42');
    expect(reactable.reacted).toEqual(['👍']);
  });

  it('surfaces a permission/API rejection as a delivery failure (never silent text)', async () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    const channelId = 'reaction-denied-channel';
    const reactable = makeReactableTextChannel({
      reactError: new Error('Missing Permissions'),
    });
    discordMock.channelsById.set(channelId, reactable.channel);

    await expect(
      adapter.outbound.sendReaction?.({ channelId }, 'msg-9', '🚫'),
    ).rejects.toThrow(/Missing Permissions/);
  });

  it('surfaces an unresolved target message as a delivery failure', async () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    const channelId = 'reaction-missing-message';
    const reactable = makeReactableTextChannel({
      fetchError: new Error('Unknown Message'),
    });
    discordMock.channelsById.set(channelId, reactable.channel);

    await expect(
      adapter.outbound.sendReaction?.({ channelId }, 'msg-gone', '👀'),
    ).rejects.toThrow(/Unknown Message/);
  });

  it('rejects when the target channel is not text-based', async () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    const channelId = 'reaction-nontext';
    const reactable = makeReactableTextChannel({ isTextBased: false });
    discordMock.channelsById.set(channelId, reactable.channel);

    await expect(
      adapter.outbound.sendReaction?.({ channelId }, 'msg-1', '👍'),
    ).rejects.toThrow(/not text-based/);
    expect(reactable.messageFetch).not.toHaveBeenCalled();
  });

  it('rejects when the target channel cannot be resolved', async () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    const channelId = 'reaction-unresolved';
    discordMock.channelsById.set(channelId, null);

    await expect(
      adapter.outbound.sendReaction?.({ channelId }, 'msg-1', '👍'),
    ).rejects.toThrow(/not text-based/);
  });

  it('rejects empty emoji and empty message id inputs (fail closed)', async () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    const channelId = 'reaction-empty-inputs';
    const reactable = makeReactableTextChannel();
    discordMock.channelsById.set(channelId, reactable.channel);

    await expect(
      adapter.outbound.sendReaction?.({ channelId }, '   ', '👍'),
    ).rejects.toThrow(/target message id/);
    await expect(
      adapter.outbound.sendReaction?.({ channelId }, 'msg-1', '  '),
    ).rejects.toThrow(/non-empty emoji/);
    expect(reactable.react).not.toHaveBeenCalled();
  });
});

describe('DiscordAdapter multi-account bindings (multi-companion W1-P2)', () => {
  beforeEach(() => {
    discordMock.channelsById.clear();
    discordMock.createdClients.length = 0;
  });

  function makeAccountAdapter(overrides?: {
    token?: string;
    siblings?: () => readonly string[];
    allowedBotUserIds?: string[];
  }): { adapter: DiscordAdapter; eventBus: EventBus } {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus, {
      ...(overrides?.allowedBotUserIds ? { allowedBotUserIds: overrides.allowedBotUserIds } : {}),
      account: {
        accountId: 'acct-a',
        companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
        token: overrides?.token ?? 'token-acct-a',
        ...(overrides?.siblings ? { siblingBotUserIds: overrides.siblings } : {}),
      },
    });
    return { adapter, eventBus };
  }

  it('keys the adapter and registry id per account', () => {
    const { adapter } = makeAccountAdapter();
    expect(adapter.id).toBe('discord:acct-a');
    expect(adapter.name).toBe('discord:acct-a');
    expect(adapter.config.accountId).toBe('acct-a');
    expect(adapter.config.enabled).toBe(true);
  });

  it('logs in with the account token, never the shared env token', async () => {
    const { adapter } = makeAccountAdapter({ token: 'token-acct-a' });
    await adapter.init();
    await adapter.start();

    const client = discordMock.createdClients.at(-1);
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(client.login).toHaveBeenCalledWith('token-acct-a');
  });

  it('fails closed when an account has no token instead of silently disabling', async () => {
    const { adapter } = makeAccountAdapter({ token: '' });
    await adapter.init();

    await expect(adapter.start()).rejects.toThrow(
      'Discord account "acct-a" has no token; refusing to start',
    );
    const client = discordMock.createdClients.at(-1);
    expect(client.login).not.toHaveBeenCalled();
  });

  it('delivers sibling companion bot messages while still filtering its own messages', async () => {
    const { adapter } = makeAccountAdapter({ siblings: () => ['bot-b'] });
    await adapter.init();
    (adapter as any).client.user = { id: 'bot-a' };

    const channelId = 'guild-shared-room';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);

    const handler = vi.fn(async (message: SubstrateMessage) => ({
      content: `reply-${message.id}`,
      channelId,
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
    }));
    adapter.onMessage(handler);

    // Own message: filtered (self echo), never ingested.
    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'own-message',
        guildId: 'guild-1',
        authorId: 'bot-a',
        bot: true,
        content: 'my own outbound echo',
      }),
    );
    expect(handler).not.toHaveBeenCalled();

    // Sibling companion bot message: ingested as a normal inbound observation.
    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'sibling-observed',
        guildId: 'guild-1',
        authorId: 'bot-b',
        authorDisplayName: 'Sibling Companion',
        bot: true,
        content: 'hello room, sibling here',
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      id: 'sibling-observed',
      authorId: 'bot-b',
      routing: expect.objectContaining({
        source: 'discord',
        responseMode: 'observe',
        authorIsMachineIntelligence: true,
      }),
    }));
    expect(interactive.sent).toHaveLength(0);

    // Sibling mention: normal respond-mode turn (companions conversing).
    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'sibling-mention',
        guildId: 'guild-1',
        authorId: 'bot-b',
        bot: true,
        content: '<@!bot-a> what do you think?',
        mentioned: true,
      }),
    );
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toEqual(expect.objectContaining({
      id: 'sibling-mention',
      routing: expect.objectContaining({ responseMode: 'respond' }),
    }));
    expect(interactive.sent).toContain('reply-sibling-mention');

    // Unknown bot: still dropped — sibling status never leaks to foreign bots.
    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'foreign-bot',
        guildId: 'guild-1',
        authorId: 'bot-z',
        bot: true,
        content: 'unrelated bot chatter',
      }),
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('resolves siblings lazily so bots that log in later are recognized', async () => {
    const siblingIds: string[] = [];
    const { adapter } = makeAccountAdapter({ siblings: () => siblingIds });
    await adapter.init();
    (adapter as any).client.user = { id: 'bot-a' };

    const channelId = 'guild-late-sibling';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);
    const handler = vi.fn(async () => ({
      content: '',
      channelId,
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
    }));
    adapter.onMessage(handler);

    const siblingMessage = () => makeDiscordIncomingMessage(channelId, interactive.channel, {
      id: `late-${Math.random()}`,
      guildId: 'guild-1',
      authorId: 'bot-late',
      bot: true,
      content: 'sibling that logged in later',
    });

    await (adapter as any).onDiscordMessage(siblingMessage());
    expect(handler).not.toHaveBeenCalled();

    siblingIds.push('bot-late');
    await (adapter as any).onDiscordMessage(siblingMessage());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not treat any bot as sibling without an account binding (single-account parity)', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    expect(adapter.id).toBe('discord');
    await adapter.init();

    const channelId = 'guild-parity';
    const interactive = makeInteractiveTextChannel();
    discordMock.channelsById.set(channelId, interactive.channel);
    const handler = vi.fn(async () => ({
      content: '',
      channelId,
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
    }));
    adapter.onMessage(handler);

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel, {
        id: 'parity-bot-message',
        guildId: 'guild-1',
        authorId: 'bot-b',
        bot: true,
        content: 'not allowlisted, not sibling',
      }),
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('DiscordAdapter reaction surface (jp36.3.1.2)', () => {
  beforeEach(() => {
    discordMock.channelsById.clear();
    discordMock.channelsCacheById.clear();
    discordMock.createdClients.length = 0;
  });

  function makeGuild(guildId: string, emojis: Array<{
    name: string | null;
    id: string;
    animated?: boolean;
    available?: boolean;
  }>) {
    const cache = new Map(emojis.map(e => [e.id, {
      name: e.name,
      id: e.id,
      animated: e.animated ?? false,
      available: e.available ?? true,
    }]));
    return { id: guildId, emojis: { cache } };
  }

  function listReactions(adapter: DiscordAdapter, channelId: string) {
    return adapter.prompt.listAvailableReactions?.(
      { channelId } as unknown as SubstrateMessage,
    );
  }

  it('surfaces the standard subset even with no guild resolved (DM/uncached)', () => {
    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    const surface = listReactions(adapter, 'dm-channel');
    expect(surface?.standard).toEqual(STANDARD_REACTION_SUBSET);
    expect(surface?.custom).toEqual([]);
  });

  it('surfaces guild-custom emoji that carry a configured meaning, excluding unknown ones', () => {
    const guildId = '900000000000000001';
    const channelId = 'guild-text-channel';
    const guild = makeGuild(guildId, [
      { name: 'blobwave', id: '111' },
      { name: 'mystery', id: '222' },
    ]);
    discordMock.channelsCacheById.set(channelId, { guild });

    const adapter = new DiscordAdapter(makeConfig(), new EventBus(), {
      customEmojiMeanings: { [guildId]: { blobwave: 'the house greeting meme' } },
    });

    const surface = listReactions(adapter, channelId);
    expect(surface?.custom).toEqual([
      { name: 'blobwave', token: 'blobwave:111', meaning: 'the house greeting meme' },
    ]);
    expect(surface?.standard.length).toBeGreaterThan(0);
  });

  it('excludes all custom emoji when the guild has no configured meanings', () => {
    const guildId = '900000000000000002';
    const channelId = 'guild-text-channel-2';
    const guild = makeGuild(guildId, [{ name: 'blobwave', id: '111' }]);
    discordMock.channelsCacheById.set(channelId, { guild });

    const adapter = new DiscordAdapter(makeConfig(), new EventBus());
    const surface = listReactions(adapter, channelId);
    expect(surface?.custom).toEqual([]);
  });
});

describe('DiscordAdapter typing flood control (psfn-framework-vvf.4)', () => {
  // Kept in sync with the adapter module constants; there is no export for them.
  const TYPING_INTERVAL_MS = 9_000;
  const STRIKE_LIMIT = 3;

  function makeTypingChannel(shouldReject: () => boolean) {
    const sendTyping = vi.fn(async () => {
      if (shouldReject()) throw new Error('Missing Permissions');
    });
    return { isTextBased: () => true, sendTyping };
  }

  function disableWarnCount(): number {
    return getRecentDiagnosticLogRecords().filter(
      (record) =>
        record.level === 'warn' &&
        record.message.includes('Disabling Discord typing indicator'),
    ).length;
  }

  beforeEach(() => {
    discordMock.channelsById.clear();
    discordMock.createdClients.length = 0;
    clearDiagnosticLogRingBufferForTests();
  });

  it('disables the typing interval and warns once after the strike limit of consecutive failures', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new DiscordAdapter(makeConfig(), new EventBus());
      const channel = makeTypingChannel(() => true);
      const msg = { channel, channelId: 'ch-strike' } as any;

      (adapter as any).startTyping(msg);
      // initial send (strike 1) + first interval tick (strike 2)
      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS);
      // second interval tick (strike 3) -> disable
      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS);

      expect(channel.sendTyping).toHaveBeenCalledTimes(STRIKE_LIMIT);
      expect(disableWarnCount()).toBe(1);

      // Interval was cleared: further time advances trigger no more sends and no
      // additional warning (warn exactly once).
      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 5);
      expect(channel.sendTyping).toHaveBeenCalledTimes(STRIKE_LIMIT);
      expect(disableWarnCount()).toBe(1);
      expect((adapter as any).typingStrikes.get('ch-strike')).toBe(STRIKE_LIMIT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the strike count on a successful send so the interval is never disabled', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new DiscordAdapter(makeConfig(), new EventBus());
      // Two failures then a success, repeating: without the reset a run of two
      // failures would eventually accumulate to the strike limit, but each
      // interleaved success brings the counter back to zero so it never trips.
      let call = 0;
      const channel = makeTypingChannel(() => {
        call += 1;
        return call % STRIKE_LIMIT !== 0; // calls 1,2 reject; call 3 succeeds; repeat
      });
      const msg = { channel, channelId: 'ch-reset' } as any;

      (adapter as any).startTyping(msg);
      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 8);

      // Interval stayed armed: sends kept firing well past the strike limit.
      expect(channel.sendTyping.mock.calls.length).toBeGreaterThan(STRIKE_LIMIT);
      expect(disableWarnCount()).toBe(0);
      // Successes keep the counter capped below the limit; it is never disabled.
      expect((adapter as any).typingStrikes.get('ch-reset') ?? 0).toBeLessThan(STRIKE_LIMIT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not disable the interval for fewer consecutive failures than the strike limit', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new DiscordAdapter(makeConfig(), new EventBus());
      // Reject only the first two sends (strikes 1 and 2), then succeed.
      let call = 0;
      const channel = makeTypingChannel(() => {
        call += 1;
        return call <= STRIKE_LIMIT - 1;
      });
      const msg = { channel, channelId: 'ch-below' } as any;

      (adapter as any).startTyping(msg);
      // initial + one interval tick => exactly two consecutive failures.
      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS);
      expect((adapter as any).typingStrikes.get('ch-below')).toBe(STRIKE_LIMIT - 1);
      expect(disableWarnCount()).toBe(0);

      // The next tick succeeds and clears the count; the interval was never
      // disabled, so sends continue.
      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS);
      expect((adapter as any).typingStrikes.has('ch-below')).toBe(false);
      const callsAfterReset = channel.sendTyping.mock.calls.length;
      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS);
      expect(channel.sendTyping.mock.calls.length).toBeGreaterThan(callsAfterReset);
      expect(disableWarnCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms typing fresh on the next message after a channel was disabled', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new DiscordAdapter(makeConfig(), new EventBus());
      const channelId = 'ch-rearm';

      // First turn: always fails, trips the strike limit and disables typing.
      const failing = makeTypingChannel(() => true);
      const failingInterval = (adapter as any).startTyping({ channel: failing, channelId } as any);
      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 2);
      expect(disableWarnCount()).toBe(1);
      expect((adapter as any).typingStrikes.get(channelId)).toBe(STRIKE_LIMIT);
      // The disabled interval must not keep firing.
      const failingCallsAtDisable = failing.sendTyping.mock.calls.length;

      // Next inbound message re-arms from a clean slate on a now-healthy channel.
      const healthy = makeTypingChannel(() => false);
      (adapter as any).startTyping({ channel: healthy, channelId } as any);
      expect((adapter as any).typingStrikes.has(channelId)).toBe(false);

      await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 3);
      expect(healthy.sendTyping.mock.calls.length).toBeGreaterThan(0);
      // Old disabled interval stayed dead; no second warning was emitted.
      expect(failing.sendTyping.mock.calls.length).toBe(failingCallsAtDisable);
      expect(disableWarnCount()).toBe(1);

      clearInterval(failingInterval);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leak strike entries after a turn completes', async () => {
    const eventBus = new EventBus();
    const adapter = new DiscordAdapter(makeConfig(), eventBus);
    await adapter.init();
    const channelId = 'ch-leak';
    const interactive = makeInteractiveTextChannel();
    // Typing fails during the turn, recording a strike, but the turn otherwise
    // completes normally; the finally cleanup must drop the strike entry.
    interactive.channel.sendTyping = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });
    discordMock.channelsById.set(channelId, interactive.channel);
    adapter.onMessage(async () => ({
      content: 'reply',
      channelId,
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 1 },
    }));

    await (adapter as any).onDiscordMessage(
      makeDiscordIncomingMessage(channelId, interactive.channel),
    );

    expect((adapter as any).typingStrikes.size).toBe(0);
  });
});
