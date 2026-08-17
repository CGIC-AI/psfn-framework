// ── Cognition Intake Firewall: sink gates (htm9.3) ──
//
// Layer 4 of the intake firewall — the actual security boundary. Every
// consequential sink (prompt assembly, memory write, wiki write, managed
// skill write, persona mutation, trust mutation, tool egress) checks
// intake-envelope state/labels through this ONE module before consuming
// content. Policy lives in
// intake-policy.json (`sinkGates` section); this module only interprets it.
//
// STRUCTURAL RULES (not policy — never configurable):
// - Quarantined content is invisible to ALL sinks: an envelope whose state is
//   not sink-consumable (released / released_sanitized / human_released /
//   human_released_sanitized) is denied at every sink.
// - Tier-N content may INFORM but never INSTRUCT higher-tier state mutation:
//   the per-sink `maxSourceRiskTier` cap encodes which tiers may drive which
//   sinks; state-mutation sinks cap lower than inform sinks.
// - Lethal-trifecta invariant (Willison): untrusted content + private data +
//   egress never meet in one uncontrolled path. HARD (deny) for
//   public/untrusted source tiers, SOFT (allow + operator review flag) for
//   trusted tiers — per the policy's trifecta.enforcementByTier table.
//
// MODE SEMANTICS (same split as screening.ts):
// - 'shadow':  every gate is evaluated and AUDITED, but `allowed` is always
//   true — observe-only rollout, zero behavior change. ONE exception
//   (psfn-framework-hrmrq.77): a HARD-enforcement lethal-trifecta deny blocks
//   even in shadow mode. The trifecta's hard tier exists precisely for the
//   most dangerous combination (untrusted content + private data + egress);
//   letting the staged-rollout observe mode fail that class open contradicts
//   the fail-closed doctrine, so per-tier enforcement 'hard' overrides the
//   global shadow mode for egress-trifecta assessments only.
// - 'enforce': `allowed` honors the verdict; deny paths are fail-closed with
//   auditable reasons.
// - 'off':     no gate is constructed (maybe-create returns null); callers
//   treat a missing gate as pre-firewall legacy behavior.
//
// UNSCREENED CONTENT: content reaching a gated sink WITHOUT an envelope
// (legacy paths that predate envelope stamping) is resolved per the sink's
// explicit `unscreened` policy default — fail-open is acceptable ONLY in
// shadow mode; in enforce mode the policy default decides. There is no
// implicit default: the owner-file validator requires every sink to map one.

import { createHash } from 'node:crypto';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  isIntakeSinkConsumableState,
  type IntakeEnvelopeSnapshot,
  type IntakeRiskLabel,
  type IntakeSink,
} from '../../../shared/contracts/intake-envelope.js';
import {
  compareIntakeSourceRiskTiers,
  INTAKE_SOURCE_RISK_TIERS,
} from '../../../shared/contracts/intake-envelope.js';
import type { IntakeSourceRiskTier } from '../../../shared/contracts/intake-envelope.js';
import {
  sinkRuleForSink,
  trifectaEnforcementForTier,
  intakeModeEnforcementPosture,
  type IntakePolicyConfig,
  type IntakeTrifectaEnforcement,
} from '../../../system/config/intake-policy-config.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';

const log = createComponentLogger('IntakeSinkGates');

