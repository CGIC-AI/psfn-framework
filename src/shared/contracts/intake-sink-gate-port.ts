// ── Cognition Intake Firewall: sink-gate port contracts (psfn-framework-kbdvl.1) ──
//
// Core-owned structural port and pure egress-capability classification used by
// companion turns, session assembly, memory writes, and shard foldback without
// depending on the host CogSec sink-gate implementation.

import type {
  IntakeEnvelopeSnapshot,
  IntakeSink,
} from './intake-envelope.js';
import type { IntakeTrifectaEnforcement } from '../../system/config/intake-policy-config.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';

export interface IntakeSinkGateDecision {
  sink: IntakeSink;
  /**
   * Mode-aware final answer for ordinary sink access. Shadow mode allows (the
   * verdict is still audited); enforce mode allows only on an 'allow' verdict.
   * Lethal-trifecta assessments use the stricter contract below.
   */
  allowed: boolean;
  /** Mode-independent policy evaluation. */
  verdict: 'allow' | 'deny';
  mode: 'shadow' | 'enforce';
  /** Human-auditable reason for the verdict. */
  reason: string;
  /** True when the content reached the sink without any envelope. */
  unscreened: boolean;
  /** Envelope ids that produced a deny verdict (empty for allow/unscreened). */
  deniedEnvelopeIds: readonly string[];
}

export type OrdinaryIntakeSinkDenialNotificationStatus =
  | 'delivered'
  | 'failed'
  | 'unconfigured';

export interface OrdinaryIntakeSinkDenialEvidence {
  caseId: string;
  incident: 'created' | 'deduplicated';
  /** Settles after the canonical NotificationPort attempt and durable evidence update. */
  notification: Promise<{
    status: OrdinaryIntakeSinkDenialNotificationStatus;
    durableEvidence: 'recorded' | 'failed';
  }>;
}

/**
 * Content-free routing supplied by a production sink. `correlationRef` is
 * hashed at the gate and never reaches persistence or notification. When it
 * is absent, the denied envelope ids provide the stable replay correlation.
 */
export interface IntakeSinkDenialRouteContext {
  /** Stable identity of this invocation/turn/request. True replays reuse it. */
  attemptRef: string;
  /** Stable identity of one operation within the attempt (for example fact index). */
  correlationRef?: string;
  sourceChannelId?: string;
  logicalSessionId?: string;
}

/** Validated, content-free context delivered to the incident recorder. */
export interface OrdinaryIntakeSinkDenialContext {
  correlationId: string;
  sourceChannelId?: string;
  logicalSessionId?: string;
}

export interface OrdinaryIntakeSinkDenial {
  decision: IntakeSinkGateDecision;
  context: OrdinaryIntakeSinkDenialContext;
}

export type OrdinaryIntakeSinkDenialRecorder = (
  denial: OrdinaryIntakeSinkDenial,
) => OrdinaryIntakeSinkDenialEvidence;

export interface IntakeEgressTrifectaAssessment {
  /** True when untrusted content + private data + egress all meet in this path. */
  triggered: boolean;
  /** Strongest enforcement across the triggering envelopes' tiers; null when not triggered. */
  enforcement: IntakeTrifectaEnforcement | null;
  verdict: 'allow' | 'deny' | 'review';
  /**
   * Mode-aware, with one fail-closed exception: a hard-enforcement deny
   * blocks in BOTH modes (hrmrq.77) — shadow mode never fails the lethal
   * trifecta open. Soft verdicts allow (with review) in both modes.
   */
  allowed: boolean;
  /** True on a soft verdict: egress proceeds but is flagged for operator review. */
  reviewRequired: boolean;
  mode: 'shadow' | 'enforce';
  reason: string;
  /** Envelope ids whose content participates in the trifecta path. */
  envelopeIds: readonly string[];
}

export interface BlockedEgressTrifectaContext {
  /** Canonical route identity used to place the incident in the operator work surface. */
  sourceChannelId: string;
  logicalSessionId: string;
  /** Structural tool identity only; arguments and content must never cross this seam. */
  toolName: string;
}

export interface BlockedEgressTrifectaIncident {
  assessment: IntakeEgressTrifectaAssessment;
  context: BlockedEgressTrifectaContext;
}

/**
 * Capability tokens that constitute EGRESS (data leaving the companion's
 * boundary): outbound notifications, git pushes/PRs, arbitrary shell/code
 * execution, world effectors, and process/agent spawning. Web fetch is
 * ingress and deliberately absent.
 */
export const INTAKE_EGRESS_CAPABILITY_TOKENS: readonly CapabilityToken[] = [
  'external.discord',
  'external.email',
  'external.web',
  'external.companion',
  'external.mcp',
  'git.write',
  'repl.execute',
  'world.control',
  'subagent.spawn',
  'shard.spawn',
  'lifecycle.restart',
  'lifecycle.rebuild',
];

export function isEgressCapabilityToken(token: CapabilityToken): boolean {
  return INTAKE_EGRESS_CAPABILITY_TOKENS.includes(token);
}

export interface IntakeSinkGateAuditEvent {
  kind: 'sink_access' | 'egress_trifecta';
  sink: IntakeSink;
  mode: 'shadow' | 'enforce';
  verdict: string;
  allowed: boolean;
  reason: string;
  /** Free-form audit context supplied by the sink call site. */
  context: Readonly<Record<string, unknown>>;
}

export interface IntakeSinkGate {
  readonly mode: 'shadow' | 'enforce';
  /**
   * Gate one sink consumption. `envelopes` empty = unscreened content
   * (explicit per-sink policy default). `context` is audit-only.
   */
  evaluate(
    sink: IntakeSink,
    envelopes: readonly IntakeEnvelopeSnapshot[],
    context?: Readonly<Record<string, unknown>>,
    denialRoute?: IntakeSinkDenialRouteContext,
  ): IntakeSinkGateDecision;
  /** Trifecta assessment for the tool-egress sink. */
  assessEgressTrifecta(
    input: {
      envelopes: readonly IntakeEnvelopeSnapshot[];
      privateDataInPath: boolean;
      egressDescription: string;
      /** Required runtime identity when a hard block must become a durable case. */
      blockedIncidentContext?: BlockedEgressTrifectaContext;
    },
    context?: Readonly<Record<string, unknown>>,
  ): IntakeEgressTrifectaAssessment;
}
