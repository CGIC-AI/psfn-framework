// Operator rule: no channel may ever take anything else down. These tests run
// external adapters inside the real plugin host and isolation supervisor, next
// to a sibling channel, and drive them over real HTTP with bridges that throw,
// hang, flood, stall, disconnect, or send garbage.

import { request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticCredentialVault } from '../../boundary/custody/credential-vault.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  ChannelSurfaceSupervisor,
  type ChannelSurfaceFailure,
} from '../backplane/channel-isolation.js';
import type { ChannelAdapterPort, MessageHandler } from '../backplane/types.js';
import { ChannelPluginHost, type ChannelPluginMessageWiring } from '../plugins/host.js';
import { parseChannelPluginSections } from '../plugins/load-sections.js';
import { createChannelPluginRegistry } from '../plugins/registry.js';
import type { ChannelPlugin } from '../plugins/types.js';
import {
  EXTERNAL_CHANNEL_TEST_COMPANION_ID,
  EXTERNAL_CHANNEL_TEST_LIMITS,
  closeServer,
  listenExternalChannelRoute,
} from '../../test-support/external-channel-conformance.js';
import { ExternalChannelAdapter } from './adapter.js';
import { ExternalChannelMcpRoute, externalChannelEndpointPath } from './mcp-route.js';
import { createExternalChannelPlugin, listExternalChannelAdapters } from './plugin.js';
import { ReferenceExternalChannelBridge } from './reference-bridge.js';

const TOKENS: Record<string, string> = {
  EXT_A_TOKEN: 'token-for-bridge-a',
  EXT_B_TOKEN: 'token-for-bridge-b',
};

function adapterEntry(id: string) {
  return {
    id,
    label: `Bridge ${id}`,
    companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
    tokenRef: { kind: 'env', envName: `EXT_${id.toUpperCase()}_TOKEN` },
  };
}

interface Sibling {
  plugin: ChannelPlugin;
  started: () => boolean;
  deliver: (text: string) => Promise<AgentResponse>;
}

/** A plain in-process channel that must keep working whatever the bridges do. */
function createSibling(): Sibling {
  let handler: MessageHandler | undefined;
  let started = false;
  const adapter: ChannelAdapterPort = {
    id: 'sibling',
    name: 'sibling',
    meta: { label: 'Sibling' },
    capabilities: { chatTypes: ['direct'], media: false, reactions: false, threads: false, streaming: false },
    config: { enabled: true },
    outbound: { textChunkLimit: 100, sendText: async () => undefined },
    gateway: { init: async () => undefined, start: async () => undefined, stop: async () => undefined },
    init: async () => undefined,
    start: async () => { started = true; },
    stop: async () => { started = false; },
    onMessage: (next) => { handler = next; },
  };
  return {
    plugin: {
      manifest: { id: 'sibling', label: 'Sibling' },
      parseConfig: () => ({ config: {}, enabled: true, credentials: [] }),
      create: () => ({ adapter }),
    },
    started: () => started,
    deliver: async (text) => {
      if (!handler) throw new Error('sibling not wired');
      return await handler({
        id: `sibling-${text}`,
        channelId: 'sibling:room',
        channelType: 'api',
        authorId: 'u',
        authorName: 'U',
        content: text,
        timestamp: new Date(),
      });
    },
  };
}

type Behavior = (message: SubstrateMessage, signal?: AbortSignal) => Promise<string>;

interface Rig {
  host: ChannelPluginHost;
  supervisor: ChannelSurfaceSupervisor;
  failures: ChannelSurfaceFailure[];
  sibling: Sibling;
  behaviors: Record<string, Behavior>;
  server?: Server;
  baseUrl?: string;
}

const rigs: Rig[] = [];
const bridges: ReferenceExternalChannelBridge[] = [];

