// ── Cognition Intake Firewall: gateway L2/L3 escalation port (htm9.6/htm9.7 wiring) ──
//
// The GATEWAY-SIDE implementation of the screening service's
// `IntakeEscalationPort` seam (src/core/cogsec/intake/screening.ts): it wires
// the already-built L2 fast API screener (l2-screener.ts) and L3 heavy
// escalation screener (l3-screener.ts) into the live `screen()` path. All
// ROUTING stays in the evaluators this port wraps — `evaluateL2` owns the
// per-tier escalation thresholds / mandatory tiers / fail-closed actions,
// `evaluateL3` owns the L2-verdict and mandatory-tier triggers — so policy
// knobs are honored in exactly one place.
//
// Placement: gateway process ONLY. The escalation screeners are tool-less
// OpenRouter calls and the gateway is the secret holder; the agent process
// composes its screening service through `maybeCreateIntakeScreeningService`,
// which deliberately has no escalation option (L1-only by construction).
//
// Fail-closed contract:
// - L2 transport/schema failure → the tier's `failClosedActionByTier`:
//   'quarantine' returns a forced-quarantine decision (the screening service
//   holds the item through its normal envelope + quarantine machinery);
//   'l1_labels_only' records the failure on the envelope (never swallowed)
//   and lets the deterministic L1/L1.5 decision stand.
// - Anything that reaches an EXECUTED L3 outcome (screened or failed_closed)
//   goes through `applyL3ScreeningOutcome` — the htm9.7 hard rule: one
//   envelope in 'quarantined'/'released_sanitized', one CogSecEvent, and a
//   quarantine hold for flagged/failed items. A failed CogSecEvent write or
//   quarantine hold THROWS out of this port; the screening service catches
//   that and quarantines (an unauditable L3 result is never delivered).

