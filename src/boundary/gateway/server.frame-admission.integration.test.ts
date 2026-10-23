import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as net from 'node:net';
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
import { logger } from '../../shared/logger.js';

const A = createCompanionId('11111111-1111-4111-8111-111111111111');
const B = createCompanionId('22222222-2222-4222-8222-222222222222');
const KEYRING = { activeVersion: 'v1', keys: { v1: 'invented-test-session-secret' } };

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function harness(multi = false) {
  const socketPath = join(tmpdir(), `psfn-frame-admission-${randomUUID()}.sock`);
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
    companionId: A,
    llmProvider: fromAny({ stream: vi.fn(), complete: vi.fn() }),
    embeddingService: fromAny({ embed: vi.fn(), embedBatch: vi.fn(), dims: 8 }),
    discordAdapter: fromAny({ id: 'discord', outbound: { textChunkLimit: 2000, sendText: vi.fn() } }),
    policyConfig: { workspacePath: '/workspace' },
    sessionHmacKeyring: KEYRING,
    wyomingShardRouting: { enabled: false },
    eventBus: new EventBus(),
    auditStore,
    intakeScreeningMode: 'shadow',
    ...(multi ? {
      intakeScreeningProvider: testShadowIntakeScreening,
      visionIntakeProvider: () => null,
      multiCompanion: {
        enabled: true,
        fleetCompanionIds: [A, B],
        channelRouting: {}, discordAccounts: {}, pluginAccounts: {},
        personalWorkspaceByCompanionId: { [A]: '/workspace/a', [B]: '/workspace/b' },
      },
    } : { intakeScreening: testShadowIntakeScreening() }),
  });
  const peers: net.Socket[] = [];
  server.start();
  return {
    auditRecords,
    async open() {
      const peer = net.createConnection(socketPath);
      peers.push(peer);
      peer.on('error', () => undefined);
      await once(peer, 'connect');
      return peer;
    },
    async close() {
      for (const peer of peers) peer.destroy();
      await server.stop();
    },
  };
}

function identify(peer: net.Socket, companionId = A, token = deriveCompanionAuthToken(companionId, 'agent', KEYRING), role = 'agent') {
  peer.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway.client.identify', params: {
    role, companionId, authToken: token,
  } }) + '\n');
}

