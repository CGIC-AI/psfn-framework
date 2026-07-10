// ── Cognition Intake Firewall: intake screening service (htm9.2) ──
//
// The wiring keystone between the already-built pieces: it consumes the L1
// deterministic scanner pipeline (htm9.4), the gateway-side L1.5 injection
// scorer (htm9.5) when provided, and the gateway-side L2/L3 escalation port
// (htm9.6/htm9.7) when provided; it produces an IntakeEnvelope (htm9.1) for
// every screened item, records an auditable screening decision, and routes
// the envelope through its post-screening state.
//
// MODE SEMANTICS (intake-policy.json `mode`):
// - 'off':     no service is constructed (see maybe-create helpers at the
//              composition sites); no envelopes exist.
// - 'shadow':  envelopes are created, screened, journaled, and LOGGED, but
//              `effectiveText` is always the original input — observe-only
//              rollout, zero behavior change for the companion.
// - 'enforce': `effectiveText` honors the decision — 'sanitize' substitutes the
//              L1 sanitized text, 'quarantine'/'block' substitutes the fixed
//              operator-reviewed withheld-content placeholder (htm9.12 wording
//              contract), so quarantined content never reaches prompt, memory
//              extraction, or emotion appraisal.
//
// DECISION AUTHORITY: this module owns only the interim per-item screening
// decision derived from L1 labels + the L1.5 score threshold for the source's
// risk tier. Sink-gate ENFORCEMENT policy (per-sink gates, held-item store,
// human release flow) is htm9.3 and consumes the envelopes produced here.
//
// The L1.5 score never quarantines alone (known over-defense — InjecGuard,
// arXiv 2410.22770): uncorroborated, an above-threshold score downgrades to a
// 'sanitize' decision so the signal is recorded and the text is normalized,
// but nothing is withheld on the classifier's word alone.

import { createHash } from 'node:crypto';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  createIntakeEnvelope,
  postScreeningStateForDecision,
  snapshotIntakeEnvelope,
  transitionIntakeEnvelope,
  type IntakeDecision,
  type IntakeDecisionAction,
  type IntakeEnvelope,
  type IntakeEnvelopeSnapshot,
  type IntakeEnvelopeSubject,
  type IntakeRiskLabel,
  type IntakeSourceClass,
  type IntakeSourceRiskTier,
} from '../../../shared/contracts/intake-envelope.js';
import {
  injectionScoreThresholdForTier,
  type IntakePolicyConfig,
} from '../../../system/config/intake-policy-config.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../intake-firewall-notice-templates.js';
import {
  INTAKE_QUARANTINE_RISK_LABELS,
  INTAKE_SANITIZE_RISK_LABELS,
} from './risk-label-families.js';
import {
  INTAKE_MARKING_SOURCE_CLASSES,
  resolveMarkingPlan,
  type IntakeMarkingPlan,
} from './marking.js';
import {
  adjustSourceRiskTierForSourceLists,
  matchIntakeSourceLists,
  type AdjustedSourceRiskTier,
} from './source-lists.js';
import {
  createIntakeL1Scanner,
  type IntakeL1Scanner,
  type IntakeL1ScannerConfig,
  type IntakeL1ScanReport,
  type IntakeScanScope,
} from './scanners/index.js';
import type { IntakeQuarantineHoldPort } from './quarantine-store.js';

export { INTAKE_QUARANTINE_RISK_LABELS, INTAKE_SANITIZE_RISK_LABELS } from './risk-label-families.js';

const log = createComponentLogger('IntakeScreening');

// ── Ports ──

/**
 * Structural port for the L1.5 injection scorer so this core module never
 * imports gateway internals. The gateway composition adapts
 * `createInjectionClassifier(...)` (src/boundary/gateway/intake/
 * injection-classifier.ts) onto this shape; the agent process runs L1-only.
 */
export interface IntakeInjectionScorerPort {
  /** Key for the score in `envelope.scores` (INJECTION_CLASSIFIER_SCANNER_ID). */
  scannerId: string;
  classify(text: string): Promise<{ score: number; labels: IntakeRiskLabel[] }>;
}

/**
 * Screening-field contribution from an escalation layer (labels, per-scanner
 * scores, audit fields), folded into the item's envelope exactly like the
 * L1 report and prior signals are.
 */
