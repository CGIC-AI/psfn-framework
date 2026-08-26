import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { MulticaAdapter, type MulticaAdapterConfig } from './adapter.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const RUNTIME_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const ISSUE_ID = '55555555-5555-4555-8555-555555555555';

function makeConfig(overrides: Partial<MulticaAdapterConfig> = {}): MulticaAdapterConfig {
  return {
    enabled: true,
    baseUrl: 'http://multica.test',
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

describe('MulticaAdapter', () => {
  it('registers a PSFN runtime, routes one claimed task, and completes it', async () => {
    const requests: Array<{
      path: string;
      method: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    let claimed = false;
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
      if (requestUrl.pathname === `/api/daemon/tasks/${TASK_ID}/complete`) {
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
    const adapter = new MulticaAdapter(makeConfig(), { fetchImpl });
    adapter.onMessage(async (message) => {
      handledMessages.push(message);
      return okResponse(message.channelId);
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(requests.some(request => request.path.endsWith('/complete'))).toBe(true);
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
      channelId: `multica:issue:${ISSUE_ID}`,
      channelType: 'multica',
      authorId: 'multica:member:99999999-9999-4999-8999-999999999999',
      authorName: 'Operator',
      isDirectMessage: false,
      content: expect.stringContaining('Wire Multica into the gateway'),
      routing: expect.objectContaining({
        source: 'multica',
        channelPrivacy: 'invite_only',
      }),
    })]);
    expect(handledMessages[0]?.content).toContain('Keep the squad moving');
    expect(handledMessages[0]?.content).not.toContain('task-scoped-token');

    const completeRequest = requests.find(request => request.path.endsWith('/complete'));
    expect(completeRequest).toMatchObject({
      authorization: 'Bearer gateway-owner-token',
      body: { output: 'Unit 00 handled the work.' },
    });
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

  it('reports companion failures to Multica exactly once', async () => {
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
      if (path === `/api/daemon/tasks/${TASK_ID}/start`) {
        return jsonResponse({ status: 'running' });
      }
      if (path === `/api/daemon/tasks/${TASK_ID}/fail`) {
        return jsonResponse({ status: 'failed' });
      }
      if (path === '/api/daemon/heartbeat' || path === '/api/daemon/deregister') {
        return jsonResponse({ status: 'ok' });
      }
      throw new Error(`Unexpected Multica request: ${path}`);
    }) as unknown as typeof fetch;

    const adapter = new MulticaAdapter(makeConfig(), { fetchImpl });
    adapter.onMessage(async () => {
      throw new Error('companion turn failed');
    });

    await adapter.start();
    await vi.waitFor(() => {
      expect(paths.filter(path => path.endsWith('/fail'))).toHaveLength(1);
    });
    await adapter.stop();

    expect(paths).not.toContain(`/api/daemon/tasks/${TASK_ID}/complete`);
  });
});
