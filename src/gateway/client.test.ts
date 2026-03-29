import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { GatewayClient } from './client.js';
import type { NdjsonConnection } from './transport.js';

/** Create a mock NdjsonConnection that captures sent messages */
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
    // Emit a message to the client as if received from the gateway
    _emit(message: unknown): void {
      emitter.emit('message', message);
    },
    _emitClose(): void {
      emitter.emit('close');
    },
    _emitError(error: Error): void {
      emitter.emit('error', error);
    },
  };

  return {
    conn: conn as unknown as NdjsonConnection,
    sent,
    _emit: conn._emit,
    _emitClose: conn._emitClose,
    _emitError: conn._emitError,
  };
}

function getRpcResponse(sent: unknown[], id: number): any {
  return sent.find((msg: any) => msg.id === id && ('result' in msg || 'error' in msg));
}

describe('GatewayClient streaming', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes chunks to the correct handler by requestId', async () => {
    const chunksA: string[] = [];
    const chunksB: string[] = [];

    // Start two concurrent streams
    const streamA = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'a' }] },
      { onText: (text) => chunksA.push(text) },
    );
    const streamB = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'b' }] },
      { onText: (text) => chunksB.push(text) },
    );

    // Both requests should have been sent — extract their requestIds
    // sent[0] is stream A's RPC request, sent[1] is stream B's RPC request
    expect(conn.sent.length).toBe(2);
    const reqA = conn.sent[0] as { id: number; params: { requestId: string } };
    const reqB = conn.sent[1] as { id: number; params: { requestId: string } };
    const requestIdA = reqA.params.requestId;
    const requestIdB = reqB.params.requestId;

    expect(requestIdA).toBeTruthy();
    expect(requestIdB).toBeTruthy();
    expect(requestIdA).not.toBe(requestIdB);

    // Simulate interleaved chunk notifications from gateway
    conn._emit({ method: 'llm.chunk', params: { requestId: requestIdA, text: 'hello-A' } });
    conn._emit({ method: 'llm.chunk', params: { requestId: requestIdB, text: 'hello-B' } });
    conn._emit({ method: 'llm.chunk', params: { requestId: requestIdA, text: ' world-A' } });
    conn._emit({ method: 'llm.chunk', params: { requestId: requestIdB, text: ' world-B' } });

    // Resolve stream A
    conn._emit({
      id: reqA.id,
      jsonrpc: '2.0',
      result: {
        content: 'hello-A world-A',
        reasoning: 'thinking-a',
        providerObservability: {
          routeKind: 'registered_model',
          requestedProvider: 'openrouter',
          requestedModel: 'test',
          backendProvider: 'openrouter',
          backendModel: 'test',
          backendApi: 'openai-completions',
          systemRole: {
            transport: 'openai_developer',
            supportsSystemRole: true,
            supportsDeveloperRole: true,
            usesOutOfBandSystemPrompt: false,
          },
          providerWireMessages: [
            { role: 'developer', source: 'system_prompt', content: 'test' },
            { role: 'user', source: 'message', content: 'a' },
          ],
        },
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
        requestId: requestIdA,
      },
    });

    // Resolve stream B
    conn._emit({
      id: reqB.id,
      jsonrpc: '2.0',
      result: {
        content: 'hello-B world-B',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
        requestId: requestIdB,
      },
    });

    const [resultA, resultB] = await Promise.all([streamA, streamB]);

    // Each handler got only its own chunks
    expect(chunksA).toEqual(['hello-A', ' world-A']);
    expect(chunksB).toEqual(['hello-B', ' world-B']);

    expect(resultA.content).toBe('hello-A world-A');
    expect(resultB.content).toBe('hello-B world-B');
    expect(resultA.reasoning).toBe('thinking-a');
    expect(resultA.providerObservability?.systemRole.transport).toBe('openai_developer');
  });

  it('cleans up chunk handler after stream completes', async () => {
    const chunks: string[] = [];

    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
      { onText: (text) => chunks.push(text) },
    );

    const req = conn.sent[0] as { id: number; params: { requestId: string } };
    const requestId = req.params.requestId;

    // Send a chunk before completion
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'before' } });

    // Complete the stream
    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        content: 'before',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      },
    });

    await streamPromise;

    // Send a chunk after completion — should not be routed
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'after' } });
    expect(chunks).toEqual(['before']);
  });

  it('cleans up chunk handler after stream error', async () => {
    const chunks: string[] = [];

    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
      {
        onText: (text) => chunks.push(text),
        onError: () => {},  // suppress unhandled error
      },
    );

    const req = conn.sent[0] as { id: number; params: { requestId: string } };
    const requestId = req.params.requestId;

    // Send a chunk before the error
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'before-error' } });

    // Send an error response
    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      error: { code: -32003, message: 'Provider error' },
    });

    await expect(streamPromise).rejects.toThrow();

    // After error, handler should be cleaned up
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'after-error' } });
    expect(chunks).toEqual(['before-error']);
  });
});

