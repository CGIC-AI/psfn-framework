import { describe, expect, it } from 'vitest';
import {
  createHumanEscalationControlPlane,
  resolveHumanEscalation,
  type HumanEscalationRoutingPolicy,
  type HumanEscalationSink,
} from './control-plane.js';
import { createInMemoryHumanEscalationLedger } from './memory-ledger.js';
import {
  validateHumanEscalationRaise,
  type HumanEscalationDeliveryOutcome,
  type HumanEscalationLedgerPort,
  type HumanEscalationRaiseRequest,
} from './contracts.js';

const NOW_MS = 1_800_000_000_000;
const HOUR_MS = 3_600_000;

const PAGING_ROUTES: HumanEscalationRoutingPolicy = {
  runtime_incident: { sink: 'operator_alert', cooldownMs: 0 },
  operator_confirmation: { sink: 'garden_only', cooldownMs: 0 },
  cogsec_quarantine: { sink: 'garden_only', cooldownMs: 0 },
};

interface Notice { text: string }

function request(
  overrides: Partial<HumanEscalationRaiseRequest<Notice>> = {},
): HumanEscalationRaiseRequest<Notice> {
  return {
    kind: 'runtime_incident',
    severity: 'critical',
    owner: { kind: 'system' },
    dedupeKey: 'incident-a',
    idempotencyKey: 'incident-a:opened:1',
    sourceRef: 'incident-a',
    labels: ['postgres_pool_pressure_opened'],
    evidence: { failureCount: 3 },
    detailPath: '/subsystem-health',
    raisedAtMs: NOW_MS,
    notice: { text: 'page' },
    ...overrides,
  };
}

interface Bench {
  ledger: HumanEscalationLedgerPort;
  delivered: Notice[];
  setNow: (nowMs: number) => void;
  raise: (
    overrides?: Partial<HumanEscalationRaiseRequest<Notice>>,
  ) => ReturnType<ReturnType<typeof createHumanEscalationControlPlane<Notice>>['raise']>;
}

function bench(options: {
  routes?: HumanEscalationRoutingPolicy;
  outcome?: HumanEscalationDeliveryOutcome;
  throws?: boolean;
} = {}): Bench {
  const ledger = createInMemoryHumanEscalationLedger();
  const delivered: Notice[] = [];
  let clock = NOW_MS;
  const sink: HumanEscalationSink<Notice> = {
    id: 'operator_alert',
    async deliver(notice) {
      if (options.throws) throw new Error('sink exploded');
      delivered.push(notice);
      return options.outcome ?? 'delivered';
    },
  };
  const plane = createHumanEscalationControlPlane<Notice>({
    ledger,
    routing: () => options.routes ?? PAGING_ROUTES,
    sinks: [sink],
    now: () => clock,
    logger: { info: () => undefined, warn: () => undefined },
  });
  return {
    ledger,
    delivered,
    setNow: (nowMs) => { clock = nowMs; },
    raise: (overrides = {}) => plane.raise(request(overrides)),
  };
}

describe('human escalation admission', () => {
  it('rejects an unknown kind rather than raising it into an unrouted channel', () => {
    expect(() => validateHumanEscalationRaise(
      request({ kind: 'made_up_kind' as never }),
    )).toThrow(/Unknown human escalation kind/);
  });

  it.each([
    ['a label carrying prose', { labels: ['Pool pressure is bad'] }],
    ['a detail path that is not a Garden route', { detailPath: 'https://example.invalid/x' }],
    ['a dedupe key with a space', { dedupeKey: 'incident a' }],
    ['an empty idempotency key', { idempotencyKey: '' }],
    ['evidence carrying a string', { evidence: { failureCount: 'many' } as never }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateHumanEscalationRaise(request(overrides))).toThrow();
  });

  it('rejects a routing entry naming a sink this process cannot reach', () => {
    expect(() => createHumanEscalationControlPlane<Notice>({
      ledger: createInMemoryHumanEscalationLedger(),
      routing: () => PAGING_ROUTES,
      sinks: [],
    })).toThrow(/routes to sink operator_alert, which is not registered/);
  });
});