export interface IntakeEscalationContribution {
  riskLabels: IntakeRiskLabel[];
  scores: Record<string, number>;
  extractedFields: Record<string, string>;
}

/**
 * One escalation request from `screen()` to the gateway-side L2/L3 port,
 * issued AFTER the L1 scanners and the L1.5 scorer ran and only when the
 * cheaper layers did not already withhold the item. Routing state:
 * `sourceRiskTier` is the source-list ADJUSTED tier (htm9.13) — the tier
 * every escalation threshold and mandatory-tier rule reads — and
 * `priorScore` is the max of the L1/L1.5/prior-signal scores that gates L2.
 */
export interface IntakeEscalationRequest {
  text: string;
  sourceClass: IntakeSourceClass;
  sourceRiskTier: IntakeSourceRiskTier;
  priorScore: number;
  origin: { ref: string; detail?: string };
  subject?: IntakeEnvelopeSubject;
  canonicalContactId?: string;
  /** Carrying channel id for the L3 CogSecEvent, when the surface knows one. */
  sourceChannelId?: string;
  /**
   * The L1/L1.5/prior-signal screening fields, so an executed L3 outcome can
   * fold the full layered history onto the ONE envelope it delivers.
   */
  priorContribution: IntakeEscalationContribution;
  atMs: number;
}

/**
 * What the escalation port decided for one item:
 * - 'skipped':      no escalation layer ran (below threshold, non-mandatory
 *                   tier) — the L1/L1.5 decision stands untouched.
 * - 'contribution': L2 ran and did not flag (or failed closed to
 *                   l1_labels_only on a trusted tier); the L1/L1.5 decision
 *                   stands and the L2 verdict/error is recorded on the
 *                   envelope.
 * - 'quarantine':   L2 failed and the tier's fail-closed action is
 *                   quarantine; the service forces a quarantine decision
 *                   through its normal envelope + hold machinery.
 * - 'final':        L3 was INVOKED (htm9.7 hard rule): the port already
 *                   produced the envelope, the CogSecEvent, and the
 *                   quarantine hold via `applyL3ScreeningOutcome`; the
 *                   returned result replaces the service's own finalize.
 */
export type IntakeEscalationDecision =
  | { kind: 'skipped'; reason: string }
  | { kind: 'contribution'; contribution: IntakeEscalationContribution }
  | { kind: 'quarantine'; reason: string; contribution: IntakeEscalationContribution }
  | {
    kind: 'final';
    result: {
      envelope: IntakeEnvelope;
      snapshot: IntakeEnvelopeSnapshot;
      action: IntakeDecisionAction;
      effectiveText: string;
      withheld: boolean;
      /** The auditable CogSecEvent written for the L3 invocation. */
      cogSecCaseId: string;
    };
  };

/**
 * Structural port for the gateway-side L2 fast screener + L3 heavy screener
 * escalation chain (htm9.6/htm9.7), mirroring `IntakeInjectionScorerPort` so
 * this core module never imports gateway internals. The gateway composition
 * (src/boundary/gateway/intake/compose-screening.ts) adapts the l2-screener/
 * l3-screener evaluators onto this shape; the agent process runs L1-only and
 * never composes one.
 */
export interface IntakeEscalationPort {
  escalate(request: IntakeEscalationRequest): Promise<IntakeEscalationDecision>;
}

// ── Screening input/result ──
// (Decision label families live in risk-label-families.ts, re-exported above.)

/**
 * A screening signal produced by an UPSTREAM screener that ran before this
 * service — e.g. the htm9.8 vision screener whose VLM flags an image's
 * embedded instruction text before the OCR transcript is L1-scanned here.
 * Prior labels are folded into the envelope and participate in the decision:
 * a quarantine-family prior label quarantines exactly like an L1 finding
 * (fail-closed aggregation across screening layers — a cleaner transcript
 * never launders a flagged image).
 */
export interface IntakePriorScreeningSignal {
  /** Scanner identity for `envelope.scores` / extracted-field attribution. */
  scannerId: string;
  labels: IntakeRiskLabel[];
  /** Optional calibrated score recorded under `scannerId` in `scores`. */
  score?: number;
  /** Audit fields merged onto the envelope (caller owns key naming). */
  extractedFields?: Record<string, string>;
}