async function startRig(options: {
  adapters: string[];
  tokens?: Record<string, string>;
  serve?: boolean;
}): Promise<Rig> {
  const failures: ChannelSurfaceFailure[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const supervisor = new ChannelSurfaceSupervisor({
    log,
    retry: { baseDelayMs: 10, maxDelayMs: 40, maxAttempts: 0 },
    isRetryable: () => false,
    report: (failure) => { failures.push(failure); },
  });
  const sibling = createSibling();
  const registry = createChannelPluginRegistry([createExternalChannelPlugin(), sibling.plugin]);
  const sections = parseChannelPluginSections({
    external: {
      enabled: true,
      limits: EXTERNAL_CHANNEL_TEST_LIMITS,
      adapters: options.adapters.map(adapterEntry),
    },
    sibling: {},
  }, registry);
  const host = await ChannelPluginHost.load({
    registry,
    sections,
    vault: createStaticCredentialVault(options.tokens ?? TOKENS),
    supervisor,
    contextFor: () => ({ log, shutdownTimeoutMs: 1_000, intakeScreening: null }),
  });
  const behaviors: Record<string, Behavior> = {};
  const wiring: ChannelPluginMessageWiring = {
    requestAgentVoiceStream: async (message, requestOptions) => {
      const accountId = requestOptions?.channelAccountRoute?.accountId ?? 'sibling';
      const behave = behaviors[accountId] ?? (async (inbound: SubstrateMessage) => `ok: ${inbound.content}`);
      const content = await behave(message, requestOptions?.signal);
      return { content, channelId: message.channelId, model: 'scripted', durationMs: 1 };
    },
    notifyOperator: async () => undefined,
  };
  host.wireMessages(wiring);
  const rig: Rig = { host, supervisor, failures, sibling, behaviors };
  if (options.serve !== false) {
    const route = new ExternalChannelMcpRoute(listExternalChannelAdapters(host), ['ordinary-api-key']);
    const listening = await listenExternalChannelRoute(route);
    rig.server = listening.server;
    rig.baseUrl = listening.baseUrl;
  }
  await host.initialize();
  await host.start();
  rigs.push(rig);
  return rig;
}

async function connect(rig: Rig, instanceId: string, token = TOKENS[`EXT_${instanceId.toUpperCase()}_TOKEN`]!) {
  const bridge = new ReferenceExternalChannelBridge({
    endpoint: new URL(`${rig.baseUrl}${externalChannelEndpointPath(instanceId)}`),
    token,
    name: `bridge-${instanceId}`,
    version: '1.0.0',
    callTimeoutMs: 5_000,
  });
  bridges.push(bridge);
  await bridge.connect();
  return bridge;
}

let sequence = 0;
function message(text: string) {
  sequence += 1;
  return {
    id: `msg-${sequence}`,
    conversationId: 'conv',
    conversationKind: 'direct' as const,
    senderId: 'user',
    senderName: 'User',
    text,
  };
}

function runningIds(rig: Rig): string[] {
  return rig.host.listRunning().map(entry => entry.id).sort();
}

async function assertSiblingHealthy(rig: Rig): Promise<void> {
  expect(rig.sibling.started()).toBe(true);
  expect((await rig.sibling.deliver('ping')).content).toBe('ok: ping');
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  for (const rig of rigs.splice(0)) {
    await rig.host.stop();
    if (rig.server) await closeServer(rig.server);
  }
});