describe('GatewayClient reverse RPC (onHandleMessage)', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('receives and processes voice.handleMessage requests from gateway', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: 'voice response',
      channelId: 'discord-voice:123',
      metadata: { model: 'test-model', inputTokens: 10, outputTokens: 5, durationMs: 500 },
    });

    client.onHandleMessage(handler);

    // Simulate gateway sending an RPC request (has 'id' AND 'method')
    conn._emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'voice.handleMessage',
      params: {
        message: {
          id: 'voice-1',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'TestUser',
          content: 'hello voice',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      },
    });

    // Wait for async handling
    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    const handledMsg = handler.mock.calls[0][0];
    expect(handledMsg.content).toBe('hello voice');
    // Timestamp should be deserialized to Date
    expect(handledMsg.timestamp).toBeInstanceOf(Date);

    // The response should have been sent back
    const response = conn.sent.find(
      (msg: any) => msg.id === 42 && 'result' in msg,
    ) as any;
    expect(response).toBeDefined();
    expect(response.result.content).toBe('voice response');
    expect(response.result.model).toBe('test-model');
    expect(response.result.durationMs).toBe(500);
  });

  it('handles voice.stream.start/chunk/end reverse RPC flow', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: 'assembled response',
      channelId: 'discord-voice:123',
      metadata: { model: 'voice-model', inputTokens: 10, outputTokens: 4, durationMs: 250 },
    });
    client.onHandleMessage(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 100,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-1',
        streamId: 'stream-1',
        sequence: 0,
        metadata: { format: 'text' },
        message: {
          id: 'voice-1',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 101,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-1',
        streamId: 'stream-1',
        sequence: 1,
        text: 'hello ',
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 102,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-1',
        streamId: 'stream-1',
        sequence: 2,
        text: 'voice',
      },
    });
    conn._emit({
      jsonrpc: '2.0',
      id: 103,
      method: 'voice.stream.end',
      params: {
        correlationId: 'corr-1',
        streamId: 'stream-1',
        sequence: 3,
      },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].content).toBe('hello voice');
    expect(handler.mock.calls[0][0].timestamp).toBeInstanceOf(Date);

    expect(getRpcResponse(conn.sent, 100).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 101).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 102).result.accepted).toBe(true);
    expect(getRpcResponse(conn.sent, 103).result.content).toBe('assembled response');
  });

  it('supports voice stream cancellation', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: 'should not happen',
      channelId: 'discord-voice:123',
      metadata: { model: 'voice-model', inputTokens: 1, outputTokens: 1, durationMs: 1 },
    });
    client.onHandleMessage(handler);

    conn._emit({
      jsonrpc: '2.0',
      id: 200,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-cancel',
        streamId: 'stream-cancel',
        sequence: 0,
        message: {
          id: 'voice-2',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      },
    });
    await new Promise(r => setTimeout(r, 10));
    conn._emit({
      jsonrpc: '2.0',
      id: 201,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-cancel',
        streamId: 'stream-cancel',
        sequence: 1,
        text: 'partial',
      },
    });
    await new Promise(r => setTimeout(r, 10));
    conn._emit({
      jsonrpc: '2.0',
      id: 202,
      method: 'voice.stream.cancel',
      params: {
        correlationId: 'corr-cancel',
        streamId: 'stream-cancel',
        sequence: 2,
        reason: 'interrupted',
      },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(getRpcResponse(conn.sent, 202).result.cancelled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it('applies drop_newest queue policy for voice chunks', async () => {
    const localConn = createMockConnection();
    const localClient = new GatewayClient(localConn.conn, 1024, {
      voiceStreamQueueSize: 1,
      voiceStreamOverflowPolicy: 'drop_newest',
    });
    const handler = vi.fn().mockResolvedValue({
      content: 'ok',
      channelId: 'discord-voice:123',
      metadata: { model: 'voice-model', inputTokens: 1, outputTokens: 1, durationMs: 1 },
    });
    localClient.onHandleMessage(handler);

    localConn._emit({
      jsonrpc: '2.0',
      id: 300,
      method: 'voice.stream.start',
      params: {
        correlationId: 'corr-drop',
        streamId: 'stream-drop',
        sequence: 0,
        message: {
          id: 'voice-3',
          channelId: 'discord-voice:123',
          channelType: 'discord',
          authorId: 'user-1',
          authorName: 'Voice User',
          content: '',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      },
    });
    await new Promise(r => setTimeout(r, 10));
    localConn._emit({
      jsonrpc: '2.0',
      id: 301,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-drop',
        streamId: 'stream-drop',
        sequence: 1,
        text: 'first',
      },
    });
    await new Promise(r => setTimeout(r, 10));
    localConn._emit({
      jsonrpc: '2.0',
      id: 302,
      method: 'voice.stream.chunk',
      params: {
        correlationId: 'corr-drop',
        streamId: 'stream-drop',
        sequence: 2,
        text: 'second',
      },
    });
    await new Promise(r => setTimeout(r, 10));
    localConn._emit({
      jsonrpc: '2.0',
      id: 303,
      method: 'voice.stream.end',
      params: {
        correlationId: 'corr-drop',
        streamId: 'stream-drop',
        sequence: 3,
      },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].content).toBe('first');
    const droppedChunkResp = getRpcResponse(localConn.sent, 302);
    expect(droppedChunkResp).toBeDefined();
    expect(droppedChunkResp.result.accepted).toBe(false);
    expect(getRpcResponse(localConn.sent, 303).result.droppedChunks).toBe(1);
    localClient.destroy();
  });

  it('chunk routing still works after refactor', async () => {
    const chunks: string[] = [];

    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
      { onText: (text) => chunks.push(text) },
    );

    const req = conn.sent[0] as { id: number; params: { requestId: string } };
    const requestId = req.params.requestId;

    // Chunk should still be routed correctly via handleChunkNotification
    conn._emit({ method: 'llm.chunk', params: { requestId, text: 'chunk-1' } });

    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        content: 'chunk-1',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      },
    });

    const result = await streamPromise;
    expect(chunks).toEqual(['chunk-1']);
    expect(result.content).toBe('chunk-1');
  });

  it('discord.message notifications still work after refactor', () => {
    const messages: unknown[] = [];
    client.onDiscordMessage((msg) => messages.push(msg));

    conn._emit({
      method: 'discord.message',
      params: {
        message: {
          id: 'msg-1',
          channelId: 'ch-1',
          content: 'test notification',
        },
      },
    });

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).content).toBe('test notification');
  });
});

