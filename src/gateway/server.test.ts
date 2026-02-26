import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { GatewayServer, resolveGatewaySessionHmacKeyring, type GatewayServerOptions } from './server.js';
import type { NdjsonConnection } from './transport.js';

// Mock the transport module to avoid real socket operations
vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  NdjsonConnection: class extends EventEmitter {},
}));

import { createSocketServer } from './transport.js';

const mockedCreateSocketServer = vi.mocked(createSocketServer);

function createMockConnection(
  onSend?: (message: any, emit: (response: unknown) => void) => void,
) {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];

  const conn = {
    send(data: unknown): boolean {
      sent.push(data);
      onSend?.(data as any, (response) => emitter.emit('message', response));
      return true;
    },
    onMessage(handler: (message: unknown) => void): void {
      emitter.on('message', handler);
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      emitter.on(event, handler);
    },
    destroy(): void {
      emitter.removeAllListeners();
    },
    get destroyed(): boolean {
      return false;
    },
    _emit(message: unknown): void {
      emitter.emit('message', message);
    },
    _emitClose(): void {
      emitter.emit('close');
    },
  };

  return { conn: conn as unknown as NdjsonConnection, sent, _emit: conn._emit, _emitClose: conn._emitClose };
}

async function setupServerConnection(
  options: GatewayServerOptions,
  onSend?: (message: any, emit: (response: unknown) => void) => void,
): Promise<{ server: GatewayServer; conn: ReturnType<typeof createMockConnection> }> {
  const server = new GatewayServer(options);
  let onConnectionCb: ((conn: NdjsonConnection) => void) | null = null;
  mockedCreateSocketServer.mockImplementation((_path, cb) => {
    onConnectionCb = cb;
    return { close: vi.fn(), listen: vi.fn() } as any;
  });
  server.start();
  const conn = createMockConnection(onSend);
  onConnectionCb!(conn.conn);
  await new Promise(r => setTimeout(r, 5));
  return { server, conn };
}

function createMinimalOptions(): GatewayServerOptions {
  return {
    socketPath: '/tmp/test.sock',
    llmProvider: {
      stream: vi.fn().mockResolvedValue({
        content: 'test',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      }),
      complete: vi.fn(),
    } as any,
    embeddingService: {
      embed: vi.fn(),
      embedBatch: vi.fn(),
      dims: 1024,
    } as any,
    discordAdapter: {
      id: 'discord',
      outbound: {
        textChunkLimit: 2000,
        sendText: vi.fn(),
      },
    } as any,
    policyConfig: {
      workspacePath: '/workspace',
    },
  };
}

function makeVoiceMessage(content: string) {
  return {
    id: 'voice-msg-1',
    channelId: 'discord-voice:123',
    channelType: 'discord' as const,
    authorId: 'user-1',
    authorName: 'Voice User',
    content,
    timestamp: new Date('2025-01-01T00:00:00.000Z'),
  };
}

async function invokeRpc(
  conn: ReturnType<typeof createMockConnection>,
  id: number,
  method: string,
  params: unknown,
): Promise<any> {
  conn._emit({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });

  for (let attempt = 0; attempt < 40; attempt++) {
    const response = conn.sent.find(
      (msg: any) => msg.id === id && ('result' in msg || 'error' in msg),
    );
    if (response) {
      return response;
    }
    await new Promise(r => setTimeout(r, 5));
  }

  throw new Error(`No RPC response found for id ${id}`);
}

describe('resolveGatewaySessionHmacKeyring', () => {
  it('parses versioned keyrings with explicit active version', () => {
    const keyring = resolveGatewaySessionHmacKeyring({
      GATEWAY_SESSION_HMAC_KEYS: 'v1:old-secret,v2:new-secret',
      GATEWAY_SESSION_HMAC_ACTIVE_VERSION: 'v2',
    });
    expect(keyring).not.toBeNull();
    expect(keyring?.activeVersion).toBe('v2');
    expect(keyring?.keys.v1).toBe('old-secret');
    expect(keyring?.keys.v2).toBe('new-secret');
  });

  it('returns null when gateway HMAC env vars are absent', () => {
    const keyring = resolveGatewaySessionHmacKeyring({});
    expect(keyring).toBeNull();
  });
});