describe('human escalation raise', () => {
  it('records one escalation and one attempt for a delivered notice', async () => {
    const plane = bench();

    const result = await plane.raise();

    expect(result).toEqual({ status: 'delivered', escalationId: expect.any(String) });
    expect(plane.delivered).toEqual([{ text: 'page' }]);
    const rows = await plane.ledger.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'runtime_incident',
      dedupeKey: 'incident-a',
      state: 'open',
      resolution: null,
      raiseCount: 1,
      lastNotifiedAtMs: NOW_MS,
    });
    await expect(plane.ledger.findAttempt('incident-a:opened:1')).resolves.toMatchObject({
      sink: 'operator_alert',
      outcome: 'delivered',
    });
  });

  it('replays an already-recorded idempotency key without dispatching again', async () => {
    const plane = bench();
    const first = await plane.raise();

    const replay = await plane.raise();

    expect(replay).toEqual({
      status: 'replayed',
      escalationId: (first as { escalationId: string }).escalationId,
      outcome: 'delivered',
    });
    // The whole point: one key, one notice, no matter how often it arrives.
    expect(plane.delivered).toHaveLength(1);
    const rows = await plane.ledger.list({ limit: 10 });
    expect(rows[0]?.raiseCount).toBe(1);
  });

  it('groups repeats of one condition under a single escalation', async () => {
    const plane = bench();
    await plane.raise();
    plane.setNow(NOW_MS + HOUR_MS);

    await plane.raise({ idempotencyKey: 'incident-a:opened:2' });

    const rows = await plane.ledger.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raiseCount).toBe(2);
    expect(plane.delivered).toHaveLength(2);
  });

  it('reopens an escalation a human closed while the condition is still true', async () => {
    const plane = bench();
    const first = await plane.raise();
    const escalationId = (first as { escalationId: string }).escalationId;
    await resolveHumanEscalation(plane.ledger, {
      escalationId,
      state: 'resolved',
      reason: 'handled',
      actor: 'operator',
      resolvedAtMs: NOW_MS + 1,
    });

    await plane.raise({ idempotencyKey: 'incident-a:opened:2' });

    const reopened = await plane.ledger.getById(escalationId);
    // The runtime restating a condition outranks a human having closed it.
    expect(reopened).toMatchObject({ state: 'open', resolution: null, raiseCount: 2 });
  });

  it('suppresses a repeat inside a routed cooldown and still records the attempt', async () => {
    const plane = bench({
      routes: { ...PAGING_ROUTES, runtime_incident: { sink: 'operator_alert', cooldownMs: HOUR_MS } },
    });
    await plane.raise();
    plane.setNow(NOW_MS + 1_000);

    const suppressed = await plane.raise({ idempotencyKey: 'incident-a:opened:2' });

    expect(suppressed).toMatchObject({ status: 'suppressed', reason: 'within_cooldown' });
    expect(plane.delivered).toHaveLength(1);
    await expect(plane.ledger.findAttempt('incident-a:opened:2')).resolves.toMatchObject({
      outcome: 'suppressed',
    });
  });

  it('records a garden-only kind without dispatching anything', async () => {
    const plane = bench();

    const result = await plane.raise({
      kind: 'operator_confirmation',
      dedupeKey: 'confirmation-b',
      idempotencyKey: 'confirmation-b:1',
      sourceRef: 'confirmation-b',
      labels: ['memory_deletion'],
      detailPath: '/confirmations',
    });

    expect(result).toMatchObject({ status: 'recorded' });
    expect(plane.delivered).toHaveLength(0);
    await expect(plane.ledger.findAttempt('confirmation-b:1')).resolves.toMatchObject({
      sink: 'garden_only',
      outcome: 'recorded',
    });
  });

  it.each([
    ['unconfigured', 'unconfigured'],
    ['no_sink', 'no_sink'],
  ] as const)('reports %s undeliverable and still leaves a durable row', async (_label, outcome) => {
    const plane = bench({ outcome });

    const result = await plane.raise();

    expect(result).toMatchObject({ status: 'undeliverable', reason: outcome });
    await expect(plane.ledger.list({ limit: 10 })).resolves.toHaveLength(1);
  });

  it('contains a throwing sink as a delivery failure rather than losing the row', async () => {
    const plane = bench({ throws: true });

    const result = await plane.raise();

    expect(result).toMatchObject({ status: 'undeliverable', reason: 'delivery_failed' });
    const rows = await plane.ledger.list({ limit: 10 });
    expect(rows[0]?.lastNotifiedAtMs).toBeNull();
  });
});

describe('human escalation resolution', () => {
  async function openOne(): Promise<{ ledger: HumanEscalationLedgerPort; id: string }> {
    const plane = bench();
    const raised = await plane.raise();
    return { ledger: plane.ledger, id: (raised as { escalationId: string }).escalationId };
  }

  it('records the state, reason and actor class a human supplied', async () => {
    const { ledger, id } = await openOne();

    const result = await resolveHumanEscalation(ledger, {
      escalationId: id,
      state: 'dismissed',
      reason: 'not_actionable',
      actor: 'fleet_principal',
      resolvedAtMs: NOW_MS + 5,
    });

    expect(result).toMatchObject({
      ok: true,
      record: {
        state: 'dismissed',
        resolution: {
          state: 'dismissed',
          reason: 'not_actionable',
          actor: 'fleet_principal',
          resolvedAtMs: NOW_MS + 5,
        },
      },
    });
  });

  it('answers 404 for an escalation that does not exist', async () => {
    const { ledger } = await openOne();

    await expect(resolveHumanEscalation(ledger, {
      escalationId: '99999999-9999-4999-8999-999999999999',
      state: 'resolved',
      reason: 'handled',
      actor: 'operator',
      resolvedAtMs: NOW_MS,
    })).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it('refuses to move a terminal escalation, so a second tab cannot overwrite the first', async () => {
    const { ledger, id } = await openOne();
    await resolveHumanEscalation(ledger, {
      escalationId: id,
      state: 'resolved',
      reason: 'handled',
      actor: 'operator',
      resolvedAtMs: NOW_MS + 5,
    });

    await expect(resolveHumanEscalation(ledger, {
      escalationId: id,
      state: 'dismissed',
      reason: 'duplicate',
      actor: 'operator',
      resolvedAtMs: NOW_MS + 6,
    })).resolves.toMatchObject({ ok: false, status: 409 });
  });

  it('allows acknowledging before resolving', async () => {
    const { ledger, id } = await openOne();

    await expect(resolveHumanEscalation(ledger, {
      escalationId: id,
      state: 'acknowledged',
      reason: 'investigating',
      actor: 'operator',
      resolvedAtMs: NOW_MS + 5,
    })).resolves.toMatchObject({ ok: true });
    await expect(resolveHumanEscalation(ledger, {
      escalationId: id,
      state: 'resolved',
      reason: 'mitigated',
      actor: 'operator',
      resolvedAtMs: NOW_MS + 6,
    })).resolves.toMatchObject({ ok: true });
    await expect(ledger.countByState()).resolves.toEqual({
      open: 0,
      acknowledged: 0,
      resolved: 1,
      dismissed: 0,
    });
  });
});