describe('Gateway frame admission at real socket and audit boundaries', () => {
  it.each([false, true])('caps simultaneous partial-frame peers in multi=%s and releases slots on close', async multi => {
    const app = await harness(multi);
    try {
      const first = await app.open();
      const second = await app.open();
      first.write(Buffer.alloc(1024 * 1024, 'x'));
      second.write(Buffer.alloc(1024 * 1024, 'x'));
      const excess = await app.open();
      await waitFor(() => excess.destroyed);
      expect(first.destroyed).toBe(false);
      first.destroy();
      await new Promise(resolve => setTimeout(resolve, 10));
      const next = await app.open();
      const response = once(next, 'data');
      if (multi) identify(next);
      else next.write('{"jsonrpc":"2.0","id":1,"method":"unknown.test"}\n');
      expect(JSON.parse((await response)[0].toString()).id).toBe(1);
    } finally { await app.close(); }
  });

  it.each([false, true])('closes stalled first frames/identity by the fixed deadline in multi=%s and recovers', async multi => {
    const app = await harness(multi);
    try {
      const first = await app.open();
      const second = await app.open();
      first.write('{"partial":"');
      if (multi) second.write('{"jsonrpc":"2.0","id":1,"method":"unknown.test"}\n');
      second.write('{"partial":"');
      first.resume();
      second.resume();
      await waitFor(() => first.destroyed && second.destroyed, 6000);
      const next = await app.open();
      const response = once(next, 'data');
      if (multi) identify(next);
      else next.write('{"jsonrpc":"2.0","id":1,"method":"unknown.test"}\n');
      expect(JSON.parse((await response)[0].toString()).id).toBe(1);
    } finally { await app.close(); }
  });

  it('reserves separate persistent roles and caps total single-companion sockets at four', async () => {
    const app = await harness();
    try {
      const agent = await app.open();
      const agentResponse = once(agent, 'data');
      agent.write('{"jsonrpc":"2.0","id":1,"method":"unknown.test"}\n');
      await agentResponse;
      const worker = await app.open();
      const workerResponse = once(worker, 'data');
      identify(worker, A, deriveCompanionAuthToken(A, 'internal_session_integrity', KEYRING), 'internal_session_integrity');
      await workerResponse;
      const pending = [await app.open(), await app.open()];
      for (const peer of pending) peer.write('{"partial":"');
      const excess = await app.open();
      await waitFor(() => excess.destroyed);
      expect(agent.destroyed).toBe(false);
      expect(worker.destroyed).toBe(false);
      expect(pending.every(peer => !peer.destroyed)).toBe(true);
    } finally { await app.close(); }
  });

  it('rejects a duplicate worker and prevents agent proof from occupying the worker slot', async () => {
    const app = await harness(true);
    try {
      const agent = await app.open();
      const ready = once(agent, 'data');
      identify(agent);
      await ready;
      const bad = await app.open();
      bad.resume();
      identify(bad, A, deriveCompanionAuthToken(A, 'agent', KEYRING), 'internal_session_integrity');
      await waitFor(() => bad.destroyed);
      const worker = await app.open();
      const workerReady = once(worker, 'data');
      identify(worker, A, deriveCompanionAuthToken(A, 'internal_session_integrity', KEYRING), 'internal_session_integrity');
      await workerReady;
      const duplicate = await app.open();
      const received: Buffer[] = [];
      duplicate.on('data', chunk => received.push(chunk));
      duplicate.resume();
      duplicate.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway.client.identify', params: {
        role: 'internal_session_integrity', companionId: A,
        authToken: deriveCompanionAuthToken(A, 'internal_session_integrity', KEYRING),
      } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session.hmac.sign', params: {
        entry: { type: 'message', id: 1, role: 'user', content: 'invented', timestamp: 1 }, previousHmac: null,
      } }) + '\n');
      await waitFor(() => duplicate.destroyed);
      expect(Buffer.concat(received).toString()).not.toContain('"id":2');
      expect(agent.destroyed).toBe(false);
      expect(worker.destroyed).toBe(false);
    } finally { await app.close(); }
  });

  it('releases pending charges after overflow and malformed frames and recovers', async () => {
    const app = await harness();
    try {
      const overflow = await app.open();
      const malformed = await app.open();
      overflow.resume();
      malformed.resume();
      malformed.write('{bad\n');
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      for (let index = 0; index < 64 && !overflow.destroyed; index += 1) {
        if (!overflow.write(chunk)) await once(overflow, 'drain');
      }
      overflow.write('x');
      await waitFor(() => overflow.destroyed && malformed.destroyed);
      const healthy = await app.open();
      const response = once(healthy, 'data');
      healthy.write('{"jsonrpc":"2.0","id":1,"method":"unknown.test"}\n');
      await response;
      expect(JSON.stringify(app.auditRecords)).not.toContain('preview');
    } finally { await app.close(); }
  });

  it('closes failed and duplicate identify peers while preserving the existing identity', async () => {
    const app = await harness(true);
    try {
      const primary = await app.open();
      const identified = once(primary, 'data');
      identify(primary);
      await identified;
      for (const token of ['invalid-token', deriveCompanionAuthToken(A, 'agent', KEYRING)]) {
        const peer = await app.open();
        peer.resume();
        identify(peer, A, token);
        await waitFor(() => peer.destroyed);
        expect(primary.destroyed).toBe(false);
      }
    } finally { await app.close(); }
  });

  it.each(['jsonrpc', 'ndjson'])('never persists %s payload sentinels in the actual audit sink', async kind => {
    const app = await harness();
    const marker = 'invented-private-audit-sentinel';
    const logs: unknown[] = [];
    const capture = (entry: { component?: string }): void => {
      if (entry.component === 'Gateway' || entry.component === 'Transport') logs.push(entry);
    };
    logger.on('data', capture);
    try {
      const peer = await app.open();
      peer.resume();
      peer.write(kind === 'jsonrpc'
        ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 42, params: { secret: marker } }) + '\n'
        : `{"secret":"${marker}"\n`);
      await waitFor(() => peer.destroyed && app.auditRecords.length >= 2);
      expect(JSON.stringify(app.auditRecords)).not.toContain(marker);
      expect(JSON.stringify(app.auditRecords)).not.toContain('preview');
      expect(JSON.stringify(logs)).not.toContain(marker);
    } finally {
      logger.removeListener('data', capture);
      await app.close();
    }
  });
});
