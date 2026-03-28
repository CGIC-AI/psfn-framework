import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GatewayServer,
  requireGatewaySessionHmacKeyring,
  resolveGatewaySessionHmacKeyring,
  type GatewayServerOptions,
} from './server.js';
import { GatewayErrors } from './protocol.js';
import type { NdjsonConnection } from './transport.js';
import type { SessionHmacKeyring } from '../session/journal-utils.js';

// Mock the transport module to avoid real socket operations
vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  NdjsonConnection: class extends EventEmitter {},
}));

import { createSocketServer } from './transport.js';

const mockedCreateSocketServer = vi.mocked(createSocketServer);

const TEST_SESSION_HMAC_KEYRING: SessionHmacKeyring = {
  activeVersion: 'v1',
  keys: {
    v1: 'test-session-secret',
  },
};

const TEST_WYOMING_SHARD_ROUTING = {
  enabled: false,
};

function createMockConnection(
  onSend?: (message: any, emit: (response: unknown) => void) => void,
) {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  let destroyed = false;

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
      destroyed = true;
      emitter.removeAllListeners();
    },
    get destroyed(): boolean {
      return destroyed;
    },
    _emit(message: unknown): void {
      emitter.emit('message', message);
    },
    _emitClose(): void {
      emitter.emit('close');
    },
    _emitError(error: unknown): void {
      emitter.emit('error', error);
    },
    _emitFrameError(error: unknown): void {
      emitter.emit('frameError', error);
    },
  };

  return {
    conn: conn as unknown as NdjsonConnection,
    sent,
    _emit: conn._emit,
    _emitClose: conn._emitClose,
    _emitError: conn._emitError,
    _emitFrameError: conn._emitFrameError,
  };
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
    sessionHmacKeyring: TEST_SESSION_HMAC_KEYRING,
    wyomingShardRouting: TEST_WYOMING_SHARD_ROUTING,
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