describe('GatewayClient session integrity RPC', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('calls session.hmac.sign and returns signed entry', async () => {
    const signPromise = client.sessionHmacSign({
      type: 'message',
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    }, null);

    const req = conn.sent[0] as { id: number; method: string };
    expect(req.method).toBe('session.hmac.sign');

    conn._emit({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        entry: {
          type: 'message',
          id: 1,
          channelId: 'api:test',
          role: 'user',
          content: 'hello',
          timestamp: 1_000,
          _hmac: 'a'.repeat(64),
          _hmacKeyVersion: 'v1',
        },
      },
    });

    const signed = await signPromise;
    expect(signed._hmac).toBe('a'.repeat(64));
    expect(signed._hmacKeyVersion).toBe('v1');
  });

  it('calls session.hmac.verify and returns verification result', async () => {
    const verifyPromise = client.sessionHmacVerify({
      type: 'message',
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
      _hmac: 'a'.repeat(64),
      _hmacKeyVersion: 'v1',
    }, null);

    const req = conn.sent[0] as { id: number; method: string };
    expect(req.method).toBe('session.hmac.verify');

    conn._emit({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        verified: true,
        observedHmac: 'a'.repeat(64),
      },
    });

    const verification = await verifyPromise;
    expect(verification).toEqual({
      verified: true,
      observedHmac: 'a'.repeat(64),
    });
  });

  it('fails to create sync session integrity bridge without socket path', () => {
    const provider = client.createSessionIntegrityProvider();
    expect(() => provider.sign({
      type: 'message',
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    }, null)).toThrow('requires a gateway socket path');
  });
});