describe('external channel isolation', () => {
  it('a hanging companion turn times out for that bridge while the other bridge and sibling answer', async () => {
    const rig = await startRig({ adapters: ['a', 'b'] });
    rig.behaviors.a = () => new Promise<string>(() => undefined);
    const [a, b] = await Promise.all([connect(rig, 'a'), connect(rig, 'b')]);
    const [hung, answered] = await Promise.all([
      a.deliverInbound(message('are you there?')),
      b.deliverInbound(message('hello b')),
    ]);
    expect(answered).toEqual({ status: 'replied', reply: { conversationId: 'conv', text: 'ok: hello b' } });
    expect(hung).toMatchObject({ status: 'rejected', reason: 'turn_timeout' });
    expect(runningIds(rig)).toEqual(['external:a', 'external:b', 'sibling']);
    expect(rig.failures.some(failure => failure.surfaceId === 'external:a' && !failure.terminal)).toBe(true);
    expect(rig.failures.every(failure => failure.surfaceId === 'external:a')).toBe(true);
    await assertSiblingHealthy(rig);
  });

  it('a flooding bridge is refused as busy beyond its in-flight bound; others are unaffected', async () => {
    const rig = await startRig({ adapters: ['a', 'b'] });
    rig.behaviors.a = () => new Promise<string>(() => undefined);
    const [a, b] = await Promise.all([connect(rig, 'a'), connect(rig, 'b')]);
    const flood = Array.from({ length: 6 }, (_, index) => a.deliverInbound(message(`flood ${index}`)));
    const answered = await b.deliverInbound(message('still here'));
    const results = await Promise.all(flood);
    const reasons = results.map(result => (result.status === 'rejected' ? result.reason : result.status));
    expect(reasons.filter(reason => reason === 'busy')).toHaveLength(6 - EXTERNAL_CHANNEL_TEST_LIMITS.maxInFlightTurns);
    expect(reasons.filter(reason => reason === 'turn_timeout')).toHaveLength(EXTERNAL_CHANNEL_TEST_LIMITS.maxInFlightTurns);
    expect(answered.status).toBe('replied');
    expect(runningIds(rig)).toEqual(['external:a', 'external:b', 'sibling']);
    await assertSiblingHealthy(rig);
  });

  it('a throwing companion turn becomes turn_failed and a degraded report, not a crash', async () => {
    const rig = await startRig({ adapters: ['a', 'b'] });
    rig.behaviors.a = async () => { throw new Error('agent exploded'); };
    const [a, b] = await Promise.all([connect(rig, 'a'), connect(rig, 'b')]);
    expect(await a.deliverInbound(message('boom'))).toMatchObject({ status: 'rejected', reason: 'turn_failed' });
    expect(await b.deliverInbound(message('fine'))).toMatchObject({ status: 'replied' });
    expect(rig.failures).toEqual([
      expect.objectContaining({ surfaceId: 'external:a', phase: 'runtime', terminal: false }),
    ]);
    expect(runningIds(rig)).toEqual(['external:a', 'external:b', 'sibling']);
    await assertSiblingHealthy(rig);
  });

  it('garbage, oversized, stalled, unauthenticated, and wrong-version requests are answered and contained', async () => {
    const rig = await startRig({ adapters: ['a', 'b'] });
    const url = `${rig.baseUrl}${externalChannelEndpointPath('a')}`;
    const auth = { Authorization: `Bearer ${TOKENS.EXT_A_TOKEN}`, 'Content-Type': 'application/json' };
    const post = (body: string, headers: Record<string, string> = auth, target = url) =>
      fetch(target, { method: 'POST', headers: { Accept: 'application/json, text/event-stream', ...headers }, body });

    expect((await post('{not json')).status).toBe(400);
    expect((await post(JSON.stringify({ pad: 'x'.repeat(EXTERNAL_CHANNEL_TEST_LIMITS.maxRequestBytes) }))).status).toBe(413);
    expect((await post('{}', { 'Content-Type': 'application/json' })).status).toBe(401);
    expect((await post('{}', { ...auth, Authorization: 'Bearer ordinary-api-key' })).status).toBe(401);
    expect((await post('{}', { ...auth, Authorization: `Bearer ${TOKENS.EXT_B_TOKEN}` })).status).toBe(401);
    expect((await post('{}', auth, `${rig.baseUrl}${externalChannelEndpointPath('unknown')}`)).status).toBe(401);
    expect((await post('{}', { ...auth, Origin: 'https://example.test' })).status).toBe(403);
    expect((await fetch(url, { headers: auth })).status).toBe(405);

    const stalledStatus = await new Promise<number>((resolve, reject) => {
      const stalled = request(url, {
        method: 'POST',
        headers: { ...auth, 'Content-Length': '4096' },
      }, response => resolve(response.statusCode ?? 0));
      stalled.on('error', reject);
      stalled.write('{"jsonrpc":');
    });
    expect(stalledStatus).toBe(408);

    const a = await connect(rig, 'a');
    await expect(a.deliverInbound({ ...message('x'), conversationKind: 'broadcast' as never }))
      .rejects.toThrow('Adapter refused');
    const wrongVersion = await post(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'channel_hello', arguments: { protocolVersion: 2, bridge: { name: 'x', version: '1' } } },
    }));
    expect(await wrongVersion.text()).toContain('Unsupported external channel protocol version 2');

    const b = await connect(rig, 'b');
    expect(await b.deliverInbound(message('unbothered'))).toMatchObject({ status: 'replied' });
    await expect(a.deliverInbound(message('still usable'))).resolves.toMatchObject({ status: 'replied' });
    expect(runningIds(rig)).toEqual(['external:a', 'external:b', 'sibling']);
    expect(rig.failures.every(failure => failure.surfaceId === 'external:a' && !failure.terminal)).toBe(true);
    await assertSiblingHealthy(rig);
  });

  it('a bridge whose credential is missing is disabled alone at load', async () => {
    const rig = await startRig({ adapters: ['a', 'c'] });
    expect(rig.supervisor.stateOf('external:c')).toBe('disabled');
    expect(rig.failures).toEqual([
      expect.objectContaining({ surfaceId: 'external:c', phase: 'load', terminal: true }),
    ]);
    expect(runningIds(rig)).toEqual(['external:a', 'sibling']);
    const a = await connect(rig, 'a');
    expect(await a.deliverInbound(message('hi'))).toMatchObject({ status: 'replied' });
    await assertSiblingHealthy(rig);
  });

  it('without an API endpoint the bridges are disabled while the sibling runs', async () => {
    const rig = await startRig({ adapters: ['a'], serve: false });
    expect(rig.supervisor.stateOf('external:a')).toBe('disabled');
    expect(rig.failures[0]?.error.message).toContain('no served endpoint');
    expect(runningIds(rig)).toEqual(['sibling']);
    await assertSiblingHealthy(rig);
  });

  it('bridges sharing a credential value are both refused; the rest keep running', async () => {
    const rig = await startRig({
      adapters: ['a', 'b', 'd'],
      tokens: { ...TOKENS, EXT_D_TOKEN: TOKENS.EXT_B_TOKEN! },
    });
    expect(rig.supervisor.stateOf('external:b')).toBe('disabled');
    expect(rig.supervisor.stateOf('external:d')).toBe('disabled');
    expect(runningIds(rig)).toEqual(['external:a', 'sibling']);
    await assertSiblingHealthy(rig);
  });
});

