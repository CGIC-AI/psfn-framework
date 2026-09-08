import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildAdminIncidentRoutes } from './incident-routes.js';
import type {
  AdminIncidentTimelineService,
  IncidentTimelineSnapshot,
} from '../services/incident-timeline-service.js';

class CapturingResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise(resolve => {
      this.resolveDone = resolve;
    });
  }

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? '';
    this.resolveDone();
  }
}

async function invokeGet(
  service: AdminIncidentTimelineService | null,
  path = '/api/admin/incidents',
): Promise<{ statusCode: number; body: unknown }> {
  const routes = buildAdminIncidentRoutes({ incidents: service });
  const route = routes.find(candidate => candidate.method === 'GET' && candidate.match(path));
  if (!route) throw new Error(`Route not found: GET ${path}`);
  const params = route.match(path) ?? {};
  const res = new CapturingResponse();
  route.handle({ headers: {} } as IncomingMessage, res as unknown as ServerResponse, params);
  await res.done;
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

const EMPTY_SNAPSHOT: IncidentTimelineSnapshot = {
  generatedAt: 2_000,
  scope: { owner: { kind: 'system' }, process: 'agent', windowMs: 21_600_000 },
  incidents: [],
};

describe('admin incident routes', () => {
  it('returns the reconstructed incident snapshot', async () => {
    const snapshot: IncidentTimelineSnapshot = {
      ...EMPTY_SNAPSHOT,
      incidents: [{
        incidentId: '33333333-3333-4333-8333-333333333333',
        family: 'background_work_failures',
        code: 'background_work_failures_opened',
        status: 'open',
        owner: { kind: 'system' },
        component: 'background_work',
        process: 'agent',
        severity: 'degraded',
        openedAtMs: 1_000,
        lastObservedAtMs: 1_900,
        closedAtMs: null,
        occurrenceCount: 3,
        statementCount: 1,
        evidence: { failureCount: 3 },
        timeline: [],
        timelineTruncated: false,
      }],
    };
    const service: AdminIncidentTimelineService = { getSnapshot: async () => snapshot };

    const response = await invokeGet(service);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(snapshot);
  });

  it('reports an empty runtime as empty rather than absent', async () => {
    const response = await invokeGet({ getSnapshot: async () => EMPTY_SNAPSHOT });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(EMPTY_SNAPSHOT);
  });

  it('fails closed with 503 when the backend is unwired', async () => {
    const response = await invokeGet(null);
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Incident timeline backend unavailable' });
  });

  it('fails closed with 503 rather than an empty list when the stream read fails', async () => {
    const response = await invokeGet({
      getSnapshot: async () => { throw new Error('health stream unavailable'); },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Incident timeline backend unavailable' });
  });
});
