import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { InMemoryAutomataRunStore, AutomataRunRegistry } from '../../../faculties/automata/run-registry.js';
import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import { AdminAutomataDataService } from '../services/automata-service.js';
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

function invoke(service: AdminAutomataDataService | null, query = ''): CapturedResponse {
  const [route] = buildAdminAutomataRoutes({ automataService: service });
  const captured: CapturedResponse = { status: 0, body: undefined };
  route!.handle(
    { url: `/api/admin/automata${query}`, headers: {} } as IncomingMessage,
    fakeResponse(captured),
    {},
  );
  return captured;
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

    const captured = invoke(new AdminAutomataDataService(registry), '?taskId=task-1&limit=10');

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      runs: [{ taskId: 'task-1', sessionIds: ['subagent:subagent-1'] }],
    });
    const classes = (captured.body as { classes: Array<{ id: string }> }).classes;
    expect(classes.map(entry => entry.id)).toContain('memory.retrieval');
    expect(classes.every(entry => typeof entry.id === 'string')).toBe(true);
  });

  it('fails closed for unavailable registries and unknown class queries', async () => {
    expect(invoke(null).status).toBe(503);
    const registry = await AutomataRunRegistry.hydrate({
      companionId: 'companion-test',
      policy: loadAutomataPolicySeedDefaults(),
      store: new InMemoryAutomataRunStore(),
    });
    const captured = invoke(new AdminAutomataDataService(registry), '?classId=unknown');
    expect(captured.status).toBe(400);
    expect(captured.body).toMatchObject({ error: expect.stringMatching(/Unknown automata class/) });
  });
});
