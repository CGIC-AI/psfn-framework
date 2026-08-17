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
// but nothing is withheld on the classifier's word alone. For authenticated
// first-party authors in private/invite-only channels, a clean deterministic
// scan makes that semantic-only signal audit-only: the original text passes
// without invoking the slower escalation layers.

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  COGSEC_DECISION_REASON_MAX_CHARS,
  COGSEC_EVIDENCE_FIELD_MAX_CHARS,
} from './screening-envelope-policy.js';
import {
  cogSecItemEnforcementPosture,
  cogSecVectorForProvenance,
  intakeEnforcementPosture,
  resolveCogSecProvenanceClass,
  resolveCogSecSurfacePosture,
  resolveCogSecVectorPosture,
  type CogSecMode,
  type CogSecProvenanceClass,
  type CogSecStructuralSurface,
  type CogSecVector,
  type IntakeEnforcementPosture,
} from '../../../shared/contracts/cogsec-mode.js';
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
  type IntakeL1RuleMatchProvenance,
  MAX_DECISION_RULE_MATCHES,
  type IntakeSourceClass,
  type IntakeSourceRiskTier,
} from '../../../shared/contracts/intake-envelope.js';
import {
  injectionScoreThresholdForTier,
  type IntakeBenignClass,
  type IntakeChatBodyChannelClass,
  type IntakePolicyConfig,
} from '../../../system/config/intake-policy-config.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { ConversationScope } from '../../session/conversation-scope.js';
import type { TrustLevel } from '../../../system/trust/types.js';
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
  buildScannerResult,
  createIntakeL1Scanner,
  INTAKE_RULE_ENGINE_SCANNER_ID,
  type IntakeL1Scanner,
  type IntakeL1ScannerConfig,
  type IntakeL1ScanReport,
  type IntakeScanScope,
} from './scanners/index.js';
import type { IntakeQuarantineHoldPort } from './quarantine-store.js';
import { classifyToolResultBenignClass } from './tool-result-benign-classes.js';

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
 * Content-free account of whether each semantic layer ran and what verdict it
 * produced. Scores and labels remain on the envelope; this trace supplies the
 * missing routing reason that lets an operator distinguish a gated-off layer
 * from a layer that ran and returned clear.
 */
