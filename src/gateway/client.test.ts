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
  };

  return { conn: conn as unknown as NdjsonConnection, sent, _emit: conn._emit };
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
  });

  it('handles backward-compat chunks with missing requestId', async () => {
    const chunks: string[] = [];

    const streamPromise = client.stream(
      { systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] },
      { onText: (text) => chunks.push(text) },
    );

    const req = conn.sent[0] as { id: number; params: { requestId: string } };

    // Simulate a legacy gateway sending chunks without requestId
    conn._emit({ method: 'llm.chunk', params: { requestId: '0', text: 'legacy-chunk' } });

    // Resolve the stream
    conn._emit({
      id: req.id,
      jsonrpc: '2.0',
      result: {
        content: 'legacy-chunk',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      },
    });

    const result = await streamPromise;
    // Backward compat: '0' falls back to any available handler
    expect(chunks).toEqual(['legacy-chunk']);
    expect(result.content).toBe('legacy-chunk');
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
