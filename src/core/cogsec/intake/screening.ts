// ── Cognition Intake Firewall: intake screening service (htm9.2) ──
//
// The wiring keystone between the already-built pieces: it consumes the L1
// deterministic scanner pipeline (htm9.4) and, when provided, the gateway-side
// L1.5 injection scorer (htm9.5), produces an IntakeEnvelope (htm9.1) for every
// screened item, records an auditable screening decision, and routes the
// envelope through its post-screening state.
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

export function createIntakeScreeningService(
  options: IntakeScreeningServiceOptions,
): IntakeScreeningService {
  const { policy, l1, injectionScorer, quarantine, actor } = options;
  if (policy.mode === 'off') {
    throw new Error(
      "Intake screening service must not be constructed with mode 'off'; "
      + 'composition sites skip construction entirely when the firewall is off',
    );
  }
  const mode = policy.mode;
  const now = options.now ?? Date.now;

  function finalize(
    text: string,
    input: IntakeScreeningInput,
    report: IntakeL1ScanReport,
    scorerOutcome: {
      score?: number;
      labels: IntakeRiskLabel[];
      error?: string;
      scannerId?: string;
    },
  ): IntakeScreeningResult {
    // htm9.13: scrutiny scales with SOURCE risk. The operator-curated source
    // lists adjust the policy tier — a trusted-site/person hit lowers it ONE
    // step (never below 'trusted'; L1 already ran unconditionally above), a
    // denied hit raises it to 'hostile'. The ADJUSTED tier is what the
    // envelope carries and what every escalation threshold reads.
    const baseTier = policy.sourceRiskTiers[input.sourceClass];
    const listMatch = matchIntakeSourceLists({
      lists: policy.sourceLists,
      originRef: input.origin.ref,
      ...(input.canonicalContactId !== undefined
        ? { canonicalContactId: input.canonicalContactId }
        : {}),
    });
    const adjusted = adjustSourceRiskTierForSourceLists(baseTier, listMatch);
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
    const decision = decideAction({
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
        `${adjusted.adjustment.from}->${sourceRiskTier} (${adjusted.adjustment.kind})`;
    }

    // htm9.13: the marking plan is a pure function of (labels, max score,
    // effective tier), computed for markable classes in both modes.
    const allRiskLabels = [
      ...report.riskLabels,
      ...scorerOutcome.labels,
      ...priorSignals.flatMap((signal) => signal.labels),
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

  async function screen(text: string, input: IntakeScreeningInput): Promise<IntakeScreeningResult> {
    const report = l1.scan(text, { scope: input.scope });
    if (!injectionScorer || !text.trim()) {
      return finalize(text, input, report, { labels: [] });
    }
    try {
      const classified = await injectionScorer.classify(text);
      return finalize(text, input, report, {
        score: classified.score,
        labels: classified.labels,
        scannerId: injectionScorer.scannerId,
      });
    } catch (error) {
      // L1.5 mirrors L1's fail-open-advisory posture: the failure is recorded
      // on the envelope and logged as an error, never swallowed, and the
      // deterministic L1 signals still drive the decision.
      return finalize(text, input, report, {
        labels: [],
        scannerId: injectionScorer.scannerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function screenSync(text: string, input: IntakeScreeningInput): IntakeScreeningResult {
    if (injectionScorer) {
      throw new Error(
        'screenSync is only available on L1-only intake screening services; '
        + 'this service has an async injection scorer configured — use screen()',
      );
    }
    const report = l1.scan(text, { scope: input.scope });
    return finalize(text, input, report, { labels: [] });
  }

  return { mode, screen, screenSync };
}

// ── Composition helper (L1-only; agent process and tests) ──

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
