import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import type { GardenRequestContext } from '../garden-request-context.js';
import { AdminIcpReadmissionRefusedError } from '../services/icp-autonomy-service.js';
import type { AdminIcpAutonomyService } from '../services/types.js';
import { buildAdminIcpAutonomyRoutes } from './icp-autonomy-routes.js';
import type { AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';
const PEER_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

/** The authenticated caller the dispatcher hands every admin route. */
const OPERATOR_CONTEXT = {
  kind: 'fleet_principal',
  actor: {
    kind: 'fleet_principal',
    principalId: 'operator-mira',
    role: 'admin',
    sessionRecordId: 'session-7',
  },
  action: 'autonomy.manage',
  requestId: 'request-9',
  decisionId: 'decision-9',
  resource: {
    routeId: 'POST /api/admin/icp-autonomy/lifecycle/readmit',
    scope: 'system',
    area: 'autonomy',
    companionId: null,
    pathParams: {},
    query: {},
  },
} as unknown as GardenRequestContext;

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
  /** Omit the authenticated context entirely, as an unrouted caller would. */
  withoutContext?: boolean;
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
    input.withoutContext ? undefined : OPERATOR_CONTEXT,
  );
  await response.done;
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as unknown,
  };
}

describe('admin ICP autonomy routes', () => {
  it('strictly validates and audits operator test initiations', async () => {
    const triggerTestInitiation = vi.fn(async () => ({
      outcome: 'accepted' as const,
      candidateId: CANDIDATE_ID,
      status: 'pending' as const,
      deliveryDisposition: 'pending' as const,
    }));
    const audit = vi.fn<AdminAuditTimelineAppender>();

    const result = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/test-initiations',
      body: { peerCompanionId: PEER_ID, requestId: REQUEST_ID },
      service: { triggerTestInitiation },
      audit,
    });

    expect(result.statusCode).toBe(200);
    expect(triggerTestInitiation).toHaveBeenCalledWith({
      peerCompanionId: PEER_ID,
      requestId: REQUEST_ID,
    });
    expect(audit).toHaveBeenCalledWith(
      'autonomy_control',
      'allowed',
      expect.stringContaining('test initiation'),
      expect.arrayContaining([
        `peerCompanionId=${PEER_ID}`,
        `requestId=${REQUEST_ID}`,
        `candidateId=${CANDIDATE_ID}`,
        'outcome=accepted',
        'status=pending',
        'deliveryDisposition=pending',
      ]),
      'operator',
      OPERATOR_CONTEXT,
    );

    const invalid = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/test-initiations',
      body: { peerCompanionId: PEER_ID, requestId: REQUEST_ID, reason: 'bypass' },
      service: { triggerTestInitiation },
      audit,
    });
    expect(invalid.statusCode).toBe(400);
    expect(triggerTestInitiation).toHaveBeenCalledTimes(1);
  });

  it('denies instead of acknowledging when durable candidate acceptance fails', async () => {
    const triggerTestInitiation = vi.fn(async () => {
      throw new Error('candidate store unavailable');
    });
    const audit = vi.fn<AdminAuditTimelineAppender>();

    const result = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/test-initiations',
      body: { peerCompanionId: PEER_ID, requestId: REQUEST_ID },
      service: { triggerTestInitiation },
      audit,
    });

    expect(result.statusCode).toBe(500);
    expect(audit).toHaveBeenCalledWith(
      'autonomy_control',
      'denied',
      expect.stringContaining('failed'),
      expect.arrayContaining([
        `peerCompanionId=${PEER_ID}`,
        `requestId=${REQUEST_ID}`,
      ]),
      'operator',
      OPERATOR_CONTEXT,
    );
    expect(audit).not.toHaveBeenCalledWith(
      'autonomy_control',
      'allowed',
      expect.anything(),
      expect.anything(),
      'operator',
      OPERATOR_CONTEXT,
    );
  });

  it('audits a terminal idempotent replay without claiming new work was triggered', async () => {
    const audit = vi.fn<AdminAuditTimelineAppender>();
    const result = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/test-initiations',
      body: { peerCompanionId: PEER_ID, requestId: REQUEST_ID },
      service: {
        triggerTestInitiation: vi.fn(async () => ({
          outcome: 'deduped',
          candidateId: CANDIDATE_ID,
          status: 'consumed',
          deliveryDisposition: 'delivered',
        })),
      },
      audit,
    });

    expect(result).toMatchObject({
      statusCode: 200,
      body: { outcome: 'deduped', status: 'consumed' },
    });
    expect(audit).toHaveBeenCalledWith(
      'autonomy_control',
      'allowed',
      expect.stringContaining('replayed'),
      expect.arrayContaining([
        'outcome=deduped',
        'status=consumed',
        'deliveryDisposition=delivered',
      ]),
      'operator',
      OPERATOR_CONTEXT,
    );
    expect(audit).not.toHaveBeenCalledWith(
      'autonomy_control',
      'allowed',
      expect.stringContaining('accepted'),
      expect.anything(),
      'operator',
      OPERATOR_CONTEXT,
    );
  });

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
      OPERATOR_CONTEXT,
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
      OPERATOR_CONTEXT,
    );
  });

  // psfn-framework-2vd7s: clearing a durable lifecycle-admission fence is the
  // one ICP control that can put a removed companion back on the wire, so the
  // route refuses every body that is not an explicit, echoed operator act.
  it('requires an echoed confirmation before readmitting a fenced companion', async () => {
    const readmitCompanion = vi.fn(async () => ({
      ok: true as const,
      companionId: PEER_ID,
      transitioned: true,
      revokedPermitCount: 0,
      message: 'Companion readmitted to ICP; the invalidation generation advanced once',
    }));
    const audit = vi.fn<AdminAuditTimelineAppender>();

    const blind = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/lifecycle/readmit',
      body: { companionId: PEER_ID },
      service: { readmitCompanion },
      audit,
    });
    expect(blind.statusCode).toBe(400);
    expect(readmitCompanion).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      'autonomy_control',
      'denied',
      expect.stringContaining('readmission rejected invalid fields'),
      [],
      'operator',
      OPERATOR_CONTEXT,
    );

    const unknownField = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/lifecycle/readmit',
      body: { companionId: PEER_ID, confirmCompanionId: PEER_ID, force: true },
      service: { readmitCompanion },
    });
    expect(unknownField.statusCode).toBe(400);
    expect(readmitCompanion).not.toHaveBeenCalled();

    const accepted = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/lifecycle/readmit',
      body: { companionId: PEER_ID, confirmCompanionId: PEER_ID },
      service: { readmitCompanion },
      audit,
    });
    expect(accepted.statusCode).toBe(200);
    expect(readmitCompanion).toHaveBeenCalledWith({
      companionId: PEER_ID,
      confirmCompanionId: PEER_ID,
    });
    expect(audit).toHaveBeenCalledWith(
      'autonomy_control',
      'allowed',
      expect.stringContaining('readmitted a lifecycle-fenced companion'),
      [`companionId=${PEER_ID}`, 'transitioned=true', 'revokedPermits=0'],
      'operator',
      OPERATOR_CONTEXT,
    );
  });

  it('answers an off-manifest readmission with a legible refusal, not a 500', async () => {
    const readmitCompanion = vi.fn(async () => {
      throw new AdminIcpReadmissionRefusedError(
        'companion_not_on_manifest',
        'ICP readmission refuses a companion that is absent from the current companions.json manifest',
      );
    });
    const audit = vi.fn<AdminAuditTimelineAppender>();

    const refused = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/lifecycle/readmit',
      body: { companionId: PEER_ID, confirmCompanionId: PEER_ID },
      service: { readmitCompanion },
      audit,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatchObject({ refusal: 'companion_not_on_manifest' });
    expect(audit).toHaveBeenCalledWith(
      'autonomy_control',
      'denied',
      expect.stringContaining('readmission was refused'),
      expect.arrayContaining(['refusal=companion_not_on_manifest']),
      'operator',
      OPERATOR_CONTEXT,
    );
  });

  it('stamps the readmission audit with the calling principal', async () => {
    const readmitCompanion = vi.fn(async () => ({
      ok: true as const,
      companionId: PEER_ID,
      transitioned: true,
      revokedPermitCount: 0,
      message: 'Companion readmitted to ICP; the invalidation generation advanced once',
    }));
    const audit = vi.fn<AdminAuditTimelineAppender>();

    const accepted = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/lifecycle/readmit',
      body: { companionId: PEER_ID, confirmCompanionId: PEER_ID },
      service: { readmitCompanion },
      audit,
    });

    expect(accepted.statusCode).toBe(200);
    // The generic 'operator' actor class is not attribution: the durable row
    // must name which principal and which session cleared the fence.
    const context = audit.mock.calls[0]?.[5];
    expect(context).toMatchObject({
      kind: 'fleet_principal',
      actor: {
        principalId: 'operator-mira',
        role: 'admin',
        sessionRecordId: 'session-7',
      },
    });
  });

  it('refuses an unattributable readmission instead of recording it as a generic operator', async () => {
    const readmitCompanion = vi.fn(async () => {
      throw new Error('readmission must not run without a principal');
    });
    const audit = vi.fn<AdminAuditTimelineAppender>();

    const refused = await invoke({
      method: 'POST',
      path: '/api/admin/icp-autonomy/lifecycle/readmit',
      body: { companionId: PEER_ID, confirmCompanionId: PEER_ID },
      service: { readmitCompanion },
      audit,
      withoutContext: true,
    });

    expect(refused.statusCode).toBe(403);
    expect(readmitCompanion).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
