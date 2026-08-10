import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import type { AdminIcpAutonomyService } from '../services/types.js';
import { buildAdminIcpAutonomyRoutes } from './icp-autonomy-routes.js';
import type { AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';

class CapturingResponse {
  statusCode = 0;
  body = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise(resolve => {
      this.resolveDone = resolve;
    });
  }

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? '';
    this.resolveDone();
  }
}

async function invoke(input: {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  service: Partial<AdminIcpAutonomyService>;
  audit?: ReturnType<typeof vi.fn<AdminAuditTimelineAppender>>;
}) {
  const withBody: AdminBodyReader = (_req, _res, callback) => {
    callback(typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {}));
  };
  const routes = buildAdminIcpAutonomyRoutes({
    service: input.service as AdminIcpAutonomyService,
    withBody,
    appendAuditTimelineEntry: input.audit,
  });
  const route = routes.find(candidate => candidate.method === input.method
    && candidate.match(input.path));
  if (!route) throw new Error(`Missing route ${input.method} ${input.path}`);
  const response = new CapturingResponse();
  route.handle(
    { headers: {} } as IncomingMessage,
    response as unknown as ServerResponse,
    route.match(input.path) ?? {},
  );
  await response.done;
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as unknown,
  };
}

describe('admin ICP autonomy routes', () => {
  it('returns the bounded service projection, including content-free delivery telemetry', async () => {
    const data = {
      available: true,
      candidates: [],
      delivery: {
        currentAvailability: null,
        initiation: {
          invited: 0,
          delivered: 1,
          suppressed: 0,
          deferred: 0,
          declined: 0,
          failed: 0,
          expired: 0,
          cancelled: 0,
        },
        messages: { delivered: 1, pending: 0, failed: 0, observed: 1 },
        recentOutcome: { kind: 'initiation', outcome: 'delivered', timestampMs: 3_000 },
      },
    };
    const result = await invoke({
      method: 'GET',
      path: '/api/admin/icp-autonomy',
      service: { getData: vi.fn(async () => data as never) },
    });
    expect(result).toEqual({ statusCode: 200, body: data });
    expect(result.body).toHaveProperty('delivery.recentOutcome.outcome', 'delivered');
  });

  it('strictly validates candidate cancellation and audits allowed controls', async () => {
    const cancelCandidate = vi.fn(async () => ({
      ok: true as const,
      revokedPermitCount: 1,
      message: 'cancelled',
    }));
    const audit = vi.fn<AdminAuditTimelineAppender>();
    const result = await invoke({
      method: 'POST',
      path: `/api/admin/icp-autonomy/candidates/${CANDIDATE_ID}/cancel`,
      body: { expectedRevision: 4 },
      service: { cancelCandidate },
      audit,
    });
    expect(result.statusCode).toBe(200);
    expect(cancelCandidate).toHaveBeenCalledWith({
      candidateId: CANDIDATE_ID,
      expectedRevision: 4,
    });
    expect(audit).toHaveBeenCalledWith(
      'autonomy_control',
      'allowed',
      expect.stringContaining('cancelled'),
      expect.any(Array),
      'operator',
    );

    const invalid = await invoke({
      method: 'POST',
      path: `/api/admin/icp-autonomy/candidates/${CANDIDATE_ID}/cancel`,
      body: { expectedRevision: 4, force: true },
      service: { cancelCandidate },
      audit,
    });
    expect(invalid.statusCode).toBe(400);
    expect(cancelCandidate).toHaveBeenCalledTimes(1);
  });

  it('audits DND and emergency disable, and rejects unknown body fields', async () => {
    const setDoNotDisturb = vi.fn(async () => ({
      ok: true as const,
      revokedPermitCount: 2,
      message: 'DND',
    }));
    const emergencyDisable = vi.fn(async () => ({
      ok: true as const,
      revokedPermitCount: 3,
      message: 'disabled',
    }));
    const audit = vi.fn<AdminAuditTimelineAppender>();
    const dnd = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/do-not-disturb',
      body: {},
      service: { setDoNotDisturb },
      audit,
    });
    const disabled = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/emergency-disable',
      body: {},
      service: { emergencyDisable },
      audit,
    });
    expect(dnd.statusCode).toBe(200);
    expect(disabled.statusCode).toBe(200);
    expect(audit).toHaveBeenCalledTimes(2);

    const rejected = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/emergency-disable',
      body: { companionId: 'cross-cluster-target' },
      service: { emergencyDisable },
      audit,
    });
    expect(rejected.statusCode).toBe(400);
    expect(emergencyDisable).toHaveBeenCalledTimes(1);
  });

  it('maps optimistic-control conflicts to 409 and audits the denial', async () => {
    const audit = vi.fn<AdminAuditTimelineAppender>();
    const result = await invoke({
      method: 'POST',
      path: `/api/admin/icp-autonomy/candidates/${CANDIDATE_ID}/cancel`,
      body: { expectedRevision: 2 },
      service: {
        cancelCandidate: vi.fn(async () => {
          throw new Error('ICP candidate revision conflict');
        }),
      },
      audit,
    });
    expect(result.statusCode).toBe(409);
    expect(audit).toHaveBeenCalledWith(
      'autonomy_control',
      'denied',
      expect.any(String),
      expect.any(Array),
      'operator',
    );
  });
});
