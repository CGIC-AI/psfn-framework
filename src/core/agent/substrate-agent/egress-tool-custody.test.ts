// Chain of custody on the tool-egress surface (psfn-framework-ccgdz.6).
//
// Two properties this file exists to hold:
//   1. RECORD-FIRST WITH THE FINAL BYTES. The gate writes the delivery record
//      before `tool.execute`, and a `pre_tool_use` hook that rewrites the
//      params must not leave the ledger citing the pre-rewrite payload.
//   2. NO WIDENING. `assessDisclosure` already denies an outward send with no
//      usable lineage, mode independent. Only the custody-durability conditions
//      this bead adds honour the shadow posture.

import { Type } from '@sinclair/typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEgressToolGuard } from './egress-tool-guard.js';
import { gateToolWithCapabilities, type CapabilityAccess } from '../../../system/capabilities/gate.js';
import { withCapabilityRequirement } from '../../../system/capabilities/requirements.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import { EgressDeliveryRecorder } from '../../cogsec/disclosure/index.js';
import {
  egressContentSha256,
  type EgressDeliveryRecord,
  type TurnEgressCustodyProof,
} from '../../cogsec/disclosure/egress-delivery-record.js';
import type { DisclosureLineage } from '../../cogsec/disclosure/contracts.js';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../../shared/logger.js';
import { canonicalJsonString } from '../../../shared/utils/json-serialization.js';
import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import type { CogSecMode } from '../../../shared/contracts/cogsec-mode.js';
import type { PreToolHookGate } from '../../../boundary/gateway/pre-tool-hook.js';
import {
  resetRuntimeChannelEnvelopeLabels,
  setRuntimeChannelEnvelopeLabels,
} from '../../../system/trust/runtime-channel-labels.js';

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const COMPANION_A = '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d';
const ROOM_CHANNEL = 'discord:guild-1:general';

const CONTACT_ID = 'contact-1';

const PROVEN: TurnEgressCustodyProof = {
  custodySnapshotRef: `turn:${TURN_ID}`,
  sourceCount: 2,
  hasUnclassifiedSource: false,
  classification: 'auto_shareable',
  effectiveSensitivity: 'public',
};

/**
 * The lineage a turn publishes BEFORE generation starts. It exists from the
 * first model step; the custody snapshot that proves it durable is folded only
 * after the tool loop returns, which is the whole timing question this file
 * pins.
 */
function roomLineage(overrides: Partial<DisclosureLineage> = {}): DisclosureLineage {
  return {
    provenanceRefs: ['tool:notify'],
    sourceSnapshots: [],
    effectiveSensitivity: 'public',
    permittedDestinations: [{ kind: 'public_room', channelIds: [ROOM_CHANNEL] }],
    subjectContactIds: [],
    sourceChannelIds: [],
    generationContextRef: `turn:${TURN_ID}`,
    classification: 'auto_shareable',
    classifiedAt: new Date(1_800_000_000_000).toISOString(),
    classifierVersion: 'disclosure/v1',
    sourceCount: 2,
    hasUnclassifiedSource: false,
    ...overrides,
  };
}

/** The same turn, aimed at the contact DM the reviewer's reproduction used. */
function contactLineage(overrides: Partial<DisclosureLineage> = {}): DisclosureLineage {
  return roomLineage({
    effectiveSensitivity: 'personal',
    classification: 'restricted',
    permittedDestinations: [{ kind: 'contact_dm', contactIds: [CONTACT_ID] }],
    subjectContactIds: [CONTACT_ID],
    ...overrides,
  });
}

function fakeStore() {
  const rows: EgressDeliveryRecord[] = [];
  return {
    rows,
    port: {
      record: vi.fn(async (record: EgressDeliveryRecord) => {
        rows.push(record);
        return 'recorded' as const;
      }),
      getByDeliveryRef: async () => null,
      listByGenerationContextRef: async () => [],
      close: async () => {},
    },
  };
}

/** Sink gate that allows everything, so the disclosure layer is what is tested. */
const permissiveSinkGate = {
  evaluate: () => ({ allowed: true, reason: 'test: sink allows' }),
  assessEgressTrifecta: () => ({ allowed: true, reason: 'test: no trifecta' }),
};

