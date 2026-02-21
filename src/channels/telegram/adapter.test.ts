import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../event-bus.js';
import type { AgentResponse, SubstrateMessage } from '../../types.js';
import type { TelegramChannelConfig } from '../config.js';
import { TelegramAdapter } from './adapter.js';

interface FetchCall {
  method: string;
  body: Record<string, unknown>;
}

function makeConfig(overrides: Partial<TelegramChannelConfig> = {}): TelegramChannelConfig {
  return {
    enabled: true,
    token: 'telegram-token',
    allowedUsers: [],
    mode: 'polling',
    pollIntervalMs: 50,
    ...overrides,
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

  it('provides media receive mapping and media send stub', async () => {
    const { fetchImpl, calls } = makeFetchMock({
      sendChatAction: () => true,
      sendMessage: () => ({ message_id: 700 }),
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
      { channelId: 'telegram:321' },
      { url: 'https://example.com/file.png', contentType: 'image/png', name: 'file.png' },
    );

    const sendCalls = calls.filter(call => call.method === 'sendMessage');
    expect(sendCalls.at(-1)?.body.text).toContain('[media stub]');
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
});
