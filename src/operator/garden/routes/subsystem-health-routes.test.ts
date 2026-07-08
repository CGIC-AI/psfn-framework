import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildAdminSubsystemHealthRoutes } from './subsystem-health-routes.js';
import type {
  AdminSubsystemHealthService,
  SubsystemHealthSnapshot,
} from '../services/subsystem-health-service.js';

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
  service: AdminSubsystemHealthService | null,
  path = '/api/admin/subsystem-health',
): Promise<{ statusCode: number; body: unknown }> {
  const routes = buildAdminSubsystemHealthRoutes({ subsystemHealth: service });
  const route = routes.find(candidate => candidate.method === 'GET' && candidate.match(path));
  if (!route) throw new Error(`Route not found: GET ${path}`);
  const params = route.match(path) ?? {};
  const res = new CapturingResponse();
  route.handle({ headers: {} } as IncomingMessage, res as unknown as ServerResponse, params);
  await res.done;
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

describe('admin subsystem-health routes', () => {
  it('returns the live snapshot from the service', async () => {
    const snapshot: SubsystemHealthSnapshot = {
      processStartedAt: 1_000,
      generatedAt: 2_000,
      lanes: [
        {
          id: 'episode_synthesis',
          label: 'Episode synthesis gate',
          description: 'gate',
          source: 'event_bus',
          sinceProcessStart: true,
          status: 'skipped',
          lastEventAt: 1_500,
          lastOutcome: 'skipped',
          lastReason: 'no_new_messages',
          lastError: null,
          counts: { newEntryCount: 0 },
          observedEventCount: 1,
          recent: [{ at: 1_500, outcome: 'skipped', reason: 'no_new_messages' }],
        },
      ],
    };
    const service: AdminSubsystemHealthService = { getSnapshot: () => snapshot };

    const response = await invokeGet(service);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(snapshot);
  });

  it('fails closed with 503 when the backend is unavailable', async () => {
    const response = await invokeGet(null);
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Subsystem health backend unavailable' });
  });
});
