import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAutomataRunStore, AutomataRunRegistry } from '../../../faculties/automata/run-registry.js';
import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import {
  AdminAutomataDataService,
  type AdminAutomataService,
} from '../services/automata-service.js';
import { buildAdminAutomataRoutes } from './automata-routes.js';

interface CapturedResponse {
  status: number;
  body: unknown;
}

function fakeResponse(captured: CapturedResponse): ServerResponse {
  return {
    writeHead: (status: number) => {
      captured.status = status;
    },
    end: (payload?: string) => {
      captured.body = payload ? JSON.parse(payload) : undefined;
    },
  } as unknown as ServerResponse;
}

async function invoke(service: AdminAutomataService | null, query = ''): Promise<CapturedResponse> {
  const [route] = buildAdminAutomataRoutes({ automataService: service });
  const captured: CapturedResponse = { status: 0, body: undefined };
  let complete: (() => void) | undefined;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const response = fakeResponse(captured);
  response.end = ((payload?: string) => {
    captured.body = payload ? JSON.parse(payload) : undefined;
    complete?.();
    return response;
  }) as ServerResponse['end'];
  route!.handle(
    { url: `/api/admin/automata${query}`, headers: {} } as IncomingMessage,
    response,
    {},
  );
  await completed;
  return captured;
}

function service(registry: AutomataRunRegistry): AdminAutomataDataService {
  return new AdminAutomataDataService({
    registry,
    companionId: 'companion-test',
    readPolicy: { defaultPageLimit: 10, maxPageLimit: 100 },
  });
}

describe('GET /api/admin/automata', () => {
  it('exposes the complete class manifest and task-to-session run discovery', async () => {
    const registry = await AutomataRunRegistry.hydrate({
      companionId: 'companion-test',
      policy: loadAutomataPolicySeedDefaults(),
      store: new InMemoryAutomataRunStore(),
      nowMs: 1,
    });
    await registry.register({
      runId: 'run-1',
      automatonClass: 'subagent.bounded',
      workerId: 'subagent-1',
      taskId: 'task-1',
      taskLabel: 'Review',
      taskSummary: 'Review the focused change.',
      sessionIds: ['subagent:subagent-1'],
      createdAtMs: 2,
    });

    const captured = await invoke(service(registry), '?taskId=task-1&limit=10');

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      runs: [{ taskId: 'task-1', sessionIds: ['subagent:subagent-1'] }],
    });
    const classes = (captured.body as { classes: Array<{ id: string }> }).classes;
    expect(classes.map(entry => entry.id)).toContain('memory.retrieval');
    expect(classes.every(entry => typeof entry.id === 'string')).toBe(true);
  });

  it('fails closed for unavailable registries and unknown class queries', async () => {
    expect((await invoke(null)).status).toBe(503);
    const registry = await AutomataRunRegistry.hydrate({
      companionId: 'companion-test',
      policy: loadAutomataPolicySeedDefaults(),
      store: new InMemoryAutomataRunStore(),
    });
    const captured = await invoke(service(registry), '?classId=unknown');
    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ error: expect.stringMatching(/Unknown automata class/) });
  });

  it('rejects unknown Bus statuses and malformed pagination', async () => {
    const registry = await AutomataRunRegistry.hydrate({
      companionId: 'companion-test',
      policy: loadAutomataPolicySeedDefaults(),
      store: new InMemoryAutomataRunStore(),
    });

    expect((await invoke(service(registry), '?verificationStatus=guessed')).status).toBe(400);
    expect((await invoke(service(registry), '?runOffset=-1')).status).toBe(400);
    expect((await invoke(service(registry), '?busLimit=0')).status).toBe(400);
  });

  it('does not disclose internal service failures', async () => {
    const captured = await invoke({
      async getSnapshot() {
        throw new Error('private database address and query text');
      },
    });

    expect(captured).toEqual({
      status: 500,
      body: { error: 'Failed to load Automata data' },
    });
  });
});

describe('POST /api/admin/automata/reindex', () => {
  it('runs one bounded reindex through the companion-bound Automata service', async () => {
    const reindex = vi.fn(async () => ({
      companionId: 'companion-test',
      status: 'completed' as const,
      processed: 2,
      indexed: 2,
      lagging: 0,
    }));
    const routes = buildAdminAutomataRoutes({
      automataService: {
        async getSnapshot() {
          throw new Error('snapshot should not be read during reindex');
        },
        reindex,
      },
    });
    const route = routes.find(candidate => (
      candidate.method === 'POST'
      && candidate.match.capabilityPattern === '/api/admin/automata/reindex'
    ));
    expect(route).toBeDefined();
    const captured: CapturedResponse = { status: 0, body: undefined };
    let complete: (() => void) | undefined;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const response = fakeResponse(captured);
    response.end = ((payload?: string) => {
      captured.body = payload ? JSON.parse(payload) : undefined;
      complete?.();
      return response;
    }) as ServerResponse['end'];

    route!.handle(
      { method: 'POST', url: '/api/admin/automata/reindex', headers: {} } as IncomingMessage,
      response,
      {},
    );
    await completed;

    expect(reindex).toHaveBeenCalledOnce();
    expect(captured).toEqual({
      status: 200,
      body: {
        companionId: 'companion-test',
        status: 'completed',
        processed: 2,
        indexed: 2,
        lagging: 0,
      },
    });
  });
});