describe('GatewayServer', () => {
  describe('requestAgent', () => {
    it('throws when no agents are connected', async () => {
      const server = new GatewayServer(createMinimalOptions());
      await expect(server.requestAgent('test.method', {})).rejects.toThrow('No agent connected');
    });

    it('sends request to connected agent and receives response', async () => {
      const options = createMinimalOptions();
      const server = new GatewayServer(options);

      // Capture the connection callback
      let onConnectionCb: ((conn: NdjsonConnection) => void) | null = null;
      mockedCreateSocketServer.mockImplementation((_path, cb) => {
        onConnectionCb = cb;
        return { close: vi.fn(), listen: vi.fn() } as any;
      });

      server.start();
      expect(onConnectionCb).not.toBeNull();

      // Simulate an agent connecting
      const mockConn = createMockConnection();
      onConnectionCb!(mockConn.conn);

      // Make a request to the agent (it will be pending until we simulate a response)
      const requestPromise = server.requestAgent('discord.handleMessage', {
        message: { content: 'hello' },
      });

      // The request should have been sent to the agent
      // Find the RPC request in sent messages
      await new Promise(r => setTimeout(r, 10)); // let async settle
      const rpcRequest = mockConn.sent.find(
        (msg: any) => msg.method === 'discord.handleMessage',
      ) as any;
      expect(rpcRequest).toBeDefined();
      expect(rpcRequest.method).toBe('discord.handleMessage');

      // Simulate agent responding
      mockConn._emit({
        jsonrpc: '2.0',
        id: rpcRequest.id,
        result: { content: 'response text', channelId: 'ch1', model: 'test', durationMs: 100 },
      });

      const result = await requestPromise;
      expect(result).toEqual({
        content: 'response text',
        channelId: 'ch1',
        model: 'test',
        durationMs: 100,
      });
    });

    it('times out when agent does not respond', async () => {
      const options = createMinimalOptions();
      const server = new GatewayServer(options);

      let onConnectionCb: ((conn: NdjsonConnection) => void) | null = null;
      mockedCreateSocketServer.mockImplementation((_path, cb) => {
        onConnectionCb = cb;
        return { close: vi.fn(), listen: vi.fn() } as any;
      });

      server.start();

      const mockConn = createMockConnection();
      onConnectionCb!(mockConn.conn);

      // Request with very short timeout
      await expect(
        server.requestAgent('test.method', {}, 50),
      ).rejects.toThrow('Agent request timed out');
    });
  });

  describe('requestAgentVoiceStream', () => {
    it('streams start/chunk/end and returns final response', async () => {
      const methods: string[] = [];
      const { server } = await setupServerConnection(createMinimalOptions(), (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        methods.push(msg.method);
        if (msg.method === 'discord.voice.start' || msg.method === 'discord.voice.chunk') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              sequence: msg.params.sequence,
              accepted: true,
              queueDepth: 0,
            },
          });
          return;
        }
        if (msg.method === 'discord.voice.end') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: 'voice response',
              channelId: 'discord-voice:123',
              model: 'voice-model',
              durationMs: 321,
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              droppedChunks: msg.params.metadata?.droppedChunks ?? 0,
            },
          });
        }
      });

      const result = await server.requestAgentVoiceStream(
        makeVoiceMessage('hello world from voice'),
        { chunkSize: 5 },
      );

      expect(result).toEqual({
        content: 'voice response',
        channelId: 'discord-voice:123',
        model: 'voice-model',
        durationMs: 321,
      });
      expect(methods[0]).toBe('discord.voice.start');
      expect(methods[methods.length - 1]).toBe('discord.voice.end');
      expect(methods.filter(m => m === 'discord.voice.chunk').length).toBeGreaterThan(1);
    });

    it('falls back to discord.handleMessage when voice stream RPC is unavailable', async () => {
      const methods: string[] = [];
      const { server } = await setupServerConnection(createMinimalOptions(), (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        methods.push(msg.method);
        if (msg.method === 'discord.voice.start') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          });
          return;
        }
        if (msg.method === 'discord.handleMessage') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: 'legacy response',
              channelId: 'discord-voice:123',
              model: 'legacy-model',
              durationMs: 111,
            },
          });
        }
      });

      const result = await server.requestAgentVoiceStream(makeVoiceMessage('legacy please'));
      expect(result.content).toBe('legacy response');
      expect(methods).toEqual(['discord.voice.start', 'discord.handleMessage']);
    });

    it('sends cancel when stream fails mid-flight', async () => {
      const methods: string[] = [];
      const { server } = await setupServerConnection(createMinimalOptions(), (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        methods.push(msg.method);
        if (msg.method === 'discord.voice.start') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              sequence: msg.params.sequence,
              accepted: true,
              queueDepth: 0,
            },
          });
          return;
        }
        if (msg.method === 'discord.voice.chunk') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32003, message: 'chunk failed' },
          });
          return;
        }
        if (msg.method === 'discord.voice.cancel') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              cancelled: true,
            },
          });
        }
      });

      await expect(
        server.requestAgentVoiceStream(makeVoiceMessage('fail me please'), { chunkSize: 4 }),
      ).rejects.toBeTruthy();
      expect(methods).toContain('discord.voice.cancel');
    });

    it('applies drop_newest queue policy for chunk backpressure', async () => {
      const chunkPayloads: string[] = [];
      let endDroppedChunks = -1;
      const { server } = await setupServerConnection(createMinimalOptions(), (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        if (msg.method === 'discord.voice.start') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              sequence: msg.params.sequence,
              accepted: true,
              queueDepth: 0,
            },
          });
          return;
        }
        if (msg.method === 'discord.voice.chunk') {
          chunkPayloads.push(msg.params.text);
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              sequence: msg.params.sequence,
              accepted: true,
              queueDepth: 0,
            },
          });
          return;
        }
        if (msg.method === 'discord.voice.end') {
          endDroppedChunks = msg.params.metadata?.droppedChunks ?? -1;
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: 'voice response',
              channelId: 'discord-voice:123',
              model: 'voice-model',
              durationMs: 321,
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              droppedChunks: endDroppedChunks,
            },
          });
        }
      });

      await server.requestAgentVoiceStream(
        makeVoiceMessage('ABCDEFGHIJKL'),
        {
          chunkSize: 2,
          maxQueueSize: 1,
          overflowPolicy: 'drop_newest',
        },
      );

      expect(chunkPayloads.length).toBe(1);
      expect(endDroppedChunks).toBeGreaterThan(0);
    });
  });

  describe('connection lifecycle', () => {
    it('removes disconnected agents from rpcClients', async () => {
      const server = new GatewayServer(createMinimalOptions());

      let onConnectionCb: ((conn: NdjsonConnection) => void) | null = null;
      mockedCreateSocketServer.mockImplementation((_path, cb) => {
        onConnectionCb = cb;
        return { close: vi.fn(), listen: vi.fn() } as any;
      });

      server.start();

      const mockConn = createMockConnection();
      onConnectionCb!(mockConn.conn);

      // Agent is connected, requestAgent should not throw "No agent connected"
      // (it will time out, but not throw "No agent connected")
      const req = server.requestAgent('test', {}, 20).catch(e => e.message);
      await expect(req).resolves.toBe('Agent request timed out');

      // Simulate disconnect
      mockConn._emitClose();

      // Now requestAgent should throw "No agent connected"
      await expect(server.requestAgent('test', {})).rejects.toThrow('No agent connected');
    });
  });

  describe('notify.ntfy', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('posts to ntfy and returns sent status', async () => {
      fetchMock.mockResolvedValue(
        new Response('', {
          status: 200,
          headers: { 'x-message-id': 'msg-123' },
        }),
      );
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        ntfy: {
          baseUrl: 'https://ntfy.local',
          defaultTopic: 'default-topic',
          token: 'test-token',
          timeoutMs: 1_000,
          debounceWindowMs: 60_000,
        },
      });

      const response = await invokeRpc(conn, 1, 'notify.ntfy', {
        message: 'Discord gateway offline',
        title: 'Incident',
        priority: 5,
        topic: 'urgent',
      });

      expect(response.result).toEqual({
        status: 'sent',
        topic: 'urgent',
        messageId: 'msg-123',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ntfy.local/urgent',
        expect.objectContaining({
          method: 'POST',
          body: 'Discord gateway offline',
          headers: expect.objectContaining({
            Title: 'Incident',
            Priority: '5',
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });

    it('debounces duplicate alerts', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 200 }));
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        ntfy: {
          baseUrl: 'https://ntfy.local',
          defaultTopic: 'ops',
          timeoutMs: 1_000,
          debounceWindowMs: 60_000,
        },
      });

      const params = {
        message: 'Discord gateway offline',
        title: 'Incident',
        priority: 5,
      };
      const first = await invokeRpc(conn, 2, 'notify.ntfy', params);
      const second = await invokeRpc(conn, 3, 'notify.ntfy', params);

      expect(first.result.status).toBe('sent');
      expect(second.result).toEqual({
        status: 'debounced',
        topic: 'ops',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns provider error when ntfy responds non-2xx', async () => {
      fetchMock.mockResolvedValue(
        new Response('error', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        ntfy: {
          baseUrl: 'https://ntfy.local',
          defaultTopic: 'ops',
          timeoutMs: 1_000,
          debounceWindowMs: 60_000,
        },
      });

      const response = await invokeRpc(conn, 4, 'notify.ntfy', {
        message: 'Discord gateway offline',
      });

      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32003);
      expect(response.error.message).toContain('ntfy request failed: 500');
    });
  });
});
