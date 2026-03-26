import { describe, it, expect, vi } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { EventBus } from '../../event-bus.js';
import type { AgentResponse, SubstrateMessage } from '../../types.js';
import type { TelegramChannelConfig } from '../config.js';
import { TelegramAdapter } from './adapter.js';

interface FetchCall {
  method: string;
  body: Record<string, unknown>;
}

type TelegramConfigOverrides = Partial<Omit<TelegramChannelConfig, 'webhook'>> & {
  webhook?: Partial<TelegramChannelConfig['webhook']>;
};

function makeConfig(overrides: TelegramConfigOverrides = {}): TelegramChannelConfig {
  const base: TelegramChannelConfig = {
    enabled: true,
    token: 'telegram-token',
    allowedUsers: [],
    mode: 'polling',
    pollIntervalMs: 50,
    webhook: {
      url: 'https://example.com/telegram/webhook',
      secret: '',
      host: '127.0.0.1',
      port: 8080,
      path: '/telegram/webhook',
    },
  };

  return {
    ...base,
    ...overrides,
    webhook: {
      ...base.webhook,
      ...overrides.webhook,
    },
  };
}

function makeResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function extractMethod(input: string | URL | Request): string {
  const value = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const idx = value.lastIndexOf('/');
  return idx >= 0 ? value.slice(idx + 1) : value;
}