describe('GatewayClient git RPC wrappers', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes git.status and git.diff with typed payloads', async () => {
    const statusPromise = client.gitStatus();
    const statusReq = conn.sent[0] as { id: number; method: string; params: Record<string, never> };
    expect(statusReq.method).toBe('git.status');
    expect(statusReq.params).toEqual({});
    conn._emit({
      jsonrpc: '2.0',
      id: statusReq.id,
      result: {
        branch: 'main',
        ahead: 1,
        behind: 0,
        staged: ['src/a.ts'],
        modified: ['src/b.ts'],
        untracked: ['src/c.ts'],
      },
    });
    await expect(statusPromise).resolves.toMatchObject({ branch: 'main', ahead: 1 });

    const diffPromise = client.gitDiff({ staged: false });
    const diffReq = conn.sent[1] as { id: number; method: string; params: { staged: boolean } };
    expect(diffReq.method).toBe('git.diff');
    expect(diffReq.params).toEqual({ staged: false });
    conn._emit({
      jsonrpc: '2.0',
      id: diffReq.id,
      result: {
        staged: '',
        unstaged: 'diff',
      },
    });
    await expect(diffPromise).resolves.toEqual({ staged: '', unstaged: 'diff' });
  });

  it('routes git write wrappers and maps structured responses', async () => {
    const createBranchPromise = client.gitCreateBranch('feature/test', 'main');
    const createBranchReq = conn.sent[0] as {
      id: number;
      method: string;
      params: { name: string; startPoint: string };
    };
    expect(createBranchReq.method).toBe('git.create_branch');
    expect(createBranchReq.params).toEqual({ name: 'feature/test', startPoint: 'main' });
    conn._emit({
      jsonrpc: '2.0',
      id: createBranchReq.id,
      result: { name: 'feature/test' },
    });
    await expect(createBranchPromise).resolves.toBe('feature/test');

    const applyPatchPromise = client.gitApplyPatch('src/x.ts', 'export const x = 1;');
    const applyPatchReq = conn.sent[1] as {
      id: number;
      method: string;
      params: { filePath: string; content: string };
    };
    expect(applyPatchReq.method).toBe('git.apply_patch');
    expect(applyPatchReq.params.filePath).toBe('src/x.ts');
    conn._emit({
      jsonrpc: '2.0',
      id: applyPatchReq.id,
      result: { success: true },
    });
    await expect(applyPatchPromise).resolves.toBeUndefined();

    const commitPromise = client.gitCommit('msg', 'intent', 'scope');
    const commitReq = conn.sent[2] as { id: number; method: string; params: Record<string, unknown> };
    expect(commitReq.method).toBe('git.commit');
    expect(commitReq.params).toEqual({ message: 'msg', intent: 'intent', scope: 'scope' });
    conn._emit({
      jsonrpc: '2.0',
      id: commitReq.id,
      result: { hash: 'abc', message: 'msg', filesChanged: 2 },
    });
    await expect(commitPromise).resolves.toMatchObject({ hash: 'abc', filesChanged: 2 });

    const openPrPromise = client.gitOpenPR('Title', 'Body', 'main');
    const openPrReq = conn.sent[3] as { id: number; method: string; params: Record<string, unknown> };
    expect(openPrReq.method).toBe('git.open_pr');
    expect(openPrReq.params).toEqual({ title: 'Title', body: 'Body', base: 'main' });
    conn._emit({
      jsonrpc: '2.0',
      id: openPrReq.id,
      result: { url: 'https://example.test/pr/1' },
    });
    await expect(openPrPromise).resolves.toBe('https://example.test/pr/1');
  });
});