// ── Decision types ──

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
interface OrdinaryIntakeSinkDenialContext {
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
 * ingress and deliberately absent. Kept here (cogsec domain) so the egress
 * leg of the trifecta has one auditable definition.
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

// ── Pure evaluation ──

function assertGateMode(policy: IntakePolicyConfig): 'shadow' | 'enforce' {
  // The sink gate enforces external content under boundary and strict (both
  // enforce external ingress + registered outbound); shadow observes only.
  // The canonical global mode never includes 'off', so no off-guard remains.
  return intakeModeEnforcementPosture(policy.mode);
}

function finalizeDecision(input: {
  sink: IntakeSink;
  mode: 'shadow' | 'enforce';
  verdict: 'allow' | 'deny';
  reason: string;
  unscreened: boolean;
  deniedEnvelopeIds: readonly string[];
}): IntakeSinkGateDecision {
  return {
    sink: input.sink,
    allowed: input.mode === 'shadow' ? true : input.verdict === 'allow',
    verdict: input.verdict,
    mode: input.mode,
    reason: input.reason,
    unscreened: input.unscreened,
    deniedEnvelopeIds: [...input.deniedEnvelopeIds],
  };
}

function evaluateEnvelopeAtSink(
  policy: IntakePolicyConfig,
  sink: IntakeSink,
  envelope: IntakeEnvelopeSnapshot,
): { verdict: 'allow' | 'deny'; reason: string } {
  // Structural rule: quarantined/unrouted content is invisible to ALL sinks.
  if (!isIntakeSinkConsumableState(envelope.state)) {
    return {
      verdict: 'deny',
      reason: `envelope ${envelope.envelopeId} state '${envelope.state}' is not sink-consumable `
        + '(quarantined content is invisible to sinks)',
    };
  }
  const rule = sinkRuleForSink(policy, sink);
  // Inform-not-instruct: content riskier than the sink's tier cap never
  // drives the sink.
  if (compareIntakeSourceRiskTiers(envelope.sourceRiskTier, rule.maxSourceRiskTier) > 0) {
    return {
      verdict: 'deny',
      reason: `envelope ${envelope.envelopeId} tier '${envelope.sourceRiskTier}' exceeds sink cap `
        + `'${rule.maxSourceRiskTier}' (tier order: ${INTAKE_SOURCE_RISK_TIERS.join(' < ')})`,
    };
  }
  const deniedLabels = envelope.riskLabels.filter(
    (label: IntakeRiskLabel) => rule.denyRiskLabels.includes(label),
  );
  if (deniedLabels.length > 0) {
    return {
      verdict: 'deny',
      reason: `envelope ${envelope.envelopeId} carries risk labels denied at this sink: `
        + deniedLabels.join('+'),
    };
  }
  return {
    verdict: 'allow',
    reason: `envelope ${envelope.envelopeId} released (state '${envelope.state}', `
      + `tier '${envelope.sourceRiskTier}')`,
  };
}

/**
 * Evaluate one sink against the intake envelopes covering the content.
 * An EMPTY envelope list means unscreened content: the sink's explicit
 * `unscreened` policy default applies. Multiple envelopes (e.g. a message
 * body plus attachments) are all checked; one denied envelope denies the
 * whole consumption (fail closed).
 */
export function evaluateSinkAccess(
  policy: IntakePolicyConfig,
  sink: IntakeSink,
  envelopes: readonly IntakeEnvelopeSnapshot[],
): IntakeSinkGateDecision {
  const globalMode = assertGateMode(policy);
  if (envelopes.length === 0) {
    const rule = sinkRuleForSink(policy, sink);
    return finalizeDecision({
      sink,
      mode: globalMode,
      verdict: rule.unscreened,
      reason: `no intake envelope covers this content; sink policy default '${rule.unscreened}' applies`,
      unscreened: true,
      deniedEnvelopeIds: [],
    });
  }
  // A surface-resolved shadow/post-pass envelope carries its posture across
  // the message boundary. One enforcing envelope is sufficient to retain the
  // global enforce behavior; only an entirely observe-only set may pass a
  // policy denial for telemetry.
  const mode = envelopes.every(envelope => envelope.enforcementPosture === 'shadow')
    ? 'shadow'
    : envelopes.some(envelope => envelope.enforcementPosture === 'enforce')
      ? 'enforce'
      : globalMode;

  const denials: Array<{ envelopeId: string; reason: string }> = [];
  for (const envelope of envelopes) {
    const evaluated = evaluateEnvelopeAtSink(policy, sink, envelope);
    if (evaluated.verdict === 'deny') {
      denials.push({ envelopeId: envelope.envelopeId, reason: evaluated.reason });
    }
  }
  if (denials.length > 0) {
    return finalizeDecision({
      sink,
      mode,
      verdict: 'deny',
      reason: denials.map((denial) => denial.reason).join('; '),
      unscreened: false,
      deniedEnvelopeIds: denials.map((denial) => denial.envelopeId),
    });
  }
  return finalizeDecision({
    sink,
    mode,
    verdict: 'allow',
    reason: `${String(envelopes.length)} envelope(s) released and within sink policy`,
    unscreened: false,
    deniedEnvelopeIds: [],
  });
}

/**
 * Lethal-trifecta assessment at the tool-egress sink. The three legs:
 * 1. external (enveloped) content in the turn's path,
 * 2. private data in the same path,
 * 3. an egress-capable invocation (implied by calling this).
 *
 * In enforce mode only envelopes in a sink-consumable state count as
 * "content in the path" (quarantined content was withheld upstream); in
 * shadow mode every envelope counts because shadow never withholds.
 * Enforcement strength is the strongest tier mapping across participating
 * envelopes: 'hard' denies, 'soft' allows with a review flag — never a
 * silent pass.
 *
 * A 'hard' deny blocks REGARDLESS of the global mode (hrmrq.77): shadow mode
 * is observe-only for everything else, but the lethal-trifecta hard tier is
 * the one class that must never fail open during staged rollout — in shadow
 * mode the untrusted content was delivered (never withheld), so the trifecta
 * is fully armed exactly when the observe-only mode would wave it through.
 */
export function evaluateEgressTrifecta(
  policy: IntakePolicyConfig,
  input: {
    envelopes: readonly IntakeEnvelopeSnapshot[];
    privateDataInPath: boolean;
    /** Auditable description of the egress, e.g. `tool:notify`. */
    egressDescription: string;
  },
): IntakeEgressTrifectaAssessment {
  const mode = assertGateMode(policy);
  const contentInPath = input.envelopes.filter(
    (envelope) => mode === 'shadow' || isIntakeSinkConsumableState(envelope.state),
  );
  const envelopeIds = contentInPath.map((envelope) => envelope.envelopeId);

  if (contentInPath.length === 0 || !input.privateDataInPath) {
    const missingLeg = contentInPath.length === 0
      ? 'no external enveloped content in the path'
      : 'no private data in the path';
    return {
      triggered: false,
      enforcement: null,
      verdict: 'allow',
      allowed: true,
      reviewRequired: false,
      mode,
      reason: `trifecta not triggered for ${input.egressDescription}: ${missingLeg}`,
      envelopeIds,
    };
  }

  let enforcement: IntakeTrifectaEnforcement = 'soft';
  const firstEnvelope = contentInPath[0];
  if (!firstEnvelope) {
    return {
      triggered: false,
      enforcement: null,
      verdict: 'allow',
      allowed: true,
      reviewRequired: false,
      mode,
      reason: `trifecta evaluation could not resolve content path for ${input.egressDescription}`,
      envelopeIds,
    };
  }
  let strongestTier: IntakeSourceRiskTier = firstEnvelope.sourceRiskTier;
  for (const envelope of contentInPath) {
    if (trifectaEnforcementForTier(policy, envelope.sourceRiskTier) === 'hard') {
      enforcement = 'hard';
    }
    if (compareIntakeSourceRiskTiers(envelope.sourceRiskTier, strongestTier) > 0) {
      strongestTier = envelope.sourceRiskTier;
    }
  }

  const verdict = enforcement === 'hard' ? 'deny' : 'review';
  // Fail closed (hrmrq.77): a hard-enforcement deny blocks in BOTH modes.
  // Shadow mode stays observe-only for every other gate, but the lethal
  // trifecta's hard tier must never be waved through during staged rollout.
  const shadowOverridden = mode === 'shadow' && verdict === 'deny';
  const reason = `lethal trifecta at ${input.egressDescription}: `
    + `${String(contentInPath.length)} enveloped item(s) (strongest tier '${strongestTier}') `
    + `+ private data + egress; enforcement '${enforcement}' per trifecta.enforcementByTier`
    + (shadowOverridden ? "; enforcement 'hard' overrides shadow mode (fail closed)" : '');
  return {
    triggered: true,
    enforcement,
    verdict,
    allowed: verdict !== 'deny',
    reviewRequired: verdict === 'review',
    mode,
    reason,
    envelopeIds,
  };
}

// ── Gate service (bound policy + audit) ──

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

export interface IntakeSinkGateOptions {
  policy: IntakePolicyConfig;
  /** Acting principal for audit records, e.g. 'agent:intake-sink-gate'. */
  actor: string;
  /** Optional additional audit sink (Garden/event-store wiring); logging always happens. */
  onAudit?: (event: IntakeSinkGateAuditEvent) => void;
  /** Required in production: durable incident + canonical alert for ordinary enforce denials. */
  onOrdinarySinkDenial?: OrdinaryIntakeSinkDenialRecorder;
  /**
   * Dedicated side effect for a blocked hard lethal-trifecta decision. Unlike
   * the best-effort telemetry hook above, callback failures propagate so a
   * security block cannot silently lose its durable operator trace.
   */
  onBlockedEgressTrifecta?: (incident: BlockedEgressTrifectaIncident) => void;
}

export type RuntimeIntakeSinkGateOptions = IntakeSinkGateOptions & Required<Pick<
  IntakeSinkGateOptions,
  'onBlockedEgressTrifecta' | 'onOrdinarySinkDenial'
>>;

function optionalContextId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`Ordinary intake sink denial context has empty ${field}`);
  return normalized;
}