function makeGuard(input: {
  /**
   * The turn's FOLDED custody proof — undefined during generation, because the
   * fold runs after the model's tool loop returns.
   */
  proof: TurnEgressCustodyProof | undefined;
  mode: CogSecMode;
  store: ReturnType<typeof fakeStore>;
  turnId?: string | undefined;
  /**
   * The turn's live lineage, stated explicitly by the mid-turn cases. It
   * defaults to the one a folded proof implies, so the post-fold cases keep
   * reading as they did; the two are deliberately independent, because the
   * defect lives exactly in the window where a lineage is published and no
   * fold has happened yet.
   */
  lineage?: DisclosureLineage | undefined;
}) {
  const lineage = 'lineage' in input
    ? input.lineage
    : (input.proof && input.proof.sourceCount > 0
      ? roomLineage({
        sourceCount: input.proof.sourceCount,
        hasUnclassifiedSource: input.proof.hasUnclassifiedSource,
      })
      : undefined);
  const guard = buildEgressToolGuard({
    intakeSinkGate: permissiveSinkGate as never,
    getActiveTurnIntakeEnvelopes: () => [],
    getCurrentTurnDisclosureLineage: () => lineage,
    getActiveTurnSessionIdentity: () => ({
      sourceChannelId: ROOM_CHANNEL,
      logicalSessionId: 'discord:session-1',
    }),
    getCurrentTurnCustodyProof: () => input.proof,
    getActiveTurnId: () => ('turnId' in input ? input.turnId : TURN_ID),
    egressDeliveryRecorder: new EgressDeliveryRecorder({
      store: input.store.port,
      companionId: COMPANION_A,
      getCogSecMode: () => input.mode,
      now: () => 1_800_000_000_000,
    }),
  });
  if (!guard) throw new Error('expected an egress tool guard');
  return guard;
}

function sendTool(onExecute?: () => void) {
  const executeSpy = vi.fn(async () => {
    onExecute?.();
    return { content: [{ type: 'text', text: 'sent' }], details: {} };
  });
  const tool = withCapabilityRequirement({
    name: 'discord.send',
    description: 'Room send surface.',
    parameters: Type.Object({
      channelId: Type.Optional(Type.String()),
      content: Type.String(),
    }),
    execute: executeSpy,
  } as never, ['external.discord'] as never);
  return { tool: tool as AgentTool<never>, executeSpy };
}

/**
 * Grants exactly the egress token under test. Tier resolution needs runtime
 * capability-tier config; this test is about the custody gate above it, so the
 * grant is stated directly rather than loaded.
 */
function accessFor(): CapabilityAccess {
  const granted = new Set<CapabilityToken>(['external.discord']);
  return {
    getTier: () => 'trusted',
    getGrantedTokens: () => granted,
    has: (token) => granted.has(token),
  };
}

/**
 * The reviewer's reproduction shape: `channel.send` addressed to a contact, so
 * `deriveDisclosureDestination` resolves a `contact_dm` — a destination that
 * requires custody proof and therefore exercises the record-first commit.
 */
function contactSendTool() {
  const executeSpy = vi.fn(async () => ({
    content: [{ type: 'text', text: 'sent' }],
    details: {},
  }));
  const tool = withCapabilityRequirement({
    name: 'channel.send',
    description: 'Contact DM surface.',
    parameters: Type.Object({
      contactId: Type.String(),
      content: Type.String(),
    }),
    execute: executeSpy,
  } as never, ['external.discord'] as never);
  return { tool: tool as AgentTool<never>, executeSpy };
}

const sendParams = {
  channelId: ROOM_CHANNEL,
  content: 'the answer the tool derived',
};

const contactSendParams = {
  contactId: CONTACT_ID,
  content: 'the answer the tool derived',
};

/** The shadow-posture line that must never appear for a merely pending fold. */
const RELEASED_WITHOUT_RECORD =
  'Egress released without a durable delivery record (shadow posture)';

function diagnosticMessages(): string[] {
  return getRecentDiagnosticLogRecords({ limit: 64 }).map(record => record.message);
}

// The room must actually classify as an outward public room for the disclosure
// destination to resolve; otherwise the test would prove nothing about egress.
beforeEach(() => {
  setRuntimeChannelEnvelopeLabels({ [ROOM_CHANNEL]: { privacy: 'public', broadcast: false } });
});
afterEach(() => {
  resetRuntimeChannelEnvelopeLabels();
});

