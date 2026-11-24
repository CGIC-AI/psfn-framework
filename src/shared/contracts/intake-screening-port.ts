// ── Cognition Intake Firewall: screening port contracts (psfn-framework-kbdvl.1) ──
//
// Core-owned structural port and event contracts for the intake screening
// service so core session, memory, shard, and EventBus modules never import
// the host CogSec screening pipeline implementation.

import type {
  CogSecMode,
  CogSecProvenanceClass,
  CogSecStructuralSurface,
  CogSecVector,
  IntakeEnforcementPosture,
} from './cogsec-mode.js';
import type { CogSecReceipt } from './cogsec-receipt.js';
import type {
  IntakeDecisionAction,
  IntakeEnvelope,
  IntakeEnvelopeSnapshot,
  IntakeEnvelopeSubject,
  IntakeL1RuleMatchProvenance,
  IntakeMarkingPlan,
  IntakeRiskLabel,
  IntakeSourceClass,
  IntakeSourceRiskTier,
} from './intake-envelope.js';
import type { IntakeChatBodyChannelClass } from '../../system/config/intake-policy-config.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../system/trust/types.js';
import type { ConversationScope } from '../../core/session/conversation-scope.js';

export const INTAKE_SCAN_SCOPES = ['all', 'context', 'strict'] as const;

export type IntakeScanScope = typeof INTAKE_SCAN_SCOPES[number];

export interface IntakeScannerFinding {
  /** Rule/detector name. For rule-file rules this doubles as the audit id. */
  ruleId: string;
  /** Envelope taxonomy labels this finding contributes. May be empty for score-only structural findings. */
  labels: readonly IntakeRiskLabel[];
  /** Score contribution in (0, 1]. Combined per scanner via noisy-or. */
  weight: number;
  /** Narrowest scope tier this finding belongs to (already scope-filtered when emitted). */
  scope: IntakeScanScope;
  /** Human-auditable detail. Must never carry raw payload bytes. */
  detail?: string;
  /** Bounded evidence for an owner-file rule match; absent for other detectors. */
  match?: IntakeL1RuleMatchProvenance;
}

export interface IntakeScannerResult {
  scannerId: string;
  /** Deduplicated union of finding labels. */
  labels: readonly IntakeRiskLabel[];
  /** Calibrated 0–1 score for this scanner (envelope `scores[scannerId]`). */
  score: number;
  findings: readonly IntakeScannerFinding[];
  /** Transformed text when the scanner sanitizes (llm-guard transform contract). */
  sanitized?: string;
  /** Safe schema-extracted metadata (envelope `extractedFields` candidates). */
  extracted?: Readonly<Record<string, string>>;
}

export interface IntakeL1ScannerError {
  scannerId: string;
  message: string;
}