function buildOrdinaryDenialContext(
  decision: IntakeSinkGateDecision,
  route: IntakeSinkDenialRouteContext | undefined,
): OrdinaryIntakeSinkDenialContext {
  const correlationRef = optionalContextId(route?.correlationRef, 'correlationRef');
  const attemptRef = optionalContextId(route?.attemptRef, 'attemptRef');
  const sourceChannelId = optionalContextId(route?.sourceChannelId, 'sourceChannelId');
  const logicalSessionId = optionalContextId(route?.logicalSessionId, 'logicalSessionId');
  const envelopeCorrelation = [...decision.deniedEnvelopeIds].sort().join('\u0000');
  if (!attemptRef) {
    throw new Error(
      `Ordinary enforce-mode ${decision.sink} denial is missing a stable per-attempt reference`,
    );
  }
  if (!correlationRef && !envelopeCorrelation) {
    throw new Error(
      `Ordinary enforce-mode ${decision.sink} denial is missing a stable correlation reference`,
    );
  }
  const digest = createHash('sha256')
    .update(decision.sink, 'utf8')
    .update('\u0000', 'utf8')
    .update(attemptRef, 'utf8')
    .update('\u0000', 'utf8')
    .update(correlationRef ?? '', 'utf8')
    .update('\u0000', 'utf8')
    .update(sourceChannelId ?? '', 'utf8')
    .update('\u0000', 'utf8')
    .update(logicalSessionId ?? '', 'utf8')
    .update('\u0000', 'utf8')
    .update(correlationRef ? '' : envelopeCorrelation, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return {
    correlationId: `cogsec_sinkdenial_${digest}`,
    ...(sourceChannelId ? { sourceChannelId } : {}),
    ...(logicalSessionId ? { logicalSessionId } : {}),
  };
}

export function createIntakeSinkGate(options: IntakeSinkGateOptions): IntakeSinkGate {
  const {
    policy,
    actor,
    onAudit,
    onOrdinarySinkDenial,
    onBlockedEgressTrifecta,
  } = options;
  const mode = assertGateMode(policy);

  function audit(event: IntakeSinkGateAuditEvent): void {
    const payload = {
      actor,
      kind: event.kind,
      sink: event.sink,
      mode: event.mode,
      verdict: event.verdict,
      allowed: event.allowed,
      reason: event.reason,
      ...event.context,
    };
    if (event.verdict === 'allow') {
      log.debug('Intake sink gate decision', payload);
    } else {
      // Deny and review verdicts are auditable security decisions even when
      // shadow mode lets the content through.
      log.warn('Intake sink gate decision', payload);
    }
    if (onAudit) {
      // Audit hook failures must be visible, but a broken hook must not turn
      // an allow into a silent block or vice versa — the decision stands.
      try {
        onAudit(event);
      } catch (error) {
        log.error('Intake sink gate audit hook failed', {
          actor,
          sink: event.sink,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    mode,
    evaluate(sink, envelopes, context = {}, denialRoute) {
      const decision = evaluateSinkAccess(policy, sink, envelopes);
      audit({
        kind: 'sink_access',
        sink,
        mode: decision.mode,
        verdict: decision.verdict,
        allowed: decision.allowed,
        reason: decision.reason,
        context: {
          ...context,
          unscreened: decision.unscreened,
          ...(decision.deniedEnvelopeIds.length > 0
            ? { deniedEnvelopeIds: decision.deniedEnvelopeIds }
            : {}),
        },
      });
      if (
        decision.mode === 'enforce'
        && decision.verdict === 'deny'
        && !decision.allowed
        && onOrdinarySinkDenial
      ) {
        onOrdinarySinkDenial({
          decision,
          context: buildOrdinaryDenialContext(decision, denialRoute),
        });
      }
      return decision;
    },
    assessEgressTrifecta(input, context = {}) {
      const assessment = evaluateEgressTrifecta(policy, input);
      const event: IntakeSinkGateAuditEvent = {
        kind: 'egress_trifecta',
        sink: 'tool_egress',
        mode: assessment.mode,
        verdict: assessment.verdict,
        allowed: assessment.allowed,
        reason: assessment.reason,
        context: {
          ...context,
          triggered: assessment.triggered,
          ...(assessment.enforcement ? { enforcement: assessment.enforcement } : {}),
          ...(assessment.envelopeIds.length > 0 ? { envelopeIds: assessment.envelopeIds } : {}),
        },
      };
      audit(event);
      if (
        !assessment.allowed
        && assessment.verdict === 'deny'
        && assessment.enforcement === 'hard'
        && onBlockedEgressTrifecta
      ) {
        if (!input.blockedIncidentContext) {
          throw new Error('Hard egress-trifecta block is missing durable incident context');
        }
        onBlockedEgressTrifecta({
          assessment,
          context: input.blockedIncidentContext,
        });
      }
      return assessment;
    },
  };
}

/**
 * Returns null when the firewall mode is 'off' (no sink gating anywhere);
 * otherwise constructs the bound gate. Mirrors
 * maybeCreateIntakeScreeningService (screening.ts).
 */
export function maybeCreateIntakeSinkGate(
  options: RuntimeIntakeSinkGateOptions,
): IntakeSinkGate | null {
  if (typeof options.onBlockedEgressTrifecta !== 'function') {
    throw new Error('Intake sink-gate runtime requires a durable hard-block incident recorder');
  }
  if (typeof options.onOrdinarySinkDenial !== 'function') {
    throw new Error('Intake sink-gate runtime requires a durable ordinary-denial incident recorder');
  }
  return createIntakeSinkGate(options);
}
