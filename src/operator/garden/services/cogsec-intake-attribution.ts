// ── Fleet CogSec: plain-text, content-free intake attribution (waw5q) ──
//
// The Cognitive Security surface must let an operator read every event by
// *meaning*, not by opaque id. This module projects plain-text attribution
// (channel label/class, inbound/outbound direction, fault type, screening
// stage, decision, correlation, and authorized target display names) from the
// existing intake quarantine / CogSec event data — WITHOUT copying message
// bodies or cross-companion private data.
//
// It is a pure projection: no new telemetry store, no persistence, no network.
// Display names are only resolved through an explicit authorized resolver port;
// when none is wired (or the viewer is not authorized for a given target) the
// name is simply absent — never fabricated, never a raw private id in the
// default projection.
//
// Raw ids (envelope id, channel id, contact id, case id) remain available only
// through the existing drill-down detail fields, never synthesized here.

import type { IntakeQuarantineHoldReason } from '../../../shared/contracts/intake-quarantine-hold-reason.js';
import type { IntakeQuarantineDecisionAction } from '../../../core/cogsec/intake/quarantine-store.js';

const INTAKE_COGSEC_DIRECTIONS = ['inbound', 'outbound'] as const;
export type IntakeCogSecDirection = typeof INTAKE_COGSEC_DIRECTIONS[number];

const INTAKE_COGSEC_SCREENING_STAGES = [
  'l1',
  'l1_5',
  'l2',
  'l3',
  'human',
  'unknown',
] as const;
export type IntakeCogSecScreeningStage = typeof INTAKE_COGSEC_SCREENING_STAGES[number];

/**
 * Plain-text channel attribution. `sourceChannelLabel` is a human label
 * ("Discord", "Web fetch"); `sourceChannelClass` is a coarse bucket
 * ("contact", "web", "tool", "internal"). Neither is ever a raw channel id.
 */
interface IntakeCogSecChannelAttribution {
  readonly sourceChannelLabel: string;
  readonly sourceChannelClass: string;
  readonly direction: IntakeCogSecDirection;
}

/**
 * Full content-free attribution for one intake CogSec row. Display names are
 * present only when an authorized resolver supplied them.
 */
export interface IntakeCogSecAttribution extends IntakeCogSecChannelAttribution {
  /** Plain-text fault family ("Prompt injection", "Screening malfunction", …). */
  readonly faultType: string;
  readonly screeningStage: IntakeCogSecScreeningStage;
  /** Plain-text terminal decision ("Held for review", "Released raw", …). */
  readonly decision: string;
  /**
   * Content-free correlation key grouping one group fanout (the same screened
   * delivery reaching several targets). Derived from the shared case/content
   * hash — never the message body.
   */
  readonly correlationId?: string;
  /** Target companion display name, only when the viewer is authorized. */
  readonly targetCompanionDisplayName?: string;
  /** Target contact/user display name, only when the viewer is authorized. */
  readonly targetContactDisplayName?: string;
}

/**
 * Input shape shared by the quarantine entry and the CogSec event projections.
 * Deliberately structural so the same projection serves both sources.
 */
interface IntakeCogSecAttributionInput {
  readonly sourceClass: string;
  readonly sourceChannelId?: string;
  readonly canonicalContactId?: string;
  readonly riskLabels: readonly string[];
  readonly holdReason: IntakeQuarantineHoldReason;
  readonly screeningDecisionReason?: string;
  readonly status: string;
  readonly operatorAction?: IntakeQuarantineDecisionAction;
  /** Shared case/content-hash key used to correlate a group fanout. */
  readonly correlationKey?: string;
}

/**
 * Resolves a plain-text channel label/class and direction. The default
 * implementation derives these from the source class and the opaque channel id
 * prefix, so enrichment works without an external channel registry.
 */
export interface IntakeChannelAttributionResolver {
  resolve(
    sourceChannelId: string | undefined,
    sourceClass: string,
  ): IntakeCogSecChannelAttribution;
}

/**
 * Resolves a target contact/user display name. Returns `undefined` when the
 * viewer is not authorized for that contact — display names are an authorized
 * projection, never a default. (Target *companion* display names are resolved
 * by the fleet overview from the authorized companion manifest.)
 */
type IntakeContactDisplayNameResolver = (
  canonicalContactId: string | undefined,
) => string | undefined;

export interface IntakeCogSecAttributionResolvers {
  readonly channel?: IntakeChannelAttributionResolver;
  readonly contactDisplayName?: IntakeContactDisplayNameResolver;
  readonly companionDisplayName?: (companionId: string | undefined) => string | undefined;
}