describe('tool egress custody', () => {
  it('records the tool-derived payload record-first, before the tool runs', async () => {
    const store = fakeStore();
    const guard = makeGuard({ proof: PROVEN, mode: 'boundary', store });
    // The record must exist BEFORE the bytes leave.
    let rowsAtExecution = -1;
    const { tool, executeSpy } = sendTool(() => { rowsAtExecution = store.rows.length; });
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    await gated.execute('tool-call-1', sendParams);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(rowsAtExecution).toBe(1);
    const [row] = store.rows;
    expect(row?.surface).toBe('tool_egress');
    expect(row?.disposition).toBe('released');
    expect(row?.contentSha256)
      .toBe(egressContentSha256(canonicalJsonString(sendParams, 'egress tool params')));
    expect(row?.destination?.kind).toBe('public_room');
    expect(row?.custodySnapshotRef).toBe(`turn:${TURN_ID}`);
    expect(row?.owner).toEqual({ kind: 'companion', companionId: COMPANION_A });
  });

  it('binds the record to the params a pre_tool_use hook rewrote, not the originals', async () => {
    const store = fakeStore();
    const guard = makeGuard({ proof: PROVEN, mode: 'boundary', store });
    const { tool, executeSpy } = sendTool();
    const rewritten = { ...sendParams, content: 'the rewritten answer' };
    const hookGate: PreToolHookGate = {
      evaluate: async () => ({
        outcome: 'modified',
        matchedHookCount: 1,
        evaluatedHooks: ['redactor'],
        finalInput: rewritten,
        inputModified: true,
        additionalContext: [],
      }),
      onDecision: () => {},
    };
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard, undefined, () => hookGate);

    await gated.execute('tool-call-1', sendParams);

    expect(executeSpy).toHaveBeenCalledWith('tool-call-1', rewritten, undefined);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.contentSha256)
      .toBe(egressContentSha256(canonicalJsonString(rewritten, 'egress tool params')));
    expect(store.rows[0]?.contentSha256)
      .not.toBe(egressContentSha256(canonicalJsonString(sendParams, 'egress tool params')));
  });

  it('holds an outward send whose turn folded no lineage, and never runs the tool', async () => {
    const store = fakeStore();
    const guard = makeGuard({ proof: undefined, mode: 'boundary', store });
    const { tool, executeSpy } = sendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    const result = await gated.execute('tool-call-1', sendParams);

    expect(executeSpy).not.toHaveBeenCalled();
    expect((result.details as { egressGated?: boolean }).egressGated).toBe(true);
    expect(store.rows[0]?.disposition).toBe('held');
    expect(store.rows[0]?.holdReason).toBe('lineage_missing');
  });

  it('keeps the pre-existing lineage denial closed under a shadow posture', async () => {
    // assessDisclosure denies an outward send with no usable lineage regardless
    // of mode. This bead labels that denial; it must never relax it.
    const store = fakeStore();
    const guard = makeGuard({ proof: undefined, mode: 'shadow', store });
    const { tool, executeSpy } = sendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    await gated.execute('tool-call-1', sendParams);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(store.rows[0]?.disposition).toBe('held');
    expect(store.rows[0]?.enforcementPosture).toBe('shadow');
  });

  it('observes a missing custody snapshot under shadow and enforces it otherwise', async () => {
    const unwritten: TurnEgressCustodyProof = { ...PROVEN };
    delete (unwritten as { custodySnapshotRef?: string }).custodySnapshotRef;

    const shadowStore = fakeStore();
    const shadowTool = sendTool();
    await gateToolWithCapabilities(
      shadowTool.tool,
      accessFor,
      () => makeGuard({ proof: unwritten, mode: 'shadow', store: shadowStore }),
    ).execute('tool-call-1', sendParams);
    expect(shadowTool.executeSpy).toHaveBeenCalledTimes(1);
    expect(shadowStore.rows[0]?.disposition).toBe('released');
    expect(shadowStore.rows[0]?.holdReason).toBe('custody_snapshot_missing');

    const strictStore = fakeStore();
    const strictTool = sendTool();
    await gateToolWithCapabilities(
      strictTool.tool,
      accessFor,
      () => makeGuard({ proof: unwritten, mode: 'strict', store: strictStore }),
    ).execute('tool-call-1', sendParams);
    expect(strictTool.executeSpy).not.toHaveBeenCalled();
    expect(strictStore.rows[0]?.disposition).toBe('held');
    expect(strictStore.rows[0]?.holdReason).toBe('custody_snapshot_missing');
  });

  it('holds a proof-requiring send whose delivery record cannot be written', async () => {
    const store = fakeStore();
    store.port.record.mockRejectedValueOnce(new Error('connection terminated'));
    const guard = makeGuard({ proof: PROVEN, mode: 'boundary', store });
    const { tool, executeSpy } = sendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    const result = await gated.execute('tool-call-1', sendParams);

    expect(executeSpy).not.toHaveBeenCalled();
    expect((result.details as { egressGated?: boolean }).egressGated).toBe(true);
  });

  it('stays a calm denial when the payload has no canonical digest', async () => {
    // A param object the canonical serializer refuses (a BigInt here) must not
    // turn a held egress into an unhandled rejection in the tool loop.
    const store = fakeStore();
    const guard = makeGuard({ proof: undefined, mode: 'boundary', store });
    const { tool, executeSpy } = sendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    const result = await gated.execute('tool-call-1', { ...sendParams, retries: 10n });

    expect(executeSpy).not.toHaveBeenCalled();
    expect((result.details as { egressGated?: boolean }).egressGated).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  it('leaves non-social tool egress governed by the existing sink gate alone', async () => {
    const store = fakeStore();
    const guard = makeGuard({ proof: undefined, mode: 'boundary', store });
    const executeSpy = vi.fn().mockResolvedValue({ content: [], details: {} });
    const shellTool = withCapabilityRequirement({
      name: 'fs',
      description: 'Local filesystem surface.',
      parameters: Type.Object({ path: Type.String() }),
      execute: executeSpy,
    } as never, ['repl.execute'] as never) as AgentTool<never>;
    const gated = gateToolWithCapabilities(shellTool, () => ({
      getTier: () => 'trusted',
      getGrantedTokens: () => new Set<CapabilityToken>(['repl.execute']),
      has: (token: CapabilityToken) => token === 'repl.execute',
    }), () => guard);

    // No outward social destination is derivable, so the disclosure check does
    // not engage; the tool runs and the release is still recorded.
    await gated.execute('tool-call-2', { path: '/tmp/x' });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(store.rows[0]?.disposition).toBe('released');
    expect(store.rows[0]?.destination).toBeUndefined();
    expect(store.rows[0]?.holdReason).toBeUndefined();
  });

  it('leaves an unresolvable social destination to the existing fail-closed gate', async () => {
    // A disclosure-bearing send whose destination cannot be resolved is already
    // denied by composeEgressDisclosureDecision. That refusal is audited there;
    // this bead must not fabricate a delivery row with an invented reason.
    const store = fakeStore();
    const guard = makeGuard({ proof: PROVEN, mode: 'boundary', store });
    const { tool, executeSpy } = sendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    const result = await gated.execute('tool-call-3', { content: 'status' });

    expect(executeSpy).not.toHaveBeenCalled();
    expect((result.details as { egressGated?: boolean }).egressGated).toBe(true);
    expect(store.rows).toHaveLength(0);
  });
});

