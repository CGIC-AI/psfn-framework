import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildAdminRoomArbiterRoutes } from './room-arbiter-routes.js';
import type { AdminRoomArbiterData, AdminRoomArbiterService } from '../services/types.js';

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

const EMPTY_DATA: AdminRoomArbiterData = {
  available: false,
  episodes: [],
  reservations: [],
  leases: [],
  participation: [],
  summary: {
    openEpisodeCount: 0,
    suppressedEpisodeCount: 0,
    activeReservationCount: 0,
    heldLeaseCount: 0,
  },
  reasonCounts: [],
  redaction: { roomText: 'not_collected', messageContent: 'not_collected' },
};

async function invoke(
  service: AdminRoomArbiterService,
): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
  const routes = buildAdminRoomArbiterRoutes({ service });
  const path = '/api/admin/room-arbiter';
  const route = routes.find(candidate => candidate.method === 'GET' && candidate.match(path));
  if (!route) throw new Error('Route not found: GET /api/admin/room-arbiter');
  const res = new CapturingResponse();
  route.handle(
    { headers: {} } as IncomingMessage,
    res as unknown as ServerResponse,
    route.match(path) ?? {},
  );
  await res.done;
  return { statusCode: res.statusCode, headers: res.headers, body: JSON.parse(res.body) as unknown };
}

describe('admin room-arbiter routes', () => {
  it('returns the telemetry payload from the service', async () => {
    const service: AdminRoomArbiterService = {
      getData: async () => ({ ...EMPTY_DATA, available: true }),
    };
    const { statusCode, body } = await invoke(service);
    expect(statusCode).toBe(200);
    expect((body as AdminRoomArbiterData).available).toBe(true);
    expect((body as AdminRoomArbiterData).redaction.roomText).toBe('not_collected');
  });

  it('returns a 500 with an error field when the service throws', async () => {
    const service: AdminRoomArbiterService = {
      getData: async () => {
        throw new Error('projection read failed');
      },
    };
    const { statusCode, body } = await invoke(service);
    expect(statusCode).toBe(500);
    expect(typeof (body as { error: string }).error).toBe('string');
    expect((body as { error: string }).error.length).toBeGreaterThan(0);
  });
});