// ── Direction ──

const OUTBOUND_SOURCE_CLASSES: ReadonlySet<string> = new Set([
  'tool_output',
  'subagent_output',
  'shard_foldback',
]);

export function isIntakeCogSecDirection(value: unknown): value is IntakeCogSecDirection {
  return typeof value === 'string'
    && (INTAKE_COGSEC_DIRECTIONS as readonly string[]).includes(value);
}

export function deriveIntakeDirection(sourceClass: string): IntakeCogSecDirection {
  return OUTBOUND_SOURCE_CLASSES.has(sourceClass) ? 'outbound' : 'inbound';
}

// ── Channel label/class ──

interface ChannelClassProjection {
  readonly label: string;
  readonly channelClass: string;
}

const CHANNEL_ID_PREFIX_LABELS: ReadonlyArray<{ prefix: string; projection: ChannelClassProjection }> = [
  { prefix: 'discord:', projection: { label: 'Discord', channelClass: 'contact' } },
  { prefix: 'web:', projection: { label: 'Web', channelClass: 'web' } },
  { prefix: 'http:', projection: { label: 'Web', channelClass: 'web' } },
  { prefix: 'https:', projection: { label: 'Web', channelClass: 'web' } },
  { prefix: 'tool:', projection: { label: 'Tool', channelClass: 'tool' } },
  { prefix: 'gateway:', projection: { label: 'Gateway', channelClass: 'internal' } },
  { prefix: 'garden:', projection: { label: 'Garden', channelClass: 'internal' } },
];

const SOURCE_CLASS_CHANNEL_PROJECTION: Readonly<Record<string, ChannelClassProjection>> = {
  operator: { label: 'Operator', channelClass: 'internal' },
  companion_self: { label: 'Companion self', channelClass: 'internal' },
  primary_user: { label: 'Primary user', channelClass: 'contact' },
  trusted_contact: { label: 'Trusted contact', channelClass: 'contact' },
  regular_contact: { label: 'Contact', channelClass: 'contact' },
  public_contact: { label: 'Public contact', channelClass: 'contact' },
  web_fetch: { label: 'Web fetch', channelClass: 'web' },
  web_search: { label: 'Web search', channelClass: 'web' },
  document: { label: 'Document', channelClass: 'document' },
  image_ocr: { label: 'Image OCR', channelClass: 'document' },
  audio_transcript: { label: 'Audio transcript', channelClass: 'document' },
  tool_output: { label: 'Tool output', channelClass: 'tool' },
  subagent_output: { label: 'Subagent output', channelClass: 'tool' },
  shard_foldback: { label: 'Shard foldback', channelClass: 'tool' },
  mcp_tool_description: { label: 'MCP tool description', channelClass: 'tool' },
};

/**
 * Default resolver: prefers an opaque channel-id prefix, then the envelope
 * source class. Never echoes a raw id — unknown prefixes fall back to the
 * source-class label rather than leaking the id.
 */
export const defaultIntakeChannelAttributionResolver: IntakeChannelAttributionResolver = {
  resolve(sourceChannelId, sourceClass) {
    const fromId = sourceChannelId?.trim()
      ? CHANNEL_ID_PREFIX_LABELS.find(entry => sourceChannelId!.startsWith(entry.prefix))?.projection
      : undefined;
    const fallback = SOURCE_CLASS_CHANNEL_PROJECTION[sourceClass]
      ?? { label: 'Unknown', channelClass: 'unknown' };
    const projection = fromId ?? fallback;
    return {
      sourceChannelLabel: projection.label,
      sourceChannelClass: projection.channelClass,
      direction: deriveIntakeDirection(sourceClass),
    };
  },
};

// ── Screening stage ──

export function isIntakeCogSecScreeningStage(
  value: unknown,
): value is IntakeCogSecScreeningStage {
  return typeof value === 'string'
    && (INTAKE_COGSEC_SCREENING_STAGES as readonly string[]).includes(value);
}

/**
 * Parses the screening stage from the recorded decision reason. Decision
 * reasons carry a stable prefix set by the screening layers
 * (`l1:`, `onnx-threshold+l1:`, `l2-fail-closed:`, `l3-…`, `vision-screener-…`).
 * A human release/discard has no screening prefix.
 */