// ── Mid-turn egress, before the turn folds its custody snapshot (lane B24) ──
//
// A model-invoked send runs INSIDE the generation. The turn's lineage is
// already published; its custody snapshot is not, and cannot be — the fold
// happens after the tool loop returns. Before this lane the guard read that
// window as "no chain at all": the delivery record had no turn to bind to, the
// write reported `written: false`, and boundary/strict refused every send as a
// custody-store outage while shadow logged a false unrecorded-release error.
describe('tool egress custody mid-turn', () => {
  beforeEach(() => {
    clearDiagnosticLogRingBufferForTests();
  });

  it('releases a contact DM against the turn lineage and records it as pending', async () => {
    const store = fakeStore();
    const guard = makeGuard({
      proof: undefined,
      lineage: contactLineage(),
      mode: 'boundary',
      store,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
    const [row] = store.rows;
    expect(row?.disposition).toBe('released');
    expect(row?.holdReason).toBeUndefined();
    expect(row?.destination?.kind).toBe('contact_dm');
    // Bound to the turn that produced the bytes, and typed as a promise the
    // fold resolves — never as a missing or unwritable snapshot.
    expect(row?.turnId).toBe(TURN_ID);
    expect(row?.generationContextRef).toBe(`turn:${TURN_ID}`);
    expect(row?.custodySnapshot).toBe('pending');
    expect(row?.custodySnapshotRef).toBeUndefined();
    expect(row?.sourceCount).toBe(2);
    expect(diagnosticMessages()).not.toContain(RELEASED_WITHOUT_RECORD);
  });

  it('releases the same send under strict, where the false hold used to bite', async () => {
    const store = fakeStore();
    const guard = makeGuard({
      proof: undefined,
      lineage: contactLineage(),
      mode: 'strict',
      store,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    const result = await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect((result.details as { egressGated?: boolean }).egressGated).toBeUndefined();
    expect(store.rows[0]?.disposition).toBe('released');
    expect(store.rows[0]?.enforcementPosture).toBe('enforce');
    expect(store.rows[0]?.custodySnapshot).toBe('pending');
  });

  it('logs no unrecorded-release error under shadow when the fold is merely pending', async () => {
    const store = fakeStore();
    const guard = makeGuard({
      proof: undefined,
      lineage: contactLineage(),
      mode: 'shadow',
      store,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(store.rows[0]?.disposition).toBe('released');
    expect(diagnosticMessages()).not.toContain(RELEASED_WITHOUT_RECORD);
  });

  it('still holds a mid-turn send whose turn admitted no source', async () => {
    // Pending is only about DURABILITY. Every provenance condition the
    // disclosure layer already enforces still holds, mid-turn or not.
    const store = fakeStore();
    const guard = makeGuard({
      proof: undefined,
      lineage: contactLineage({ sourceCount: 0, classification: 'non_shareable' }),
      mode: 'boundary',
      store,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    const result = await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).not.toHaveBeenCalled();
    expect((result.details as { egressGated?: boolean }).egressGated).toBe(true);
    expect(store.rows[0]?.disposition).toBe('held');
    expect(store.rows[0]?.holdReason).toBe('no_admitted_source');
  });

  it('still holds a mid-turn send whose turn admitted an unclassified source', async () => {
    const store = fakeStore();
    const guard = makeGuard({
      proof: undefined,
      lineage: contactLineage({ hasUnclassifiedSource: true, classification: 'non_shareable' }),
      mode: 'boundary',
      store,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(store.rows[0]?.disposition).toBe('held');
    expect(store.rows[0]?.holdReason).toBe('unclassified_source');
  });

  it('still holds a mid-turn send whose turn published no lineage at all', async () => {
    const store = fakeStore();
    const guard = makeGuard({
      proof: undefined,
      lineage: undefined,
      mode: 'boundary',
      store,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(store.rows[0]?.disposition).toBe('held');
    expect(store.rows[0]?.holdReason).toBe('lineage_missing');
  });

  it('still holds a mid-turn send when the delivery record cannot be written', async () => {
    // A pending fold must not mask a genuine custody-store outage: the record
    // is the thing that makes the pending claim resolvable later.
    const store = fakeStore();
    store.port.record.mockRejectedValueOnce(new Error('connection terminated'));
    const guard = makeGuard({
      proof: undefined,
      lineage: contactLineage(),
      mode: 'boundary',
      store,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    const result = await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).not.toHaveBeenCalled();
    expect((result.details as { egressGated?: boolean }).egressGated).toBe(true);
    expect(diagnosticMessages())
      .toContain('Egress held: the delivery record could not be written');
  });

  it('reports the outage under shadow instead of pretending the egress was recorded', async () => {
    const store = fakeStore();
    store.port.record.mockRejectedValueOnce(new Error('connection terminated'));
    const guard = makeGuard({
      proof: undefined,
      lineage: contactLineage(),
      mode: 'shadow',
      store,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(diagnosticMessages()).toContain(RELEASED_WITHOUT_RECORD);
  });

  it('holds a mid-turn send outside any active turn, which has nothing to bind to', async () => {
    const store = fakeStore();
    const guard = makeGuard({
      proof: undefined,
      lineage: contactLineage(),
      mode: 'boundary',
      store,
      turnId: undefined,
    });
    const { tool, executeSpy } = contactSendTool();
    const gated = gateToolWithCapabilities(tool, accessFor, () => guard);

    const result = await gated.execute('tool-call-mid-turn', contactSendParams);

    expect(executeSpy).not.toHaveBeenCalled();
    expect((result.details as { egressGated?: boolean }).egressGated).toBe(true);
    expect(store.rows).toHaveLength(0);
    expect(diagnosticMessages())
      .toContain('Egress delivery record skipped: no active turn identity');
  });
});
