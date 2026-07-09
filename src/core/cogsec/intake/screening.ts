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
  createIntakeL1Scanner,
  type IntakeL1Scanner,
  type IntakeL1ScannerConfig,
  type IntakeL1ScanReport,
  type IntakeScanScope,
} from './scanners/index.js';

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

// ── Decision label families (interim htm9.2 policy; htm9.3 refines) ──

/**
 * L1 labels that alone justify a quarantine decision. The deterministic rule
 * engine's high-risk families: instruction override/injection markers, persona
 * and policy mutation attempts, executable instructions, canary leaks, and
 * slow-poisoning patterns.
 */
export const INTAKE_QUARANTINE_RISK_LABELS: readonly IntakeRiskLabel[] = [
  'injection/override_attempt',
  'injection/indirect',
  'injection/encoded_smuggling',
  'injection/role_confusion',
  'injection/jailbreak_marker',
  'persona/mutation_attempt',
  'policy/security_modification',
  'execution/executable_instruction',
  'exfil/canary_leak',
  'poisoning/memory_write_pressure',
  'poisoning/trust_grooming',
  'poisoning/source_drift',
];

/**
 * L1 labels whose findings the sanitized text actually removes (stripped
 * invisible codepoints, redacted secrets/PII) — these justify a 'sanitize'
 * decision when the sanitized text differs.
 */
export const INTAKE_SANITIZE_RISK_LABELS: readonly IntakeRiskLabel[] = [
  'injection/invisible_text',
  'secrets/api_key',
  'secrets/credential_material',
  'pii/credential_adjacent',
  'pii/financial',
  'pii/personal_identifier',
];

// ── Screening input/result ──

export interface IntakeScreeningInput {
  sourceClass: IntakeSourceClass;
  /** Origin locator: url, `discord:<channel>:<message>`, tool call id, ... */
  origin: { ref: string; detail?: string };
  scope: IntakeScanScope;
  /** What the envelope covers on the carrying message. Default `{kind:'body'}`. */
  subject?: IntakeEnvelopeSubject;
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
}

function decideAction(signals: ScreeningSignals): { action: IntakeDecisionAction; reason: string } {
  const { report, injectionScore, injectionScoreThreshold } = signals;
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

function buildContentRef(text: string): {
  store: string;
  ref: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
} {
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    // No durable quarantine store exists yet (htm9.3 owns the held-item store
    // + human release flow); the hash identifies the content without carrying
    // raw bytes on the envelope.
    store: 'unpersisted',
    ref: `sha256:${sha256}`,
    sha256,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    mediaType: 'text/plain',
  };
}

export function createIntakeScreeningService(
  options: IntakeScreeningServiceOptions,
): IntakeScreeningService {
  const { policy, l1, injectionScorer, actor } = options;
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
    const sourceRiskTier = policy.sourceRiskTiers[input.sourceClass];
    const atMs = input.atMs ?? now();

    let envelope = createIntakeEnvelope({
      sourceClass: input.sourceClass,
      sourceRiskTier,
      contentRef: buildContentRef(text),
      origin: input.origin,
      atMs,
    });

    const decision = decideAction({
      report,
      injectionScore: scorerOutcome.score,
      injectionScoreThreshold: injectionScoreThresholdForTier(policy, sourceRiskTier),
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

    envelope = transitionIntakeEnvelope(envelope, {
      to: 'screened',
      actor,
      reason: decision.reason.slice(0, 1024),
      atMs,
      decision: intakeDecision,
      riskLabels: [...report.riskLabels, ...scorerOutcome.labels],
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
      ...(report.scannerErrors.length > 0 ? { scannerErrors: report.scannerErrors } : {}),
      ...(scorerOutcome.error ? { injectionScorerError: scorerOutcome.error } : {}),
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
    actor: options.actor,
    ...(options.now ? { now: options.now } : {}),
  });
}
