// ── Egress tool guard (CogSec sink + disclosure composition) ──
// Extracted from SubstrateAgent (charter 12.1 split, emh3p.2). The guard
// composes the intake sink gate WITH the outbound disclosure destination
// check — never a parallel path. The disclosure check only engages for a
// positively identified outbound social destination and can only narrow,
// never widen, the sink gate's verdict. Fail closed: an outward destination
// with no per-turn lineage is denied; companion-self stays eligible via the
// decision layer.

import type { EgressToolGuard, EgressToolGuardCommit } from '../../../system/capabilities/gate.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import { currentChannelClassificationEpoch } from '../../../system/trust/runtime-classification-epochs.js';
import {
  composeEgressDisclosureDecision,
  deriveDisclosureDestination,
  destinationRequiresCustodyProof,
  egressContentSha256,
  evaluateEgressCustodyHold,
  isCustodyDurabilityHoldReason,
  isDisclosureSocialEgressInvocation,
  turnEgressCustodyProof,
  type DisclosureDestination,
  type DisclosureLineage,
  type EgressCustodyHoldReason,
  type EgressDeliveryRecorder,
  type TurnEgressCustodyProof,
} from '../../cogsec/disclosure/index.js';
import {
  isEgressCapabilityToken,
  type IntakeSinkGate,
} from '../../cogsec/intake/sink-gates.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../cogsec/intake-firewall-notice-templates.js';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import { canonicalJsonString } from '../../../shared/utils/json-serialization.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { TurnSessionIdentity } from './turn-execution/contracts.js';

const log = createComponentLogger('EgressToolGuard');

export interface EgressToolGuardDeps {
  intakeSinkGate: IntakeSinkGate | null;
  getActiveTurnIntakeEnvelopes: () => readonly IntakeEnvelopeSnapshot[];
  getCurrentTurnDisclosureLineage: () => DisclosureLineage | undefined;
  getActiveTurnSessionIdentity: () => TurnSessionIdentity | null;
  /**
   * The turn's durable custody proof (psfn-framework-ccgdz.6): the custody
   * snapshot ref the record-first write returned, plus the lineage facts the
   * hold rules read. Undefined until the turn folds — which, for a model-invoked
   * tool, is ALWAYS the case, because the fold happens after the tool loop
   * returns. In that window the guard derives an unfolded proof from the live
   * lineage below and records the egress as `custodySnapshot: 'pending'`.
   */
  getCurrentTurnCustodyProof: () => TurnEgressCustodyProof | undefined;
  /**
   * The turn this egress belongs to; the delivery record's correlation key.
   * Published BEFORE generation starts, so a mid-turn tool egress has a turn to
   * bind its bytes to. Undefined only outside a turn.
   */
  getActiveTurnId: () => string | undefined;
  /** Durable delivery-record sink; null when no custody store is wired. */
  egressDeliveryRecorder: EgressDeliveryRecorder | null;
}

/**
 * The custody condition this egress is held (or, under `shadow`, merely
 * observed) for, and whether it actually withholds.
 *
 * The layering is deliberate and must not be flattened. `assessDisclosure`
 * ALREADY denies unconditionally on a missing/unclassified lineage, mode
 * independent, and `egress-composition.ts` forbids widening it — so those
 * reasons are recorded as labels on a denial that stands regardless of posture.
 * Only the custody-durability conditions this bead introduces are posture-gated,
 * because they are genuinely new enforcement (design §5: land the hold in
 * shadow first).
 */
function resolveCustodyHold(input: {
  reason: EgressCustodyHoldReason | null;
  composedAllowed: boolean;
  posture: 'shadow' | 'enforce';
}): { withholds: boolean; reason: EgressCustodyHoldReason | null } {
  if (input.reason === null) return { withholds: false, reason: null };
  if (!isCustodyDurabilityHoldReason(input.reason)) {
    // Already governed by the composed decision; never relaxed, never widened.
    return { withholds: !input.composedAllowed, reason: input.reason };
  }
  return { withholds: input.posture === 'enforce', reason: input.reason };
}