export interface IntakeScreeningInput {
  sourceClass: IntakeSourceClass;
  /** Origin locator: url, `discord:<channel>:<message>`, tool call id, ... */
  origin: { ref: string; detail?: string };
  scope: IntakeScanScope;
  /** What the envelope covers on the carrying message. Default `{kind:'body'}`. */
  subject?: IntakeEnvelopeSubject;
  /**
   * Canonical contact id of the sender, when the surface knows one. Matched
   * against the trustedPeople/deniedPeople source lists (htm9.13).
   */
  canonicalContactId?: string;
  /**
   * Signals from screeners that already ran on this content upstream (htm9.8
   * vision screener). Folded into the envelope; quarantine-family prior labels
   * force a quarantine decision (fail closed across layers).
   */
  priorSignals?: readonly IntakePriorScreeningSignal[];
  /**
   * Carrying channel id, when the surface knows one. Recorded on the
   * CogSecEvent when the item reaches the L3 heavy screener (htm9.7 hard
   * rule); absent, the escalation port derives a source-class identifier.
   */
  sourceChannelId?: string;
  atMs?: number;
}

export interface IntakeScreeningResult {
  /** The envelope in its post-screening state (released/…/quarantined). */
  envelope: IntakeEnvelope;
  /** Point-in-time projection for MessageRoutingMetadata / session metadata. */
  snapshot: IntakeEnvelopeSnapshot;
  report: IntakeL1ScanReport;
  action: IntakeDecisionAction;
  mode: 'shadow' | 'enforce';
  /**
   * Text for downstream use. Shadow mode: always the original input. Enforce
   * mode: original on 'pass', L1 sanitized text on 'sanitize', the fixed
   * htm9.12 withheld-content placeholder on 'quarantine'.
   */
  effectiveText: string;
  /** True when enforce-mode quarantine withheld the content. */
  withheld: boolean;
  /** L1.5 score when a scorer ran; absent for L1-only screening. */
  injectionScore?: number;
  /** Visible-not-swallowed L1.5 failure (screening continued on L1 signals). */
  injectionScorerError?: string;
  /**
   * Visible-not-swallowed failure writing a quarantined item to the durable
   * quarantine store (htm9.11). The content stays withheld in enforce mode
   * regardless (fail closed) — only the operator review copy was lost.
   */
  quarantineHoldError?: string;
  /**
   * Data-marking plan (htm9.13) for markable source classes
   * (INTAKE_MARKING_SOURCE_CLASSES): a pure function of the screening labels,
   * max score, and effective tier. Computed and audited in BOTH modes; never
   * applied to effectiveText here — the prompt-assembly read side
   * (intake-sink-gating.ts) applies it in enforce mode, so inbound re-scans
   * never see legitimate markers.
   */
  markingPlan?: IntakeMarkingPlan;
  /**
   * The auditable CogSecEvent written when the item reached the L3 heavy
   * screener (htm9.7 hard rule: every L3 invocation writes one). Absent for
   * items that never escalated to L3.
   */
  cogSecCaseId?: string;
}

export interface IntakeScreeningService {
  readonly mode: 'shadow' | 'enforce';
  /** Full screening: L1 plus the L1.5 scorer when configured. */
  screen(text: string, input: IntakeScreeningInput): Promise<IntakeScreeningResult>;
  /**
   * Synchronous L1-only screening for sync call sites (session-entry
   * recording). Fails closed when an async scorer is configured: silently
   * skipping a configured screening layer is not allowed.
   */
  screenSync(text: string, input: IntakeScreeningInput): IntakeScreeningResult;
}

export interface IntakeScreeningServiceOptions {
  policy: IntakePolicyConfig;
  l1: IntakeL1Scanner;
  injectionScorer?: IntakeInjectionScorerPort;
  /**
   * Gateway-side L2/L3 escalation chain (htm9.6/htm9.7). Absent (agent
   * process, tests, no OpenRouter backend) screening stops at L1/L1.5 —
   * the agent process must NEVER compose one (it has no external egress).
   */
  escalation?: IntakeEscalationPort;
  /**
   * Durable quarantine store (htm9.11): quarantine decisions HOLD the raw
   * item here for the Garden approval queue. Absent (tests, minimal
   * compositions) quarantined content is withheld without a review copy.
   */
  quarantine?: IntakeQuarantineHoldPort;
  /** Acting principal for envelope transitions, e.g. 'gateway:intake-screening'. */
  actor: string;
  now?: () => number;
}