function makeWyomingVoiceMessage(content: string) {
  return {
    id: 'wyoming-msg-conn-hallway-1',
    channelId: 'api:wyoming:ha-main:voice-pe-hallway',
    channelType: 'api' as const,
    authorId: 'wyoming-user:owner',
    authorName: 'Wyoming Voice User',
    content,
    timestamp: new Date('2025-01-01T00:00:00.000Z'),
    isDirectMessage: true,
    routing: {
      source: 'wyoming' as const,
    },
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

  it('fails closed when a required gateway keyring is missing', () => {
    expect(() => requireGatewaySessionHmacKeyring({})).toThrow('Session HMAC keyring is required');
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

  describe('session.hmac RPC', () => {
    it('signs and verifies entries using the gateway keyring', async () => {
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        sessionHmacKeyring: {
          activeVersion: 'v1',
          keys: { v1: 'integration-secret' },
        },
      });

      const signResponse = await invokeRpc(conn, 900, 'session.hmac.sign', {
        entry: {
          type: 'message',
          id: 1,
          channelId: 'api:test',
          role: 'user',
          content: 'hello',
          timestamp: 1_000,
        },
        previousHmac: null,
      });

      expect(signResponse.result.entry._hmac).toMatch(/^[a-f0-9]{64}$/i);
      expect(signResponse.result.entry._hmacKeyVersion).toBe('v1');

      const verifyResponse = await invokeRpc(conn, 901, 'session.hmac.verify', {
        entry: signResponse.result.entry,
        previousHmac: null,
      });
      expect(verifyResponse.result).toMatchObject({
        verified: true,
      });
    });

    it('returns failed verification for unsigned entries', async () => {
      const { conn } = await setupServerConnection(createMinimalOptions());
      const verifyResponse = await invokeRpc(conn, 902, 'session.hmac.verify', {
        entry: {
          type: 'message',
          id: 1,
          channelId: 'api:test',
          role: 'user',
          content: 'hello',
          timestamp: 1_000,
        },
        previousHmac: null,
      });

      expect(verifyResponse.error).toBeUndefined();
      expect(verifyResponse.result).toMatchObject({
        verified: false,
        reason: 'missing_signature',
      });
    });
  });

  it('serves fs.list results from workspace-scoped globbing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'gw-fs-list-'));
    const nestedDir = join(workspace, 'nested');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(workspace, 'alpha.txt'), 'alpha');
    writeFileSync(join(nestedDir, 'beta.txt'), 'beta');
    writeFileSync(join(workspace, 'gamma.md'), 'gamma');

    try {
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        policyConfig: {
          workspacePath: workspace,
        },
      });

      const listed = await invokeRpc(conn, 950, 'fs.list', {
        glob: '**/*.txt',
        maxEntries: 10,
      });

      expect(listed.result.paths).toEqual([
        'alpha.txt',
        'nested/beta.txt',
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('roots fs.read and fs.write relative paths to the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'gw-fs-rw-'));
    const relativeReadPath = 'notes.txt';
    const relativeWritePath = 'new-note.txt';
    writeFileSync(join(workspace, relativeReadPath), 'hello from workspace');

    try {
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        policyConfig: {
          workspacePath: workspace,
        },
      });

      const readResponse = await invokeRpc(conn, 960, 'fs.read', { path: relativeReadPath });
      expect(readResponse.result.content).toBe('hello from workspace');

      const writeResponse = await invokeRpc(conn, 961, 'fs.write', {
        path: relativeWritePath,
        content: 'written in workspace',
      });
      expect(writeResponse.result).toEqual({ success: true });
      expect(readFileSync(join(workspace, relativeWritePath), 'utf-8')).toBe('written in workspace');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('roots relative fs.read and fs.list to full codebase root in yolo mode while keeping writes in workspace', async () => {
    const codebaseRoot = mkdtempSync(join(tmpdir(), 'gw-yolo-root-'));
    const workspace = join(codebaseRoot, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(codebaseRoot, 'AGENTS.md'), 'root-agents');
    writeFileSync(join(workspace, 'AGENTS.md'), 'workspace-agents');

    try {
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        policyConfig: {
          workspacePath: workspace,
          fullCodebaseReadRoot: codebaseRoot,
        },
      });

      const readResponse = await invokeRpc(conn, 970, 'fs.read', { path: 'AGENTS.md' });
      expect(readResponse.result.content).toBe('root-agents');

      const listResponse = await invokeRpc(conn, 971, 'fs.list', {
        glob: '*.md',
        maxEntries: 20,
      });
      expect(listResponse.result.paths).toContain('AGENTS.md');

      const writeResponse = await invokeRpc(conn, 972, 'fs.write', {
        path: 'yolo-note.txt',
        content: 'workspace-write-only',
      });
      expect(writeResponse.result).toEqual({ success: true });
      expect(readFileSync(join(workspace, 'yolo-note.txt'), 'utf-8')).toBe('workspace-write-only');
      expect(existsSync(join(codebaseRoot, 'yolo-note.txt'))).toBe(false);
    } finally {
      rmSync(codebaseRoot, { recursive: true, force: true });
    }
  });

  describe('confirmation queue', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'gw-confirmation-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('queues gated actions until operator approval arrives', async () => {
      const queuedPath = join(tempDir, 'queued-write.txt');
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        capabilityTierProvider: () => 'apprentice',
      });

      const queued = await invokeRpc(conn, 10, 'fs.write', {
        path: queuedPath,
        content: 'queued-content',
      });

      expect(queued.error).toBeDefined();
      expect(queued.error.code).toBe(GatewayErrors.NEEDS_APPROVAL);
      expect(queued.error.message).toContain('pending operator approval');
      expect(existsSync(queuedPath)).toBe(false);

      const listed = await invokeRpc(conn, 11, 'confirmation.list', {});
      expect(listed.result.entries).toHaveLength(1);
      const entry = listed.result.entries[0];
      expect(entry.method).toBe('fs.write');
      expect(entry.scope).toBe(queuedPath);
      expect(entry.params).toEqual({
        path: queuedPath,
        content: 'queued-content',
      });

      const approved = await invokeRpc(conn, 12, 'confirmation.resolve', {
        id: entry.id,
        decision: 'approve',
      });
      expect(approved.result).toEqual({
        id: entry.id,
        status: 'approved',
        message: 'Action approved and executed.',
        executed: true,
      });
      expect(readFileSync(queuedPath, 'utf-8')).toBe('queued-content');

      const empty = await invokeRpc(conn, 13, 'confirmation.list', {});
      expect(empty.result.entries).toEqual([]);
    });

    it('executes modify decision with operator-provided params', async () => {
      const originalPath = join(tempDir, 'original.txt');
      const modifiedPath = join(tempDir, 'modified.txt');
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        capabilityTierProvider: () => 'apprentice',
      });

      const queued = await invokeRpc(conn, 20, 'fs.write', {
        path: originalPath,
        content: 'original-content',
      });
      expect(queued.error.code).toBe(GatewayErrors.NEEDS_APPROVAL);

      const listed = await invokeRpc(conn, 21, 'confirmation.list', {});
      const entry = listed.result.entries[0];

      const modified = await invokeRpc(conn, 22, 'confirmation.resolve', {
        id: entry.id,
        decision: 'modify',
        modifiedParams: {
          path: modifiedPath,
          content: 'modified-content',
        },
      });
      expect(modified.result).toEqual({
        id: entry.id,
        status: 'modified',
        message: 'Action executed with modified parameters.',
        executed: true,
      });
      expect(existsSync(originalPath)).toBe(false);
      expect(readFileSync(modifiedPath, 'utf-8')).toBe('modified-content');
    });

    it('bypasses confirmation queue for autonomous tier', async () => {
      const autoPath = join(tempDir, 'autonomous-write.txt');
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        capabilityTierProvider: () => 'autonomous',
      });

      const response = await invokeRpc(conn, 30, 'fs.write', {
        path: autoPath,
        content: 'autonomous-content',
      });
      expect(response.result).toEqual({ success: true });
      expect(readFileSync(autoPath, 'utf-8')).toBe('autonomous-content');

      const listed = await invokeRpc(conn, 31, 'confirmation.list', {});
      expect(listed.result.entries).toEqual([]);
    });

    it('expires pending requests after configured timeout', async () => {
      const queuedPath = join(tempDir, 'expired.txt');
      const { conn } = await setupServerConnection({
        ...createMinimalOptions(),
        capabilityTierProvider: () => 'apprentice',
        confirmation: {
          expiryMs: 20,
        },
      });

      const queued = await invokeRpc(conn, 40, 'fs.write', {
        path: queuedPath,
        content: 'expired-content',
      });
      expect(queued.error.code).toBe(GatewayErrors.NEEDS_APPROVAL);

      const listed = await invokeRpc(conn, 41, 'confirmation.list', {});
      const entry = listed.result.entries[0];

      await new Promise((resolve) => setTimeout(resolve, 40));

      const resolved = await invokeRpc(conn, 42, 'confirmation.resolve', {
        id: entry.id,
        decision: 'approve',
      });
      expect(resolved.result).toEqual({
        id: entry.id,
        status: 'expired',
        message: 'Confirmation request expired before resolution.',
        executed: false,
      });
      expect(existsSync(queuedPath)).toBe(false);
    });
  });

  describe('requestAgentVoiceStream', () => {
    it('streams start/chunk/end and returns final response', async () => {
      const methods: string[] = [];
      const { server } = await setupServerConnection(createMinimalOptions(), (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        methods.push(msg.method);
        if (msg.method === 'voice.stream.start' || msg.method === 'voice.stream.chunk') {
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
        if (msg.method === 'voice.stream.end') {
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
      expect(methods[0]).toBe('voice.stream.start');
      expect(methods[methods.length - 1]).toBe('voice.stream.end');
      expect(methods.filter(m => m === 'voice.stream.chunk').length).toBeGreaterThan(1);
    });

    it('marks Wyoming shard delegation ineligible by default-safe policy', async () => {
      let routedMessage: Record<string, unknown> | null = null;
      const { server } = await setupServerConnection(createMinimalOptions(), (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        if (msg.method === 'voice.stream.start') {
          routedMessage = msg.params.message as Record<string, unknown>;
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
        if (msg.method === 'voice.stream.chunk') {
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
        if (msg.method === 'voice.stream.end') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: 'voice response',
              channelId: 'api:wyoming:ha-main:voice-pe-hallway',
              model: 'voice-model',
              durationMs: 321,
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              droppedChunks: msg.params.metadata?.droppedChunks ?? 0,
            },
          });
        }
      });

      await server.requestAgentVoiceStream(makeWyomingVoiceMessage('hello from hallway'));

      const routing = (routedMessage?.routing as Record<string, unknown> | undefined)?.wyoming as Record<string, unknown>;
      expect(routing).toMatchObject({
        connectionId: 'conn-hallway',
        siteId: 'ha-main',
        satelliteId: 'voice-pe-hallway',
      });
      expect(routing.shardDelegation).toEqual({
        eligible: false,
        reason: 'policy_disabled',
      });
    });

    it('marks Wyoming shard delegation eligible when policy allowlists match', async () => {
      let routedMessage: Record<string, unknown> | null = null;
      const { server } = await setupServerConnection({
        ...createMinimalOptions(),
        wyomingShardRouting: {
          enabled: true,
          siteAllowlist: ['ha-main'],
          satelliteAllowlist: ['voice-pe-hallway'],
        },
      }, (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        if (msg.method === 'voice.stream.start') {
          routedMessage = msg.params.message as Record<string, unknown>;
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
        if (msg.method === 'voice.stream.chunk') {
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
        if (msg.method === 'voice.stream.end') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: 'voice response',
              channelId: 'api:wyoming:ha-main:voice-pe-hallway',
              model: 'voice-model',
              durationMs: 321,
              correlationId: msg.params.correlationId,
              streamId: msg.params.streamId,
              droppedChunks: msg.params.metadata?.droppedChunks ?? 0,
            },
          });
        }
      });

      await server.requestAgentVoiceStream(makeWyomingVoiceMessage('route to shard'));

      const routing = (routedMessage?.routing as Record<string, unknown> | undefined)?.wyoming as Record<string, unknown>;
      expect(routing.shardDelegation).toEqual({
        eligible: true,
        reason: 'eligible',
      });
    });

    it('sends cancel when stream fails mid-flight', async () => {
      const methods: string[] = [];
      const { server } = await setupServerConnection(createMinimalOptions(), (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        methods.push(msg.method);
        if (msg.method === 'voice.stream.start') {
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
        if (msg.method === 'voice.stream.chunk') {
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32003, message: 'chunk failed' },
          });
          return;
        }
        if (msg.method === 'voice.stream.cancel') {
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
      expect(methods).toContain('voice.stream.cancel');
    });

    it('applies drop_newest queue policy for chunk backpressure', async () => {
      const chunkPayloads: string[] = [];
      let endDroppedChunks = -1;
      const { server } = await setupServerConnection(createMinimalOptions(), (msg, emit) => {
        if (!msg.id || typeof msg.method !== 'string') return;
        if (msg.method === 'voice.stream.start') {
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
        if (msg.method === 'voice.stream.chunk') {
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
        if (msg.method === 'voice.stream.end') {
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

    it('fails closed when connected agents are present but none are ready', async () => {
      const server = new GatewayServer(createMinimalOptions());

      let onConnectionCb: ((conn: NdjsonConnection) => void) | null = null;
      mockedCreateSocketServer.mockImplementation((_path, cb) => {
        onConnectionCb = cb;
        return { close: vi.fn(), listen: vi.fn() } as any;
      });

      server.start();

      const mockConn = createMockConnection();
      onConnectionCb!(mockConn.conn);
      await new Promise(resolve => setTimeout(resolve, 10));

      const statuses = (server as any).connectionStatuses as Map<NdjsonConnection, any>;
      const status = statuses.get(mockConn.conn);
      expect(status).toBeDefined();
      status.state = 'degraded';
      status.health = 'failed';
      status.stateReason = 'test_degraded';

      await expect(server.requestAgent('test', {})).rejects.toThrow('No ready agent connected');
    });

    it('marks stale connections degraded and blocks routing until healthy', async () => {
      const server = new GatewayServer(createMinimalOptions());

      let onConnectionCb: ((conn: NdjsonConnection) => void) | null = null;
      mockedCreateSocketServer.mockImplementation((_path, cb) => {
        onConnectionCb = cb;
        return { close: vi.fn(), listen: vi.fn() } as any;
      });

      server.start();

      const mockConn = createMockConnection();
      onConnectionCb!(mockConn.conn);
      await new Promise(resolve => setTimeout(resolve, 10));

      const statuses = (server as any).connectionStatuses as Map<NdjsonConnection, any>;
      const status = statuses.get(mockConn.conn);
      expect(status).toBeDefined();
      status.lastHeartbeatAt = Date.now() - status.heartbeatStaleAfterMs - 5;

      await expect(server.requestAgent('test', {})).rejects.toThrow('No ready agent connected');
      expect(status.state).toBe('degraded');
      expect(status.health).toBe('stale');
      expect(status.stateReason).toBe('heartbeat_stale');
    });

    it('fails closed and audits malformed JSON-RPC frames', async () => {
      const auditLog = vi.fn().mockReturnValue(123);
      const auditComplete = vi.fn();
      const { server, conn } = await setupServerConnection({
        ...createMinimalOptions(),
        auditStore: {
          log: auditLog,
          complete: auditComplete,
        } as any,
      });

      conn._emit({
        jsonrpc: '2.0',
        id: 77,
        method: 42,
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(auditLog).toHaveBeenCalledWith(
        'gateway.ipc.frame.invalid',
        'DENY',
        expect.objectContaining({
          frameKind: 'jsonrpc',
        }),
      );
      expect(auditComplete).toHaveBeenCalledWith(
        123,
        expect.any(Number),
        expect.stringContaining('method'),
      );
      expect(conn.conn.destroyed).toBe(true);
      await expect(server.requestAgent('test', {})).rejects.toThrow('No agent connected');
    });

    it('fails closed and audits malformed NDJSON frames', async () => {
      const auditLog = vi.fn().mockReturnValue(222);
      const auditComplete = vi.fn();
      const { server, conn } = await setupServerConnection({
        ...createMinimalOptions(),
        auditStore: {
          log: auditLog,
          complete: auditComplete,
        } as any,
      });

      conn._emitFrameError({
        message: 'Malformed NDJSON frame received',
        preview: '{"jsonrpc":"2.0","bad":',
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(auditLog).toHaveBeenCalledWith(
        'gateway.ipc.frame.invalid',
        'DENY',
        expect.objectContaining({
          frameKind: 'ndjson',
        }),
      );
      expect(auditComplete).toHaveBeenCalledWith(
        222,
        expect.any(Number),
        'Malformed NDJSON frame received',
      );
      expect(conn.conn.destroyed).toBe(true);
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

    it('accepts unicode title text without header ByteString crashes', async () => {
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

      const response = await invokeRpc(conn, 5, 'notify.ntfy', {
        message: 'unicode title test',
        title: '😺 Alert',
      });

      expect(response.result).toEqual({
        status: 'sent',
        topic: 'ops',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const fetchArgs = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> };
      const encodedTitle = fetchArgs.headers?.Title;
      expect(typeof encodedTitle).toBe('string');
      expect(encodedTitle).toBeDefined();
      expect(encodedTitle).not.toContain('😺');
      expect(Buffer.from(encodedTitle!, 'latin1').toString('utf8')).toBe('😺 Alert');
    });
  });

  describe('runtime.health', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('surfaces gateway, ntfy, and vault health through runtime.health', async () => {
      const vaultOps = {
        write: vi.fn().mockRejectedValue(new Error('vault write failed')),
        read: vi.fn(),
        search: vi.fn(),
        daily: vi.fn(),
      };
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
        policyConfig: {
          workspacePath: '/workspace',
          vault: {
            enabled: true,
            allowActions: ['write', 'read'],
            ops: vaultOps as any,
          },
        },
      });

      const initial = await invokeRpc(conn, 600, 'runtime.health', {});
      expect(initial.result.services).toEqual(expect.arrayContaining([
        expect.objectContaining({ serviceId: 'gateway', status: 'healthy' }),
        expect.objectContaining({ serviceId: 'ntfy', status: 'healthy' }),
        expect.objectContaining({
          serviceId: 'vault',
          status: 'healthy',
          availableActions: ['write', 'read'],
        }),
      ]));

      const notifyFailure = await invokeRpc(conn, 601, 'notify.ntfy', {
        message: 'operator alert',
      });
      expect(notifyFailure.error).toBeDefined();
      expect(notifyFailure.error.message).toContain('ntfy request failed: 500');

      const vaultFailure = await invokeRpc(conn, 602, 'vault.write', {
        name: 'Inbox',
        content: 'entry',
      });
      expect(vaultFailure.error).toBeDefined();
      expect(vaultFailure.error.message).toContain('vault write failed');

      const degraded = await invokeRpc(conn, 603, 'runtime.health', {});
      const servicesById = Object.fromEntries(
        degraded.result.services.map((service: any) => [service.serviceId, service]),
      ) as Record<string, any>;

      expect(servicesById.gateway).toMatchObject({
        serviceId: 'gateway',
        status: 'healthy',
      });
      expect(servicesById.ntfy).toMatchObject({
        serviceId: 'ntfy',
        status: 'degraded',
        lastFailure: expect.objectContaining({
          scope: 'notify.ntfy',
        }),
      });
      expect(servicesById.ntfy.lastFailure.message).toContain('ntfy request failed: 500');
      expect(servicesById.vault).toMatchObject({
        serviceId: 'vault',
        status: 'degraded',
        availableActions: ['write', 'read'],
        lastFailure: expect.objectContaining({
          scope: 'vault.write',
        }),
      });
      expect(servicesById.vault.lastFailure.message).toContain('vault write failed');
    });
  });
});
