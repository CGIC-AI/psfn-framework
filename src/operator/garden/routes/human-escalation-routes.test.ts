import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildAdminHumanEscalationRoutes } from './human-escalation-routes.js';
import { createInMemoryHumanEscalationLedger } from '../../../shared/escalation/memory-ledger.js';
import { AdminHumanEscalationDataService } from '../services/human-escalation-service.js';
import {
  DEFAULT_HUMAN_ESCALATION_CONFIG,
} from '../../../system/config/scheduler-config/human-escalation.js';
import type {
  HumanEscalationLedgerPort,
  HumanEscalationRecord,
} from '../../../shared/escalation/contracts.js';
import type { GardenRequestContext } from '../garden-request-context.js';

const NOW_MS = 1_800_000_000_000;
const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

class CapturingResponse {
  statusCode = 0;
  body = '';
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
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

function service(ledger: HumanEscalationLedgerPort, companionId?: string) {
  return new AdminHumanEscalationDataService({
    ledger,
    config: () => DEFAULT_HUMAN_ESCALATION_CONFIG,
    ...(companionId ? { companionId } : {}),
    now: () => NOW_MS,
  });
}

function routes(ledger: HumanEscalationLedgerPort | null, companionId?: string) {
  return buildAdminHumanEscalationRoutes({
    escalations: ledger ? service(ledger, companionId) : null,
    withBody: (_req, _res, cb) => { cb(pendingBody); },
    appendAuditTimelineEntry: (...entry) => { auditLog.push(entry[1]); },
  });
}

let pendingBody = '';
let auditLog: string[] = [];

async function get(
  ledger: HumanEscalationLedgerPort | null,
  path = '/api/admin/escalations',
  companionId?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const route = routes(ledger, companionId)
    .find(candidate => candidate.method === 'GET' && candidate.match(path.split('?')[0] ?? ''));
  if (!route) throw new Error(`Route not found: GET ${path}`);
  const res = new CapturingResponse();
  route.handle(
    { headers: {}, url: path } as IncomingMessage,
    res as unknown as ServerResponse,
    {},
  );
  await res.done;
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function post(
  ledger: HumanEscalationLedgerPort,
  escalationId: string,
  body: unknown,
  options: { context?: GardenRequestContext; companionId?: string } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  pendingBody = typeof body === 'string' ? body : JSON.stringify(body);
  auditLog = [];
  const path = `/api/admin/escalations/${escalationId}/resolve`;
  const route = routes(ledger, options.companionId)
    .find(candidate => candidate.method === 'POST' && candidate.match(path));
  if (!route) throw new Error(`Route not found: POST ${path}`);
  const params = route.match(path) ?? {};
  const res = new CapturingResponse();
  route.handle(
    { headers: {}, url: path } as IncomingMessage,
    res as unknown as ServerResponse,
    params,
    options.context,
  );
  await res.done;
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function seed(options: {
  companionId?: string;
  dedupeKey?: string;
  kind?: HumanEscalationRecord['kind'];
  ledger?: HumanEscalationLedgerPort;
} = {}): Promise<{ ledger: HumanEscalationLedgerPort; id: string }> {
  const ledger = options.ledger ?? createInMemoryHumanEscalationLedger();
  const record = await ledger.openOrReopen({
    kind: options.kind ?? 'runtime_incident',
    severity: 'critical',
    owner: options.companionId
      ? { kind: 'companion', companionId: options.companionId as never }
      : { kind: 'system' },
    dedupeKey: options.dedupeKey ?? 'incident-a',
    sourceRef: 'incident-a',
    labels: ['postgres_pool_pressure_opened'],
    evidence: { failureCount: 3 },
    detailPath: '/subsystem-health',
    raisedAtMs: NOW_MS,
  });
  return { ledger, id: record.escalationId };
}

describe('admin human escalation routes', () => {
  it('answers 503 rather than an empty queue when the ledger is unavailable', async () => {
    await expect(get(null)).resolves.toMatchObject({ statusCode: 503 });
  });

  it('returns the open queue with content-free state counts', async () => {
    const { ledger } = await seed();

    const response = await get(ledger);

    expect(response.statusCode).toBe(200);
    expect(response.body.counts).toEqual({ open: 1, acknowledged: 0, resolved: 0, dismissed: 0 });
    expect(response.body.escalations).toHaveLength(1);
  });

  it('rejects an unknown state filter', async () => {
    const { ledger } = await seed();

    await expect(get(ledger, '/api/admin/escalations?state=maybe'))
      .resolves.toMatchObject({ statusCode: 400 });
  });

  it.each([
    ['an unknown field', { state: 'resolved', reason: 'handled', note: 'because' }],
    ['an unknown state', { state: 'archived', reason: 'handled' }],
    ['an unknown reason', { state: 'resolved', reason: 'vibes' }],
    ['a missing reason', { state: 'resolved' }],
  ])('rejects a resolve body with %s', async (_label, body) => {
    const { ledger, id } = await seed();

    const response = await post(ledger, id, body);

    expect(response.statusCode).toBe(400);
    expect(auditLog).toContain('denied');
  });

  it('records a resolution and audits it as allowed', async () => {
    const { ledger, id } = await seed();

    const response = await post(ledger, id, { state: 'resolved', reason: 'handled' });

    expect(response.statusCode).toBe(200);
    expect(response.body.escalation).toMatchObject({
      state: 'resolved',
      // A standalone ADMIN_TOKEN or harness operator is recorded as `operator`;
      // only a fleet principal is recorded as one.
      resolution: { reason: 'handled', actor: 'operator' },
    });
    expect(auditLog).toContain('allowed');
  });

  it('records a fleet principal as its own actor class', async () => {
    const { ledger, id } = await seed();

    const response = await post(ledger, id, { state: 'dismissed', reason: 'expected' }, {
      context: { kind: 'fleet_principal' } as GardenRequestContext,
    });

    expect(response.body.escalation).toMatchObject({
      resolution: { actor: 'fleet_principal' },
    });
  });

  it('answers 409 when the escalation already left the queue', async () => {
    const { ledger, id } = await seed();
    await post(ledger, id, { state: 'resolved', reason: 'handled' });

    const second = await post(ledger, id, { state: 'dismissed', reason: 'duplicate' });

    expect(second.statusCode).toBe(409);
  });

  it('answers 404 for an unknown escalation', async () => {
    const { ledger } = await seed();

    const response = await post(ledger, '99999999-9999-4999-8999-999999999999', {
      state: 'resolved',
      reason: 'handled',
    });

    expect(response.statusCode).toBe(404);
  });

  it('does not enumerate or resolve another companion\'s escalation', async () => {
    const { ledger, id } = await seed({ companionId: COMPANION_B });

    const listed = await get(ledger, '/api/admin/escalations', COMPANION_A);
    const resolved = await post(ledger, id, { state: 'resolved', reason: 'handled' }, {
      companionId: COMPANION_A,
    });

    expect(listed.body.escalations).toHaveLength(0);
    // 404, not 403: "exists, but not yours" is an enumeration oracle.
    expect(resolved.statusCode).toBe(404);
  });

  it.each([
    ['operator_confirmation' as const, 'confirmation-a'],
    ['cogsec_quarantine' as const, 'quarantine-a'],
  ])('lets the standalone ADMIN_TOKEN or harness operator answer a %s escalation', async (
    kind,
    dedupeKey,
  ) => {
    // The producers wired in psfn-framework-wtw7l raise these kinds, and they
    // route `garden_only` — so this surface is the ONLY place a person sees
    // them, and the standalone principal (an ADMIN_TOKEN or harness key, which
    // reaches these routes with no fleet context) must be able to answer.
    const { ledger, id } = await seed({ kind, dedupeKey });

    const listed = await get(ledger);
    const resolved = await post(ledger, id, { state: 'resolved', reason: 'handled' });

    expect(listed.body.escalations).toMatchObject([{ kind, state: 'open' }]);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.body.escalation).toMatchObject({
      kind,
      state: 'resolved',
      resolution: { reason: 'handled', actor: 'operator' },
    });
  });

  it('shows the confirmation and quarantine kinds beside runtime incidents', async () => {
    const ledger = createInMemoryHumanEscalationLedger();
    await seed({ ledger, kind: 'runtime_incident', dedupeKey: 'incident-a' });
    await seed({ ledger, kind: 'operator_confirmation', dedupeKey: 'confirmation-a' });
    await seed({ ledger, kind: 'cogsec_quarantine', dedupeKey: 'quarantine-a' });

    const response = await get(ledger);

    expect(response.body.counts).toMatchObject({ open: 3 });
    expect((response.body.escalations as { kind: string }[]).map(row => row.kind).sort())
      .toEqual(['cogsec_quarantine', 'operator_confirmation', 'runtime_incident']);
  });
});