export interface IntakeL1ScanReport {
  scope: IntakeScanScope;
  /** True when the input exceeded MAX_SCAN_CHARS and was capped pre-regex. */
  truncated: boolean;
  /** Deduplicated union across scanners — envelope riskLabels input. */
  riskLabels: readonly IntakeRiskLabel[];
  /** Per-scanner 0–1 scores keyed by scanner id — envelope scores input. */
  scores: Readonly<Record<string, number>>;
  results: readonly IntakeScannerResult[];
  /**
   * Invisible-stripped, datamark-stripped, NFKC-normalized, secret-redacted
   * text (capped). Substituting it for the raw content is a policy decision
   * (htm9.3 'sanitize'), not L1's.
   */
  sanitizedText: string;
  /** True when sanitizedText differs from the original input. */
  sanitizedDiffers: boolean;
  /** Merged scanner extractions, keyed `<scannerId>.<key>` — envelope extractedFields input. */
  extractedFields: Readonly<Record<string, string>>;
  /** Scanner failures (fail-open-advisory: visible, never swallowed). */
  scannerErrors: readonly IntakeL1ScannerError[];
  elapsedMs: number;
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
 * A screening signal produced by an UPSTREAM screener that ran before this
 * service — e.g. the htm9.8 vision screener whose VLM flags an image's
 * embedded instruction text before the OCR transcript is L1-scanned here.
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

export interface IntakeScreeningInput {
  sourceClass: IntakeSourceClass;
  /** Trusted scheduler provenance used to prove a narrow internal tool-result class. */
  toolResultProvenance?: { toolName: string; arguments: unknown };
  /**
   * STRUCTURAL clean-bubble provenance, set ONLY by an authenticated call site
   * from tool/identity (never content).
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
  /** Canonical contact id of the sender, when the surface knows one. */
  canonicalContactId?: string;
  /** Canonical channel classification supplied by the authenticated surface. */
  channelPrivacy?: ChannelPrivacy;
  /** Canonical, content-free evidence for the private direct-chat handling rule. */
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
  /** Signals from screeners that already ran on this content upstream. */
  priorSignals?: readonly IntakePriorScreeningSignal[];
  /** Carrying channel id, when the surface knows one. */
  sourceChannelId?: string;
  /** Transport-authoritative message identity for post-incident correlation. */
  sourceMessageId?: string;
  /** On-disk artifact paths carrying this item's raw content. */
  artifactPaths?: readonly string[];
  /** Content-free message correlation for bounded live latency telemetry. */
  timing?: IntakeScreeningTimingContext;
  atMs?: number;
}

export interface IntakeScreeningObservabilityEvent {
  envelopeId: string;
  sourceClass: IntakeSourceClass;
  sourceRiskTier: IntakeSourceRiskTier;
  state: IntakeEnvelope['state'];
  action: IntakeDecisionAction;
  riskLabels: readonly IntakeRiskLabel[];
  scores: Readonly<Record<string, number>>;
  priorVerdicts: Readonly<Record<string, 'clear' | 'flagged'>>;
  semanticTrace: IntakeSemanticScreeningTrace;
}

export type IntakeReceiptAbsenceReason =
  | 'no_receipt_writer'
  | 'sync_screening'
  | 'clean_bubble'
  | 'screening_incomplete'
  | 'deep_screening_pending'
  | 'not_admitted'
  | 'withheld'
  | 'envelope_not_consumable'
  | 'scan_truncated'
  | 'scanner_error'
  | 'injection_scorer_error';

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
  /** Declared CogSec vector resolved for this item (content-free). */
  cogsecVector: CogSecVector;
  /** Content-free layer scores, escalation routing, and downstream verdicts. */
  observability: IntakeScreeningObservabilityEvent;
  /** Text for downstream use. */
  effectiveText: string;
  /** True when enforce-mode quarantine withheld the content. */
  withheld: boolean;
  /** L1.5 score when a scorer ran; absent for L1-only screening. */
  injectionScore?: number;
  /** Visible-not-swallowed L1.5 failure (screening continued on L1 signals). */
  injectionScorerError?: string;
  /** Visible-not-swallowed failure writing a quarantined item to the durable hold store. */
  quarantineHoldError?: string;
  /** Data-marking plan (htm9.13) for markable source classes. */
  markingPlan?: IntakeMarkingPlan;
  /** Auditable CogSecEvent written when the item reached the L3 heavy screener. */
  cogSecCaseId?: string;
  /** Deep layers were scheduled after pass-through and have not settled yet. */
  postEscalation?: 'pending';
  /** Content-addressed admission receipt. */
  receipt?: CogSecReceipt;
  /** Visible-not-swallowed failure minting or persisting the admission receipt. */
  receiptIssuanceError?: string;
  /** Why this result carries no receipt. */
  receiptAbsence?: IntakeReceiptAbsenceReason;
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
  screen(text: string, input: IntakeScreeningInput): Promise<IntakeScreeningResult>;
  screenSync(text: string, input: IntakeScreeningInput): IntakeScreeningResult;
  screeningContractDigest(input: IntakeScreeningInput): string | null;
}
