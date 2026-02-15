import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import type { NdjsonConnection } from './transport.js';

// Mock the transport module to avoid real socket operations
vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  NdjsonConnection: class extends EventEmitter {},
}));

import { createSocketServer } from './transport.js';

const mockedCreateSocketServer = vi.mocked(createSocketServer);

function createMockConnection() {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];

  const conn = {
    send(data: unknown): boolean {
      sent.push(data);
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
      send: vi.fn(),
    } as any,
    policyConfig: {
      workspacePath: '/workspace',
    },
  };
}

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
});
