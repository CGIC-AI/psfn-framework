import { setTimeout as realDelay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as net from 'node:net';
import { WebSocket } from 'ws';
import { createGatewayRpcTlsFixture, loadRawWebSocketTlsOptions } from './__tests__/transport-tls.js';
import { GATEWAY_RPC_WS_PROTOCOL } from './transport.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import { GatewayServer } from './server.js';
import { deriveCompanionAuthToken } from './companion-auth.js';
import type { GatewayAuditStorePort } from './audit-port.js';
import { EventBus } from '../../shared/event-bus.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { testShadowIntakeScreening } from '../../test-support/intake-screening.js';

const A = createCompanionId('11111111-1111-4111-8111-111111111111');
const KEYRING = { activeVersion: 'v1', keys: { v1: 'invented-test-session-secret' } };

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function harness(kind: 'unix' | 'wss', embedBatch: () => Promise<number[][]>, fleetCompanionIds?: ReturnType<typeof createCompanionId>[]) {
  const socketPath = join(tmpdir(), `psfn-frame-admission-${randomUUID()}.sock`);
  const fixture = kind === 'wss' ? createGatewayRpcTlsFixture() : undefined;
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const url = `wss://localhost:${port}/rpc`;
  const auditRecords: unknown[] = [];
  const auditStore: GatewayAuditStorePort = {
    append: async entry => { auditRecords.push(structuredClone(entry)); return auditRecords.length; },
    complete: async (id, duration, error) => { auditRecords.push({ id, duration, error }); },
    recordSummary: async () => 1,
    createSummaryHook: () => async () => undefined,
    enforceRotation: async () => undefined,
    getRecent: async () => [],
    getByMethod: async () => [],
    getApprovalEvents: async () => [],
    count: async () => 0,
  };
  const server = new GatewayServer({
    socketPath,
    ...(fixture ? { gatewayRpcEndpoint: { kind: 'wss' as const, host: '127.0.0.1', port, path: '/rpc', url, tls: fixture.serverTls } } : {}),
    companionId: A,
    llmProvider: fromAny({ stream: vi.fn(), complete: vi.fn() }),
    embeddingService: fromAny({ embed: vi.fn(), embedBatch, dims: 8 }),
    discordAdapter: fromAny({ id: 'discord', outbound: { textChunkLimit: 2000, sendText: vi.fn() } }),
    policyConfig: { workspacePath: '/workspace' },
    sessionHmacKeyring: KEYRING,
    wyomingShardRouting: { enabled: false },
    eventBus: new EventBus(),
    auditStore,
    intakeScreeningMode: 'shadow',
    ...(fleetCompanionIds ? {
      intakeScreeningProvider: testShadowIntakeScreening,
      visionIntakeProvider: () => null,
      multiCompanion: {
        enabled: true,
        fleetCompanionIds,
        channelRouting: {}, discordAccounts: {}, pluginAccounts: {},
        personalWorkspaceByCompanionId: Object.fromEntries(fleetCompanionIds.map(id => [id, `/workspace/${id}`])),
      },
    } : { intakeScreening: testShadowIntakeScreening() }),
  });
  const peers: Array<net.Socket | WebSocket> = [];
  server.start();
  return {
    auditRecords,
    server,
    async open(companionId = A) {
      const peer = fixture
        ? new WebSocket(url, GATEWAY_RPC_WS_PROTOCOL, loadRawWebSocketTlsOptions(fixture.clientTls))
        : net.createConnection(socketPath);
      peers.push(peer);
      peer.on('error', () => undefined);
      const frames: Array<Record<string, unknown>> = [];
      let partial = '';
      if (peer instanceof WebSocket) {
        peer.on('message', data => frames.push(JSON.parse(data.toString())));
      } else {
        peer.on('data', chunk => {
          partial += chunk.toString();
          const lines = partial.split('\n');
          partial = lines.pop()!;
          for (const line of lines) if (line) frames.push(JSON.parse(line));
        });
      }
      await once(peer, fixture ? 'open' : 'connect');
      return {
        frames,
        pause() { peer.pause(); },
        resume() { peer.resume(); },
        write(text: string) { if (peer instanceof WebSocket) peer.send(text.trimEnd()); else peer.write(text); },
        get destroyed() { return peer instanceof WebSocket ? peer.readyState === WebSocket.CLOSED : peer.destroyed; },
        destroy() { if (peer instanceof WebSocket) peer.terminate(); else peer.destroy(); },
        async ready() {
          identify(this, companionId);
          await waitFor(() => frames.some(frame => frame.id === 1));
          expect(frames.find(frame => frame.id === 1)?.result).toMatchObject({ success: true });
          if (fleetCompanionIds) {
            this.write('{"jsonrpc":"2.0","id":0,"method":"gateway.client.ready","params":{}}\n');
            await waitFor(() => frames.some(frame => frame.id === 0));
            expect(frames.find(frame => frame.id === 0)?.result).toMatchObject({ success: true });
          }
        },
      };
    },
    async close() {
      for (const peer of peers) { if (peer instanceof WebSocket) peer.terminate(); else peer.destroy(); }
      await server.stop();
      fixture?.cleanup();
    },
  };
}

function identify(peer: { write(text: string): void }, companionId = A, token = deriveCompanionAuthToken(companionId, 'agent', KEYRING), role = 'agent') {
  peer.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway.client.identify', params: {
    role, companionId, authToken: token,
  } }) + '\n');
}

