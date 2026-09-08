import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIntakeQuarantineStore } from './quarantine-store.js';
import {
  createQuarantineDecisionEscalationObserver,
  createQuarantineHoldEscalationObserver,
} from './quarantine-escalation-producer.js';
import { createInMemoryHumanEscalationLedger } from '../../../shared/escalation/memory-ledger.js';
import {
  createHumanEscalationControlPlane,
  type HumanEscalationRoutingPolicy,
} from '../../../shared/escalation/control-plane.js';
import type { HumanEscalationLedgerPort } from '../../../shared/escalation/contracts.js';
import {
  createIntakeEnvelope,
  transitionIntakeEnvelope,
  type IntakeEnvelope,
} from '../../../shared/contracts/intake-envelope.js';

const NOW_MS = 1_800_000_000_000;
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const ENVELOPE_ID = '018f22a2-52b8-7a3a-8c16-25b7b14f7082';

const ROUTING: HumanEscalationRoutingPolicy = {
  runtime_incident: { sink: 'garden_only', cooldownMs: 0 },
  operator_confirmation: { sink: 'garden_only', cooldownMs: 0 },
  cogsec_quarantine: { sink: 'garden_only', cooldownMs: 0 },
};

let dir = '';

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'quarantine-escalation-')); });
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function envelope(): IntakeEnvelope {
  const sha256 = 'a'.repeat(64);
  const created = createIntakeEnvelope({
    id: ENVELOPE_ID,
    sourceClass: 'web_fetch',
    sourceRiskTier: 'untrusted',
    contentRef: { store: 'intake-quarantine', ref: `sha256:${sha256}`, sha256 },
    origin: { ref: 'https://suspect.example/page' },
    atMs: NOW_MS,
  });
  const screened = transitionIntakeEnvelope(created, {
    to: 'screened',
    actor: 'test:screening',
    reason: 'l1:injection/override_attempt',
    atMs: NOW_MS,
    decision: {
      action: 'quarantine',
      reason: 'l1:injection/override_attempt',
      decidedBy: 'screening',
      decidedAtMs: NOW_MS,
    },
    riskLabels: ['injection/override_attempt'],
  });
  return transitionIntakeEnvelope(screened, {
    to: 'quarantined',
    actor: 'test:screening',
    reason: "routed per screening decision 'quarantine'",
    atMs: NOW_MS,
  });
}

function plane(ledger: HumanEscalationLedgerPort) {
  return createHumanEscalationControlPlane<null>({
    ledger,
    routing: () => ROUTING,
    sinks: [],
    now: () => NOW_MS,
  });
}

/**
 * The production topology: the gateway holds and raises into ITS ledger, and
 * the Garden decides in a different process against its own — which is why the
 * decision observer is given a list of ledgers to search.
 */
function stores(options: {
  holdLedger: HumanEscalationLedgerPort;
  decisionLedgers: readonly HumanEscalationLedgerPort[];
}) {
  const path = join(dir, 'intake-quarantine.json');
  const holder = createIntakeQuarantineStore(path, {
    itemTtlHours: 24,
    maxHeldItems: 10,
    now: () => NOW_MS,
    onHeld: createQuarantineHoldEscalationObserver({
      plane: plane(options.holdLedger),
      companionId: COMPANION_ID,
      renderNotice: () => null,
      now: () => NOW_MS,
    }),
  });
  const decider = createIntakeQuarantineStore(path, {
    itemTtlHours: 24,
    maxHeldItems: 10,
    now: () => NOW_MS,
    onDecided: createQuarantineDecisionEscalationObserver({
      ledgers: options.decisionLedgers,
      now: () => NOW_MS,
    }),
  });
  return { holder, decider };
}

describe('quarantine escalation producer', () => {
  it('raises one content-free escalation for a held item', async () => {
    const ledger = createInMemoryHumanEscalationLedger();
    const { holder } = stores({ holdLedger: ledger, decisionLedgers: [ledger] });

    holder.hold({
      envelope: envelope(),
      mode: 'enforce',
      rawText: 'the withheld content must never reach the ledger',
      canonicalContactId: 'contact-secret',
      sourceChannelId: 'channel-secret',
    });
    await settle();

    const record = await ledger.findByCondition('cogsec_quarantine', ENVELOPE_ID);
    expect(record).toMatchObject({
      kind: 'cogsec_quarantine',
      state: 'open',
      dedupeKey: ENVELOPE_ID,
      detailPath: '/cognitive-security',
      owner: { kind: 'companion', companionId: COMPANION_ID },
      labels: ['cogsec_quarantine', 'enforce'],
    });
    expect(JSON.stringify(record)).not.toMatch(/withheld content|contact-secret|channel-secret/u);
  });

  it('resolves across process boundaries when the deciding surface holds another ledger', async () => {
    // The gateway raised into the FLEET ledger; the Garden's own tenant ledger
    // has nothing. Searching only the first would leave the row open forever.
    const fleetLedger = createInMemoryHumanEscalationLedger();
    const companionLedger = createInMemoryHumanEscalationLedger();
    const { holder, decider } = stores({
      holdLedger: fleetLedger,
      decisionLedgers: [companionLedger, fleetLedger],
    });
    holder.hold({ envelope: envelope(), mode: 'enforce', rawText: 'held' });
    await settle();

    decider.applyDecision({
      id: ENVELOPE_ID,
      action: 'discard',
      actor: 'operator:garden',
      reason: 'not wanted',
    });
    await settle();

    expect(await fleetLedger.findByCondition('cogsec_quarantine', ENVELOPE_ID))
      .toMatchObject({
        state: 'resolved',
        resolution: { reason: 'handled', actor: 'operator' },
      });
  });

  it('never lets an unreachable ledger fail the hold it is projecting', async () => {
    const broken: HumanEscalationLedgerPort = {
      ...createInMemoryHumanEscalationLedger(),
      openOrReopen: () => Promise.reject(new Error('ledger unreachable')),
    };
    const { holder } = stores({ holdLedger: broken, decisionLedgers: [broken] });

    const held = holder.hold({ envelope: envelope(), mode: 'shadow', rawText: 'held' });
    await settle();

    // The security decision landed regardless: quarantine holds are not
    // conditional on an operator surface being reachable.
    expect(held.status).toBe('held');
    expect(holder.getById(ENVELOPE_ID)?.status).toBe('held');
  });
});