export interface IntakeSemanticScreeningTrace {
  l2: {
    status: 'not_run' | 'clear' | 'flagged' | 'failed_closed';
    reason: string;
  };
  l3: {
    status: 'not_run' | 'clear' | 'flagged' | 'failed_closed';
    reason: string;
  };
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
  /** Explicit per-item posture; private-direct mark-only uses observe-only. */
  enforcementPosture?: IntakeEnforcementPosture;
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
  /**
   * On-disk artifact paths carrying this item's raw content (hrmrq.54).
   * MUST reach the quarantine hold on every escalation outcome that
   * quarantines — including the L3 'final' path, whose hold the port itself
   * writes via applyL3ScreeningOutcome — or the read gate never learns about
   * the artifacts and fs/shell reads of the quarantined bytes go unaudited.
   */
  artifactPaths?: readonly string[];
  /** Content-free observer bound to this one screening correlation. */
  emitTiming?: (
    stage: IntakeScreeningTimingStage,
    status: IntakeScreeningTimingStatus,
    durationMs?: number,
  ) => void;
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
  | { kind: 'skipped'; reason: string; trace?: IntakeSemanticScreeningTrace }
  | {
    kind: 'contribution';
    contribution: IntakeEscalationContribution;
    trace?: IntakeSemanticScreeningTrace;
  }
  | {
    kind: 'quarantine';
    reason: string;
    contribution: IntakeEscalationContribution;
    trace?: IntakeSemanticScreeningTrace;
  }
  | {
    kind: 'final';
    trace?: IntakeSemanticScreeningTrace;
    result: {
      envelope: IntakeEnvelope;
      snapshot: IntakeEnvelopeSnapshot;
      action: IntakeDecisionAction;
      mode: IntakeEnforcementPosture;
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
  /** Trusted scheduler provenance used to prove a narrow internal tool-result class. */
  toolResultProvenance?: { toolName: string; arguments: unknown };
  /**
   * STRUCTURAL clean-bubble provenance, set ONLY by an authenticated call site
   * from tool/identity (never content). When the source class is internal
   * (tool_output / companion_self) this resolves the CogSec vector that drives
   * the centralized enforce/monitor decision; external ingress source classes
   * ignore it, so forged content cannot claim the clean bubble. Absent =
   * 'external' (screened normally).
   */
  structuralProvenance?: CogSecProvenanceClass;
  /**
   * Structurally authenticated channel/workflow identity. Unknown values are
   * rejected; content and origin strings never participate in resolution.
   */
  surface?: CogSecStructuralSurface;
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
  /** Canonical channel classification supplied by the authenticated surface. */
  channelPrivacy?: ChannelPrivacy;
  /**
   * Canonical, content-free evidence for the narrow owner-configured private
   * direct-chat handling rule. Missing or contradictory fields simply retain
   * the ordinary stricter screening path.
   */
  chatBodyContext?: {
    channelClass: IntakeChatBodyChannelClass;
    conversationScope: ConversationScope;
    contactTrust: {
      contactId: string;
      trustLevel: TrustLevel;
      resolvedAtMs: number;
      archived: boolean;
    };
  };
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
  /** Transport-authoritative message identity for post-incident correlation. */
  sourceMessageId?: string;
  /**
   * On-disk artifact paths carrying this item's raw content (a saved
   * document and its parsed-text sidecar). Registered on the quarantine hold
   * so read seams can refuse to serve a quarantined artifact and record the
   * attempt for the operator (hrmrq.54).
   */
  artifactPaths?: readonly string[];
  /** Content-free message correlation for bounded live latency telemetry. */
  timing?: IntakeScreeningTimingContext;
  atMs?: number;
}

export type IntakeScreeningTimingStage = 'local_screening' | 'l2' | 'l3';
export type IntakeScreeningTimingStatus = 'observed' | 'not_run';

export interface IntakeScreeningTimingContext {
  traceId: string;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  channelType?: string;
}

export interface IntakeScreeningTimingEvent extends IntakeScreeningTimingContext {
  stage: IntakeScreeningTimingStage;
  status: IntakeScreeningTimingStatus;
  durationMs?: number;
}

/**
 * Canonical content-free decision record emitted for every completed
 * screening, including released items. Raw text, safe summaries, origin refs,
 * and model output never ride this surface.
 */
interface IntakeScreeningObservabilityEvent {
  envelopeId: string;
  sourceClass: IntakeSourceClass;
  sourceRiskTier: IntakeSourceRiskTier;
  state: IntakeEnvelope['state'];
  action: IntakeDecisionAction;
  riskLabels: readonly IntakeRiskLabel[];
  scores: Readonly<Record<string, number>>;
  /** Verdicts supplied by upstream layers such as the image/OCR screener. */
  priorVerdicts: Readonly<Record<string, 'clear' | 'flagged'>>;
  semanticTrace: IntakeSemanticScreeningTrace;
}

export interface IntakeScreeningResult {
  /** The envelope in its post-screening state (released/…/quarantined). */
  envelope: IntakeEnvelope;
  /** Point-in-time projection for MessageRoutingMetadata / session metadata. */
  snapshot: IntakeEnvelopeSnapshot;
  report: IntakeL1ScanReport;
  action: IntakeDecisionAction;
  /** Per-item enforcement posture under which this item was evaluated. */
  mode: IntakeEnforcementPosture;
  /** Canonical global CogSec mode active when this item was screened. */
  globalMode: CogSecMode;
  /**
   * The declared CogSec vector resolved for this item (content-free; derived
   * from structural provenance). Feeds the centralized decision telemetry.
   */
  cogsecVector: CogSecVector;
  /** Content-free layer scores, escalation routing, and downstream verdicts. */
  observability: IntakeScreeningObservabilityEvent;
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
  /** Deep layers were scheduled after pass-through and have not settled yet. */
  postEscalation?: 'pending';
}

export interface IntakePostEscalationEvent {
  phase: 'post_pass';
  disposition: 'clear' | 'confirmed_bad' | 'failed_closed';
  surface: CogSecStructuralSurface;
  envelopeId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  action: IntakeDecisionAction;
  riskLabels: readonly IntakeRiskLabel[];
  scores: Readonly<Record<string, number>>;
  semanticTrace: IntakeSemanticScreeningTrace;
  cogSecCaseId?: string;
  completedAtMs: number;
}

export interface IntakeInlineShadowFindingEvent
  extends Omit<IntakePostEscalationEvent, 'phase' | 'disposition'> {
  phase: 'inline_shadow';
  disposition: 'confirmed_bad';
}

export type IntakeCogSecFindingEvent =
  | IntakePostEscalationEvent
  | IntakeInlineShadowFindingEvent;

export interface IntakeScreeningService {
  /** Ingress enforcement posture of this screening instance (observe/enforce). */
  readonly mode: IntakeEnforcementPosture;
  /** Canonical global CogSec mode this instance is running under. */
  readonly globalMode: CogSecMode;
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
  /** Structural alert telemetry; never carries screened content. */
  onFailClosed?: (event: {
    stage: 'escalation' | 'l3' | 'quarantine_hold';
    sourceClass: IntakeSourceClass;
    error: string;
    timestamp: number;
  }) => void;
  /** Content-free, telemetry-only observer. A throwing observer is isolated from screening. */
  onTiming?: (event: IntakeScreeningTimingEvent) => void;
  /** Canonical content-free decision observer. A throwing observer is isolated. */
  onDecision?: (event: IntakeScreeningObservabilityEvent) => void;
  /** Content-free completion observer for pass-through deep screening. */
  onPostEscalation?: (event: IntakePostEscalationEvent) => void | Promise<void>;
  /** Content-free alert observer for non-clean inline shadow-full decisions. */
  onInlineShadowFinding?: (event: IntakeInlineShadowFindingEvent) => void | Promise<void>;
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

function applyBenignClassPolicy(
  report: IntakeL1ScanReport,
  benignClass: IntakeBenignClass | undefined,
  policy: IntakePolicyConfig,
  controlReport: IntakeL1ScanReport | undefined,
): IntakeL1ScanReport {
  if (benignClass === undefined || controlReport === undefined) return report;
  if (controlReport.scannerErrors.some((error) => error.scannerId === INTAKE_RULE_ENGINE_SCANNER_ID)) {
    return report;
  }
  const configuredSuppressions = policy.sinkGates.benignClasses[benignClass];
  if (!configuredSuppressions || configuredSuppressions.length === 0) return report;
  const controlRuleIds = new Set(
    controlReport.results
      .filter((result) => result.scannerId === INTAKE_RULE_ENGINE_SCANNER_ID)
      .flatMap((result) => result.findings.map((finding) => finding.ruleId)),
  );
  const suppressedLabels = new Set<IntakeRiskLabel>();
  const suppressedRuleIds = new Set<string>();
  const results = report.results.map((result) => {
    if (result.scannerId !== INTAKE_RULE_ENGINE_SCANNER_ID) return result;
    const findings = result.findings.flatMap((finding) => {
      const configured = configuredSuppressions.find((entry) => entry.ruleId === finding.ruleId);
      if (!configured || controlRuleIds.has(finding.ruleId)) return [finding];
      const labels = finding.labels.filter((label) => {
        if (!configured.riskLabels.includes(label)) return true;
        suppressedLabels.add(label);
        suppressedRuleIds.add(finding.ruleId);
        return false;
      });
      if (labels.length === 0) return [];
      return [{ ...finding, labels }];
    });
    if (findings.length === result.findings.length
      && findings.every((finding, index) => finding === result.findings[index])) {
      return result;
    }
    return buildScannerResult({
      scannerId: result.scannerId,
      findings,
      ...(result.sanitized !== undefined ? { sanitized: result.sanitized } : {}),
      ...(result.extracted !== undefined ? { extracted: result.extracted } : {}),
    });
  });
  if (suppressedLabels.size === 0) return report;
  const scores: Record<string, number> = {};
  for (const result of results) scores[result.scannerId] = result.score;
  return {
    ...report,
    results,
    riskLabels: [...new Set(results.flatMap((result) => result.labels))],
    scores,
    extractedFields: {
      ...report.extractedFields,
      [`${INTAKE_RULE_ENGINE_SCANNER_ID}.benignClass`]: benignClass,
      [`${INTAKE_RULE_ENGINE_SCANNER_ID}.suppressedRuleIds`]: [...suppressedRuleIds].join(','),
      [`${INTAKE_RULE_ENGINE_SCANNER_ID}.suppressedRiskLabels`]: [...suppressedLabels].join(','),
    },
  };
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

function ruleMatchesForDecision(
  report: IntakeL1ScanReport,
  decision: { action: IntakeDecisionAction; reason: string },
): Pick<
  IntakeDecision,
  'ruleMatches' | 'ruleMatchTotalCount' | 'ruleMatchesTruncated'
> | undefined {
  if (decision.action !== 'quarantine' && decision.action !== 'block') return undefined;
  if (!decision.reason.startsWith('l1:') && !decision.reason.startsWith('onnx-threshold+l1:')) {
    return undefined;
  }
  const allMatches = report.results
    .filter((result) => result.scannerId === INTAKE_RULE_ENGINE_SCANNER_ID)
    .flatMap((result) => result.findings)
    .map((finding) => finding.match)
    .filter((match): match is IntakeL1RuleMatchProvenance => match !== undefined);
  if (allMatches.length === 0) return undefined;
  const ruleMatches = allMatches.slice(0, MAX_DECISION_RULE_MATCHES);
  return {
    ruleMatches,
    ruleMatchTotalCount: allMatches.length,
    ruleMatchesTruncated: allMatches.length > ruleMatches.length,
  };
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

/**
 * A zero-finding L1 report for the clean-bubble path, where NO semantic
 * scanner runs. It carries the original (capped) text as sanitizedText so a
 * downstream sanitize decision — impossible on this path, the posture never
 * enforces — would be a no-op, and records zero elapsed scanner time.
 */
function emptyL1ScanReport(text: string, scope: IntakeScanScope): IntakeL1ScanReport {
  return {
    scope,
    truncated: false,
    riskLabels: [],
    scores: {},
    results: [],
    sanitizedText: text,
    sanitizedDiffers: false,
    extractedFields: {},
    scannerErrors: [],
    elapsedMs: 0,
  };
}

/** Escalation results folded into `finalize` (never alters the L1 report). */
interface EscalationExtras {
  /** L2 verdict / recorded L2 failure merged onto the envelope fields. */
  contribution?: IntakeEscalationContribution;
  /** Fail-closed override of the L1/L1.5 decision (L2 per-tier quarantine). */
  forced?: { action: Extract<IntakeDecisionAction, 'quarantine'>; reason: string };
  /** Present only when the override was caused by a screening runtime failure. */
  failure?: { stage: 'escalation'; error: string };
  /** Keep an uncorroborated semantic score for audit, but do not act on it. */
  observeUncorroboratedSemanticScore?: boolean;
  /** Gateway semantic-layer routing/verdict record (content-free). */
  semanticTrace?: IntakeSemanticScreeningTrace;
  /** Local fast scan is recorded, but this surface always passes before deep scan. */
  postEscalationPass?: boolean;
}

function semanticLayersNotRun(reason: string): IntakeSemanticScreeningTrace {
  return {
    l2: { status: 'not_run', reason },
    l3: { status: 'not_run', reason },
  };
}

export function createIntakeScreeningService(
  options: IntakeScreeningServiceOptions,
): IntakeScreeningService {
  const { policy, l1, injectionScorer, escalation, quarantine, actor } = options;
  const globalMode = policy.mode;
  // Ingress enforcement posture of this screening instance: shadow observes,
  // boundary/strict enforce external ingress. Per-item clean-bubble bypass is
  // resolved inside screen()/screenSync() through the centralized posture.
  const mode = intakeEnforcementPosture(globalMode);
  const now = options.now ?? Date.now;

  function emitScreeningObservability(
    envelope: IntakeEnvelope,
    action: IntakeDecisionAction,
    semanticTrace: IntakeSemanticScreeningTrace,
    priorSignals: readonly IntakePriorScreeningSignal[] = [],
  ): IntakeScreeningObservabilityEvent {
    const priorVerdicts = Object.fromEntries(priorSignals.map((signal) => [
      signal.scannerId,
      signal.labels.length > 0 ? 'flagged' : 'clear',
    ])) as Record<string, 'clear' | 'flagged'>;
    const event: IntakeScreeningObservabilityEvent = {
      envelopeId: envelope.id,
      sourceClass: envelope.sourceClass,
      sourceRiskTier: envelope.sourceRiskTier,
      state: envelope.state,
      action,
      riskLabels: [...envelope.riskLabels],
      scores: { ...envelope.scores },
      priorVerdicts,
      semanticTrace,
    };
    // This deliberately runs at info for pass/release too. Before n82kq those
    // decisions existed only at debug and could not be attributed in a live
    // corpus drive. The payload is content-free by construction.
    log.info('Intake screening observability', event);
    try {
      options.onDecision?.(event);
    } catch (error) {
      log.warn('Intake screening decision observer failed', {
        envelopeId: envelope.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return event;
  }

  /** Resolves the declared CogSec vector for an item from its structural provenance. */
  function resolveCogSecVector(input: IntakeScreeningInput): CogSecVector {
    const provenance = resolveCogSecProvenanceClass({
      sourceClass: input.sourceClass,
      ...(input.structuralProvenance !== undefined
        ? { structuralProvenance: input.structuralProvenance }
        : {}),
    });
    return cogSecVectorForProvenance(provenance, input.sourceClass);
  }

  /** Content-free telemetry for a centralized enforce/monitor decision. */
  function emitDecisionTelemetry(event: {
    vector: CogSecVector;
    posture: IntakeEnforcementPosture;
    screens: boolean;
    sourceClass: IntakeSourceClass;
    originRef: string;
  }): void {
    log.debug('CogSec vector enforcement decision', {
      globalMode,
      vector: event.vector,
      posture: event.posture,
      screens: event.screens,
      sourceClass: event.sourceClass,
      originRef: event.originRef.slice(0, 256),
    });
  }

  /**
   * Clean-bubble short-circuit (boundary mode × internal vector): create a
   * released envelope with ZERO semantic-scanner calls and no risk labels, so
   * the item flows through every sink gate and can never be held solely by
   * its content. Content-free decision telemetry is still emitted; the raw
   * bytes never travel on the telemetry path. The per-item posture is always
   * 'shadow' (observe-only) on this path.
   */
  function screenCleanBubble(
    text: string,
    input: IntakeScreeningInput,
    vector: CogSecVector,
  ): IntakeScreeningResult {
    const adjusted = resolveTier(input);
    const atMs = input.atMs ?? now();
    const report = emptyL1ScanReport(text, input.scope);
    let envelope = createIntakeEnvelope({
      sourceClass: input.sourceClass,
      sourceRiskTier: adjusted.tier,
      contentRef: buildContentRef(text, quarantine ? 'intake-quarantine' : 'unpersisted'),
      origin: input.origin,
      atMs,
    });
    const intakeDecision: IntakeDecision = {
      action: 'pass',
      reason: `clean-bubble:${vector} (boundary internal vector; no semantic screening)`,
      decidedBy: 'policy',
      decidedAtMs: atMs,
    };
    envelope = transitionIntakeEnvelope(envelope, {
      to: 'screened',
      actor,
      reason: intakeDecision.reason.slice(0, COGSEC_DECISION_REASON_MAX_CHARS),
      atMs,
      decision: intakeDecision,
    });
    envelope = transitionIntakeEnvelope(envelope, {
      to: 'released',
      actor,
      reason: 'released per clean-bubble policy (boundary internal vector)',
      atMs,
    });
    const snapshot = snapshotIntakeEnvelope(
      envelope,
      input.subject ?? { kind: 'body' },
      'shadow',
    );
    emitDecisionTelemetry({
      vector,
      posture: 'shadow',
      screens: false,
      sourceClass: input.sourceClass,
      originRef: input.origin.ref,
    });
    emitDeepScreeningNotRun(input);
    const observability = emitScreeningObservability(
      envelope,
      'pass',
      semanticLayersNotRun(`clean-bubble:${vector}`),
    );
    log.debug('Intake clean-bubble release (zero semantic-screening calls)', {
      envelopeId: envelope.id,
      globalMode,
      vector,
      sourceClass: input.sourceClass,
      originRef: input.origin.ref.slice(0, 256),
    });
    return {
      envelope,
      snapshot,
      report,
      action: 'pass',
      mode: 'shadow',
      globalMode,
      cogsecVector: vector,
      observability,
      effectiveText: text,
      withheld: false,
    };
  }

  /** Resolves the per-item posture for an input under the global mode. */
  function resolveItemPosture(input: IntakeScreeningInput): {
    vector: CogSecVector;
    posture: IntakeEnforcementPosture;
    screens: boolean;
    deepScreening: 'inline' | 'post_pass';
  } {
    const vector = resolveCogSecVector(input);
    if (input.surface) {
      const resolved = resolveCogSecSurfacePosture(policy.surfacePostures, input.surface);
      return {
        vector,
        posture: resolved.enforces ? 'enforce' : 'shadow',
        screens: resolved.screens,
        deepScreening: resolved.deepScreening,
      };
    }
    const decision = resolveCogSecVectorPosture(globalMode, vector);
    return {
      vector,
      posture: cogSecItemEnforcementPosture(globalMode, vector),
      screens: decision.screens,
      deepScreening: 'inline',
    };
  }

  function isHighestTrustPrivateDirectMarkOnly(input: IntakeScreeningInput): boolean {
    const rule = policy.chatBodyHandling.highestTrustPrivateDirect;
    const context = input.chatBodyContext;
    if (rule.findingDisposition !== 'mark_only' || !context) return false;
    const scope = context.conversationScope;
    const ageMs = (input.atMs ?? now()) - context.contactTrust.resolvedAtMs;
    return rule.eligibleChannelClasses.includes(context.channelClass)
      && input.sourceClass === 'primary_user'
      && input.canonicalContactId !== undefined
      && scope.kind === 'dm'
      && scope.contact.contactId === input.canonicalContactId
      && context.contactTrust.contactId === input.canonicalContactId
      && context.contactTrust.trustLevel === 'primary'
      && context.contactTrust.archived === false
      && scope.channelId === input.sourceChannelId
      && input.channelPrivacy === 'private'
      && scope.envelope.channelPrivacy === 'private'
      && scope.envelope.audienceScope === 'one'
      && scope.envelope.audienceKnowledge === 'all_known'
      && scope.envelope.broadcast === false
      && ageMs >= 0
      && ageMs <= rule.trustResolutionMaxAgeMs;
  }

  function emitTiming(
    input: IntakeScreeningInput,
    stage: IntakeScreeningTimingStage,
    status: IntakeScreeningTimingStatus,
    durationMs?: number,
  ): void {
    if (!options.onTiming || !input.timing) return;
    try {
      options.onTiming({
        ...input.timing,
        stage,
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    } catch (error) {
      log.warn('Intake screening timing observer failed', {
        traceId: input.timing.traceId,
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function emitDeepScreeningNotRun(input: IntakeScreeningInput): void {
    emitTiming(input, 'l2', 'not_run');
    emitTiming(input, 'l3', 'not_run');
  }

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
      extractedFields[`${scorerOutcome.scannerId}.error`] = scorerOutcome.error.slice(
        0,
        COGSEC_EVIDENCE_FIELD_MAX_CHARS,
      );
    }
    for (const signal of priorSignals) {
      if (signal.score !== undefined) {
        scores[signal.scannerId] = signal.score;
      }
      for (const [key, value] of Object.entries(signal.extractedFields ?? {})) {
        extractedFields[key] = value.slice(0, COGSEC_EVIDENCE_FIELD_MAX_CHARS);
      }
    }
    if (adjusted.adjustment) {
      extractedFields['source_list.match'] =
        `${adjusted.adjustment.match.kind}:${adjusted.adjustment.match.list}:${adjusted.adjustment.match.pattern}`
          .slice(0, COGSEC_EVIDENCE_FIELD_MAX_CHARS);
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

  function emitInlineShadowFinding(
    input: IntakeScreeningInput,
    envelope: IntakeEnvelope,
    action: IntakeDecisionAction,
    semanticTrace: IntakeSemanticScreeningTrace,
    confirmedFinding: boolean,
    cogSecCaseId?: string,
  ): void {
    if (!input.surface || !confirmedFinding) return;
    const surfacePosture = resolveCogSecSurfacePosture(policy.surfacePostures, input.surface);
    if (surfacePosture.profile !== 'shadow_full') return;
    const sourceChannelId = input.sourceChannelId?.trim();
    const sourceMessageId = input.sourceMessageId?.trim();
    if (!sourceChannelId || !sourceMessageId) {
      options.onFailClosed?.({
        stage: 'escalation',
        sourceClass: input.sourceClass,
        error: 'inline shadow finding lacks structural sourceChannelId/sourceMessageId',
        timestamp: input.atMs ?? now(),
      });
      return;
    }
    const event: IntakeInlineShadowFindingEvent = {
      phase: 'inline_shadow',
      disposition: 'confirmed_bad',
      surface: input.surface,
      envelopeId: envelope.id,
      sourceChannelId,
      sourceMessageId,
      action,
      riskLabels: [...envelope.riskLabels],
      scores: { ...envelope.scores },
      semanticTrace,
      ...(cogSecCaseId ? { cogSecCaseId } : {}),
      completedAtMs: now(),
    };
    log.info('Inline shadow-full CogSec finding completed', event);
    try {
      const completion = options.onInlineShadowFinding?.(event);
      if (completion) {
        void completion.catch(error => {
          options.onFailClosed?.({
            stage: 'escalation',
            sourceClass: input.sourceClass,
            error: `inline shadow finding observer failed: ${error instanceof Error ? error.message : String(error)}`,
            timestamp: event.completedAtMs,
          });
        });
      }
    } catch (error) {
      options.onFailClosed?.({
        stage: 'escalation',
        sourceClass: input.sourceClass,
        error: `inline shadow finding observer failed: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: event.completedAtMs,
      });
    }
  }

  function finalize(
    text: string,
    input: IntakeScreeningInput,
    report: IntakeL1ScanReport,
    scorerOutcome: ScorerOutcome,
    itemPosture: IntakeEnforcementPosture,
    cogsecVector: CogSecVector,
    escalationExtras?: EscalationExtras,
  ): IntakeScreeningResult {
    const adjusted = resolveTier(input);
    const sourceRiskTier = adjusted.tier;
    const atMs = input.atMs ?? now();
    const itemEnforces = itemPosture === 'enforce';

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
    const injectionScoreForDecision = escalationExtras?.observeUncorroboratedSemanticScore
      ? undefined
      : scorerOutcome.score;
    const screenedDecision = escalationExtras?.forced
      ? { action: escalationExtras.forced.action, reason: escalationExtras.forced.reason }
      : decideAction({
        report,
        injectionScore: injectionScoreForDecision,
        injectionScoreThreshold: injectionScoreThresholdForTier(policy, sourceRiskTier),
        priorSignals,
      });
    // A valid direct-chat rule may downgrade actual screening findings, but
    // never infrastructure/audit failures: those retain the hard fail-closed
    // quarantine required by the escalation boundary.
    const markOnlyChatBody = !escalationExtras?.forced
      && !escalationExtras?.failure
      && isHighestTrustPrivateDirectMarkOnly(input);
    const postEscalationPass = escalationExtras?.postEscalationPass === true;
    const effectiveItemPosture: IntakeEnforcementPosture = markOnlyChatBody || postEscalationPass
      ? 'shadow'
      : itemPosture;
    const decision = postEscalationPass
      ? {
        action: 'pass' as const,
        reason: `post-escalation-pass:${screenedDecision.reason}`,
      }
      : markOnlyChatBody && screenedDecision.action !== 'pass'
      ? {
        action: 'pass' as const,
        reason: `chat-body-mark-only:${screenedDecision.reason}`,
      }
      : screenedDecision;
    const ruleMatchEvidence = ruleMatchesForDecision(report, decision);
    const intakeDecision: IntakeDecision = {
      action: decision.action,
      reason: decision.reason.slice(0, COGSEC_DECISION_REASON_MAX_CHARS),
      decidedBy: 'screening',
      decidedAtMs: atMs,
      ...(ruleMatchEvidence ?? {}),
    };

    const collected = collectSignalContribution(report, scorerOutcome, priorSignals, adjusted);
    const base = escalationExtras?.observeUncorroboratedSemanticScore
      ? {
        ...collected,
        // A record-only score must not leave an actionable injection label on
        // the envelope: sink gates consume riskLabels independently of the
        // screening action. Preserve the classifier output as audit metadata.
        riskLabels: [
          ...report.riskLabels,
          ...priorSignals.flatMap(signal => signal.labels),
        ],
        extractedFields: {
          ...collected.extractedFields,
          'semantic_score.labels': scorerOutcome.labels.join(','),
        },
      }
      : collected;
    const scores: Record<string, number> = {
      ...base.scores,
      ...(escalationExtras?.contribution?.scores ?? {}),
    };
    const extractedFields: Record<string, string> = {
      ...base.extractedFields,
      ...(escalationExtras?.contribution?.extractedFields ?? {}),
      ...(escalationExtras?.observeUncorroboratedSemanticScore
        ? { 'semantic_score.disposition': 'observed_first_party_closed_channel' }
        : {}),
      ...(markOnlyChatBody
        ? {
          'chat_body.handling': 'highest_trust_private_direct_mark_only',
          'chat_body.screened_action': screenedDecision.action,
        }
        : {}),
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
      extractedFields['marking.provenance'] = markingPlan.provenanceNote.slice(
        0,
        COGSEC_EVIDENCE_FIELD_MAX_CHARS,
      );
    }

    envelope = transitionIntakeEnvelope(envelope, {
      to: 'screened',
      actor,
      reason: decision.reason.slice(0, COGSEC_DECISION_REASON_MAX_CHARS),
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

    const withheld = itemEnforces
      && (decision.action === 'quarantine' || decision.action === 'block');
    let effectiveText = text;
    if (itemEnforces) {
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
          mode: itemPosture,
          rawText: text,
          ...(input.canonicalContactId !== undefined
            ? { canonicalContactId: input.canonicalContactId }
            : {}),
          ...(input.sourceChannelId !== undefined
            ? { sourceChannelId: input.sourceChannelId }
            : {}),
          ...(input.artifactPaths !== undefined && input.artifactPaths.length > 0
            ? { artifactPaths: input.artifactPaths }
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

    const snapshot = snapshotIntakeEnvelope(
      envelope,
      input.subject ?? { kind: 'body' },
      effectiveItemPosture,
    );

    // Every decision is audited; findings and enforcement escalate severity.
    const auditPayload = {
      envelopeId: envelope.id,
      sourceClass: input.sourceClass,
      sourceRiskTier,
      originRef: input.origin.ref,
      mode: effectiveItemPosture,
      globalMode,
      cogsecVector,
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
    if (escalationExtras?.failure) {
      options.onFailClosed?.({
        stage: escalationExtras.failure.stage,
        sourceClass: input.sourceClass,
        error: escalationExtras.failure.error,
        timestamp: atMs,
      });
    }
    if (quarantineHoldError) {
      options.onFailClosed?.({
        stage: 'quarantine_hold',
        sourceClass: input.sourceClass,
        error: quarantineHoldError,
        timestamp: atMs,
      });
    }

    const observability = emitScreeningObservability(
      envelope,
      decision.action,
      escalationExtras?.semanticTrace
        ?? semanticLayersNotRun('semantic escalation was not requested'),
      priorSignals,
    );
    if (!postEscalationPass) {
      const semanticFailure = observability.semanticTrace.l2.status === 'failed_closed'
        || observability.semanticTrace.l3.status === 'failed_closed';
      emitInlineShadowFinding(
        input,
        envelope,
        screenedDecision.action,
        observability.semanticTrace,
        screenedDecision.action !== 'pass' && !semanticFailure,
      );
    }

    return {
      envelope,
      snapshot,
      report,
      action: decision.action,
      mode: effectiveItemPosture,
      globalMode,
      cogsecVector,
      observability,
      effectiveText,
      withheld,
      ...(scorerOutcome.score !== undefined ? { injectionScore: scorerOutcome.score } : {}),
      ...(scorerOutcome.error ? { injectionScorerError: scorerOutcome.error } : {}),
      ...(quarantineHoldError ? { quarantineHoldError } : {}),
      ...(markingPlan ? { markingPlan } : {}),
      ...(postEscalationPass ? { postEscalation: 'pending' as const } : {}),
    };
  }

  function schedulePostEscalation(
    text: string,
    input: IntakeScreeningInput,
    report: IntakeL1ScanReport,
    scorerOutcome: ScorerOutcome,
    port: IntakeEscalationPort,
    cogsecVector: CogSecVector,
  ): IntakeScreeningResult {
    if (!input.surface) throw new Error('Post-escalation screening requires a structural surface');
    const sourceChannelId = input.sourceChannelId?.trim();
    const sourceMessageId = input.sourceMessageId?.trim();
    if (!sourceChannelId || !sourceMessageId) {
      throw new Error(
        'Post-escalation screening requires structural sourceChannelId and sourceMessageId',
      );
    }
    const atMs = input.atMs ?? now();
    const timedInput: IntakeScreeningInput = { ...input, atMs };
    const adjusted = resolveTier(input);
    const priorSignals = input.priorSignals ?? [];
    const prior = collectSignalContribution(report, scorerOutcome, priorSignals, adjusted);
    const priorScore = Math.min(1, Math.max(0, ...Object.values(prior.scores)));
    const local = finalize(text, timedInput, report, scorerOutcome, 'shadow', cogsecVector, {
      postEscalationPass: true,
      semanticTrace: semanticLayersNotRun('deep screening scheduled after pass-through'),
    });

    const completion = port.escalate({
      text,
      sourceClass: input.sourceClass,
      sourceRiskTier: adjusted.tier,
      enforcementPosture: 'shadow',
      priorScore,
      origin: input.origin,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.canonicalContactId ? { canonicalContactId: input.canonicalContactId } : {}),
      sourceChannelId,
      priorContribution: prior,
      ...(input.artifactPaths ? { artifactPaths: input.artifactPaths } : {}),
      emitTiming: (stage, status, durationMs) => emitTiming(timedInput, stage, status, durationMs),
      atMs,
    }).then((decision): IntakePostEscalationEvent => {
      const final = decision.kind === 'final' ? decision.result : undefined;
      const action: IntakeDecisionAction = decision.kind === 'quarantine'
        ? 'quarantine'
        : final?.action ?? 'pass';
      const deepRiskLabels = decision.kind === 'contribution' || decision.kind === 'quarantine'
        ? decision.contribution.riskLabels
        : final?.envelope.riskLabels ?? [];
      const riskLabels = [...new Set([...prior.riskLabels, ...deepRiskLabels])];
      const deepScores = decision.kind === 'contribution' || decision.kind === 'quarantine'
        ? decision.contribution.scores
        : final?.envelope.scores ?? {};
      const scores = { ...prior.scores, ...deepScores };
      const semanticTrace = decision.trace
        ?? semanticLayersNotRun(`uninstrumented post-escalation result: ${decision.kind}`);
      const confirmedBad = decision.kind === 'quarantine'
        || action === 'quarantine'
        || action === 'block'
        || riskLabels.some(label => INTAKE_QUARANTINE_RISK_LABELS.includes(label));
      return {
        phase: 'post_pass',
        disposition: confirmedBad ? 'confirmed_bad' : 'clear',
        surface: input.surface!,
        envelopeId: local.envelope.id,
        sourceChannelId,
        sourceMessageId,
        action,
        riskLabels: [...riskLabels],
        scores,
        semanticTrace,
        ...(final?.cogSecCaseId ? { cogSecCaseId: final.cogSecCaseId } : {}),
        completedAtMs: now(),
      };
    }).catch((error): IntakePostEscalationEvent => {
      log.error('Post-pass CogSec escalation failed closed', {
        envelopeId: local.envelope.id,
        sourceChannelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        phase: 'post_pass',
        disposition: 'failed_closed',
        surface: input.surface!,
        envelopeId: local.envelope.id,
        sourceChannelId,
        sourceMessageId,
        action: 'quarantine',
        riskLabels: [],
        scores: { ...prior.scores },
        semanticTrace: {
          l2: { status: 'failed_closed', reason: 'post-escalation transport failed' },
          l3: { status: 'failed_closed', reason: 'post-escalation transport failed' },
        },
        completedAtMs: now(),
      };
    }).then(event => {
      log.info('Post-pass CogSec escalation completed', event);
      return event;
    });
    void completion.then(async event => {
      try {
        await options.onPostEscalation?.(event);
      } catch (error) {
        options.onFailClosed?.({
          stage: 'escalation',
          sourceClass: input.sourceClass,
          error: `post-escalation observer failed: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: event.completedAtMs,
        });
        log.error('Post-pass CogSec escalation observer failed', {
          envelopeId: event.envelopeId,
          sourceChannelId: event.sourceChannelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return local;
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
    itemPosture: IntakeEnforcementPosture,
    cogsecVector: CogSecVector,
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
      emitDeepScreeningNotRun(timedInput);
      return finalize(text, timedInput, report, scorerOutcome, itemPosture, cogsecVector, {
        semanticTrace: semanticLayersNotRun(
          `local-terminal:${preliminary.action}`,
        ),
      });
    }

    const prior = collectSignalContribution(report, scorerOutcome, priorSignals, adjusted);
    const priorScore = Math.min(1, Math.max(0, ...Object.values(prior.scores)));

    let escalationDecision: IntakeEscalationDecision;
    try {
      escalationDecision = await port.escalate({
        text,
        sourceClass: input.sourceClass,
        sourceRiskTier: adjusted.tier,
        ...(isHighestTrustPrivateDirectMarkOnly(input)
          ? { enforcementPosture: 'shadow' as const }
          : {}),
        priorScore,
        origin: input.origin,
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.canonicalContactId !== undefined
          ? { canonicalContactId: input.canonicalContactId }
          : {}),
        ...(input.sourceChannelId !== undefined
          ? { sourceChannelId: input.sourceChannelId }
          : {}),
        // hrmrq.54: the escalation port owns the quarantine hold on the L3
        // 'final' path, so the artifact paths must travel with the request —
        // omitting them here left L2/L3-only quarantines with unregistered,
        // guard-invisible artifacts.
        ...(input.artifactPaths !== undefined && input.artifactPaths.length > 0
          ? { artifactPaths: input.artifactPaths }
          : {}),
        priorContribution: prior,
        ...(input.timing
          ? {
            emitTiming: (stage, status, durationMs) => emitTiming(
              timedInput,
              stage,
              status,
              durationMs,
            ),
          }
          : {}),
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
      return finalize(text, timedInput, report, scorerOutcome, itemPosture, cogsecVector, {
        forced: {
          action: 'quarantine',
          reason: `escalation-fail-closed:${message}`.slice(
            0,
            COGSEC_DECISION_REASON_MAX_CHARS,
          ),
        },
        failure: {
          stage: 'escalation',
          error: message,
        },
        contribution: {
          riskLabels: [],
          scores: {},
          extractedFields: {
            'escalation.error': message.slice(0, COGSEC_EVIDENCE_FIELD_MAX_CHARS),
          },
        },
        semanticTrace: {
          l2: { status: 'failed_closed', reason: 'gateway escalation port failed' },
          l3: { status: 'failed_closed', reason: 'gateway escalation port failed' },
        },
      });
    }

    switch (escalationDecision.kind) {
      case 'skipped':
        return finalize(text, timedInput, report, scorerOutcome, itemPosture, cogsecVector, {
          semanticTrace: escalationDecision.trace
            ?? semanticLayersNotRun(`uninstrumented escalation port: ${escalationDecision.reason}`),
        });
      case 'contribution':
        return finalize(text, timedInput, report, scorerOutcome, itemPosture, cogsecVector, {
          contribution: escalationDecision.contribution,
          semanticTrace: escalationDecision.trace
            ?? semanticLayersNotRun('uninstrumented escalation contribution'),
        });
      case 'quarantine':
        return finalize(text, timedInput, report, scorerOutcome, itemPosture, cogsecVector, {
          forced: {
            action: 'quarantine',
            reason: escalationDecision.reason.slice(0, COGSEC_DECISION_REASON_MAX_CHARS),
          },
          contribution: escalationDecision.contribution,
          semanticTrace: escalationDecision.trace
            ?? semanticLayersNotRun('uninstrumented escalation quarantine'),
        });
      case 'final': {
        // L3 was invoked: the port already owns the envelope, the CogSecEvent,
        // and the quarantine hold (applyL3ScreeningOutcome hard rule). Its
        // effectiveText contract matches this service's: original in shadow,
        // withheld notice / safe representation in enforce — the L3-reached
        // raw content string never ships in enforce mode.
        const final = escalationDecision.result;
        const observability = emitScreeningObservability(
          final.envelope,
          final.action,
          escalationDecision.trace
            ?? semanticLayersNotRun('uninstrumented final escalation'),
          priorSignals,
        );
        emitInlineShadowFinding(
          timedInput,
          final.envelope,
          final.action,
          observability.semanticTrace,
          observability.semanticTrace.l3.status === 'flagged',
          final.cogSecCaseId,
        );
        return {
          envelope: final.envelope,
          snapshot: final.snapshot,
          report,
          action: final.action,
          mode: final.mode,
          globalMode,
          cogsecVector,
          observability,
          effectiveText: final.effectiveText,
          withheld: final.withheld,
          ...(scorerOutcome.score !== undefined ? { injectionScore: scorerOutcome.score } : {}),
          ...(scorerOutcome.error ? { injectionScorerError: scorerOutcome.error } : {}),
          cogSecCaseId: final.cogSecCaseId,
        };
      }
    }
  }

  function scanL1(text: string, input: IntakeScreeningInput): IntakeL1ScanReport {
    const report = l1.scan(text, { scope: input.scope });
    if (input.sourceClass !== 'tool_output' || input.toolResultProvenance === undefined) {
      return report;
    }
    const classification = classifyToolResultBenignClass({
      ...input.toolResultProvenance,
      text,
    });
    if (classification === undefined) return report;
    const controlReport = l1.scan(classification.controlText, { scope: input.scope });
    return applyBenignClassPolicy(
      report,
      classification.benignClass,
      policy,
      controlReport,
    );
  }

  async function screen(text: string, input: IntakeScreeningInput): Promise<IntakeScreeningResult> {
    const item = resolveItemPosture(input);
    if (!item.screens) {
      // Clean bubble (boundary × internal vector): zero semantic-screening calls.
      return screenCleanBubble(text, input, item.vector);
    }
    emitDecisionTelemetry({
      vector: item.vector,
      posture: item.posture,
      screens: true,
      sourceClass: input.sourceClass,
      originRef: input.origin.ref,
    });
    const localScreeningStartedAt = performance.now();
    const report = scanL1(text, input);
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
    emitTiming(
      input,
      'local_screening',
      'observed',
      Math.max(0, performance.now() - localScreeningStartedAt),
    );
    const adjustedTier = resolveTier(input).tier;
    const aboveSemanticThreshold = scorerOutcome.score !== undefined
      && scorerOutcome.score >= injectionScoreThresholdForTier(policy, adjustedTier);
    const mandatoryDeepScreening = policy.l2Screener.mandatoryTiers.includes(adjustedTier)
      || policy.l3Screener.mandatoryTiers.includes(adjustedTier);
    const provenHighestTrustPrivateDirect = isHighestTrustPrivateDirectMarkOnly(input);
    const deterministicScreenIsClean = report.riskLabels.length === 0
      && report.scannerErrors.length === 0
      && !report.truncated
      && (input.priorSignals ?? []).every((signal) => signal.labels.length === 0);
    if (
      aboveSemanticThreshold
      && !mandatoryDeepScreening
      && provenHighestTrustPrivateDirect
      && deterministicScreenIsClean
    ) {
      // The local classifier remains visible telemetry, but an uncorroborated
      // false positive must not rewrite or delay an authenticated highest-trust
      // private direct chat. Deterministic findings still take
      // their ordinary fail-closed path before this narrow optimization, and
      // operator-mandated L2/L3 tiers retain their configured deep screening.
      emitDeepScreeningNotRun(input);
      return finalize(text, input, report, scorerOutcome, item.posture, item.vector, {
        observeUncorroboratedSemanticScore: true,
      });
    }
    if (!escalation || !text.trim()) {
      emitDeepScreeningNotRun(input);
      return finalize(text, input, report, scorerOutcome, item.posture, item.vector);
    }
    if (item.deepScreening === 'post_pass') {
      return schedulePostEscalation(text, input, report, scorerOutcome, escalation, item.vector);
    }
    return escalateAndFinalize(text, input, report, scorerOutcome, escalation, item.posture, item.vector);
  }

  function screenSync(text: string, input: IntakeScreeningInput): IntakeScreeningResult {
    if (injectionScorer || escalation) {
      throw new Error(
        'screenSync is only available on L1-only intake screening services; '
        + 'this service has an async injection scorer or escalation port '
        + 'configured — use screen()',
      );
    }
    const item = resolveItemPosture(input);
    if (item.deepScreening === 'post_pass') {
      throw new Error(
        'CogSec post-escalation surfaces require asynchronous screen(); screenSync cannot schedule deep screening',
      );
    }
    if (!item.screens) {
      return screenCleanBubble(text, input, item.vector);
    }
    emitDecisionTelemetry({
      vector: item.vector,
      posture: item.posture,
      screens: true,
      sourceClass: input.sourceClass,
      originRef: input.origin.ref,
    });
    const localScreeningStartedAt = performance.now();
    const report = scanL1(text, input);
    emitTiming(
      input,
      'local_screening',
      'observed',
      Math.max(0, performance.now() - localScreeningStartedAt),
    );
    emitDeepScreeningNotRun(input);
    return finalize(text, input, report, { labels: [] }, item.posture, item.vector);
  }

  return { mode, globalMode, screen, screenSync };
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
  onFailClosed?: IntakeScreeningServiceOptions['onFailClosed'];
}

/**
 * Constructs the L1 scanner (fail-closed on a missing/invalid rule file) and
 * the screening service. The canonical CogSec mode is always one of
 * shadow/boundary/strict, so screening is always wired; null is returned only
 * for callers that explicitly opt out (a null `policy`).
 */
export function maybeCreateIntakeScreeningService(
  options: MaybeCreateIntakeScreeningOptions,
): IntakeScreeningService | null {
  return createIntakeScreeningService({
    policy: options.policy,
    l1: createIntakeL1Scanner({
      ...options.l1Config,
      schemeActions: options.policy.urlScanner.schemeActions,
    }),
    ...(options.injectionScorer ? { injectionScorer: options.injectionScorer } : {}),
    ...(options.quarantine ? { quarantine: options.quarantine } : {}),
    actor: options.actor,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onFailClosed ? { onFailClosed: options.onFailClosed } : {}),
  });
}