/** The fixed, operator-reviewed in-place placeholder for withheld content. */
export function renderIntakeWithheldContentPlaceholder(): string {
  return INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent;
}

// ── Decision ──

interface ScreeningSignals {
  report: IntakeL1ScanReport;
  injectionScore: number | undefined;
  injectionScoreThreshold: number;
  priorSignals: readonly IntakePriorScreeningSignal[];
}

function decideAction(signals: ScreeningSignals): { action: IntakeDecisionAction; reason: string } {
  const { report, injectionScore, injectionScoreThreshold, priorSignals } = signals;
  const quarantineLabels = report.riskLabels
    .filter((label) => INTAKE_QUARANTINE_RISK_LABELS.includes(label));
  const sanitizeLabels = report.riskLabels
    .filter((label) => INTAKE_SANITIZE_RISK_LABELS.includes(label));
  const scorerSignal = injectionScore !== undefined && injectionScore >= injectionScoreThreshold;
  const scoreNote = injectionScore === undefined
    ? ''
    : `; onnx=${injectionScore.toFixed(4)} (tier threshold ${injectionScoreThreshold.toFixed(2)})`;
  const truncationNote = report.truncated ? '; input truncated at scan cap' : '';

  if (quarantineLabels.length > 0) {
    return {
      action: 'quarantine',
      reason: `l1:${quarantineLabels.join('+')}${scoreNote}${truncationNote}`,
    };
  }
  // Upstream-screener findings quarantine exactly like L1 findings: a
  // quarantine-family label from a prior layer (e.g. the vision screener's
  // embedded-instruction flag) is a deterministic finding, not a raw score.
  const priorQuarantine = priorSignals
    .map((signal) => ({
      scannerId: signal.scannerId,
      labels: signal.labels.filter((label) => INTAKE_QUARANTINE_RISK_LABELS.includes(label)),
    }))
    .filter((signal) => signal.labels.length > 0);
  if (priorQuarantine.length > 0) {
    const detail = priorQuarantine
      .map((signal) => `${signal.scannerId}:${signal.labels.join('+')}`)
      .join(',');
    return {
      action: 'quarantine',
      reason: `prior:${detail}${scoreNote}${truncationNote}`,
    };
  }
  if (scorerSignal && report.riskLabels.length > 0) {
    // Above-threshold score corroborated by at least one deterministic finding.
    return {
      action: 'quarantine',
      reason: `onnx-threshold+l1:${report.riskLabels.join('+')}${scoreNote}${truncationNote}`,
    };
  }
  if (scorerSignal) {
    // Score alone never quarantines (over-defense guard); record and sanitize.
    return {
      action: 'sanitize',
      reason: `onnx-threshold-uncorroborated${scoreNote}${truncationNote}`,
    };
  }
  if (sanitizeLabels.length > 0 && report.sanitizedDiffers) {
    return {
      action: 'sanitize',
      reason: `l1-sanitize:${sanitizeLabels.join('+')}${scoreNote}${truncationNote}`,
    };
  }
  return { action: 'pass', reason: `no-findings${scoreNote}${truncationNote}` };
}

// ── Service ──

function buildContentRef(text: string, store: string): {
  store: string;
  ref: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
} {
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    // With a quarantine store configured (htm9.11), 'intake-quarantine' can
    // resolve the hash handle for held items; without one the hash still
    // identifies the content without carrying raw bytes on the envelope.
    store,
    ref: `sha256:${sha256}`,
    sha256,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    mediaType: 'text/plain',
  };
}

interface ScorerOutcome {
  score?: number;
  labels: IntakeRiskLabel[];
  error?: string;
  scannerId?: string;
}

/** Escalation results folded into `finalize` (never alters the L1 report). */
interface EscalationExtras {
  /** L2 verdict / recorded L2 failure merged onto the envelope fields. */
  contribution?: IntakeEscalationContribution;
  /** Fail-closed override of the L1/L1.5 decision (L2 per-tier quarantine). */
  forced?: { action: Extract<IntakeDecisionAction, 'quarantine'>; reason: string };
}