function makeFetchMock(
  handlers: Partial<Record<string, (body: Record<string, unknown>) => unknown>>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const method = extractMethod(input);
    const bodyText = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    calls.push({ method, body });
    const handler = handlers[method];
    const result = handler ? handler(body) : true;
    return makeResponse(result);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function okResponse(channelId: string): AgentResponse {
  return {
    content: 'ok',
    channelId,
    metadata: {
      model: 'test',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 1,
    },
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (!address) {
    throw new Error('Unable to allocate an ephemeral test port');
  }
  return address.port;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TelegramAdapter', () => {
  it('exposes channel adapter facets and task-kind routing hook', () => {
    const { fetchImpl } = makeFetchMock({});
    const adapter = new TelegramAdapter(makeConfig(), new EventBus(), { fetchImpl });

    expect(adapter.id).toBe('telegram');
    expect(adapter.name).toBe('telegram');
    expect(adapter.meta.label).toBe('Telegram');
    expect(adapter.outbound.textChunkLimit).toBe(4096);
    expect(adapter.gateway).toBe(adapter);
    expect(adapter.security.allowlist).toEqual([]);
    expect(adapter.threading.toThreadChannelId('telegram:1', '99')).toBe('telegram:1/thread/99');
    expect(adapter.threading.fromThreadChannelId('telegram:1/thread/99')).toBe('99');
    expect(adapter.prompt.resolveTaskKind?.({
      id: 'm1',
      channelId: 'telegram:1',
      channelType: 'telegram',
      authorId: 'u1',
      authorName: 'User',
      content: '/sync now',
      timestamp: new Date(),
    } satisfies SubstrateMessage)).toBe('telegram_command');
  });

  it('handles DM/group messages with command routing, typing, and reply-thread mapping', async () => {
    let sentMessageId = 500;
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: sentMessageId++ }),
    });

    const handled: SubstrateMessage[] = [];
    const adapter = new TelegramAdapter(makeConfig(), new EventBus(), {
      fetchImpl,
      commandRouter: ({ command, args }) => {
        if (command !== 'sync') return undefined;
        return `run-skill ${args}`;
      },
    });
    adapter.onMessage(async (message) => {
      handled.push(message);
      return okResponse(message.channelId);
    });

    await (adapter as any).handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        text: 'hello from dm',
        chat: { id: 111, type: 'private' },
        from: { id: 42, is_bot: false, username: 'dm_user' },
      },
    });

    await (adapter as any).handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_100,
        text: '/sync now please',
        chat: { id: -900, type: 'supergroup' },
        from: { id: 42, is_bot: false, username: 'group_user' },
        message_thread_id: 7,
        reply_to_message: { message_id: 9 },
      },
    });

    expect(handled).toHaveLength(2);
    expect(handled[0].isDirectMessage).toBe(true);
    expect(handled[0].channelId).toBe('telegram:111');
    expect(handled[0].content).toBe('hello from dm');
    expect(handled[1].isDirectMessage).toBe(false);
    expect(handled[1].channelId).toBe('telegram:-900/thread/7');
    expect(handled[1].content).toBe('run-skill now please');

    const sendCalls = calls.filter(call => call.method === 'sendMessage');
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0].body.chat_id).toBe('111');
    expect(sendCalls[0].body.reply_to_message_id).toBe(10);
    expect(sendCalls[0].body.parse_mode).toBe('Markdown');
    expect(sendCalls[1].body.chat_id).toBe('-900');
    expect(sendCalls[1].body.reply_to_message_id).toBe(9);
    expect(sendCalls[1].body.message_thread_id).toBe(7);

    const typingCalls = calls.filter(call => call.method === 'sendChatAction');
    expect(typingCalls.length).toBeGreaterThan(0);
  });

  it('streams progressive Telegram replies with editMessageText and reconciles the final response', async () => {
    let sentMessageId = 800;
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: sentMessageId++ }),
      editMessageText: () => true,
    });
    const eventBus = new EventBus();
    const adapter = new TelegramAdapter(makeConfig(), eventBus, { fetchImpl });

    adapter.onMessage(async (message) => {
      await eventBus.emit('agent.stream.delta', {
        channelId: message.channelId,
        text: 'Hello',
      });
      await eventBus.emit('agent.stream.delta', {
        channelId: message.channelId,
        text: ' world',
      });
      return {
        ...okResponse(message.channelId),
        content: 'Hello *world*!',
      };
    });

    await (adapter as any).handleUpdate({
      update_id: 2,
      message: {
        message_id: 20,
        date: 1_700_000_020,
        text: 'stream please',
        chat: { id: 222, type: 'private' },
        from: { id: 42, is_bot: false, username: 'stream_user' },
      },
    });

    const sendCalls = calls.filter(call => call.method === 'sendMessage');
    const editCalls = calls.filter(call => call.method === 'editMessageText');

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.body.chat_id).toBe('222');
    expect(sendCalls[0]?.body.reply_to_message_id).toBe(20);
    expect(sendCalls[0]?.body.text).toBe('Hello');
    expect(sendCalls[0]?.body.parse_mode).toBeUndefined();

    expect(editCalls).toHaveLength(2);
    expect(editCalls[0]?.body.message_id).toBe(800);
    expect(editCalls[0]?.body.text).toBe('Hello world');
    expect(editCalls[0]?.body.parse_mode).toBeUndefined();
    expect(editCalls[1]?.body.message_id).toBe(800);
    expect(editCalls[1]?.body.text).toBe('Hello *world*!');
    expect(editCalls[1]?.body.parse_mode).toBe('Markdown');
  });

  it('emits explicit egress diagnostics when Telegram stream edits fail', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 880 }),
      editMessageText: () => {
        throw new Error('telegram edit failed');
      },
    });
    const eventBus = new EventBus();
    const diagnostics: any[] = [];
    (eventBus as any).on('channel.message.error', (event: any) => {
      diagnostics.push(event);
    });
    const adapter = new TelegramAdapter(makeConfig(), eventBus, { fetchImpl });

    adapter.onMessage(async (message) => {
      await eventBus.emit('agent.stream.delta', {
        channelId: message.channelId,
        text: 'Hello',
      });
      await eventBus.emit('agent.stream.delta', {
        channelId: message.channelId,
        text: ' world',
      });
      return {
        ...okResponse(message.channelId),
        content: 'Hello world',
      };
    });

    await (adapter as any).handleUpdate({
      update_id: 3,
      message: {
        message_id: 21,
        date: 1_700_000_021,
        text: 'broken stream',
        chat: { id: 223, type: 'private' },
        from: { id: 42, is_bot: false, username: 'stream_user' },
      },
    });

    const sendCalls = calls.filter(call => call.method === 'sendMessage');
    const editCalls = calls.filter(call => call.method === 'editMessageText');

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.body.text).toBe('Hello');
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.body.text).toBe('Hello world');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      channelId: 'telegram:223',
      channelType: 'telegram',
      messageId: 'telegram:223:21',
      phase: 'egress',
      error: expect.stringContaining('telegram edit failed'),
    }));
  });

  it('sends rate-limited long-running think status updates and clears them after tool completion', async () => {
    vi.useFakeTimers();
    try {
      let sentMessageId = 900;
      const { fetchImpl, calls } = makeFetchMock({
        sendChatAction: () => true,
        sendMessage: () => ({ message_id: sentMessageId++ }),
        editMessageText: () => true,
        deleteMessage: () => true,
      });
      const eventBus = new EventBus();
      const adapter = new TelegramAdapter(makeConfig(), eventBus, { fetchImpl });

      adapter.onMessage(async (message) => {
        await eventBus.emit('agent.tool.start', {
          channelId: message.channelId,
          toolCallId: 'think-call-1',
          toolName: 'think',
        });
        await vi.advanceTimersByTimeAsync(16_000);
        await vi.advanceTimersByTimeAsync(25_000);
        await eventBus.emit('agent.tool.end', {
          channelId: message.channelId,
          toolCallId: 'think-call-1',
          toolName: 'think',
          isError: false,
        });
        return okResponse(message.channelId);
      });

      await (adapter as any).handleUpdate({
        update_id: 3,
        message: {
          message_id: 12,
          date: 1_700_000_200,
          text: 'please think',
          chat: { id: 333, type: 'private' },
          from: { id: 42, is_bot: false, username: 'think_user' },
        },
      });

      const longRunningSends = calls.filter(call =>
        call.method === 'sendMessage'
        && String(call.body.text ?? '').includes('Still thinking deeply'),
      );
      const longRunningEdits = calls.filter(call => call.method === 'editMessageText');
      const longRunningDeletes = calls.filter(call => call.method === 'deleteMessage');

      expect(longRunningSends).toHaveLength(1);
      expect(longRunningEdits).toHaveLength(1);
      expect(longRunningDeletes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces allowlist checks for inbound users', async () => {
    const { fetchImpl } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 123 }),
    });
    const handler = vi.fn(async (message: SubstrateMessage) => okResponse(message.channelId));

    const adapter = new TelegramAdapter(
      makeConfig({ allowedUsers: ['42', '@friend'] }),
      new EventBus(),
      { fetchImpl },
    );
    adapter.onMessage(handler);

    await (adapter as any).handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text: 'should be ignored',
        chat: { id: 111, type: 'private' },
        from: { id: 99, is_bot: false, username: 'intruder' },
      },
    });
    expect(handler).toHaveBeenCalledTimes(0);

    await (adapter as any).handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 1_700_000_001,
        text: 'allowed by username',
        chat: { id: 111, type: 'private' },
        from: { id: 55, is_bot: false, username: 'friend' },
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('provides media receive mapping and native media send method selection', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 700 }),
      sendPhoto: () => ({ message_id: 701 }),
      sendVoice: () => ({ message_id: 702 }),
      sendDocument: () => ({ message_id: 703 }),
    });
    const received: SubstrateMessage[] = [];

    const adapter = new TelegramAdapter(makeConfig(), new EventBus(), { fetchImpl });
    adapter.onMessage(async (message) => {
      received.push(message);
      return okResponse(message.channelId);
    });

    await (adapter as any).handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 321, type: 'private' },
        from: { id: 7, is_bot: false, username: 'media_user' },
        photo: [{ file_id: 'photo-file', file_unique_id: 'u-photo' }],
        voice: { file_id: 'voice-file', mime_type: 'audio/ogg' },
        document: { file_id: 'doc-file', file_name: 'spec.pdf', mime_type: 'application/pdf' },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('[media message]');
    expect(received[0].attachments).toHaveLength(3);
    expect(received[0].attachments?.[0].url).toContain('photo-file');

    await adapter.outbound.sendMedia?.(
      {
        channelId: 'telegram:321/thread/9',
        replyToMessageId: 'telegram:321:55',
      },
      { url: 'https://example.com/file.png', contentType: 'image/png', name: 'file.png' },
    );
    await adapter.outbound.sendMedia?.(
      { channelId: 'telegram:321/thread/9' },
      { url: 'telegram://file/voice-file', contentType: 'audio/ogg', name: 'voice.ogg' },
    );
    await adapter.outbound.sendMedia?.(
      { channelId: 'telegram:321/thread/9' },
      { url: 'https://example.com/spec.pdf', contentType: 'application/pdf', name: 'spec.pdf' },
    );

    const sendPhotoCall = calls.find(call => call.method === 'sendPhoto');
    expect(sendPhotoCall?.body.chat_id).toBe('321');
    expect(sendPhotoCall?.body.message_thread_id).toBe(9);
    expect(sendPhotoCall?.body.reply_to_message_id).toBe(55);
    expect(sendPhotoCall?.body.photo).toBe('https://example.com/file.png');

    const sendVoiceCall = calls.find(call => call.method === 'sendVoice');
    expect(sendVoiceCall?.body.chat_id).toBe('321');
    expect(sendVoiceCall?.body.message_thread_id).toBe(9);
    expect(sendVoiceCall?.body.voice).toBe('voice-file');

    const sendDocumentCall = calls.find(call => call.method === 'sendDocument');
    expect(sendDocumentCall?.body.chat_id).toBe('321');
    expect(sendDocumentCall?.body.message_thread_id).toBe(9);
    expect(sendDocumentCall?.body.document).toBe('https://example.com/spec.pdf');
  });

  it('sends response attachments after the text reply', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 801 }),
      sendPhoto: () => ({ message_id: 802 }),
    });

    const adapter = new TelegramAdapter(makeConfig(), new EventBus(), { fetchImpl });
    adapter.onMessage(async (message) => ({
      content: 'selfie sent',
      channelId: message.channelId,
      attachments: [{
        url: 'https://images.example.test/selfie.png',
        contentType: 'image/png',
        name: 'selfie.png',
      }],
      metadata: {
        model: 'test',
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
      },
    }));

    await (adapter as any).handleUpdate({
      update_id: 2,
      message: {
        message_id: 99,
        date: 1_700_000_000,
        chat: { id: 321, type: 'private' },
        from: { id: 7, is_bot: false, username: 'media_user' },
        text: 'send me a selfie',
      },
    });

    const sendMessageCall = calls.find(call => call.method === 'sendMessage');
    expect(sendMessageCall?.body.chat_id).toBe('321');
    expect(sendMessageCall?.body.text).toBe('selfie sent');
    expect(sendMessageCall?.body.reply_to_message_id).toBe(99);

    const sendPhotoCall = calls.find(call => call.method === 'sendPhoto');
    expect(sendPhotoCall?.body.chat_id).toBe('321');
    expect(sendPhotoCall?.body.photo).toBe('https://images.example.test/selfie.png');
  });

  it('emits channel.message.error diagnostics without sending canned fallback text when handler throws', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 777 }),
    });
    const eventBus = new EventBus();
    const diagnostics: any[] = [];
    (eventBus as any).on('channel.message.error', (event: any) => {
      diagnostics.push(event);
    });

    const adapter = new TelegramAdapter(makeConfig(), eventBus, { fetchImpl });
    adapter.onMessage(async () => {
      throw new Error('telegram handler exploded');
    });

    await (adapter as any).handleUpdate({
      update_id: 2,
      message: {
        message_id: 44,
        date: 1_700_000_050,
        text: 'will fail',
        chat: { id: 654, type: 'private' },
        from: { id: 77, is_bot: false, username: 'broken_user' },
      },
    });

    const sendCalls = calls.filter(call => call.method === 'sendMessage');
    expect(sendCalls).toHaveLength(0);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      channelId: 'telegram:654',
      channelType: 'telegram',
      messageId: 'telegram:654:44',
      phase: 'handler',
      error: expect.stringContaining('telegram handler exploded'),
    }));
  });

  it('sends response attachments after the text reply', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 801 }),
      sendPhoto: () => ({ message_id: 802 }),
    });

    const adapter = new TelegramAdapter(makeConfig(), new EventBus(), { fetchImpl });
    adapter.onMessage(async (message) => ({
      content: 'selfie sent',
      channelId: message.channelId,
      attachments: [{
        url: 'https://images.example.test/selfie.png',
        contentType: 'image/png',
        name: 'selfie.png',
      }],
      metadata: {
        model: 'test',
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
      },
    }));

    await (adapter as any).handleUpdate({
      update_id: 2,
      message: {
        message_id: 99,
        date: 1_700_000_000,
        chat: { id: 321, type: 'private' },
        from: { id: 7, is_bot: false, username: 'media_user' },
        text: 'send me a selfie',
      },
    });

    const sendMessageCall = calls.find(call => call.method === 'sendMessage');
    expect(sendMessageCall?.body.chat_id).toBe('321');
    expect(sendMessageCall?.body.text).toBe('selfie sent');
    expect(sendMessageCall?.body.reply_to_message_id).toBe(99);

    const sendPhotoCall = calls.find(call => call.method === 'sendPhoto');
    expect(sendPhotoCall?.body.chat_id).toBe('321');
    expect(sendPhotoCall?.body.photo).toBe('https://images.example.test/selfie.png');
  });

  it('defers same-channel concurrent updates and processes the deferred turn', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 700 }),
    });
    const adapter = new TelegramAdapter(makeConfig(), new EventBus(), { fetchImpl });
    const handled: string[] = [];
    const firstTurnStarted = createDeferred<void>();
    const releaseFirstTurn = createDeferred<void>();

    adapter.onMessage(async (message) => {
      handled.push(message.content);
      if (message.content === 'first') {
        firstTurnStarted.resolve();
        await releaseFirstTurn.promise;
      }
      return okResponse(message.channelId);
    });

    const firstTurn = (adapter as any).handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        text: 'first',
        chat: { id: 600, type: 'private' },
        from: { id: 42, is_bot: false, username: 'user' },
      },
    });
    await firstTurnStarted.promise;

    await (adapter as any).handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_001,
        text: 'second',
        chat: { id: 600, type: 'private' },
        from: { id: 42, is_bot: false, username: 'user' },
      },
    });

    releaseFirstTurn.resolve();
    await firstTurn;

    for (let i = 0; i < 40; i += 1) {
      const sentCount = calls.filter(call => call.method === 'sendMessage').length;
      if (handled.length >= 2 && sentCount >= 2) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    expect(handled).toEqual(['first', 'second']);
    const sendCalls = calls.filter(call => call.method === 'sendMessage');
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]?.body.reply_to_message_id).toBe(11);
  });

  it('keeps ingress responsive across chats while one chat turn is in flight', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 701 }),
    });
    const adapter = new TelegramAdapter(makeConfig(), new EventBus(), { fetchImpl });
    const handled: string[] = [];
    const firstTurnStarted = createDeferred<void>();
    const releaseFirstTurn = createDeferred<void>();

    adapter.onMessage(async (message) => {
      handled.push(`${message.channelId}:${message.content}`);
      if (message.channelId === 'telegram:600') {
        firstTurnStarted.resolve();
        await releaseFirstTurn.promise;
      }
      return okResponse(message.channelId);
    });

    const firstTurn = (adapter as any).handleUpdate({
      update_id: 10,
      message: {
        message_id: 30,
        date: 1_700_000_010,
        text: 'first',
        chat: { id: 600, type: 'private' },
        from: { id: 42, is_bot: false, username: 'user' },
      },
    });
    await firstTurnStarted.promise;

    await (adapter as any).handleUpdate({
      update_id: 11,
      message: {
        message_id: 31,
        date: 1_700_000_011,
        text: 'second',
        chat: { id: 601, type: 'private' },
        from: { id: 42, is_bot: false, username: 'user' },
      },
    });

    expect(handled).toEqual([
      'telegram:600:first',
      'telegram:601:second',
    ]);

    let sendCalls = calls.filter(call => call.method === 'sendMessage');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.body.chat_id).toBe('601');
    expect(sendCalls[0]?.body.reply_to_message_id).toBe(31);

    releaseFirstTurn.resolve();
    await firstTurn;

    for (let i = 0; i < 40; i += 1) {
      sendCalls = calls.filter(call => call.method === 'sendMessage');
      if (sendCalls.length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]?.body.chat_id).toBe('600');
    expect(sendCalls[1]?.body.reply_to_message_id).toBe(30);
  });

  it('registers webhook mode lifecycle and routes incoming updates through listener', async () => {
    const webhookPort = await reservePort();
    const { fetchImpl, calls } = makeFetchMock({
      setWebhook: () => true,
      deleteWebhook: () => true,
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 901 }),
    });
    const handled: SubstrateMessage[] = [];
    const adapter = new TelegramAdapter(makeConfig({
      mode: 'webhook',
      webhook: {
        url: 'https://public.example.com/hooks/telegram',
        secret: 'shared-secret',
        host: '127.0.0.1',
        port: webhookPort,
        path: '/hooks/telegram',
      },
    }), new EventBus(), { fetchImpl });
    adapter.onMessage(async (message) => {
      handled.push(message);
      return okResponse(message.channelId);
    });

    await adapter.start();

    const registerCall = calls.find(call => call.method === 'setWebhook');
    expect(registerCall?.body.url).toBe('https://public.example.com/hooks/telegram');
    expect(registerCall?.body.secret_token).toBe('shared-secret');

    const response = await fetch(`http://127.0.0.1:${webhookPort}/hooks/telegram`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'shared-secret',
      },
      body: JSON.stringify({
        update_id: 10,
        message: {
          message_id: 33,
          date: 1_700_000_900,
          text: 'webhook hello',
          chat: { id: 444, type: 'private' },
          from: { id: 55, is_bot: false, username: 'webhook_user' },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(handled).toHaveLength(1);
    expect(handled[0].content).toBe('webhook hello');
    expect(handled[0].channelId).toBe('telegram:444');

    await adapter.stop();
    const deregisterCall = calls.find(call => call.method === 'deleteWebhook');
    expect(deregisterCall?.body.drop_pending_updates).toBe(false);
  });

  it('starts/stops polling lifecycle through gateway facet', async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, calls } = makeFetchMock({
        getUpdates: () => [],
      });
      const adapter = new TelegramAdapter(makeConfig({ pollIntervalMs: 25 }), new EventBus(), {
        fetchImpl,
        longPollTimeoutSeconds: 1,
      });

      await adapter.start();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      const pollsBeforeStop = calls.filter(call => call.method === 'getUpdates').length;
      expect(pollsBeforeStop).toBeGreaterThan(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(200);

      const pollsAfterStop = calls.filter(call => call.method === 'getUpdates').length;
      expect(pollsAfterStop).toBe(pollsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off polling delay after consecutive transport failures', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { fetchImpl, calls } = makeFetchMock({
        getUpdates: () => {
          attempts += 1;
          throw new Error('fetch failed');
        },
      });
      const adapter = new TelegramAdapter(makeConfig({ pollIntervalMs: 10 }), new EventBus(), {
        fetchImpl,
        longPollTimeoutSeconds: 1,
      });

      await adapter.start();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(9);
      expect(calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(calls.filter(call => call.method === 'getUpdates')).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(19);
      expect(calls.filter(call => call.method === 'getUpdates')).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(calls.filter(call => call.method === 'getUpdates')).toHaveLength(3);
      expect(attempts).toBe(3);

      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers from polling 409 conflict by clearing webhook and retrying getUpdates', async () => {
    vi.useFakeTimers();
    try {
      let getUpdatesAttempts = 0;
      const { fetchImpl, calls } = makeFetchMock({
        deleteWebhook: () => true,
        getUpdates: () => {
          getUpdatesAttempts += 1;
          if (getUpdatesAttempts === 1) {
            throw new Error('Telegram API HTTP 409: terminated by other getUpdates request');
          }
          return [];
        },
      });
      const adapter = new TelegramAdapter(makeConfig({ pollIntervalMs: 25 }), new EventBus(), {
        fetchImpl,
        longPollTimeoutSeconds: 1,
      });

      await adapter.start();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      const deleteWebhookCalls = calls.filter(call => call.method === 'deleteWebhook');
      const getUpdatesCalls = calls.filter(call => call.method === 'getUpdates');
      expect(deleteWebhookCalls.length).toBeGreaterThanOrEqual(2);
      expect(getUpdatesCalls).toHaveLength(2);

      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
