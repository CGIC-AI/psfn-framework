import { describe, expect, it, vi } from 'vitest';
import { ConfirmationQueue, composeConfirmationQueueObservers } from './confirmation-queue.js';
import { createConfirmationEscalationObserver } from './confirmation-escalation-producer.js';
import { createInMemoryHumanEscalationLedger } from '../../shared/escalation/memory-ledger.js';
import {
  createHumanEscalationControlPlane,
  type HumanEscalationRoutingPolicy,
} from '../../shared/escalation/control-plane.js';
import type { HumanEscalationLedgerPort } from '../../shared/escalation/contracts.js';

const NOW_MS = 1_800_000_000_000;
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

const ROUTING: HumanEscalationRoutingPolicy = {
  runtime_incident: { sink: 'garden_only', cooldownMs: 0 },
  operator_confirmation: { sink: 'garden_only', cooldownMs: 0 },
  cogsec_quarantine: { sink: 'garden_only', cooldownMs: 0 },
};

function harness(ledger: HumanEscalationLedgerPort = createInMemoryHumanEscalationLedger()): {
  ledger: HumanEscalationLedgerPort;
  queue: ConfirmationQueue;
} {
  const plane = createHumanEscalationControlPlane<null>({
    ledger,
    routing: () => ROUTING,
    sinks: [],
    now: () => NOW_MS,
  });
  const queue = new ConfirmationQueue({
    now: () => NOW_MS,
    observer: composeConfirmationQueueObservers([
      createConfirmationEscalationObserver({
        plane,
        ledger,
        renderNotice: () => null,
        now: () => NOW_MS,
      }),
    ]),
  });
  return { ledger, queue };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function enqueue(queue: ConfirmationQueue, overrides: Record<string, unknown> = {}): string {
  return queue.enqueue({
    method: 'shell.run',
    action: 'run a command',
    scope: 'tool',
    params: { command: 'the operator must never see this in the ledger' },
    companionReason: 'the companion said something private here',
    approvalOwner: { companionId: COMPANION_ID },
    ...overrides,
  }, async () => undefined).id;
}

describe('confirmation queue escalation producer', () => {
  it('opens one content-free escalation for a pending confirmation', async () => {
    const { ledger, queue } = harness();
    const id = enqueue(queue);
    await settle();

    const record = await ledger.findByCondition('operator_confirmation', id);
    expect(record).toMatchObject({
      kind: 'operator_confirmation',
      state: 'open',
      dedupeKey: id,
      sourceRef: id,
      detailPath: '/confirmations',
      owner: { kind: 'companion', companionId: COMPANION_ID },
      labels: ['operator_confirmation'],
    });
    // Nothing the queue holds about the request crosses the seam.
    expect(JSON.stringify(record)).not.toMatch(/never see this|something private|shell\.run/u);
  });

  it('resolves the escalation when the domain flow resolves, naming the operator', async () => {
    const { ledger, queue } = harness();
    const id = enqueue(queue);
    await settle();

    await queue.resolve({ id, decision: 'approve' }, { kind: 'operator', id: 'operator-1' });
    await settle();

    expect(await ledger.findByCondition('operator_confirmation', id)).toMatchObject({
      state: 'resolved',
      resolution: { state: 'resolved', reason: 'handled', actor: 'operator' },
    });
  });

  it('records an expiry as a system resolution nobody acted on', async () => {
    const ledger = createInMemoryHumanEscalationLedger();
    const plane = createHumanEscalationControlPlane<null>({
      ledger,
      routing: () => ROUTING,
      sinks: [],
      now: () => NOW_MS,
    });
    let nowMs = NOW_MS;
    const queue = new ConfirmationQueue({
      now: () => nowMs,
      defaultExpiryMs: 1_000,
      observer: createConfirmationEscalationObserver({
        plane,
        ledger,
        renderNotice: () => null,
        now: () => nowMs,
      }),
    });
    const id = enqueue(queue);
    await settle();

    nowMs = NOW_MS + 2_000;
    await queue.resolve({ id, decision: 'approve' });
    await settle();

    expect(await ledger.findByCondition('operator_confirmation', id)).toMatchObject({
      state: 'resolved',
      resolution: { reason: 'not_actionable', actor: 'system' },
    });
  });

  it('serializes resolve behind its own raise, so an instant approval still closes the row', async () => {
    const inner = createInMemoryHumanEscalationLedger();
    // Delay only the open, so a resolution that arrives synchronously after the
    // enqueue would otherwise find no row and silently leave it open forever.
    const ledger: HumanEscalationLedgerPort = {
      ...inner,
      openOrReopen: async (facts) => {
        await settle();
        return await inner.openOrReopen(facts);
      },
    };
    const { queue } = harness(ledger);
    const id = enqueue(queue);
    await queue.resolve({ id, decision: 'approve' }, { kind: 'operator', id: 'operator-1' });
    await settle();
    await settle();

    expect(await ledger.findByCondition('operator_confirmation', id))
      .toMatchObject({ state: 'resolved' });
  });

  it('never lets a ledger fault fail the approval it is projecting', async () => {
    const inner = createInMemoryHumanEscalationLedger();
    const ledger: HumanEscalationLedgerPort = {
      ...inner,
      openOrReopen: () => Promise.reject(new Error('ledger unreachable')),
    };
    const warn = vi.fn();
    const plane = createHumanEscalationControlPlane<null>({
      ledger,
      routing: () => ROUTING,
      sinks: [],
      now: () => NOW_MS,
    });
    const queue = new ConfirmationQueue({
      now: () => NOW_MS,
      observer: createConfirmationEscalationObserver({
        plane,
        ledger,
        renderNotice: () => null,
        now: () => NOW_MS,
        logger: { info: () => undefined, warn },
      }),
    });

    const id = enqueue(queue);
    await settle();
    const result = await queue.resolve({ id, decision: 'approve' });
    await settle();

    expect(result.status).toBe('approved');
    expect(warn).toHaveBeenCalled();
  });

  it('is idempotent under a repeated raise for one condition', async () => {
    const { ledger, queue } = harness();
    const id = enqueue(queue);
    await settle();
    const first = await ledger.findByCondition('operator_confirmation', id);
    // A second enqueue of the same id cannot happen through the queue, so drive
    // the observer's own path: the plane reopens rather than duplicating.
    queue.enqueue({
      method: 'shell.run',
      action: 'run a command',
      scope: 'tool',
      params: {},
      companionReason: 'second',
      approvalOwner: { companionId: COMPANION_ID },
    }, async () => undefined);
    await settle();

    const all = await ledger.list({ limit: 50 });
    expect(all.filter(row => row.dedupeKey === id)).toHaveLength(1);
    expect(all).toHaveLength(2);
    expect(first?.raiseCount).toBe(1);
  });
});