export function createIntakeScreeningService(
  options: IntakeScreeningServiceOptions,
): IntakeScreeningService {
  const { policy, l1, injectionScorer, escalation, quarantine, actor } = options;
  if (policy.mode === 'off') {
    throw new Error(
      "Intake screening service must not be constructed with mode 'off'; "
      + 'composition sites skip construction entirely when the firewall is off',
    );
  }
  const mode = policy.mode;
  const now = options.now ?? Date.now;

  // htm9.13: scrutiny scales with SOURCE risk. The operator-curated source
  // lists adjust the policy tier — a trusted-site/person hit lowers it ONE
  // step (never below 'trusted'; L1 always runs unconditionally), a denied
  // hit raises it to 'hostile'. The ADJUSTED tier is what the envelope
  // carries and what every escalation threshold and mandatory-tier rule reads.
  function resolveTier(input: IntakeScreeningInput): AdjustedSourceRiskTier {
    const baseTier = policy.sourceRiskTiers[input.sourceClass];
    const listMatch = matchIntakeSourceLists({
      lists: policy.sourceLists,
      originRef: input.origin.ref,
      ...(input.canonicalContactId !== undefined
        ? { canonicalContactId: input.canonicalContactId }
        : {}),
    });
    return adjustSourceRiskTierForSourceLists(baseTier, listMatch);
  }

  /** Folds L1 report + L1.5 scorer + prior signals + tier adjustment into envelope fields. */
  function collectSignalContribution(
    report: IntakeL1ScanReport,
    scorerOutcome: ScorerOutcome,
    priorSignals: readonly IntakePriorScreeningSignal[],
    adjusted: AdjustedSourceRiskTier,
  ): IntakeEscalationContribution {
    const scores: Record<string, number> = { ...report.scores };
    if (scorerOutcome.score !== undefined && scorerOutcome.scannerId) {
      scores[scorerOutcome.scannerId] = scorerOutcome.score;
    }
    const extractedFields: Record<string, string> = { ...report.extractedFields };
    if (scorerOutcome.error && scorerOutcome.scannerId) {
      extractedFields[`${scorerOutcome.scannerId}.error`] = scorerOutcome.error.slice(0, 4096);
    }
    for (const signal of priorSignals) {
      if (signal.score !== undefined) {
        scores[signal.scannerId] = signal.score;
      }
      for (const [key, value] of Object.entries(signal.extractedFields ?? {})) {
        extractedFields[key] = value.slice(0, 4096);
      }
    }
    if (adjusted.adjustment) {
      extractedFields['source_list.match'] =
        `${adjusted.adjustment.match.kind}:${adjusted.adjustment.match.list}:${adjusted.adjustment.match.pattern}`
          .slice(0, 4096);
      extractedFields['source_list.tier_adjustment'] =
        `${adjusted.adjustment.from}->${adjusted.tier} (${adjusted.adjustment.kind})`;
    }
    const riskLabels = [
      ...report.riskLabels,
      ...scorerOutcome.labels,
      ...priorSignals.flatMap((signal) => signal.labels),
    ];
    return { riskLabels, scores, extractedFields };
  }

  function finalize(
    text: string,
    input: IntakeScreeningInput,
    report: IntakeL1ScanReport,
    scorerOutcome: ScorerOutcome,
    escalationExtras?: EscalationExtras,
  ): IntakeScreeningResult {
    const adjusted = resolveTier(input);
    const sourceRiskTier = adjusted.tier;
    const atMs = input.atMs ?? now();

    let envelope = createIntakeEnvelope({
      sourceClass: input.sourceClass,
      sourceRiskTier,
      contentRef: buildContentRef(text, quarantine ? 'intake-quarantine' : 'unpersisted'),
      origin: input.origin,
      atMs,
    });

    const priorSignals = input.priorSignals ?? [];
    // An escalation fail-closed override (L2 error on a quarantine-action
    // tier, or an escalation-port failure) replaces the L1/L1.5 decision;
    // otherwise the decision derives from the cheaper layers exactly as it
    // did before escalation was wired.
    const decision = escalationExtras?.forced
      ? { action: escalationExtras.forced.action, reason: escalationExtras.forced.reason }
      : decideAction({
        report,
        injectionScore: scorerOutcome.score,
        injectionScoreThreshold: injectionScoreThresholdForTier(policy, sourceRiskTier),
        priorSignals,
      });
    const intakeDecision: IntakeDecision = {
      action: decision.action,
      reason: decision.reason.slice(0, 1024),
      decidedBy: 'screening',
      decidedAtMs: atMs,
    };

    const base = collectSignalContribution(report, scorerOutcome, priorSignals, adjusted);
    const scores: Record<string, number> = {
      ...base.scores,
      ...(escalationExtras?.contribution?.scores ?? {}),
    };
    const extractedFields: Record<string, string> = {
      ...base.extractedFields,
      ...(escalationExtras?.contribution?.extractedFields ?? {}),
    };

    // htm9.13: the marking plan is a pure function of (labels, max score,
    // effective tier), computed for markable classes in both modes.
    const allRiskLabels = [
      ...base.riskLabels,
      ...(escalationExtras?.contribution?.riskLabels ?? []),
    ];
    const maxScore = Math.min(1, Math.max(0, ...Object.values(scores)));
    const markingPlan = INTAKE_MARKING_SOURCE_CLASSES.has(input.sourceClass)
      ? resolveMarkingPlan({ labels: allRiskLabels, score: maxScore, tier: sourceRiskTier })
      : undefined;
    if (markingPlan) {
      extractedFields['marking.intensity'] = markingPlan.intensity;
      extractedFields['marking.provenance'] = markingPlan.provenanceNote.slice(0, 4096);
    }

    envelope = transitionIntakeEnvelope(envelope, {
      to: 'screened',
      actor,
      reason: decision.reason.slice(0, 1024),
      atMs,
      decision: intakeDecision,
      riskLabels: allRiskLabels,
      scores,
      extractedFields,
    });
    envelope = transitionIntakeEnvelope(envelope, {
      to: postScreeningStateForDecision(decision.action),
      actor,
      reason: `routed per screening decision '${decision.action}'`,
      atMs,
    });

    const withheld = mode === 'enforce'
      && (decision.action === 'quarantine' || decision.action === 'block');
    let effectiveText = text;
    if (mode === 'enforce') {
      if (withheld) {
        effectiveText = renderIntakeWithheldContentPlaceholder();
      } else if (decision.action === 'sanitize') {
        effectiveText = report.sanitizedText;
      }
    }

    // Durable hold for the Garden approval queue (htm9.11): quarantine
    // decisions land the raw item in the quarantine store so the operator can
    // review, release, or discard it. Hold failure mirrors the L1.5 posture:
    // recorded on the result and logged as an error, never swallowed — and the
    // content stays withheld in enforce mode regardless (fail closed).
    let quarantineHoldError: string | undefined;
    if (quarantine && envelope.state === 'quarantined') {
      try {
        quarantine.hold({
          envelope,
          mode,
          rawText: text,
          ...(input.canonicalContactId !== undefined
            ? { canonicalContactId: input.canonicalContactId }
            : {}),
          atMs,
        });
      } catch (error) {
        quarantineHoldError = error instanceof Error ? error.message : String(error);
        log.error('Intake quarantine hold failed; item stays withheld without a review copy', {
          envelopeId: envelope.id,
          originRef: input.origin.ref,
          error: quarantineHoldError,
        });
      }
    }

    const snapshot = snapshotIntakeEnvelope(envelope, input.subject ?? { kind: 'body' });

    // Every decision is audited; findings and enforcement escalate severity.
    const auditPayload = {
      envelopeId: envelope.id,
      sourceClass: input.sourceClass,
      sourceRiskTier,
      originRef: input.origin.ref,
      mode,
      action: decision.action,
      reason: decision.reason,
      state: envelope.state,
      riskLabels: envelope.riskLabels,
      scores: envelope.scores,
      withheld,
      truncated: report.truncated,
      elapsedMs: report.elapsedMs,
      ...(adjusted.adjustment
        ? {
          sourceListMatch: `${adjusted.adjustment.match.kind}:${adjusted.adjustment.match.list}:${adjusted.adjustment.match.pattern}`,
          sourceTierAdjustment: `${adjusted.adjustment.from}->${sourceRiskTier}`,
        }
        : {}),
      ...(markingPlan ? { markingIntensity: markingPlan.intensity } : {}),
      ...(report.scannerErrors.length > 0 ? { scannerErrors: report.scannerErrors } : {}),
      ...(scorerOutcome.error ? { injectionScorerError: scorerOutcome.error } : {}),
      ...(quarantineHoldError ? { quarantineHoldError } : {}),
    };
    if (decision.action === 'pass') {
      log.debug('Intake screening decision', auditPayload);
    } else {
      log.warn('Intake screening decision', auditPayload);
    }
    if (scorerOutcome.error) {
      log.error('Intake L1.5 injection scorer failed; screening continued on L1 signals', {
        envelopeId: envelope.id,
        originRef: input.origin.ref,
        error: scorerOutcome.error,
      });
    }

    return {
      envelope,
      snapshot,
      report,
      action: decision.action,
      mode,
      effectiveText,
      withheld,
      ...(scorerOutcome.score !== undefined ? { injectionScore: scorerOutcome.score } : {}),
      ...(scorerOutcome.error ? { injectionScorerError: scorerOutcome.error } : {}),
      ...(quarantineHoldError ? { quarantineHoldError } : {}),
      ...(markingPlan ? { markingPlan } : {}),
    };
  }

  // ── L2/L3 escalation (htm9.6/htm9.7, gateway-side port only) ──
  // Ordering: L1 scanners → L1.5 score → source-list-adjusted tier →
  // shouldEscalateToL2 → evaluateL2 → (escalate_l3 / mandatory tier) →
  // evaluateL3 → applyL3ScreeningOutcome. All routing lives in the port and
  // the l2/l3 evaluators it wraps; this function only folds the outcome back
  // into the screening result.
  async function escalateAndFinalize(
    text: string,
    input: IntakeScreeningInput,
    report: IntakeL1ScanReport,
    scorerOutcome: ScorerOutcome,
    port: IntakeEscalationPort,
  ): Promise<IntakeScreeningResult> {
    // Freeze the timestamp so the escalation request and the finalize path
    // record the same decision time.
    const atMs = input.atMs ?? now();
    const timedInput: IntakeScreeningInput = { ...input, atMs };
    const adjusted = resolveTier(input);
    const priorSignals = input.priorSignals ?? [];

    // Items the cheaper layers already withhold skip escalation: L2/L3 exist
    // to refine UNCERTAIN items, and a quarantine decision is already the
    // fail-closed terminal pending operator review — re-screening it would
    // spend API calls to reach the same outcome and duplicate the held item.
    const preliminary = decideAction({
      report,
      injectionScore: scorerOutcome.score,
      injectionScoreThreshold: injectionScoreThresholdForTier(policy, adjusted.tier),
      priorSignals,
    });
    if (preliminary.action === 'quarantine' || preliminary.action === 'block') {
      return finalize(text, timedInput, report, scorerOutcome);
    }

    const prior = collectSignalContribution(report, scorerOutcome, priorSignals, adjusted);
    const priorScore = Math.min(1, Math.max(0, ...Object.values(prior.scores)));

    let escalationDecision: IntakeEscalationDecision;
    try {
      escalationDecision = await port.escalate({
        text,
        sourceClass: input.sourceClass,
        sourceRiskTier: adjusted.tier,
        priorScore,
        origin: input.origin,
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.canonicalContactId !== undefined
          ? { canonicalContactId: input.canonicalContactId }
          : {}),
        ...(input.sourceChannelId !== undefined
          ? { sourceChannelId: input.sourceChannelId }
          : {}),
        priorContribution: prior,
        atMs,
      });
    } catch (error) {
      // The port throws only where the htm9.7 hard rule is at stake (a failed
      // CogSecEvent write or quarantine hold inside applyL3ScreeningOutcome):
      // fail closed — the item is quarantined with the failure on the
      // envelope, never delivered on a broken audit guarantee.
      const message = error instanceof Error ? error.message : String(error);
      log.error('Intake escalation port failed; failing closed to quarantine', {
        sourceClass: input.sourceClass,
        sourceRiskTier: adjusted.tier,
        originRef: input.origin.ref,
        error: message,
      });
      return finalize(text, timedInput, report, scorerOutcome, {
        forced: {
          action: 'quarantine',
          reason: `escalation-fail-closed:${message}`.slice(0, 1024),
        },
        contribution: {
          riskLabels: [],
          scores: {},
          extractedFields: { 'escalation.error': message.slice(0, 4096) },
        },
      });
    }

    switch (escalationDecision.kind) {
      case 'skipped':
        return finalize(text, timedInput, report, scorerOutcome);
      case 'contribution':
        return finalize(text, timedInput, report, scorerOutcome, {
          contribution: escalationDecision.contribution,
        });
      case 'quarantine':
        return finalize(text, timedInput, report, scorerOutcome, {
          forced: { action: 'quarantine', reason: escalationDecision.reason.slice(0, 1024) },
          contribution: escalationDecision.contribution,
        });
      case 'final': {
        // L3 was invoked: the port already owns the envelope, the CogSecEvent,
        // and the quarantine hold (applyL3ScreeningOutcome hard rule). Its
        // effectiveText contract matches this service's: original in shadow,
        // withheld notice / safe representation in enforce — the L3-reached
        // raw content string never ships in enforce mode.
        const final = escalationDecision.result;
        return {
          envelope: final.envelope,
          snapshot: final.snapshot,
          report,
          action: final.action,
          mode,
          effectiveText: final.effectiveText,
          withheld: final.withheld,
          ...(scorerOutcome.score !== undefined ? { injectionScore: scorerOutcome.score } : {}),
          ...(scorerOutcome.error ? { injectionScorerError: scorerOutcome.error } : {}),
          cogSecCaseId: final.cogSecCaseId,
        };
      }
    }
  }

  async function screen(text: string, input: IntakeScreeningInput): Promise<IntakeScreeningResult> {
    const report = l1.scan(text, { scope: input.scope });
    let scorerOutcome: ScorerOutcome = { labels: [] };
    if (injectionScorer && text.trim()) {
      try {
        const classified = await injectionScorer.classify(text);
        scorerOutcome = {
          score: classified.score,
          labels: classified.labels,
          scannerId: injectionScorer.scannerId,
        };
      } catch (error) {
        // L1.5 mirrors L1's fail-open-advisory posture: the failure is recorded
        // on the envelope and logged as an error, never swallowed, and the
        // deterministic L1 signals still drive the decision.
        scorerOutcome = {
          labels: [],
          scannerId: injectionScorer.scannerId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (!escalation || !text.trim()) {
      return finalize(text, input, report, scorerOutcome);
    }
    return escalateAndFinalize(text, input, report, scorerOutcome, escalation);
  }

  function screenSync(text: string, input: IntakeScreeningInput): IntakeScreeningResult {
    if (injectionScorer || escalation) {
      throw new Error(
        'screenSync is only available on L1-only intake screening services; '
        + 'this service has an async injection scorer or escalation port '
        + 'configured — use screen()',
      );
    }
    const report = l1.scan(text, { scope: input.scope });
    return finalize(text, input, report, { labels: [] });
  }

  return { mode, screen, screenSync };
}

// ── Composition helper (L1-only; agent process and tests) ──
//
// Deliberately carries NO `escalation` option: the agent process composes
// through this helper and must never hold an L2/L3 escalation port (the
// escalation screeners are OpenRouter calls, and only the gateway holds
// external egress). Gateway composition uses createIntakeScreeningService
// directly (src/boundary/gateway/intake/compose-screening.ts).

export interface MaybeCreateIntakeScreeningOptions {
  policy: IntakePolicyConfig;
  actor: string;
  l1Config?: IntakeL1ScannerConfig;
  injectionScorer?: IntakeInjectionScorerPort;
  /** Durable quarantine store (htm9.11) for held-item review in Garden. */
  quarantine?: IntakeQuarantineHoldPort;
  now?: () => number;
}

/**
 * Returns null when the firewall mode is 'off' (no screening wired anywhere);
 * otherwise constructs the L1 scanner (fail-closed on a missing/invalid rule
 * file) and the screening service.
 */
export function maybeCreateIntakeScreeningService(
  options: MaybeCreateIntakeScreeningOptions,
): IntakeScreeningService | null {
  if (options.policy.mode === 'off') {
    log.warn("Intake firewall mode is 'off': no intake screening is wired on any surface");
    return null;
  }
  return createIntakeScreeningService({
    policy: options.policy,
    l1: createIntakeL1Scanner(options.l1Config ?? {}),
    ...(options.injectionScorer ? { injectionScorer: options.injectionScorer } : {}),
    ...(options.quarantine ? { quarantine: options.quarantine } : {}),
    actor: options.actor,
    ...(options.now ? { now: options.now } : {}),
  });
}