describe('GatewayClient vault RPC wrappers', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes vault methods with typed payloads', async () => {
    const writePromise = client.vaultWrite('Inbox', 'entry', {
      folder: 'Journal',
      mode: 'append',
    });
    const writeReq = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };
    expect(writeReq.method).toBe('vault.write');
    expect(writeReq.params).toEqual({
      name: 'Inbox',
      content: 'entry',
      folder: 'Journal',
      mode: 'append',
    });
    conn._emit({
      jsonrpc: '2.0',
      id: writeReq.id,
      result: { name: 'Inbox', folder: 'Journal', mode: 'append' },
    });
    await expect(writePromise).resolves.toEqual({ name: 'Inbox', folder: 'Journal', mode: 'append' });

    const readPromise = client.vaultRead('Inbox.md');
    const readReq = conn.sent[1] as { id: number; method: string; params: Record<string, unknown> };
    expect(readReq.method).toBe('vault.read');
    expect(readReq.params).toEqual({ name: 'Inbox.md' });
    conn._emit({
      jsonrpc: '2.0',
      id: readReq.id,
      result: { name: 'Inbox.md', content: 'hello' },
    });
    await expect(readPromise).resolves.toEqual({ name: 'Inbox.md', content: 'hello' });

    const searchPromise = client.vaultSearch('focus', 5);
    const searchReq = conn.sent[2] as { id: number; method: string; params: Record<string, unknown> };
    expect(searchReq.method).toBe('vault.search');
    expect(searchReq.params).toEqual({ query: 'focus', limit: 5 });
    conn._emit({
      jsonrpc: '2.0',
      id: searchReq.id,
      result: { query: 'focus', results: [{ path: 'Notes/Focus.md' }] },
    });
    await expect(searchPromise).resolves.toEqual({
      query: 'focus',
      results: [{ path: 'Notes/Focus.md' }],
    });

    const dailyReadPromise = client.vaultDaily();
    const dailyReadReq = conn.sent[3] as { id: number; method: string; params: Record<string, unknown> };
    expect(dailyReadReq.method).toBe('vault.daily');
    expect(dailyReadReq.params).toEqual({});
    conn._emit({
      jsonrpc: '2.0',
      id: dailyReadReq.id,
      result: { date: '2026-03-06', content: 'daily', mode: 'read' },
    });
    await expect(dailyReadPromise).resolves.toEqual({ date: '2026-03-06', content: 'daily', mode: 'read' });

    const dailyAppendPromise = client.vaultDaily('entry');
    const dailyAppendReq = conn.sent[4] as { id: number; method: string; params: Record<string, unknown> };
    expect(dailyAppendReq.method).toBe('vault.daily');
    expect(dailyAppendReq.params).toEqual({ content: 'entry' });
    conn._emit({
      jsonrpc: '2.0',
      id: dailyAppendReq.id,
      result: { date: '2026-03-06', mode: 'append' },
    });
    await expect(dailyAppendPromise).resolves.toEqual({ date: '2026-03-06', mode: 'append' });
  });

  it('exposes RPC-name aliases for tool wiring validation', () => {
    expect(typeof (client as any)['vault.write']).toBe('function');
    expect(typeof (client as any)['vault.read']).toBe('function');
    expect(typeof (client as any)['vault.search']).toBe('function');
    expect(typeof (client as any)['vault.daily']).toBe('function');
  });
});

describe('GatewayClient runtime health RPC wrapper', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('requests runtime.health with the typed response shape', async () => {
    const healthPromise = client.runtimeHealth();
    const healthReq = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };

    expect(healthReq.method).toBe('runtime.health');
    expect(healthReq.params).toEqual({});

    conn._emit({
      jsonrpc: '2.0',
      id: healthReq.id,
      result: {
        checkedAt: 1_701_234_567_890,
        services: [
          {
            serviceId: 'gateway',
            status: 'healthy',
            detail: 'Gateway ready.',
            checkedAt: 1_701_234_567_890,
          },
        ],
      },
    });

    await expect(healthPromise).resolves.toEqual({
      checkedAt: 1_701_234_567_890,
      services: [
        {
          serviceId: 'gateway',
          status: 'healthy',
          detail: 'Gateway ready.',
          checkedAt: 1_701_234_567_890,
        },
      ],
    });
  });
});

