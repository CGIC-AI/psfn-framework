// ── Cognition Intake Firewall: sink gates (htm9.3) ──
//
// Layer 4 of the intake firewall — the actual security boundary. Every
// consequential sink (prompt assembly, memory write, wiki write, persona
// mutation, trust mutation, tool egress) checks intake-envelope state/labels
// through this ONE module before consuming content. Policy lives in
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
//   true — observe-only rollout, zero behavior change.
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
  type IntakePolicyConfig,
  type IntakeTrifectaEnforcement,
} from '../../../system/config/intake-policy-config.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';

const log = createComponentLogger('IntakeSinkGates');

// ── Decision types ──

export interface IntakeSinkGateDecision {
  sink: IntakeSink;
  /**
   * Mode-aware final answer. Shadow mode always allows (the verdict is still
   * audited); enforce mode allows only on an 'allow' verdict.
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

export interface IntakeEgressTrifectaAssessment {
  /** True when untrusted content + private data + egress all meet in this path. */
  triggered: boolean;
  /** Strongest enforcement across the triggering envelopes' tiers; null when not triggered. */
  enforcement: IntakeTrifectaEnforcement | null;
  verdict: 'allow' | 'deny' | 'review';
  /** Mode-aware: shadow always allows; enforce denies only on a hard verdict. */
  allowed: boolean;
  /** True on a soft verdict: egress proceeds but is flagged for operator review. */
  reviewRequired: boolean;
  mode: 'shadow' | 'enforce';
  reason: string;
  /** Envelope ids whose content participates in the trifecta path. */
  envelopeIds: readonly string[];
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
  if (policy.mode === 'off') {
    throw new Error(
      "Intake sink gates must not be evaluated with mode 'off'; "
      + 'composition sites skip gate construction entirely when the firewall is off',
    );
  }
  return policy.mode;
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
  const mode = assertGateMode(policy);
  if (envelopes.length === 0) {
    const rule = sinkRuleForSink(policy, sink);
    return finalizeDecision({
      sink,
      mode,
      verdict: rule.unscreened,
      reason: `no intake envelope covers this content; sink policy default '${rule.unscreened}' applies`,
      unscreened: true,
      deniedEnvelopeIds: [],
    });
  }

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
  let strongestTier: IntakeSourceRiskTier = contentInPath[0].sourceRiskTier;
  for (const envelope of contentInPath) {
    if (trifectaEnforcementForTier(policy, envelope.sourceRiskTier) === 'hard') {
      enforcement = 'hard';
    }
    if (compareIntakeSourceRiskTiers(envelope.sourceRiskTier, strongestTier) > 0) {
      strongestTier = envelope.sourceRiskTier;
    }
  }

  const verdict = enforcement === 'hard' ? 'deny' : 'review';
  const reason = `lethal trifecta at ${input.egressDescription}: `
    + `${String(contentInPath.length)} enveloped item(s) (strongest tier '${strongestTier}') `
    + `+ private data + egress; enforcement '${enforcement}' per trifecta.enforcementByTier`;
  return {
    triggered: true,
    enforcement,
    verdict,
    allowed: mode === 'shadow' ? true : verdict !== 'deny',
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
  ): IntakeSinkGateDecision;
  /** Trifecta assessment for the tool-egress sink. */
  assessEgressTrifecta(
    input: {
      envelopes: readonly IntakeEnvelopeSnapshot[];
      privateDataInPath: boolean;
      egressDescription: string;
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
}

export function createIntakeSinkGate(options: IntakeSinkGateOptions): IntakeSinkGate {
  const { policy, actor, onAudit } = options;
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
    evaluate(sink, envelopes, context = {}) {
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
      return decision;
    },
    assessEgressTrifecta(input, context = {}) {
      const assessment = evaluateEgressTrifecta(policy, input);
      audit({
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
      });
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
  options: IntakeSinkGateOptions,
): IntakeSinkGate | null {
  if (options.policy.mode === 'off') {
    log.warn("Intake firewall mode is 'off': no sink gates are wired at any consequential sink");
    return null;
  }
  return createIntakeSinkGate(options);
}