import type {
  IntakeEscalationContribution,
  IntakeEscalationDecision,
  IntakeEscalationPort,
  IntakeEscalationRequest,
} from '../../../core/cogsec/intake/screening.js';
import type { IntakeQuarantineHoldPort } from '../../../core/cogsec/intake/quarantine-store.js';
import type { IntakeRiskLabel } from '../../../shared/contracts/intake-envelope.js';
import type { CogSecEventStore } from '../../../core/cogsec/events.js';
import type { IntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import type { ScreenerBackend, ScreenerFetch } from './screener-transport.js';
import { evaluateL2, l2ScreeningContribution } from './l2-screener.js';
import { applyL3ScreeningOutcome, evaluateL3 } from './l3-screener.js';

/** Extracted-field key recording a fail-closed L2 screener error on the envelope. */
export const L2_SCREENER_ERROR_FIELD = 'l2_error';

export interface GatewayIntakeEscalationDeps {
  policy: IntakePolicyConfig;
  /** Gateway-resolved OpenRouter connection (secret-bearing, never logged). */
  backend: ScreenerBackend;
  /** Durable quarantine store (htm9.11) for the L3 hard-rule hold. */
  quarantine?: IntakeQuarantineHoldPort;
  /** Every L3 invocation writes an auditable CogSecEvent through this port. */
  cogSecEvents: Pick<CogSecEventStore, 'createEvent'>;
  /** Acting principal for L3 envelope transitions. Default 'gateway:intake-l3'. */
  actor?: string;
  /** Test seam; production uses the global fetch. */
  fetch?: ScreenerFetch;
}

function mergeContributions(
  prior: IntakeEscalationContribution,
  l2: IntakeEscalationContribution | undefined,
): IntakeEscalationContribution {
  if (!l2) return prior;
  return {
    riskLabels: [...new Set([...prior.riskLabels, ...l2.riskLabels])],
    scores: { ...prior.scores, ...l2.scores },
    extractedFields: { ...prior.extractedFields, ...l2.extractedFields },
  };
}

/**
 * Builds the gateway escalation port. Below-threshold, non-mandatory items
 * make ZERO API calls here: `evaluateL2` and `evaluateL3` both check their
 * routing triggers before any transport call, so the trusted-tier fast path
 * pays no escalation latency.
 */
export function createGatewayIntakeEscalationPort(
  deps: GatewayIntakeEscalationDeps,
): IntakeEscalationPort {
  async function escalate(request: IntakeEscalationRequest): Promise<IntakeEscalationDecision> {
    const context = {
      sourceClass: request.sourceClass,
      // The source-list ADJUSTED tier (htm9.13): every escalation threshold,
      // mandatory-tier rule, and fail-closed action routes on this.
      sourceRiskTier: request.sourceRiskTier,
    };

    const l2Outcome = await evaluateL2({
      text: request.text,
      context,
      priorScore: request.priorScore,
      config: deps.policy,
      backend: deps.backend,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });

    let l2ForL3: { labels: readonly IntakeRiskLabel[]; injectionConfidence: number } | undefined;
    let l2Contribution: IntakeEscalationContribution | undefined;
    if (l2Outcome.kind === 'failed_closed') {
      if (l2Outcome.action === 'quarantine') {
        // High-risk tier: an unscreenable item is held, never passed.
        return {
          kind: 'quarantine',
          reason: `l2-fail-closed:${l2Outcome.error}`,
          contribution: {
            riskLabels: [],
            scores: {},
            extractedFields: {
              [L2_SCREENER_ERROR_FIELD]: l2Outcome.error.slice(0, 4096),
            },
          },
        };
      }
      // 'l1_labels_only' (trusted tiers): the L2 verdict is dropped, the
      // failure is recorded on the envelope (visible, never swallowed), and
      // mandatory-tier L3 routing below is still consulted.
      l2Contribution = {
        riskLabels: [],
        scores: {},
        extractedFields: { [L2_SCREENER_ERROR_FIELD]: l2Outcome.error.slice(0, 4096) },
      };
    } else if (l2Outcome.kind === 'classified' || l2Outcome.kind === 'escalate_l3') {
      l2ForL3 = {
        labels: l2Outcome.classification.labels,
        injectionConfidence: l2Outcome.classification.injectionConfidence,
      };
      l2Contribution = l2ScreeningContribution(l2Outcome.classification);
    }
    // kind 'skipped': below threshold and not mandatory — no L2 verdict.

    // evaluateL3 owns the escalation trigger (L2 flag, L2 confidence at/above
    // the tier threshold, or an L3-mandatory tier). It returns 'skipped' with
    // zero API calls when nothing triggers — including after a skipped or
    // failed L2, where only the mandatory-tier route can still escalate.
    const l3Outcome = await evaluateL3({
      text: request.text,
      context,
      ...(l2ForL3 ? { l2: l2ForL3 } : {}),
      config: deps.policy,
      backend: deps.backend,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });

    if (l3Outcome.kind === 'skipped') {
      if (l2Contribution) {
        return { kind: 'contribution', contribution: l2Contribution };
      }
      return {
        kind: 'skipped',
        reason: `l2 ${l2Outcome.kind}; l3 ${l3Outcome.reason}`,
      };
    }

    // ── htm9.7 hard rule: an EXECUTED L3 outcome (screened or failed_closed)
    // becomes one envelope + one CogSecEvent + a quarantine hold when held.
    // Throws (caught by the screening service, which quarantines) when the
    // CogSecEvent write or the quarantine hold fails.
    const result = applyL3ScreeningOutcome({
      text: request.text,
      sourceClass: request.sourceClass,
      origin: request.origin,
      sourceChannelId: request.sourceChannelId ?? `intake:${request.sourceClass}`,
      outcome: l3Outcome,
      config: deps.policy,
      cogSecEvents: deps.cogSecEvents,
      ...(deps.quarantine ? { quarantine: deps.quarantine } : {}),
      ...(request.canonicalContactId !== undefined
        ? { canonicalContactId: request.canonicalContactId }
        : {}),
      ...(deps.actor ? { actor: deps.actor } : {}),
      ...(request.subject ? { subject: request.subject } : {}),
      sourceRiskTier: request.sourceRiskTier,
      priorContribution: mergeContributions(request.priorContribution, l2Contribution),
      atMs: request.atMs,
    });
    return {
      kind: 'final',
      result: {
        envelope: result.envelope,
        snapshot: result.snapshot,
        action: result.action,
        effectiveText: result.effectiveText,
        withheld: result.withheld,
        cogSecCaseId: result.cogSecCaseId,
      },
    };
  }

  return { escalate };
}
