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

const PROVEN: TurnEgressCustodyProof = {
  custodySnapshotRef: `turn:${TURN_ID}`,
  sourceCount: 2,
  hasUnclassifiedSource: false,
  classification: 'auto_shareable',
  effectiveSensitivity: 'public',
};

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
  proof: TurnEgressCustodyProof | undefined;
  mode: CogSecMode;
  store: ReturnType<typeof fakeStore>;
  turnId?: string;
}) {
  const guard = buildEgressToolGuard({
    intakeSinkGate: permissiveSinkGate as never,
    getActiveTurnIntakeEnvelopes: () => [],
    // The lineage the disclosure decision layer reads. A proof-bearing turn
    // supplies one that permits the destination room.
    getCurrentTurnDisclosureLineage: () => (input.proof && input.proof.sourceCount > 0
      ? {
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
        sourceCount: input.proof.sourceCount,
        hasUnclassifiedSource: input.proof.hasUnclassifiedSource,
      }
      : undefined),
    getActiveTurnSessionIdentity: () => ({
      sourceChannelId: ROOM_CHANNEL,
      logicalSessionId: 'discord:session-1',
    }),
    getCurrentTurnCustodyProof: () => input.proof,
    getActiveTurnId: () => input.turnId ?? TURN_ID,
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

const sendParams = {
  channelId: ROOM_CHANNEL,
  content: 'the answer the tool derived',
};

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
