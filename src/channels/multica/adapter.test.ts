import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  MulticaAdapter,
  type MulticaAdapterConfig,
  type MulticaAdapterOptions,
} from './adapter.js';
import type {
  MulticaRuntimeLease,
  MulticaRuntimeLeaseHandle,
} from './runtime-lease.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const RUNTIME_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const ISSUE_ID = '55555555-5555-4555-8555-555555555555';

function makeConfig(overrides: Partial<MulticaAdapterConfig> = {}): MulticaAdapterConfig {
  return {
    enabled: true,
    baseUrl: 'https://multica.test',
    workspaceId: WORKSPACE_ID,
    companionId: COMPANION_ID,
    token: 'gateway-owner-token',
    pollIntervalMs: 60_000,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function okResponse(channelId: string): AgentResponse {
  return {
    content: 'Unit 00 handled the work.',
    channelId,
    metadata: {
      model: 'test-model',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 5,
    },
  };
}

class ImmediateRuntimeLease implements MulticaRuntimeLease {
  async tryAcquire(): Promise<MulticaRuntimeLeaseHandle> {
    return { lost: new AbortController().signal, release: async () => undefined };
  }

  async acquire(): Promise<MulticaRuntimeLeaseHandle> {
    return await this.tryAcquire();
  }
}

function makeOptions(options: Partial<MulticaAdapterOptions> = {}): MulticaAdapterOptions {
  return { runtimeLease: new ImmediateRuntimeLease(), ...options };
}

class SharedRuntimeLease implements MulticaRuntimeLease {
  private owner: MulticaRuntimeLeaseHandle | null = null;
  private ownerLost: AbortController | null = null;
  private readonly waiters: Array<{
    resolve: (handle: MulticaRuntimeLeaseHandle) => void;
    reject: (reason?: unknown) => void;
    signal: AbortSignal;
  }> = [];

  async tryAcquire(): Promise<MulticaRuntimeLeaseHandle | null> {
    return this.owner ? null : this.grant();
  }

  async acquire(
    _key: string,
    options: { signal: AbortSignal },
  ): Promise<MulticaRuntimeLeaseHandle> {
    options.signal.throwIfAborted();
    if (!this.owner) return this.grant();
    return await new Promise<MulticaRuntimeLeaseHandle>((resolve, reject) => {
      const waiter = { resolve, reject, signal: options.signal };
      this.waiters.push(waiter);
      options.signal.addEventListener('abort', () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(options.signal.reason);
      }, { once: true });
    });
  }

  private grant(): MulticaRuntimeLeaseHandle {
    const lost = new AbortController();
    let released = false;
    const handle: MulticaRuntimeLeaseHandle = {
      lost: lost.signal,
      release: async () => {
        if (released) return;
        released = true;
        if (this.owner === handle) this.owner = null;
        this.grantNext();
      },
    };
    this.owner = handle;
    this.ownerLost = lost;
    return handle;
  }

  loseOwner(reason = new Error('lease connection lost')): void {
    this.ownerLost?.abort(reason);
    this.owner = null;
    this.ownerLost = null;
    this.grantNext();
  }

  private grantNext(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (waiter.signal.aborted) {
      this.grantNext();
      return;
    }
    waiter.resolve(this.grant());
  }
}

describe('MulticaAdapter', () => {
  it('registers a PSFN runtime, routes one claimed task, and completes it', async () => {
    const requests: Array<{
      path: string;
      method: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    let claimed = false;
    let completeAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      requests.push({
        path: requestUrl.pathname,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body,
      });

      if (requestUrl.pathname === '/api/daemon/register') {
        return jsonResponse({
          runtimes: [{
            id: RUNTIME_ID,
            name: 'PSFN Companion',
            provider: 'psfn',
            status: 'online',
          }],
          repos: [],
          repos_version: '',
        });
      }
      if (requestUrl.pathname === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: {
            id: TASK_ID,
            agent_id: '66666666-6666-4666-8666-666666666666',
            runtime_id: RUNTIME_ID,
            issue_id: ISSUE_ID,
            workspace_id: WORKSPACE_ID,
            status: 'dispatched',
            kind: 'direct',
            created_at: '2026-08-26T18:00:00.000Z',
            project_id: '77777777-7777-4777-8777-777777777777',
            project_title: 'PSFN Framework',
            is_leader_task: true,
            leader_role_resolved: true,
            squad_id: '88888888-8888-4888-8888-888888888888',
            squad_name: 'Framework Squad',
            handoff_note: 'Keep the squad moving and report blockers.',
            initiator_type: 'member',
            initiator_id: '99999999-9999-4999-8999-999999999999',
            initiator_name: 'Operator',
            auth_token: 'task-scoped-token',
            agent: {
              id: '66666666-6666-4666-8666-666666666666',
              name: 'V Unit 00',
              instructions: 'Coordinate the assigned squad.',
            },
          },
        });
      }
      if (requestUrl.pathname === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (requestUrl.pathname === `/api/issues/${ISSUE_ID}`) {
        expect(headers.get('authorization')).toBe('Bearer task-scoped-token');
        return jsonResponse({
          id: ISSUE_ID,
          workspace_id: WORKSPACE_ID,
          identifier: 'PSFN-42',
          title: 'Wire Multica into the gateway',
          description: 'Build the native connector.',
          status: 'in_progress',
          priority: 'high',
        });
      }
      if (requestUrl.pathname === `/api/daemon/tasks/${TASK_ID}/start`) {
        return jsonResponse({ status: 'running' });
      }
      if (requestUrl.pathname === `/api/daemon/tasks/${TASK_ID}/status`) {
        return jsonResponse({ status: 'running' });
      }
      if (requestUrl.pathname === `/api/daemon/tasks/${TASK_ID}/complete`) {
        completeAttempts += 1;
        if (completeAttempts < 3) {
          return new Response('temporary settlement failure', { status: 503 });
        }
        return jsonResponse({ status: 'completed' });
      }
      if (requestUrl.pathname === '/api/daemon/heartbeat') {
        return jsonResponse({ status: 'ok' });
      }
      if (requestUrl.pathname === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${requestUrl.pathname}`);
    }) as unknown as typeof fetch;

    const handledMessages: SubstrateMessage[] = [];
    const screen = vi.fn(async (content: string) => fromAny({
      effectiveText: `screened:${content}`,
      snapshot: { envelopeId: 'multica-intake-envelope' },
    }));
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({
      fetchImpl,
      intakeScreening: fromAny({ screen }),
    }));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async (message) => {
      handledMessages.push(message);
      return okResponse(message.channelId);
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(requests.filter(request => request.path.endsWith('/complete'))).toHaveLength(3);
    });
    await adapter.stop();

    expect(requests[0]).toMatchObject({
      path: '/api/daemon/register',
      method: 'POST',
      authorization: 'Bearer gateway-owner-token',
      body: {
        workspace_id: WORKSPACE_ID,
        daemon_id: `psfn-gateway-${COMPANION_ID}`,
        device_name: 'PSFN Gateway',
        runtimes: [{
          name: 'PSFN Companion',
          type: 'psfn',
          version: 'gateway-channel-v1',
          status: 'online',
        }],
      },
    });
    expect(handledMessages).toEqual([expect.objectContaining({
      id: TASK_ID,
      channelId: `multica:${WORKSPACE_ID}:issue:${ISSUE_ID}`,
      channelType: 'multica',
      authorId: `multica:system:${WORKSPACE_ID}`,
      authorName: 'Multica system',
      isDirectMessage: false,
      content: expect.stringContaining('Wire Multica into the gateway'),
      routing: expect.objectContaining({
        source: 'multica',
        channelPrivacy: 'invite_only',
        authorIsMachineIntelligence: true,
        intakeEnvelopes: [{ envelopeId: 'multica-intake-envelope' }],
      }),
    })]);
    expect(screen).toHaveBeenCalledOnce();
    expect(handledMessages[0]?.content).toContain('screened:# Multica work item');
    expect(handledMessages[0]?.content).toContain('Keep the squad moving');
    expect(handledMessages[0]?.content).not.toContain('task-scoped-token');

    const completeRequest = requests.find(request => request.path.endsWith('/complete'));
    expect(completeRequest).toMatchObject({
      authorization: 'Bearer gateway-owner-token',
      body: { output: 'Unit 00 handled the work.' },
    });
    expect(requests).toContainEqual(expect.objectContaining({
      path: `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`,
      authorization: 'Bearer gateway-owner-token',
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      path: '/api/daemon/heartbeat',
      authorization: 'Bearer gateway-owner-token',
      body: { runtime_id: RUNTIME_ID },
    }));
    expect(requests.at(-1)).toMatchObject({
      path: '/api/daemon/deregister',
      body: { runtime_ids: [RUNTIME_ID] },
    });
  });

  it('reconciles a lost start response without replaying the non-idempotent transition', async () => {
    let claimed = false;
    let startAttempts = 0;
    const handler = vi.fn(async (message: SubstrateMessage) => okResponse(message.channelId));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path.endsWith('/recover-orphans')) return jsonResponse({ orphaned: 0, retried: 0 });
      if (path.endsWith('/tasks/claim')) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: { id: TASK_ID, runtime_id: RUNTIME_ID, workspace_id: WORKSPACE_ID },
        });
      }
      if (path.endsWith('/start')) {
        startAttempts += 1;
        if (startAttempts === 1) throw new TypeError('connection lost after commit');
        return new Response('task is already running', { status: 400 });
      }
      if (path.endsWith('/status')) return jsonResponse({ status: 'running' });
      if (path.endsWith('/complete')) return jsonResponse({ status: 'completed' });
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl }));
    adapter.onMessage(handler);
    adapter.onOperatorAlert(async () => undefined);

    await adapter.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await adapter.stop();

    expect(startAttempts).toBe(1);
  });

  it('does not fail a task when an ambiguous start cannot be reconciled', async () => {
    let claimed = false;
    let statusAttempts = 0;
    const paths: string[] = [];
    const handler = vi.fn(async (message: SubstrateMessage) => okResponse(message.channelId));
    const alert = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      paths.push(path);
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path.endsWith('/recover-orphans')) return jsonResponse({ orphaned: 0, retried: 0 });
      if (path.endsWith('/tasks/claim')) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: { id: TASK_ID, runtime_id: RUNTIME_ID, workspace_id: WORKSPACE_ID },
        });
      }
      if (path.endsWith('/start')) throw new TypeError('connection lost after commit');
      if (path.endsWith('/status')) {
        statusAttempts += 1;
        throw new TypeError('status endpoint unavailable');
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl }));
    adapter.onMessage(handler);
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
    await expect(adapter.stop()).rejects.toThrow('could not reconcile');

    expect(statusAttempts).toBe(3);
    expect(handler).not.toHaveBeenCalled();
    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/fail`);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringContaining('start-reconciliation'),
    }));
  });

  it.each([
    ['cancels', jsonResponse({ status: 'cancelled' })],
    ['deletes or reassigns', new Response('task not found', { status: 404 })],
  ])('aborts companion work when Multica %s the running task', async (_case, statusResponse) => {
    let claimed = false;
    let handlerSignal: AbortSignal | undefined;
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      paths.push(path);
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path.endsWith('/recover-orphans')) return jsonResponse({ orphaned: 0, retried: 0 });
      if (path.endsWith('/tasks/claim')) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: { id: TASK_ID, runtime_id: RUNTIME_ID, workspace_id: WORKSPACE_ID },
        });
      }
      if (path.endsWith('/start')) return jsonResponse({ status: 'running' });
      if (path.endsWith('/status')) return statusResponse.clone();
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const adapter = new MulticaAdapter(makeConfig({ pollIntervalMs: 1 }), makeOptions({ fetchImpl }));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async (message, options) => {
      handlerSignal = options?.signal;
      await Promise.race([
        new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true })),
        new Promise<void>(resolve => setTimeout(resolve, 50)),
      ]);
      return okResponse(message.channelId);
    });

    await adapter.start();
    await vi.waitFor(() => expect(handlerSignal?.aborted).toBe(true));
    await adapter.stop();

    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/complete`);
    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/fail`);
  });

  it('reconciles cancellation after completion fails before the watcher polls', async () => {
    let claimed = false;
    let completionAttempts = 0;
    let reconciledAfterCompletionFailure = false;
    const paths: string[] = [];
    const alert = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      paths.push(path);
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path.endsWith('/recover-orphans')) return jsonResponse({ orphaned: 0, retried: 0 });
      if (path.endsWith('/tasks/claim')) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: { id: TASK_ID, runtime_id: RUNTIME_ID, workspace_id: WORKSPACE_ID },
        });
      }
      if (path.endsWith('/start')) return jsonResponse({ status: 'running' });
      if (path.endsWith('/status')) {
        if (completionAttempts === 0) return jsonResponse({ status: 'running' });
        reconciledAfterCompletionFailure = true;
        return jsonResponse({ status: 'cancelled' });
      }
      if (path.endsWith('/complete')) {
        completionAttempts += 1;
        return new Response('task is cancelled', { status: 409 });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const adapter = new MulticaAdapter(makeConfig({ pollIntervalMs: 60_000 }), makeOptions({
      fetchImpl,
      heartbeatIntervalMs: 60_000,
    }));
    adapter.onMessage(async message => okResponse(message.channelId));
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await vi.waitFor(() => expect(reconciledAfterCompletionFailure).toBe(true));

    expect(completionAttempts).toBe(3);
    expect(alert).not.toHaveBeenCalled();
    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/fail`);
    expect(paths).not.toContain('/api/daemon/deregister');

    await adapter.stop();
  });

  it('hands one stable runtime from an old gateway pod to its rolling replacement', async () => {
    const lease = new SharedRuntimeLease();
    const events: string[] = [];
    const daemonIds: string[] = [];
    const recoveredRuntimeIds: string[] = [];
    const deregisteredRuntimeIds: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      if (path === '/api/daemon/register') {
        const daemonId = String(body.daemon_id);
        daemonIds.push(daemonId);
        events.push('register');
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path.endsWith('/recover-orphans')) {
        recoveredRuntimeIds.push(path.split('/').at(-2) ?? '');
        events.push('recover');
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path.endsWith('/tasks/claim')) return jsonResponse({ task: null });
      if (path === '/api/daemon/heartbeat') return jsonResponse({ status: 'ok' });
      if (path === '/api/daemon/deregister') {
        const ids = body.runtime_ids;
        if (Array.isArray(ids)) deregisteredRuntimeIds.push(...ids.map(String));
        events.push('deregister');
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;

    const makeAdapter = (): MulticaAdapter => {
      const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl, runtimeLease: lease }));
      adapter.onMessage(async message => okResponse(message.channelId));
      adapter.onOperatorAlert(async () => undefined);
      return adapter;
    };
    const oldPod = makeAdapter();
    const newPod = makeAdapter();

    await oldPod.start();
    await newPod.start();
    expect(daemonIds).toEqual([`psfn-gateway-${COMPANION_ID}`]);
    expect(recoveredRuntimeIds).toEqual([RUNTIME_ID]);

    await oldPod.stop();
    await vi.waitFor(() => expect(recoveredRuntimeIds).toEqual([RUNTIME_ID, RUNTIME_ID]));
    await newPod.stop();

    expect(new Set(daemonIds)).toEqual(new Set([`psfn-gateway-${COMPANION_ID}`]));
    expect(deregisteredRuntimeIds).toEqual([RUNTIME_ID, RUNTIME_ID]);
    expect(events).toEqual([
      'register', 'recover', 'deregister',
      'register', 'recover', 'deregister',
    ]);
  });

  it('lets a standby recover the stable runtime after its owner crashes', async () => {
    const lease = new SharedRuntimeLease();
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        events.push('register');
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path.endsWith('/recover-orphans')) {
        events.push('recover');
        return jsonResponse({ orphaned: 1, retried: 1 });
      }
      if (path.endsWith('/tasks/claim')) return jsonResponse({ task: null });
      if (path === '/api/daemon/heartbeat') return jsonResponse({ status: 'ok' });
      if (path === '/api/daemon/deregister') {
        events.push('deregister');
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const makeAdapter = (): MulticaAdapter => {
      const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl, runtimeLease: lease }));
      adapter.onMessage(async message => okResponse(message.channelId));
      adapter.onOperatorAlert(async () => undefined);
      return adapter;
    };
    const crashedPod = makeAdapter();
    const standbyPod = makeAdapter();

    await crashedPod.start();
    await standbyPod.start();
    lease.loseOwner();
    await vi.waitFor(() => expect(events.filter(event => event === 'recover')).toHaveLength(2));

    expect(events).not.toContain('deregister');
    await expect(crashedPod.stop()).rejects.toThrow('ownership was lost');
    await standbyPod.stop();
    expect(events.filter(event => event === 'deregister')).toHaveLength(1);
  });

  it('cancels a stale deregistration when ownership transfers to a standby', async () => {
    const lease = new SharedRuntimeLease();
    let recoveries = 0;
    let deregistrationAttempts = 0;
    let completedDeregistrations = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path.endsWith('/recover-orphans')) {
        recoveries += 1;
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path.endsWith('/tasks/claim')) return jsonResponse({ task: null });
      if (path === '/api/daemon/heartbeat') return jsonResponse({ status: 'ok' });
      if (path === '/api/daemon/deregister') {
        deregistrationAttempts += 1;
        if (deregistrationAttempts === 1) {
          lease.loseOwner(new Error('lease lost during deregistration'));
          return await new Promise<Response>(() => undefined);
        }
        completedDeregistrations += 1;
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const makeAdapter = (): MulticaAdapter => {
      const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl, runtimeLease: lease }));
      adapter.onMessage(async message => okResponse(message.channelId));
      adapter.onOperatorAlert(async () => undefined);
      return adapter;
    };
    const oldPod = makeAdapter();
    const standbyPod = makeAdapter();
    await oldPod.start();
    await standbyPod.start();

    await expect(oldPod.stop()).rejects.toThrow();
    await vi.waitFor(() => expect(recoveries).toBe(2));

    expect(deregistrationAttempts).toBe(1);
    expect(completedDeregistrations).toBe(0);
    await standbyPod.stop();
    expect(completedDeregistrations).toBe(1);
  });

  it('alerts after three standby ownership failures instead of wedging silently', async () => {
    const runtimeLease: MulticaRuntimeLease = {
      tryAcquire: async () => null,
      acquire: vi.fn(async () => { throw new Error('database unavailable'); }),
    };
    let releaseAlert!: () => void;
    const alert = vi.fn(async () => await new Promise<void>(resolve => { releaseAlert = resolve; }));
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({ runtimeLease }));
    adapter.onMessage(async message => okResponse(message.channelId));
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());

    expect(runtimeLease.acquire).toHaveBeenCalledTimes(3);
    let stopSettled = false;
    const stopping = adapter.stop().finally(() => { stopSettled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopSettled).toBe(false);
    releaseAlert();
    await expect(stopping).rejects.toThrow('standby ownership failed after 3 attempts');
  });

  it('coalesces concurrent starts and lets stop cancel registration', async () => {
    const paths: string[] = [];
    const resolveRegistrations: Array<() => void> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      paths.push(path);
      if (path === '/api/daemon/register') {
        return await new Promise<Response>((resolve) => {
          resolveRegistrations.push(() => resolve(jsonResponse({
            runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }],
          })));
        });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        return jsonResponse({ task: null });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const alert = vi.fn(async () => undefined);
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl }));
    adapter.onMessage(async message => okResponse(message.channelId));
    adapter.onOperatorAlert(alert);

    const firstStart = adapter.start();
    const secondStart = adapter.start();
    await vi.waitFor(() => expect(resolveRegistrations.length).toBeGreaterThan(0));
    await adapter.stop();
    resolveRegistrations.forEach(resolve => resolve());
    await Promise.allSettled([firstStart, secondStart]);
    await adapter.stop();

    expect(paths.filter(path => path === '/api/daemon/register')).toHaveLength(1);
    expect(paths).not.toContain(`/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`);
    expect(paths).not.toContain(`/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`);
    expect(alert).not.toHaveBeenCalled();
  });

  it('honors a start requested while registration cancellation is in progress', async () => {
    let registrationAttempts = 0;
    let recoveryAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        registrationAttempts += 1;
        if (registrationAttempts === 1) {
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const rejectForAbort = (): void => reject(signal?.reason);
            if (signal?.aborted) rejectForAbort();
            else signal?.addEventListener('abort', rejectForAbort, { once: true });
          });
        }
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        recoveryAttempts += 1;
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        return jsonResponse({ task: null });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const alert = vi.fn(async () => undefined);
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl }));
    adapter.onMessage(async message => okResponse(message.channelId));
    adapter.onOperatorAlert(alert);

    const initialStart = adapter.start();
    await vi.waitFor(() => expect(registrationAttempts).toBe(1));
    const stopping = adapter.stop();
    const restarting = adapter.start();
    await Promise.all([initialStart, stopping, restarting]);
    await adapter.stop();

    expect(registrationAttempts).toBe(2);
    expect(recoveryAttempts).toBe(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('cancels failure settlement when gateway shutdown begins', async () => {
    let claimed = false;
    let failureAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: { id: TASK_ID, runtime_id: RUNTIME_ID, workspace_id: WORKSPACE_ID },
        });
      }
      if (path === `/api/daemon/tasks/${TASK_ID}/start`) {
        return jsonResponse({ status: 'running' });
      }
      if (path === `/api/daemon/tasks/${TASK_ID}/fail`) {
        failureAttempts += 1;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectForAbort = (): void => reject(signal?.reason);
          if (signal?.aborted) rejectForAbort();
          else signal?.addEventListener('abort', rejectForAbort, { once: true });
        });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const alert = vi.fn(async () => undefined);
    const adapter = new MulticaAdapter(makeConfig({ pollIntervalMs: 1 }), makeOptions({
      fetchImpl,
      heartbeatIntervalMs: 60_000,
      requestTimeoutMs: 100,
    }));
    adapter.onMessage(async () => { throw new Error('companion turn failed'); });
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await vi.waitFor(() => expect(failureAttempts).toBe(1));
    const stopOutcome = adapter.stop().then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    );
    const stoppedWithinShutdownBudget = await Promise.race([
      stopOutcome.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 50)),
    ]);
    const outcome = await stopOutcome;

    expect(stoppedWithinShutdownBudget).toBe(true);
    expect(outcome).toEqual({ ok: true });
    expect(failureAttempts).toBe(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('shares one shutdown deadline across deregistration retries and lease release', async () => {
    const release = vi.fn(async () => undefined);
    const runtimeLease: MulticaRuntimeLease = {
      tryAcquire: async () => ({ lost: new AbortController().signal, release }),
      acquire: async () => ({ lost: new AbortController().signal, release }),
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path.endsWith('/recover-orphans')) return jsonResponse({ orphaned: 0, retried: 0 });
      if (path.endsWith('/tasks/claim')) return jsonResponse({ task: null });
      if (path === '/api/daemon/heartbeat') return jsonResponse({ status: 'ok' });
      if (path === '/api/daemon/deregister') return await new Promise<Response>(() => undefined);
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({
      fetchImpl,
      runtimeLease,
      requestTimeoutMs: 40,
      shutdownTimeoutMs: 20,
    }));
    adapter.onMessage(async message => okResponse(message.channelId));
    adapter.onOperatorAlert(async () => undefined);
    await adapter.start();

    const stopped = adapter.stop().then(() => true, () => true);
    const stoppedWithinBudget = await Promise.race([
      stopped,
      new Promise<false>(resolve => setTimeout(() => resolve(false), 70)),
    ]);
    await stopped;

    expect(stoppedWithinBudget).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('retries idempotent failure settlement at most three times', async () => {
    const paths: string[] = [];
    let claimed = false;
    let failureAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      paths.push(path);
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: {
            id: TASK_ID,
            runtime_id: RUNTIME_ID,
            workspace_id: WORKSPACE_ID,
          },
        });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/tasks/${TASK_ID}/start`) {
        return jsonResponse({ status: 'running' });
      }
      if (path === `/api/daemon/tasks/${TASK_ID}/fail`) {
        failureAttempts += 1;
        if (failureAttempts < 3) {
          return new Response('temporary settlement failure', { status: 503 });
        }
        return jsonResponse({ status: 'failed' });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;

    const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl }));
    adapter.onOperatorAlert(async () => undefined);
    adapter.onMessage(async () => {
      throw new Error('companion turn failed');
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(paths.filter(path => path.endsWith('/fail'))).toHaveLength(3);
    });
    await adapter.stop();

    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/complete`);
  });

  it('rejects crossed workspace data before companion ingress and alerts the operator', async () => {
    const foreignWorkspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const paths: string[] = [];
    let claimed = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      paths.push(path);
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: {
            id: TASK_ID,
            runtime_id: RUNTIME_ID,
            workspace_id: foreignWorkspaceId,
          },
        });
      }
      if (path === `/api/daemon/tasks/${TASK_ID}/fail`
        || path === '/api/daemon/heartbeat'
        || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;

    const handler = vi.fn(async (message: SubstrateMessage) => okResponse(message.channelId));
    const alert = vi.fn(async () => undefined);
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl }));
    adapter.onMessage(handler);
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
    await expect(adapter.stop()).rejects.toThrow('workspace');

    expect(handler).not.toHaveBeenCalled();
    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/fail`);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringContaining('workspace-boundary'),
      message: expect.stringContaining(TASK_ID),
    }));
  });

  it('rejects an issue whose workspace differs from its validated task', async () => {
    const foreignWorkspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const paths: string[] = [];
    let claimed = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      paths.push(path);
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        if (claimed) return jsonResponse({ task: null });
        claimed = true;
        return jsonResponse({
          task: {
            id: TASK_ID,
            runtime_id: RUNTIME_ID,
            workspace_id: WORKSPACE_ID,
            issue_id: ISSUE_ID,
            auth_token: 'task-scoped-token',
          },
        });
      }
      if (path === `/api/issues/${ISSUE_ID}`) {
        return jsonResponse({ id: ISSUE_ID, workspace_id: foreignWorkspaceId });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;

    const handler = vi.fn(async (message: SubstrateMessage) => okResponse(message.channelId));
    const alert = vi.fn(async () => undefined);
    const adapter = new MulticaAdapter(makeConfig(), makeOptions({ fetchImpl }));
    adapter.onMessage(handler);
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
    await expect(adapter.stop()).rejects.toThrow('workspace');

    expect(handler).not.toHaveBeenCalled();
    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/start`);
    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/fail`);
  });

  it('stops and alerts after three persistent malformed claim responses', async () => {
    let claimAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        claimAttempts += 1;
        return jsonResponse({ task: { id: TASK_ID, runtime_id: RUNTIME_ID, workspace_id: 42 } });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;

    const alert = vi.fn(async () => undefined);
    const handler = vi.fn(async (message: SubstrateMessage) => okResponse(message.channelId));
    const adapter = new MulticaAdapter(makeConfig({ pollIntervalMs: 1 }), makeOptions({
      fetchImpl,
      heartbeatIntervalMs: 60_000,
    }));
    adapter.onMessage(handler);
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
    await expect(adapter.stop()).rejects.toThrow('task.workspace_id');

    expect(claimAttempts).toBe(3);
    expect(handler).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringContaining('polling'),
      message: expect.stringContaining('after 3 attempts'),
    }));
  });

  it('preserves a terminal failure that finishes while stop awaits the loops', async () => {
    let alertStarted!: () => void;
    let releaseAlert!: () => void;
    const alertWasStarted = new Promise<void>(resolve => { alertStarted = resolve; });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        return jsonResponse({ task: { id: TASK_ID, runtime_id: RUNTIME_ID, workspace_id: 42 } });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;
    const alert = vi.fn(async () => {
      alertStarted();
      await new Promise<void>(resolve => { releaseAlert = resolve; });
    });
    const adapter = new MulticaAdapter(makeConfig({ pollIntervalMs: 1 }), makeOptions({
      fetchImpl,
      heartbeatIntervalMs: 60_000,
    }));
    adapter.onMessage(async message => okResponse(message.channelId));
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await alertWasStarted;
    const stopping = adapter.stop();
    releaseAlert();

    await expect(stopping).rejects.toThrow('task.workspace_id');
    expect(alert).toHaveBeenCalledOnce();
  });

  it('times out hung requests and preserves exhausted alert delivery as a terminal error', async () => {
    let claimAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      ).pathname;
      if (path === '/api/daemon/register') {
        return jsonResponse({ runtimes: [{ id: RUNTIME_ID, provider: 'psfn' }] });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/recover-orphans`) {
        return jsonResponse({ orphaned: 0, retried: 0 });
      }
      if (path === `/api/daemon/runtimes/${RUNTIME_ID}/tasks/claim`) {
        claimAttempts += 1;
        return await new Promise<Response>(() => undefined);
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;

    const alert = vi.fn(async () => { throw new Error('operator sink unavailable'); });
    const adapter = new MulticaAdapter(makeConfig({ pollIntervalMs: 1 }), makeOptions({
      fetchImpl,
      heartbeatIntervalMs: 60_000,
      requestTimeoutMs: 5,
    }));
    adapter.onMessage(async message => okResponse(message.channelId));
    adapter.onOperatorAlert(alert);

    await adapter.start();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(3));
    await expect(adapter.stop()).rejects.toThrow('operator alert failed');

    expect(claimAttempts).toBe(3);
  });
});