describe('GatewayClient beads RPC wrappers', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('routes beads methods with typed payloads', async () => {
    const readyPromise = client.beadsReady({ actor: 'agent' });
    const readyReq = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };
    expect(readyReq.method).toBe('beads.ready');
    expect(readyReq.params).toEqual({ actor: 'agent' });
    conn._emit({
      jsonrpc: '2.0',
      id: readyReq.id,
      result: {
        actor: 'agent',
        action: 'ready',
        target: 'ready',
        result: 'success',
        payload: [{ id: 'PSFN-1' }],
      },
    });
    await expect(readyPromise).resolves.toMatchObject({ action: 'ready' });

    const createPromise = client.beadsCreate({
      title: 'New issue',
      issueType: 'task',
      priority: 2,
      actor: 'agent',
    });
    const createReq = conn.sent[1] as { id: number; method: string; params: Record<string, unknown> };
    expect(createReq.method).toBe('beads.create');
    expect(createReq.params).toEqual({
      title: 'New issue',
      issueType: 'task',
      priority: 2,
      actor: 'agent',
    });
    conn._emit({
      jsonrpc: '2.0',
      id: createReq.id,
      result: {
        actor: 'agent',
        action: 'create',
        target: 'new',
        result: 'success',
        payload: { id: 'PSFN-2' },
      },
    });
    await expect(createPromise).resolves.toMatchObject({ action: 'create' });

    const closePromise = client.beadsClose({
      id: 'PSFN-2',
      reason: 'done',
    });
    const closeReq = conn.sent[2] as { id: number; method: string; params: Record<string, unknown> };
    expect(closeReq.method).toBe('beads.close');
    expect(closeReq.params).toEqual({ id: 'PSFN-2', reason: 'done' });
    conn._emit({
      jsonrpc: '2.0',
      id: closeReq.id,
      result: {
        actor: 'runtime-agent',
        action: 'close',
        target: 'PSFN-2',
        result: 'success',
        payload: { closed: true },
      },
    });
    await expect(closePromise).resolves.toMatchObject({ action: 'close' });
  });
});

describe('GatewayClient keepalive', () => {
  it('emits lightweight keepalive RPC frames while idle', async () => {
    vi.useFakeTimers();
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, { keepaliveIntervalMs: 1_000 });

    try {
      expect(conn.sent).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(conn.sent).toHaveLength(1);

      const keepaliveReq = conn.sent[0] as { id: number; method: string; params: Record<string, unknown> };
      expect(keepaliveReq.method).toBe('discord.typing');
      expect(keepaliveReq.params).toEqual({ channelId: 'internal:gateway-keepalive' });

      conn._emit({
        jsonrpc: '2.0',
        id: keepaliveReq.id,
        result: { success: true },
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(conn.sent).toHaveLength(2);
      const secondKeepaliveReq = conn.sent[1] as { method: string };
      expect(secondKeepaliveReq.method).toBe('discord.typing');
    } finally {
      client.destroy();
      vi.useRealTimers();
    }
  });

  it('stops keepalive emissions after destroy', async () => {
    vi.useFakeTimers();
    const conn = createMockConnection();
    const client = new GatewayClient(conn.conn, 1024, { keepaliveIntervalMs: 500 });

    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(conn.sent).toHaveLength(1);

      const keepaliveReq = conn.sent[0] as { id: number };
      conn._emit({
        jsonrpc: '2.0',
        id: keepaliveReq.id,
        result: { success: true },
      });

      client.destroy();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(conn.sent).toHaveLength(1);
    } finally {
      client.destroy();
      vi.useRealTimers();
    }
  });
});

describe('GatewayClient connection lifecycle', () => {
  let conn: ReturnType<typeof createMockConnection>;
  let client: GatewayClient;

  beforeEach(() => {
    conn = createMockConnection();
    client = new GatewayClient(conn.conn, 1024);
  });

  it('emits disconnect once when the gateway connection closes', () => {
    const handler = vi.fn();
    client.onDisconnect(handler);

    conn._emitClose();
    conn._emitError(new Error('late error'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ source: 'close' });
  });
});