describe.each(['unix', 'wss'] as const)('%s Gateway per-connection RPC flow control', kind => {
  it('bounds slow handlers and closes before dispatching the seventeenth retained request', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const embedBatch = vi.fn(async () => { await blocked; return [[1]]; });
    const app = await harness(kind, embedBatch);
    try {
      const peer = await app.open();
      await peer.ready();
      for (let id = 2; id < 18; id++) peer.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'llm.embed', params: { texts: ['work'] } }) + '\n');
      await waitFor(() => embedBatch.mock.calls.length >= 4);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(embedBatch).toHaveBeenCalledTimes(4);
      expect(peer.destroyed).toBe(false);
      peer.write('{"jsonrpc":"2.0","id":18,"method":"llm.embed","params":{"texts":["overflow"]}}\n');
      await waitFor(() => peer.destroyed);
      release();
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(embedBatch).toHaveBeenCalledTimes(4);
      const next = await app.open();
      await next.ready();
    } finally { release(); await app.close(); }
  });

  it.each([0, 1])('accounts raw multibyte UTF-8 at the exact byte budget plus %s', async excess => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const embedBatch = vi.fn(async () => { await blocked; return [[1]]; });
    const app = await harness(kind, embedBatch);
    const frame = (id: number, bytes: number) => {
      const value = { jsonrpc: '2.0', id, method: 'llm.embed', params: { texts: ['work'] }, padding: '' };
      const remaining = bytes - Buffer.byteLength(JSON.stringify(value));
      value.padding = '☃'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
      return JSON.stringify(value) + (kind === 'unix' ? '\n' : '');
    };
    try {
      const peer = await app.open();
      await peer.ready();
      peer.write(frame(2, 32 * 1024 * 1024));
      await waitFor(() => embedBatch.mock.calls.length === 1);
      peer.write(frame(3, 32 * 1024 * 1024 + excess));
      if (excess) {
        await waitFor(() => peer.destroyed);
        expect(embedBatch).toHaveBeenCalledTimes(1);
      } else {
        await waitFor(() => embedBatch.mock.calls.length === 2);
        expect(peer.destroyed).toBe(false);
        peer.write('{"jsonrpc":"2.0","id":4,"method":"llm.embed","params":{"texts":["overflow"]}}');
        if (kind === 'unix') peer.write('\n');
        await waitFor(() => peer.destroyed);
        expect(embedBatch).toHaveBeenCalledTimes(2);
      }
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      const next = await app.open();
      await next.ready();
    } finally { release(); await app.close(); }
  });

  it('drains accepted work after handler errors and keeps response/control traffic responsive', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const embedBatch = vi.fn(async () => { await blocked; throw new Error('invented-private-handler-sentinel'); });
    const app = await harness(kind, embedBatch);
    try {
      const peer = await app.open();
      await peer.ready();
      for (let id = 2; id < 18; id++) peer.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'llm.embed', params: { texts: ['work'] } }) + '\n');
      await waitFor(() => embedBatch.mock.calls.length === 4);
      // The shared capacity is full; free one charge before the reverse response.
      release();
      await waitFor(() => peer.frames.filter(frame => Number(frame.id) >= 2).length === 16);
      expect(embedBatch).toHaveBeenCalledTimes(16);
      const reverse = app.server.requestAgent('health.test', {});
      await waitFor(() => peer.frames.some(frame => frame.method === 'health.test'));
      const request = peer.frames.find(frame => frame.method === 'health.test')!;
      peer.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\n');
      await expect(reverse).resolves.toEqual({ ok: true });
      expect(peer.destroyed).toBe(false);
    } finally { release(); await app.close(); }
  });

  it('routes a reverse response while all request workers are blocked and drops queued notifications on close', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const embedBatch = vi.fn(async () => { await blocked; return [[1]]; });
    const app = await harness(kind, embedBatch);
    try {
      const peer = await app.open();
      await peer.ready();
      for (let id = 2; id < 18; id++) peer.write(JSON.stringify({ jsonrpc: '2.0', method: 'llm.embed', params: { texts: ['work'] } }) + '\n');
      await waitFor(() => embedBatch.mock.calls.length === 4);
      const reverse = app.server.requestAgent('health.test', {});
      await waitFor(() => peer.frames.some(frame => frame.method === 'health.test'));
      const request = peer.frames.find(frame => frame.method === 'health.test')!;
      peer.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\n');
      await expect(reverse).resolves.toEqual({ ok: true });
      peer.destroy();
      await waitFor(() => !app.server.isApiReady());
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(embedBatch).toHaveBeenCalledTimes(4);
      const next = await app.open();
      await next.ready();
    } finally { release(); await app.close(); }
  });


  it.each([false, true])('quarantines cancellation-ignoring work across reconnects, with cancellationId=%s', async cancellable => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const embedBatch = vi.fn(async () => { await blocked; return [[1]]; });
    const app = await harness(kind, embedBatch);
    try {
      // Each closed connection leaves 32 MiB of active work. The fifth must
      // fail closed against the independent 128 MiB global active-work ceiling.
      for (let cycle = 0; cycle < 5; cycle++) {
        const peer = await app.open();
        await peer.ready();
        const cancellationIds: string[] = [];
        for (let id = 2; id < 6; id++) {
          const cancellationId = randomUUID();
          cancellationIds.push(cancellationId);
          const frame = { jsonrpc: '2.0', id, method: 'llm.embed', params: {
            texts: ['work'], ...(cancellable ? { cancellationId } : {}),
          }, padding: '' };
          frame.padding = 'x'.repeat(8 * 1024 * 1024 - 1024 - Buffer.byteLength(JSON.stringify(frame)));
          peer.write(JSON.stringify(frame) + '\n');
        }
        if (cycle < 4) {
          await waitFor(() => embedBatch.mock.calls.length === (cycle + 1) * 4);
          if (cancellable) {
            for (let index = 0; index < 4; index++) {
              peer.write(JSON.stringify({ jsonrpc: '2.0', id: 100 + index, method: 'llm.cancel', params: { cancellationId: cancellationIds[index] } }) + '\n');
              // Both the cancellation acknowledgement and original RPC error
              // arrive while its abort-ignoring provider remains blocked.
              await waitFor(() => peer.frames.some(frame => frame.id === 100 + index)
                && peer.frames.some(frame => frame.id === 2 + index && frame.error));
            }
          }
          peer.destroy();
          await waitFor(() => !app.server.isApiReady());
        } else {
          await waitFor(() => peer.destroyed);
          expect(embedBatch).toHaveBeenCalledTimes(16);
        }
      }
      await Promise.race([app.server.stop(), realDelay(500).then(() => { throw new Error('Shutdown did not settle'); })]);
      app.server.start();
      const quarantined = await app.open();
      await quarantined.ready();
      const retry = { jsonrpc: '2.0', id: 2, method: 'llm.embed', params: { texts: ['still blocked'] }, padding: 'x'.repeat(8 * 1024 * 1024) };
      quarantined.write(JSON.stringify(retry) + '\n');
      await waitFor(() => quarantined.destroyed);
      expect(embedBatch).toHaveBeenCalledTimes(16);
      release();
      await realDelay(40);
      const next = await app.open();
      await next.ready();
      next.write('{"jsonrpc":"2.0","id":2,"method":"llm.embed","params":{"texts":["recovered"]}}\n');
      await waitFor(() => next.frames.some(frame => frame.id === 2));
      expect(embedBatch).toHaveBeenCalledTimes(17);
    } finally { release(); await app.close(); }
  });

  it('expires active work, releases timers, and keeps shutdown bounded for abort-ignoring handlers', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const embedBatch = vi.fn(async () => { await blocked; return [[1]]; });
    const app = await harness(kind, embedBatch);
    try {
      const peer = await app.open();
      await peer.ready();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      for (let id = 2; id < 18; id++) peer.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'llm.embed', params: { texts: ['work'] } }) + '\n');
      await realDelay(40);
      expect(embedBatch).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      await waitFor(() => peer.destroyed);
      await Promise.race([app.server.stop(), realDelay(500).then(() => { throw new Error('Shutdown did not settle'); })]);
      release();
      await realDelay(20);
      expect(embedBatch).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); release(); await app.close(); }
  });


  it.each(['responses', 'notifications'])('closes an authenticated non-reading peer under %s pressure and recovers', async pressure => {
    const app = await harness(kind, async () => [[1]]);
    try {
      const peer = await app.open();
      await peer.ready();
      peer.pause();
      const payload = '☃'.repeat(350_000);
      let attempts = 0;
      while (attempts < 90 && app.server.isApiReady()) {
        if (pressure === 'responses') {
          peer.write(JSON.stringify({ jsonrpc: '2.0', id: payload, method: 'unknown.test' }) + '\n');
          await realDelay(5);
        } else {
          app.server.notifyAll('notification.test', { payload });
        }
        attempts++;
      }
      await waitFor(() => !app.server.isApiReady());
      expect(attempts).toBeLessThan(90);
      peer.resume();
      await waitFor(() => peer.destroyed);
      const next = await app.open();
      await next.ready();
    } finally { await app.close(); }
  });


  it('bounds aggregate queued bytes across authenticated connections before starting queued handlers', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const embedBatch = vi.fn(async () => { await blocked; return [[1]]; });
    const fleet = [A, createCompanionId('22222222-2222-4222-8222-222222222222'), createCompanionId('33333333-3333-4333-8333-333333333333')];
    const app = await harness(kind, embedBatch, fleet);
    const peers: Array<Awaited<ReturnType<typeof app.open>>> = [];
    const request = (id: number, bytes?: number) => {
      const frame = { jsonrpc: '2.0', id, method: 'llm.embed', params: { texts: ['work'] }, padding: '' };
      if (bytes) frame.padding = '☃'.repeat(Math.floor((bytes - Buffer.byteLength(JSON.stringify(frame))) / 3));
      return JSON.stringify(frame) + '\n';
    };
    const barrier = async (index: number) => {
      const peer = peers[index]!;
      const before = peer.frames.length;
      const reverse = app.server.requestCompanionAgent(fleet[index]!, 'health.test', {});
      await waitFor(() => peer.frames.slice(before).some(frame => frame.method === 'health.test'));
      const frame = peer.frames.slice(before).find(frame => frame.method === 'health.test')!;
      peer.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } }) + '\n');
      await expect(reverse).resolves.toEqual({ ok: true });
    };
    try {
      for (const companionId of fleet) {
        const peer = await app.open(companionId);
        await peer.ready();
        peers.push(peer);
        for (let id = 2; id < 6; id++) peer.write(request(id));
      }
      await waitFor(() => embedBatch.mock.calls.length === 12);
      // 48 + 48 + 24 MiB stays below the independent global 128 MiB ceiling.
      // Reverse responses are ordered barriers behind the queued frames.
      for (let index = 0; index < 3; index++) {
        peers[index]!.write(request(6, 24 * 1024 * 1024));
        if (index < 2) peers[index]!.write(request(7, 24 * 1024 * 1024));
        await barrier(index);
      }
      expect(peers.every(peer => !peer.destroyed)).toBe(true);
      peers[2]!.write(request(7, 24 * 1024 * 1024));
      await waitFor(() => peers[2]!.destroyed);
      expect(peers.slice(0, 2).every(peer => !peer.destroyed)).toBe(true);
      expect(embedBatch).toHaveBeenCalledTimes(12);
      // Closing the overflowing connection releases its queued 24 MiB, while
      // its four abort-ignoring active operations keep their own charges.
      const replacement = await app.open(fleet[2]);
      await replacement.ready();
      peers[2] = replacement;
      for (let id = 2; id < 6; id++) replacement.write(request(id));
      await waitFor(() => embedBatch.mock.calls.length === 16);
      replacement.write(request(6, 24 * 1024 * 1024));
      await barrier(2);
      replacement.write(request(7, 24 * 1024 * 1024));
      await waitFor(() => replacement.destroyed);
      expect(embedBatch).toHaveBeenCalledTimes(16);
    } finally { release(); await app.close(); }
  });

  it('bounds aggregate queued frame counts and releases queued slots without freeing active work', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const embedBatch = vi.fn(async () => { await blocked; return [[1]]; });
    const fleet = [A, ...Array.from({ length: 16 }, (_, index) => createCompanionId(`${String(index + 2).padStart(8, '0')}-2222-4222-8222-222222222222`))];
    const app = await harness(kind, embedBatch, fleet);
    const peers: Array<Awaited<ReturnType<typeof app.open>>> = [];
    const request = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'llm.embed', params: { texts: ['work'] } }) + '\n';
    try {
      for (const companionId of fleet) {
        const peer = await app.open(companionId);
        await peer.ready();
        peers.push(peer);
      }
      for (let index = 0; index < 16; index++) {
        for (let id = 2; id < 18; id++) peers[index]!.write(request(id));
        await waitFor(() => embedBatch.mock.calls.length === (index + 1) * 4);
      }
      await realDelay(20);
      expect(peers.every(peer => !peer.destroyed)).toBe(true);
      // 16 connections x 16 retained requests fills exactly 256 global slots.
      peers[16]!.write(request(2));
      await waitFor(() => peers[16]!.destroyed);
      expect(embedBatch).toHaveBeenCalledTimes(64);
      peers[0]!.destroy();
      await waitFor(() => app.server.getFleetConnectionSnapshot().connections.length === 15);
      const replacement = await app.open(fleet[0]);
      await replacement.ready();
      // Twelve queued slots were released; the four active charges survived.
      for (let id = 2; id < 14; id++) replacement.write(request(id));
      await waitFor(() => embedBatch.mock.calls.length === 68);
      await realDelay(20);
      expect(replacement.destroyed).toBe(false);
      replacement.write(request(14));
      await waitFor(() => replacement.destroyed);
      expect(embedBatch).toHaveBeenCalledTimes(68);
    } finally { release(); await app.close(); }
  });

});