describe('external bridge liveness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a silent bridge is reported degraded once per interval and recovers when it calls again', async () => {
    vi.useFakeTimers();
    const reports: unknown[] = [];
    const limits = { ...EXTERNAL_CHANNEL_TEST_LIMITS, heartbeatTimeoutMs: 1_000, failureReportIntervalMs: 5_000 };
    const adapter = new ExternalChannelAdapter({
      observer: { authorId: 'external-companion:test', displayName: 'Test Companion' },
      config: { instanceId: 'quiet', label: 'Quiet', companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID, limits },
      token: 'quiet-token',
      intakeScreening: null,
      log: { warn: () => undefined, error: () => undefined },
      reportRuntimeFailure: error => reports.push(error),
    });
    adapter.onMessage(async inbound => ({
      content: '', channelId: inbound.channelId,
      metadata: { model: 'scripted', inputTokens: 0, outputTokens: 0, durationMs: 0 },
    }));
    void new ExternalChannelMcpRoute([adapter], []);
    await adapter.start();
    expect(adapter.status().state).toBe('awaiting_bridge');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(adapter.status().state).toBe('stale');
    expect(reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reports).toHaveLength(1);
    adapter.hello();
    expect(adapter.status().state).toBe('connected');
    await adapter.stop();
    expect(adapter.status().state).toBe('stopped');
  });

  it('a bridge that stops pulling fills its bounded queue and further sends are refused', async () => {
    const reports: unknown[] = [];
    const adapter = new ExternalChannelAdapter({
      observer: { authorId: 'external-companion:test', displayName: 'Test Companion' },
      config: {
        instanceId: 'full', label: 'Full', companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
        limits: EXTERNAL_CHANNEL_TEST_LIMITS,
      },
      token: 'full-token',
      intakeScreening: null,
      log: { warn: () => undefined, error: () => undefined },
      reportRuntimeFailure: error => reports.push(error),
    });
    adapter.onMessage(async () => { throw new Error('unused'); });
    void new ExternalChannelMcpRoute([adapter], []);
    await adapter.start();
    const ctx = { channelId: 'external:full:conv' };
    for (let index = 0; index < EXTERNAL_CHANNEL_TEST_LIMITS.outboundQueueMax; index += 1) {
      await adapter.outbound.sendText(ctx, `m${index}`);
    }
    await expect(adapter.outbound.sendText(ctx, 'overflow')).rejects.toThrow('outbound queue is full');
    await expect(adapter.outbound.sendText({ channelId: 'discord:123' }, 'x')).rejects.toThrow('does not belong');
    expect(adapter.status()).toMatchObject({ outboundQueued: EXTERNAL_CHANNEL_TEST_LIMITS.outboundQueueMax, droppedOutbound: 1 });
    expect(reports).toHaveLength(1);
    await adapter.stop();
    await expect(adapter.outbound.sendText(ctx, 'after stop')).rejects.toThrow('not running');
  });
});