export function parseIntakeScreeningStage(
  decisionReason: string | undefined,
  operatorAction: IntakeQuarantineDecisionAction | undefined,
): IntakeCogSecScreeningStage {
  if (operatorAction !== undefined) return 'human';
  const reason = decisionReason?.trim();
  if (!reason) return 'unknown';
  if (reason.startsWith('l3-fail-closed:') || reason.startsWith('l3-clear:') || reason.startsWith('l3_escalation')) {
    return 'l3';
  }
  if (reason.startsWith('vision-screener-fail-closed:')) return 'l3';
  if (reason.startsWith('l2-fail-closed:')) return 'l2';
  if (reason.startsWith('onnx-threshold+l1:')) return 'l1_5';
  if (reason.startsWith('l1:')) return 'l1';
  return 'unknown';
}

// ── Fault type ──

const RISK_LABEL_FAULT_FAMILY: ReadonlyArray<{ test: RegExp; family: string }> = [
  { test: /(?:^|[^a-z])injection\//u, family: 'Prompt injection' },
  { test: /(?:^|[^a-z])exfil\//u, family: 'Exfiltration' },
  { test: /(?:^|[^a-z])secrets\//u, family: 'Secret material' },
  { test: /(?:^|[^a-z])pii\//u, family: 'Personal data' },
  { test: /(?:^|[^a-z])poisoning\//u, family: 'Slow poisoning' },
  { test: /(?:^|[^a-z])persona\//u, family: 'Persona modification' },
  { test: /(?:^|[^a-z])policy\//u, family: 'Policy modification' },
  { test: /(?:^|[^a-z])execution\//u, family: 'Executable instruction' },
  { test: /(?:^|[^a-z])content\//u, family: 'Content risk' },
];

export function deriveIntakeFaultType(input: {
  riskLabels: readonly string[];
  holdReason: IntakeQuarantineHoldReason;
  screeningDecisionReason?: string;
}): string {
  if (input.holdReason === 'screener_malfunction') return 'Screening malfunction';
  for (const label of input.riskLabels) {
    const match = RISK_LABEL_FAULT_FAMILY.find(entry => entry.test.test(label));
    if (match) return match.family;
  }
  // Fall back to the L1 label family encoded in the reason ("l1:injection/…").
  if (input.screeningDecisionReason) {
    const reasonFamily = RISK_LABEL_FAULT_FAMILY.find(
      entry => entry.test.test(input.screeningDecisionReason!),
    );
    if (reasonFamily) return reasonFamily.family;
  }
  return 'Detection';
}

// ── Decision ──

const STATUS_DECISION_LABEL: Readonly<Record<string, string>> = {
  held: 'Held for review',
  released_raw: 'Released raw',
  released_sanitized: 'Released sanitized',
  discarded: 'Discarded',
  expired: 'Expired',
};

const OPERATOR_ACTION_LABEL: Readonly<Record<IntakeQuarantineDecisionAction, string>> = {
  release_raw: 'Released raw',
  release_sanitized: 'Released sanitized',
  discard: 'Discarded',
};

export function deriveIntakeDecision(
  status: string,
  operatorAction: IntakeQuarantineDecisionAction | undefined,
): string {
  if (operatorAction !== undefined) return OPERATOR_ACTION_LABEL[operatorAction];
  return STATUS_DECISION_LABEL[status] ?? 'Unknown';
}

// ── Full projection ──

/**
 * Projects content-free plain-text attribution for one intake row. Display
 * names are only included when an authorized resolver supplies them.
 */
export function projectIntakeCogSecAttribution(
  input: IntakeCogSecAttributionInput,
  resolvers: IntakeCogSecAttributionResolvers = {},
): IntakeCogSecAttribution {
  const channelResolver = resolvers.channel ?? defaultIntakeChannelAttributionResolver;
  const channel = channelResolver.resolve(input.sourceChannelId, input.sourceClass);
  const faultType = deriveIntakeFaultType({
    riskLabels: input.riskLabels,
    holdReason: input.holdReason,
    ...(input.screeningDecisionReason !== undefined
      ? { screeningDecisionReason: input.screeningDecisionReason }
      : {}),
  });
  const screeningStage = parseIntakeScreeningStage(input.screeningDecisionReason, input.operatorAction);
  const decision = deriveIntakeDecision(input.status, input.operatorAction);
  const targetContactDisplayName = resolvers.contactDisplayName?.(input.canonicalContactId);

  const attribution: IntakeCogSecAttribution = {
    sourceChannelLabel: channel.sourceChannelLabel,
    sourceChannelClass: channel.sourceChannelClass,
    direction: channel.direction,
    faultType,
    screeningStage,
    decision,
    ...(input.correlationKey ? { correlationId: input.correlationKey } : {}),
    ...(targetContactDisplayName ? { targetContactDisplayName } : {}),
  };
  return attribution;
}
