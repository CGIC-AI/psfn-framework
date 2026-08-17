// ── Egress tool guard (CogSec sink + disclosure composition) ──
// Extracted from SubstrateAgent (charter 12.1 split, emh3p.2). The guard
// composes the intake sink gate WITH the outbound disclosure destination
// check — never a parallel path. The disclosure check only engages for a
// positively identified outbound social destination and can only narrow,
// never widen, the sink gate's verdict. Fail closed: an outward destination
// with no per-turn lineage is denied; companion-self stays eligible via the
// decision layer.

import type { EgressToolGuard } from '../../../system/capabilities/gate.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import { currentChannelClassificationEpoch } from '../../../system/trust/runtime-classification-epochs.js';
import {
  composeEgressDisclosureDecision,
  deriveDisclosureDestination,
  isDisclosureSocialEgressInvocation,
  type DisclosureLineage,
} from '../../cogsec/disclosure/index.js';
import {
  isEgressCapabilityToken,
  type IntakeSinkGate,
} from '../../cogsec/intake/sink-gates.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../cogsec/intake-firewall-notice-templates.js';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { TurnSessionIdentity } from './turn-execution/contracts.js';

const log = createComponentLogger('EgressToolGuard');

export interface EgressToolGuardDeps {
  intakeSinkGate: IntakeSinkGate | null;
  getActiveTurnIntakeEnvelopes: () => readonly IntakeEnvelopeSnapshot[];
  getCurrentTurnDisclosureLineage: () => DisclosureLineage | undefined;
  getActiveTurnSessionIdentity: () => TurnSessionIdentity | null;
}

export function buildEgressToolGuard(deps: EgressToolGuardDeps): EgressToolGuard | null {
  const gate = deps.intakeSinkGate;
  if (!gate) return null;
  return {
    evaluate: ({ toolName, requiredTokens, params }) => {
      if (!requiredTokens.some(isEgressCapabilityToken)) return null;
      const envelopes = deps.getActiveTurnIntakeEnvelopes();
      const turnIdentity = deps.getActiveTurnSessionIdentity();
      const access = gate.evaluate('tool_egress', envelopes, { toolName }, {
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
      const composed = composeEgressDisclosureDecision({
        sinkAllowed,
        sinkReason,
        lineage: deps.getCurrentTurnDisclosureLineage(),
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
      if (!composed.allowed) {
        return { allowed: false, noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld };
      }
      return { allowed: true, noticeText: '' };
    },
  };
}