export function buildEgressToolGuard(deps: EgressToolGuardDeps): EgressToolGuard | null {
  const gate = deps.intakeSinkGate;
  if (!gate) return null;
  const recorder = deps.egressDeliveryRecorder;

  /**
   * Write one delivery record for this invocation. Content-free: the bytes are
   * reduced to a canonical-JSON digest of the params the tool will actually
   * receive, which is the exact payload the egress carries.
   */
  const recordEgress = async (input: {
    disposition: 'released' | 'held';
    toolCallId: string;
    finalParams: unknown;
    destination: DisclosureDestination | null;
    proof: TurnEgressCustodyProof | undefined;
    turnId: string | undefined;
    outcome: ReturnType<typeof composeEgressDisclosureDecision>['outcome'];
    decisionAllowed: boolean;
    holdReason: EgressCustodyHoldReason | null;
    /** The turn has not folded its custody snapshot yet (the in-turn case). */
    custodySnapshotPending: boolean;
  }): Promise<boolean> => {
    if (!recorder) return true;
    if (input.turnId === undefined) {
      // No turn identity means no correlation key to bind the bytes to. The
      // composed decision already governs release; this must not be silent.
      log.error('Egress delivery record skipped: no active turn identity', {
        toolCallId: input.toolCallId,
        disposition: input.disposition,
      });
      return false;
    }
    // The digest is derived here rather than inside the recorder, so its own
    // failure must be handled here too: `canonicalJsonString` refuses a param
    // object it cannot serialize (a BigInt, a cycle), and letting that throw
    // out of `evaluate` would turn a calm denial into an unhandled rejection in
    // the tool loop. Report it the same way a failed write is reported.
    let contentSha256: string;
    try {
      contentSha256 = egressContentSha256(
        canonicalJsonString(input.finalParams, 'egress tool params'),
      );
    } catch (error) {
      log.error('Egress delivery record skipped: the payload has no canonical digest', {
        toolCallId: input.toolCallId,
        disposition: input.disposition,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const result = await recorder.record({
      surface: 'tool_egress',
      disposition: input.disposition,
      turnId: input.turnId,
      attemptRef: input.toolCallId,
      contentSha256,
      destination: input.destination,
      proof: input.proof,
      outcome: input.outcome,
      decisionAllowed: input.decisionAllowed,
      ...(input.holdReason !== null ? { holdReason: input.holdReason } : {}),
      ...(input.custodySnapshotPending ? { custodySnapshot: 'pending' as const } : {}),
    });
    return result.written;
  };

  return {
    evaluate: async ({ toolCallId, toolName, requiredTokens, params }) => {
      if (!requiredTokens.some(isEgressCapabilityToken)) return null;
      const envelopes = deps.getActiveTurnIntakeEnvelopes();
      const turnIdentity = deps.getActiveTurnSessionIdentity();
      const access = gate.evaluate('tool_egress', envelopes, { toolName }, {
        attemptRef: toolCallId,
        correlationRef: turnIdentity
          ? `${turnIdentity.logicalSessionId}:${toolName}`
          : `unrouted:${toolName}`,
        ...(turnIdentity
          ? {
              sourceChannelId: turnIdentity.sourceChannelId,
              logicalSessionId: turnIdentity.logicalSessionId,
            }
          : {}),
      });
      let sinkAllowed = access.allowed;
      let sinkReason = access.reason;
      if (sinkAllowed) {
        let trifecta;
        try {
          trifecta = gate.assessEgressTrifecta({
            envelopes,
            privateDataInPath: true,
            egressDescription: `tool:${toolName}`,
            ...(turnIdentity
              ? {
                blockedIncidentContext: {
                  sourceChannelId: turnIdentity.sourceChannelId,
                  logicalSessionId: turnIdentity.logicalSessionId,
                  toolName,
                },
              }
              : {}),
          }, {
            toolName,
            ...(turnIdentity
              ? {
                sourceChannelId: turnIdentity.sourceChannelId,
                logicalSessionId: turnIdentity.logicalSessionId,
              }
              : {}),
          });
        } catch (error) {
          // Preserve the security outcome even when its operator-visible
          // incident cannot be written. The raw failure is logged locally;
          // callers receive a fixed, non-sensitive diagnostic alongside the
          // normal calm denial notice, so the failure is not swallowed and
          // the tool is still never invoked.
          log.error('Intake egress sink gate failed closed', {
            toolName,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            allowed: false,
            noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld,
            diagnostic: {
              code: 'intake_sink_gate_evaluation_failed',
              message: 'The outbound action was blocked, but its operator security incident could not be recorded.',
            },
          };
        }
        if (!trifecta.allowed) {
          sinkAllowed = false;
          sinkReason = trifecta.reason;
        }
      }

      // jp36.1.3: compose the outbound disclosure destination check WITH the
      // existing sink gate — never a parallel path. The disclosure check only
      // engages for a positively identified outbound social destination and can
      // only narrow, never widen, the sink gate's verdict. Fail closed: an
      // outward destination with no per-turn lineage is denied; companion-self
      // stays eligible via the decision layer.
      const destination = deriveDisclosureDestination({
        method: toolName,
        params,
        // jp36.6.4: stamp the channel's CURRENT classification epoch onto the
        // derived room destination so jp36.6.3's epoch gate can deny content
        // admitted under a prior epoch. Untracked channels return undefined and
        // the gate stays inert (byte-identical to the pre-epoch runtime).
        resolveChannel: (channelId) => {
          const disclosure = classifyChannelDisclosure(channelId);
          const classificationEpoch = currentChannelClassificationEpoch(channelId);
          return classificationEpoch !== undefined
            ? { ...disclosure, classificationEpoch }
            : disclosure;
        },
      });
      const lineage = deps.getCurrentTurnDisclosureLineage();
      const composed = composeEgressDisclosureDecision({
        sinkAllowed,
        sinkReason,
        lineage,
        destination,
        requiresDisclosureDestination: isDisclosureSocialEgressInvocation({
          method: toolName,
          params,
        }),
      });
      if (composed.disclosureEvaluated) {
        log.debug('Egress disclosure destination check', {
          toolName,
          destinationKind: composed.destination?.kind,
          allowed: composed.allowed,
          outcome: composed.outcome,
          reason: composed.reason,
        });
      }

      // ccgdz.6: fail-closed provenance hold. A proof-requiring outward
      // destination with no custody snapshot, no admitted source, or an
      // unclassified source is held — and either way the decision is recorded.
      // The turn's custody snapshot is folded AFTER the model's tool loop
      // returns, so a model-invoked egress can never see a folded proof. The
      // facts the hold rules read (source count, unclassified source) come from
      // the SAME live lineage the composed decision above was taken against —
      // published before generation started and tightened in place by any
      // admitted tool result — so the two layers never disagree. The missing
      // piece is only the durable ref, and that is what `pending` states.
      const foldedProof = deps.getCurrentTurnCustodyProof();
      const custodySnapshotPending = foldedProof === undefined && lineage !== undefined;
      const proof = foldedProof
        ?? (lineage ? turnEgressCustodyProof(lineage, undefined) : undefined);
      const turnId = deps.getActiveTurnId();
      const custodyHold = resolveCustodyHold({
        reason: evaluateEgressCustodyHold({
          destination: composed.destination,
          proof,
          custodySnapshotPending,
        }),
        composedAllowed: composed.allowed,
        posture: recorder?.enforcementPosture() ?? 'shadow',
      });
      const held = !composed.allowed || custodyHold.withholds;
      if (held) {
        // A denial with no custody condition is an ordinary sink-gate or
        // unresolvable-destination refusal. Those are already audited by the
        // gate that made them, nothing was delivered, and no custody claim was
        // staked — so they do not manufacture a delivery row with an invented
        // reason. Only a stated chain-of-custody condition is recorded here.
        const recordedReason = custodyHold.reason
          ?? (destinationRequiresCustodyProof(composed.destination)
            ? 'lineage_missing'
            : null);
        if (recordedReason !== null) {
          log.warn('Egress held: incomplete chain of custody', {
            toolName,
            destinationKind: composed.destination?.kind,
            holdReason: recordedReason,
            posture: recorder?.enforcementPosture() ?? 'shadow',
          });
          await recordEgress({
            disposition: 'held',
            toolCallId,
            finalParams: params,
            destination: composed.destination,
            proof,
            turnId,
            outcome: composed.outcome,
            decisionAllowed: composed.allowed,
            holdReason: recordedReason,
            custodySnapshotPending,
          });
        }
        return { allowed: false, noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld };
      }

      return {
        allowed: true,
        noticeText: '',
        // Record-first: the gate awaits this with the post-hook params, so the
        // durable record binds the bytes that actually leave.
        commit: async (finalParams: unknown): Promise<EgressToolGuardCommit> => {
          const written = await recordEgress({
            disposition: 'released',
            toolCallId,
            finalParams,
            destination: composed.destination,
            proof,
            turnId,
            outcome: composed.outcome,
            decisionAllowed: true,
            holdReason: custodyHold.reason,
            custodySnapshotPending,
          });
          if (written || !destinationRequiresCustodyProof(composed.destination)) {
            return { allowed: true, noticeText: '' };
          }
          // Custody-store unavailability holds proof-requiring egress; it never
          // degrades to "send anyway" (design §4 rule 6). Under a shadow
          // posture the failure is observed and the send proceeds.
          if (recorder?.enforcementPosture() !== 'enforce') {
            log.error('Egress released without a durable delivery record (shadow posture)', {
              toolName,
              destinationKind: composed.destination?.kind,
              holdReason: 'custody_store_unavailable',
            });
            return { allowed: true, noticeText: '' };
          }
          log.error('Egress held: the delivery record could not be written', {
            toolName,
            destinationKind: composed.destination?.kind,
            holdReason: 'custody_store_unavailable',
          });
          return { allowed: false, noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld };
        },
      };
    },
  };
}
