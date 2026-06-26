import type { AgentTool } from '@mariozechner/pi-agent-core';
import type {
  GeneratedMessageProvenanceMetadata,
  SubstrateMessage,
  ResponseStyle,
} from '../../../shared/contracts/runtime.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SURFACE_VALUES,
  type ChargePolicyConfig,
  type ChargePolicyRuntimeLane,
  type ChargePolicySurface,
} from '../../../shared/contracts/charge-policy.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import { resolveTierCapabilityTokens } from '../../../system/capabilities/tiers.js';
import { resolveToolRequiredCapabilities } from '../../../system/capabilities/requirements.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import type { ChannelVisibility, TrustLevel } from '../../../system/trust/types.js';
import { normalizeChannelVisibility } from '../../../system/trust/types.js';
import {
  buildResponseStylePromptState,
  buildTrustPromptState,
  classifyChannel,
  type ChannelMeta,
} from '../../../system/trust/policy.js';
import type { ContactStorePort } from '../../contacts/contact-store-port.js';
import type { Contact } from '../../contacts/types.js';
import type { ScratchpadProvider } from '../contracts.js';
import type { EmotionAppraisalEntry } from '../../emotion/appraisal.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type { ActiveConcernContextProvider } from '../../intention/concern-store-port.js';
import { formatActiveConcernsContextBlock, OPEN_THREADS_BODY_TEMPLATE } from '../../intention/concerns.js';
import type { BehavioralPatternContextProvider } from '../../intention/patterns.js';
import {
  buildEmotionalAffectPromptVariables,
  EMOTIONAL_AFFECT_BODY_TEMPLATE,
} from '../../emotion/persona-adaptation.js';
import type { MetacognitiveFlag } from '../../self-model/metacognition.js';
import {
  buildMetacognitiveFlagPromptVariables,
  formatMetacognitiveNotesContextBlock,
  METACOGNITIVE_PERSONA_GUIDANCE_BODY_TEMPLATE,
} from '../../self-model/metacognition.js';
import type { InternalState } from '../../self-model/state.js';
import type { InternalStateContinuityGap } from '../../self-model/internal-state-persistence.js';
import type { AdaptiveLoadedExtendedToolState } from '../adaptive-tools-telemetry.js';
import type { ExtendedToolTurnClass } from '../extended-tool-autoload-policy.js';
import { isDeferredToolHandoffMessageId } from '../deferred-tool-handoff.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { resolvePreferredContactName } from '../../contacts/preferred-name.js';
import {
  formatActiveDate,
  formatActiveDateTimeIso,
  formatActiveDateTimeLabel,
  resolveActiveTimezone,
} from '../../../shared/time/active-timezone.js';
import {
  unwrapSingleWrappedPromptSection,
  wrapPromptSectionXml,
} from '../../identity/prompt-sections.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import {
  EXTENDED_TOOLS_BODY_TEMPLATE,
  INTERNAL_STATE_BODY_TEMPLATE,
  RESPONSE_STYLE_DELIVERY_TEMPLATE,
  RESPONSE_STYLE_EXPANSION_TEMPLATE,
  RESPONSE_STYLE_GUIDANCE_COMPAT_TEMPLATE,
  SELF_IMAGE_TOOL_GUIDANCE_BODY_TEMPLATE,
  TRUST_GUIDANCE_BODY_TEMPLATE,
} from './runtime-prompt-templates.js';
import { getRunChargeSnapshot } from '../../../shared/telemetry/run-charge.js';

const SCRATCHPAD_PROMPT_SCAN_LIMIT = 64;
const SCRATCHPAD_PROMPT_MAX_ENTRIES = 8;
const SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS = 240;
const SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS = 1_600;

interface RuntimeContextLogger {
  warn: (message: string, payload: Record<string, unknown>) => void;
  debug: (message: string, payload: Record<string, unknown>) => void;
}

interface RuntimeContextActiveToolCounts {
  core: number;
  promoted: number;
  extendedLoaded: number;
  autoload: number;
  deferred: number;
  total: number;
}

interface ExtendedToolGuideEntry {
  line: string;
  blocked: boolean;
  activatable: boolean;
}

const OMITTED_CONCERN_LINE_PATTERN = /^- (\d+) additional lower-salience thread(?:s)? omitted\.$/;
const CONCERN_PRIORITY_PATTERN = /\[(high|medium|low);/i;
const SKILL_TAG_PATTERN = /<skill\b/gi;

const CHARGE_SURFACE_PROMPT_LABELS: Record<ChargePolicySurface, string> = {
  ownerFileInspection: 'owner-file inspection',
  localFilesystem: 'local filesystem read',
  memoryRead: 'memory read',
  memoryWrite: 'memory write through direct memory tools',
  localEmbedding: 'local embedding',
  externalEmbedding: 'external embedding',
  localImageGeneration: 'local image generation',
  paidImageGeneration: 'paid image/video generation',
  analysisWorkbenchExtensionBand: 'analysis_workbench extension pass after the first iteration',
  subagentLaunch: 'subagent launch',
  shardLaunch: 'shard launch',
  externalModelConsult: 'external model consult',
  moaRoundBase: 'multi-model deliberation round',
};

const ANALYSIS_WORKBENCH_EXTENSION_SURFACE: ChargePolicySurface = 'analysisWorkbenchExtensionBand';

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeGeneratedMessageProvenance(
  value: unknown,
): GeneratedMessageProvenanceMetadata | null {
  if (!isRecordValue(value)) return null;
  if (value.kind !== 'deferred_tool_handoff') return null;
  const sourceMessageId = trimNonEmptyString(value.sourceMessageId);
  const sourceChannelId = trimNonEmptyString(value.sourceChannelId);
  const sourceAuthorId = trimNonEmptyString(value.sourceAuthorId);
  const sourceAuthorName = trimNonEmptyString(value.sourceAuthorName);
  if (!sourceMessageId || !sourceChannelId || !sourceAuthorId || !sourceAuthorName) {
    return null;
  }
  return {
    kind: 'deferred_tool_handoff',
    sourceMessageId,
    sourceChannelId,
    sourceAuthorId,
    sourceAuthorName,
  };
}

function isChargePolicyRuntimeLane(value: string): value is ChargePolicyRuntimeLane {
  return (CHARGE_POLICY_RUNTIME_LANE_VALUES as readonly string[]).includes(value);
}

function isChargePolicyConfig(value: unknown): value is ChargePolicyConfig {
  if (!isRecordValue(value)) return false;
  if (value.schemaVersion !== 1) return false;
  return (
    isRecordValue(value.runChargeQuotaByLane)
    && isRecordValue(value.surfaceCosts)
    && isRecordValue(value.moa)
    && isRecordValue(value.referenceModelClassPricing)
  );
}

function resolveChargePolicyConfig(config: Record<string, unknown> | undefined): ChargePolicyConfig | null {
  const raw = config?.chargePolicy;
  return isChargePolicyConfig(raw) ? raw : null;
}

function formatChargeAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

function buildChargeBudgetContextBlock(input: {
  config?: Record<string, unknown>;
}): string {
  const chargePolicy = resolveChargePolicyConfig(input.config);
  if (!chargePolicy) return '';

  const snapshot = getRunChargeSnapshot();
  const lane = snapshot?.lane && isChargePolicyRuntimeLane(snapshot.lane)
    ? snapshot.lane
    : 'interactive';
  const quota = chargePolicy.runChargeQuotaByLane[lane];
  const spent = snapshot?.quotaSpentByLane[lane] ?? 0;
  const remaining = Math.max(0, quota - spent);
  const analysisWorkbenchExtensionCost = chargePolicy.surfaceCosts[ANALYSIS_WORKBENCH_EXTENSION_SURFACE];
  const costedSurfaces = CHARGE_POLICY_SURFACE_VALUES
    .map(surface => ({
      surface,
      amount: chargePolicy.surfaceCosts[surface],
    }))
    .filter(entry => entry.amount > 0)
    .sort((left, right) => right.amount - left.amount || left.surface.localeCompare(right.surface));

  const lines = [
    '[Charge budget]',
    `Active lane: ${lane}; current-turn spend ${formatChargeAmount(spent)}; remaining ${formatChargeAmount(remaining)} of ${formatChargeAmount(quota)} run-charge units before this turn's optional escalations.`,
    'This prompt quota is a fresh current-turn allowance, not the long-running monthly/session budget. Historical spend is recorded in the charge ledger and visible in Garden Charge / Budget for planning and allocation.',
    'Costed escalations:',
    ...costedSurfaces.map(entry => `- ${CHARGE_SURFACE_PROMPT_LABELS[entry.surface]}: ${formatChargeAmount(entry.amount)}`),
    `analysis_workbench first pass: 0 charge units but still high-latency; each extension pass after the first iteration costs ${formatChargeAmount(analysisWorkbenchExtensionCost)} current-turn units and still has a safety wall-time cap.`,
    'Zero-cost default path: use direct semantic tools for routine reads, memory/session lookup, schedule work, repo inspection, and state changes.',
    'Use analysis_workbench only for bounded multi-stage analysis of large files, codebases, logs, transcripts, datasets, or evidence sets. Do not use it for routine orient actions, concern maintenance, scheduler work, tool discovery, schema confusion, simple lookup, or ordinary replies.',
  ];

  return wrapPromptSectionXml({
    id: 'runtime_charge_budget',
    content: lines.join('\n'),
  });
}

function formatGapDuration(gapMs: number): string {
  const hours = gapMs / (60 * 60 * 1000);
  if (hours < 48) {
    return `${String(Math.round(hours))} hours`;
  }
  return `${String(Math.round(hours / 24))} days`;
}

export function buildInternalStateContinuityGapContextBlock(
  gap: InternalStateContinuityGap | null | undefined,
): string {
  if (!gap) return '';
  const lines = [
    '[Continuity notice]',
    `The runtime restarted after being offline for about ${formatGapDuration(gap.gapMs)} (last running state was saved ${gap.offlineSince}).`,
    'Your internal emotional and attention state from before the gap was too old to carry forward safely, so this is a fresh start of that state — it will rebuild naturally as you talk.',
    'A gap this long usually means something interrupted the system itself (maintenance, a crash, or hardware trouble) rather than an ordinary quiet stretch. It is okay to notice the gap, wonder about it, or ask what happened.',
  ];
  return wrapPromptSectionXml({
    id: 'runtime_continuity_notice',
    content: lines.join('\n'),
  });
}

function buildSatelliteEndpointContextBlock(message: SubstrateMessage): string {
  const satellite = message.routing?.satellite;
  if (!satellite) return '';

  const effectiveCapabilities = satellite.capabilities.effective.join(', ') || 'none';
  const policyDeniedCapabilities = satellite.capabilities.policyDenied.join(', ') || 'none';
  const telemetryScopes = satellite.telemetryScopes.join(', ') || 'none';
  const locationLine = satellite.staticLocationLabel
    ? `Static location label: ${satellite.staticLocationLabel}`
    : `Mobility: ${satellite.mobility}`;

  return wrapPromptSectionXml({
    id: 'runtime_satellite_endpoint',
    content: [
      '[Satellite endpoint]',
      `Satellite: ${satellite.satelliteDisplayName} (${satellite.satelliteId})`,
      `Endpoint: ${satellite.endpointDisplayName} (${satellite.endpointId}); claim ${satellite.claimType}; session ${satellite.sessionId}`,
      `Prompt channel type: ${satellite.promptChannelType}`,
      locationLine,
      `Effective capabilities: ${effectiveCapabilities}`,
      `Policy-denied or not-yet-modeled capabilities: ${policyDeniedCapabilities}`,
      `Allowed telemetry scopes: ${telemetryScopes}`,
      'Use only the effective capabilities listed here. Do not assume microphone, speech output, camera, avatar, location, or telemetry unless that capability is present.',
      'If audio_input/speech_to_text are present, spoken user input may arrive as text. If audio_output/text_to_speech are present, ordinary replies may be spoken by the satellite.',
    ].join('\n'),
  });
}

export interface ResolvedAuthorContext {
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  resolvedUserName: string;
  /** True when the resolved contact is another machine intelligence (peer companion/agent). */
  speakingWithIsMachineIntelligence?: boolean;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  continuitySubjectKey?: string;
  channelPrivacyLevel?: ChannelVisibility;
  continuityFallbackKeys: string[];
}

const SELF_IMAGE_TOOL_NAMES = ['selfie_create'] as const;

export function resolveAppearanceContextFromTemplateVariables(
  templateVariables?: Record<string, string>,
): string {
  const promptVariables = templateVariables ?? {};
  return (
    promptVariables['character.visual_description']
    || promptVariables.extensions_visual_description
    || promptVariables.visual_description
    || ''
  ).trim();
}

function isInternalJournalChannel(channelId: string): boolean {
  return channelId === 'internal:heartbeat' || channelId.startsWith('internal:reflection:');
}

function resolveMessageChannelMeta(message: Pick<SubstrateMessage, 'isDirectMessage' | 'routing'>): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelVisibility(message.routing?.channelPrivacy);
  if (message.isDirectMessage === undefined && !privacyLevel) return undefined;
  return {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(privacyLevel ? { privacyLevel } : {}),
  };
}

function compactPromptText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function formatScratchpadOmissionMetadata(entries: Array<{ updatedAt: number }>): string {
  const updatedTimes = entries
    .map(entry => entry.updatedAt)
    .filter((value): value is number => Number.isFinite(value));
  if (updatedTimes.length === 0) return '';

  const newest = Math.max(...updatedTimes);
  const oldest = Math.min(...updatedTimes);
  return [
    ' Older/stale metadata:',
    `newest omitted updated ${new Date(newest).toISOString()};`,
    `oldest omitted updated ${new Date(oldest).toISOString()}.`,
  ].join(' ');
}

function formatPromptRuntimeDateTime(now: Date): string {
  const timeZone = resolveActiveTimezone();
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
}

function formatPromptRuntimeDate(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
}

function formatPromptRuntimeTime(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
}

function formatPromptRuntimeRelativeDate(now: Date, dayOffset: number): string {
  const [yearText, monthText, dayText] = formatActiveDate(now).split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return formatActiveDate(now);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return shifted.toISOString().slice(0, 10);
}

function formatPromptRuntimePartOfDay(now: Date): string {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now).find(part => part.type === 'hour')?.value;
  const parsedHour = Number(hourPart);
  if (!Number.isFinite(parsedHour)) return '';
  const hour = parsedHour % 24;
  if (hour < 5) return 'overnight';
  if (hour < 9) return 'morning';
  if (hour < 12) return 'late morning';
  if (hour < 15) return 'early afternoon';
  if (hour < 18) return 'late afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

function buildExtendedToolGuide(input: {
  capabilityTier: CapabilityTier;
  extendedTools: AgentTool<any>[];
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
}): {
  lines: string[];
  activatableCount: number;
  blockedCount: number;
} {
  const grantedTokens = new Set<CapabilityToken>(resolveTierCapabilityTokens(input.capabilityTier));
  const entries: ExtendedToolGuideEntry[] = input.extendedTools.map((tool) => {
    const loaded = input.loadedExtended.get(tool.name);
    const turnClass = input.classifyExtendedToolForTurn(tool.name);

    if (turnClass !== 'overlay') {
      return {
        line: `- ${tool.name}: ${tool.description.split('.')[0]} (background-only; not callable in-turn)`,
        blocked: false,
        activatable: false,
      };
    }

    const missingTokens = resolveToolRequiredCapabilities(tool, {})
      .filter(token => !grantedTokens.has(token));
    const blockedSuffix = missingTokens.length > 0
      ? `; current tier blocks execution: ${missingTokens.join(', ')}`
      : '';

    let suffix = '(use toolset action="activate")';
    let activatable = true;
    if (input.promotedExtendedToolNames.has(tool.name)) {
      suffix = `(promoted, always active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'autoload') {
      suffix = `(autoload active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'deferred') {
      suffix = `(deferred active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'extended_loaded') {
      suffix = `(loaded active${blockedSuffix})`;
      activatable = false;
    } else if (missingTokens.length > 0) {
      suffix = `(blocked by current tier: ${missingTokens.join(', ')})`;
      activatable = false;
    }

    return {
      line: `- ${tool.name}: ${tool.description.split('.')[0]} ${suffix}`.replace(/\s+\(/, ' ('),
      blocked: missingTokens.length > 0,
      activatable,
    };
  });

  return {
    lines: entries.map(entry => entry.line),
    activatableCount: entries.filter(entry => entry.activatable).length,
    blockedCount: entries.filter(entry => entry.blocked).length,
  };
}

function formatPromptRuntimeWeekday(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    weekday: 'long',
  }).format(now);
}

function formatRelativeElapsed(now: Date, then: Date): string {
  const deltaMs = Math.max(0, now.getTime() - then.getTime());
  const deltaMinutes = Math.floor(deltaMs / 60_000);
  if (deltaMinutes < 1) return 'just now';
  if (deltaMinutes < 60) return `${deltaMinutes} minute${deltaMinutes === 1 ? '' : 's'} ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} hour${deltaHours === 1 ? '' : 's'} ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays} day${deltaDays === 1 ? '' : 's'} ago`;
}

function formatElapsedDaysHours(now: Date, then: Date): string {
  const deltaMs = Math.max(0, now.getTime() - then.getTime());
  const totalHours = Math.floor(deltaMs / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0 && hours > 0) {
    return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function buildLastMessagePromptVariables(input: {
  now: Date;
  lastMessageReceivedAt: Date | null;
}): Record<string, string> {
  const { now, lastMessageReceivedAt } = input;
  if (!lastMessageReceivedAt) {
    return {
      runtime_last_message_received_present: 'false',
      runtime_last_message_received_human: 'no earlier message is loaded for this channel',
      runtime_last_message_received_at_iso: '',
      runtime_last_message_received_weekday: '',
      runtime_last_message_received_date_human: '',
      runtime_last_message_received_time_human: '',
      runtime_last_message_received_timezone: '',
      runtime_last_message_received_ago: '',
      runtime_last_message_received_days_hours: '',
      runtime_last_message_received_missing_notice: 'No earlier message is loaded for this channel.',
    };
  }

  const activeTimezone = resolveActiveTimezone();
  const relativeElapsed = formatRelativeElapsed(now, lastMessageReceivedAt);
  return {
    runtime_last_message_received_present: 'true',
    runtime_last_message_received_human: `${formatPromptRuntimeDateTime(lastMessageReceivedAt)} ${activeTimezone} (${relativeElapsed})`,
    runtime_last_message_received_at_iso: formatActiveDateTimeIso(lastMessageReceivedAt),
    runtime_last_message_received_weekday: formatPromptRuntimeWeekday(lastMessageReceivedAt),
    runtime_last_message_received_date_human: formatPromptRuntimeDate(lastMessageReceivedAt),
    runtime_last_message_received_time_human: formatPromptRuntimeTime(lastMessageReceivedAt),
    runtime_last_message_received_timezone: activeTimezone,
    runtime_last_message_received_ago: relativeElapsed,
    runtime_last_message_received_days_hours: formatElapsedDaysHours(now, lastMessageReceivedAt),
    runtime_last_message_received_missing_notice: '',
  };
}

function unwrapPromptSectionBody(section: string | null | undefined): string {
  if (!section) return '';
  return unwrapSingleWrappedPromptSection(section)?.content ?? section.trim();
}

function describeValence(value: number): string {
  if (value >= 0.45) return 'positive';
  if (value >= 0.15) return 'warm';
  if (value <= -0.45) return 'heavy';
  if (value <= -0.15) return 'strained';
  return 'steady';
}

function describeArousal(value: number): string {
  if (value >= 0.55) return 'high-energy';
  if (value >= 0.2) return 'engaged';
  if (value <= -0.2) return 'quiet';
  return 'calm';
}

function describeCertainty(value: number): string {
  if (value >= 0.75) return 'confident';
  if (value >= 0.45) return 'steady';
  return 'tentative';
}

function describeInteractionFrequency(value: number): string {
  if (value >= 0.75) return 'very frequent';
  if (value >= 0.4) return 'frequent';
  if (value > 0) return 'occasional';
  return 'new or infrequent';
}

function describeLastSeenRecency(lastSeenDeltaSeconds: number | null | undefined): string {
  if (lastSeenDeltaSeconds == null) return 'unknown recency';
  if (lastSeenDeltaSeconds <= 300) return 'just interacted';
  if (lastSeenDeltaSeconds <= 3_600) return 'recently interacted';
  return 'not recently seen';
}

function resolveTopEmotionNames(
  discrete: Record<string, number>,
  max = 2,
): string[] {
  return Object.entries(discrete)
    .filter(([emotion, score]) => emotion !== 'neutral' && score >= 0.15)
    .sort((left, right) => right[1] - left[1])
    .slice(0, max)
    .map(([emotion]) => emotion);
}

function buildInternalStatePromptVariables(internalState?: InternalState): Record<string, string> {
  const emptyInternalStateVariables = {
    runtime_internal_state_present: 'false',
    runtime_internal_state_cognitive_processing_quality: '',
    runtime_internal_state_cognitive_certainty_label: '',
    runtime_internal_state_cognitive_topic_engagement_label: '',
    runtime_internal_state_attention_conversation_trajectory: '',
    runtime_internal_state_attention_active_concern_count: '',
    runtime_internal_state_attention_active_concern_plural_suffix: '',
    runtime_internal_state_attention_pending_follow_up_count: '',
    runtime_internal_state_attention_pending_follow_up_plural_suffix: '',
    runtime_internal_state_relational_trust_level: '',
    runtime_internal_state_relational_recent_interaction_frequency_label: '',
    runtime_internal_state_relational_last_seen_label: '',
    runtime_internal_state_emotional_mood_valence_label: '',
    runtime_internal_state_emotional_mood_arousal_label: '',
    runtime_internal_state_emotional_prefix: '',
    runtime_internal_state_emotional_secondary_clause: '',
    runtime_internal_state_emotional_secondary_emotions: '',
  } satisfies Record<string, string>;

  if (!internalState) {
    return emptyInternalStateVariables;
  }

  const pendingFollowUps = internalState.attention.pendingFollowUps ?? [];
  const secondaryEmotions = resolveTopEmotionNames(internalState.emotional.discreteEmotions);
  return {
    runtime_internal_state_present: 'true',
    runtime_internal_state_cognitive_processing_quality: internalState.cognitive.processingQuality,
    runtime_internal_state_cognitive_certainty_label: describeCertainty(internalState.cognitive.certaintyLevel),
    runtime_internal_state_cognitive_topic_engagement_label: describeArousal(internalState.cognitive.topicEngagement),
    runtime_internal_state_attention_conversation_trajectory: internalState.attention.conversationTrajectory,
    runtime_internal_state_attention_active_concern_count: String(internalState.attention.activeConcerns.length),
    runtime_internal_state_attention_active_concern_plural_suffix: internalState.attention.activeConcerns.length === 1 ? '' : 's',
    runtime_internal_state_attention_pending_follow_up_count: String(pendingFollowUps.length),
    runtime_internal_state_attention_pending_follow_up_plural_suffix: pendingFollowUps.length === 1 ? '' : 's',
    runtime_internal_state_relational_trust_level: internalState.relational.trustLevel,
    runtime_internal_state_relational_recent_interaction_frequency_label: describeInteractionFrequency(
      internalState.relational.recentInteractionFrequency,
    ),
    runtime_internal_state_relational_last_seen_label: describeLastSeenRecency(internalState.relational.lastSeenDeltaSeconds),
    runtime_internal_state_emotional_mood_valence_label: describeValence(internalState.emotional.mood.valence),
    runtime_internal_state_emotional_mood_arousal_label: describeArousal(internalState.emotional.mood.arousal),
    runtime_internal_state_emotional_prefix: secondaryEmotions.length > 0 ? 'mostly ' : '',
    runtime_internal_state_emotional_secondary_clause: secondaryEmotions.length > 0
      ? `, with ${secondaryEmotions.join(' and ')} present`
      : '',
    runtime_internal_state_emotional_secondary_emotions: secondaryEmotions.join(', '),
  };
}

function buildConcernPromptVariables(activeConcernsBlock: string | null | undefined): Record<string, string> {
  const body = unwrapPromptSectionBody(activeConcernsBlock);
  if (!body) {
    return {
      runtime_concerns_count: '0',
      runtime_concerns_top_lines: '',
      runtime_concerns_top_priorities: '',
      runtime_concerns_omitted_count: '0',
      runtime_concerns_omitted_plural_suffix: 's',
    };
  }

  const lines = body
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const topLines = lines.filter(line => (
    line.startsWith('- ')
    && !OMITTED_CONCERN_LINE_PATTERN.test(line)
  ));
  const omittedLine = lines.find(line => OMITTED_CONCERN_LINE_PATTERN.test(line));
  const omittedCount = omittedLine
    ? Number.parseInt(omittedLine.match(OMITTED_CONCERN_LINE_PATTERN)?.[1] ?? '0', 10)
    : 0;
  const topPriorities = topLines
    .map(line => line.match(CONCERN_PRIORITY_PATTERN)?.[1]?.toLowerCase() ?? '')
    .filter((priority): priority is string => priority.length > 0);

  return {
    runtime_concerns_count: String(topLines.length + omittedCount),
    runtime_concerns_top_lines: topLines.join('\n'),
    runtime_concerns_top_priorities: topPriorities.join(', '),
    runtime_concerns_omitted_count: String(omittedCount),
    runtime_concerns_omitted_plural_suffix: omittedCount === 1 ? '' : 's',
  };
}

function countNonEmptyLines(body: string): number {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .length;
}

function buildBehavioralNotesPromptVariables(behavioralNotesBlock: string | null | undefined): Record<string, string> {
  const body = unwrapPromptSectionBody(behavioralNotesBlock);
  return {
    runtime_behavioral_notes_count: body ? String(countNonEmptyLines(body)) : '0',
    runtime_behavioral_notes_body_raw: body,
  };
}

function buildSkillsPromptVariables(skillsContext: string | null | undefined): Record<string, string> {
  const count = skillsContext?.match(SKILL_TAG_PATTERN)?.length ?? 0;
  return {
    runtime_skills_count: String(count),
  };
}

function formatEmotionAppraisalLines(
  emotionAppraisalChain: readonly EmotionAppraisalEntry[],
): string[] {
  return emotionAppraisalChain
    .slice(-2)
    .map(entry => (
      `- ${formatActiveDateTimeLabel(new Date(entry.timestamp))} (${entry.trigger}): ${compactPromptText(entry.summary, 220)}`
    ));
}

function buildEmotionAppraisalPromptVariables(
  emotionAppraisalChain: readonly EmotionAppraisalEntry[],
): Record<string, string> {
  const latestEntry = emotionAppraisalChain.at(-1);
  const recentLines = formatEmotionAppraisalLines(emotionAppraisalChain);
  const latestTimestamp = latestEntry ? new Date(latestEntry.timestamp) : null;
  const latestTimestampIso = latestTimestamp && Number.isFinite(latestTimestamp.getTime())
    ? latestTimestamp.toISOString()
    : '';

  return {
    runtime_emotion_appraisal_length: String(emotionAppraisalChain.length),
    runtime_emotion_appraisal_latest_trigger: latestEntry?.trigger ?? '',
    runtime_emotion_appraisal_latest_summary: latestEntry ? compactPromptText(latestEntry.summary, 220) : '',
    runtime_emotion_appraisal_latest_timestamp_iso: latestTimestampIso,
    runtime_emotion_appraisal_recent_lines: recentLines.join('\n'),
  };
}

function buildExtendedToolPromptVariables(input: {
  extendedTools: AgentTool<any>[];
  extendedToolGuide: {
    lines: string[];
    activatableCount: number;
    blockedCount: number;
  };
}): Record<string, string> {
  return {
    runtime_extended_tools_total: String(input.extendedTools.length),
    runtime_extended_tools_activatable_count: String(input.extendedToolGuide.activatableCount),
    runtime_extended_tools_blocked_count: String(input.extendedToolGuide.blockedCount),
    runtime_extended_tool_names: input.extendedTools.map(tool => tool.name).join(', '),
    runtime_extended_tool_directory_lines: input.extendedToolGuide.lines.join('\n'),
  };
}

function renderRuntimePromptBodyTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return injectPromptRuntimeTokens(template, { variables });
}

export function buildPromptTemplateVariables(input: {
  message: SubstrateMessage;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  channelType: string | undefined;
  canonicalContactKey: string | undefined;
  subjectIdentityKey?: string;
  now: Date;
  characterPromptVariables: Record<string, string>;
  modelId: string;
  fallbackCharacterName: string;
}): { templateVariables: Record<string, string>; runtimeCharacterName: string } {
  const visibility = classifyChannel(input.message.channelId, resolveMessageChannelMeta(input.message));
  const runtimeCharacterName = resolveRuntimeCharacterName(
    input.characterPromptVariables,
    input.fallbackCharacterName,
  );
  const subjectIdentityKey = input.subjectIdentityKey ?? input.message.authorId;
  const canonicalIdentityKey = input.canonicalContactKey ?? input.subjectIdentityKey ?? input.message.authorId;

  return {
    templateVariables: {
      ...input.characterPromptVariables,
      user: input.resolvedUserName,
      user_name: input.resolvedUserName,
      user_id: subjectIdentityKey,
      char: runtimeCharacterName,
      char_name: runtimeCharacterName,
      character: runtimeCharacterName,
      character_name: runtimeCharacterName,
      channel: input.message.channelId,
      channel_id: input.message.channelId,
      channel_type: input.channelType ?? 'unknown',
      channel_visibility: visibility,
      trust_level: input.trustLevel,
      canonical_contact_id: canonicalIdentityKey,
      model: input.modelId,
      model_id: input.modelId,
      now_iso: formatActiveDateTimeIso(input.now),
      active_timezone: resolveActiveTimezone(),
    },
    runtimeCharacterName,
  };
}

export function buildDynamicPromptTemplateVariables(input: {
  message: SubstrateMessage;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  channelType: string | undefined;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  responseStyle?: ResponseStyle;
  now?: Date;
  taskKind?: string;
  templateVariables?: Record<string, string>;
  internalState?: InternalState;
  metacognitiveFlags?: readonly MetacognitiveFlag[];
  emotionAppraisalChain?: readonly EmotionAppraisalEntry[];
  modelId: string;
  capabilityTier: CapabilityTier;
  activeToolCounts: RuntimeContextActiveToolCounts;
  extendedTools: AgentTool<any>[];
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
  skillsContext?: string;
  activeConcernsBlock?: string;
  behavioralNotesBlock?: string;
  lastMessageReceivedAtMs?: number | null;
  config: Record<string, unknown>;
}): Record<string, string> {
  const internalTurn = isInternalJournalChannel(input.message.channelId);
  const visibility = classifyChannel(input.message.channelId, resolveMessageChannelMeta(input.message));
  const hasActiveSelfImageTool = (): boolean => {
    for (const toolName of SELF_IMAGE_TOOL_NAMES) {
      if (input.promotedExtendedToolNames.has(toolName)) return true;
      if (input.loadedExtended.has(toolName)) return true;
    }
    return false;
  };

  const responseStyle = input.responseStyle ?? 'concise';
  const now = input.now ?? new Date();
  const emotionAppraisalChain = input.emotionAppraisalChain ?? [];
  const {
    core: coreCount,
    promoted: promotedCount,
    extendedLoaded: extendedLoadedCount,
    autoload: autoloadCount,
    deferred: deferredCount,
    total: activeCount,
  } = input.activeToolCounts;
  const extendedCount = input.extendedTools.length;
  const extendedToolGuide = buildExtendedToolGuide({
    capabilityTier: input.capabilityTier,
    extendedTools: input.extendedTools,
    loadedExtended: input.loadedExtended,
    classifyExtendedToolForTurn: input.classifyExtendedToolForTurn,
    promotedExtendedToolNames: input.promotedExtendedToolNames,
  });
  const activeToolSummary = `${activeCount} active now (${coreCount} core`
    + (promotedCount > 0 ? `, ${promotedCount} promoted` : '')
    + (extendedLoadedCount > 0 ? `, ${extendedLoadedCount} loaded` : '')
    + (autoloadCount > 0 ? `, ${autoloadCount} autoload` : '')
    + (deferredCount > 0 ? `, ${deferredCount} deferred` : '')
    + `)${extendedCount > 0
      ? `; ${extendedToolGuide.activatableCount} more activatable via toolset action="activate"`
        + (extendedToolGuide.blockedCount > 0
          ? `, ${extendedToolGuide.blockedCount} blocked by the current capability tier.`
          : '.')
      : '.'}`;

  const emotionSnapshot = input.internalState ? toEmotionSnapshotFromInternalState(input.internalState) : null;
  const affectVariables = buildEmotionalAffectPromptVariables({
    trustLevel: input.trustLevel,
    emotionSnapshot,
    promptVariables: input.templateVariables,
    config: input.config,
  });
  const metacognitiveVariables = buildMetacognitiveFlagPromptVariables(input.metacognitiveFlags ?? []);
  const internalStateVariables = buildInternalStatePromptVariables(input.internalState);
  const emotionAppraisalVariables = buildEmotionAppraisalPromptVariables(emotionAppraisalChain);
  const emotionAppraisalBody = emotionAppraisalVariables.runtime_emotion_appraisal_recent_lines;
  const concernVariables = buildConcernPromptVariables(input.activeConcernsBlock);
  const behavioralNotesBody = unwrapPromptSectionBody(input.behavioralNotesBlock);
  const behavioralNotesVariables = buildBehavioralNotesPromptVariables(input.behavioralNotesBlock);
  const skillsIndexBody = unwrapPromptSectionBody(input.skillsContext);
  const skillsVariables = buildSkillsPromptVariables(input.skillsContext);
  const selfImageToolActive = hasActiveSelfImageTool();
  const appearanceContextBody = internalTurn
    ? ''
    : resolveAppearanceContextFromTemplateVariables(input.templateVariables);
  const extendedToolVariables = buildExtendedToolPromptVariables({
    extendedTools: input.extendedTools,
    extendedToolGuide,
  });
  const lastMessageReceivedAt = (
    typeof input.lastMessageReceivedAtMs === 'number' && Number.isFinite(input.lastMessageReceivedAtMs)
  )
    ? new Date(input.lastMessageReceivedAtMs)
    : null;
  const lastMessagePromptVariables = buildLastMessagePromptVariables({
    now,
    lastMessageReceivedAt,
  });
  const responseStyleState = buildResponseStylePromptState(responseStyle);
  const trustState = buildTrustPromptState(input.trustLevel);
  const dynamicVariables = {
    active_timezone: resolveActiveTimezone(),
    runtime_current_datetime_human: formatPromptRuntimeDateTime(now),
    runtime_current_datetime_iso: formatActiveDateTimeIso(now),
    runtime_current_weekday: formatPromptRuntimeWeekday(now),
    runtime_current_date_human: formatPromptRuntimeDate(now),
    runtime_current_time_human: formatPromptRuntimeTime(now),
    runtime_current_today: formatPromptRuntimeRelativeDate(now, 0),
    runtime_current_yesterday: formatPromptRuntimeRelativeDate(now, -1),
    runtime_current_tomorrow: formatPromptRuntimeRelativeDate(now, 1),
    runtime_current_part_of_day: formatPromptRuntimePartOfDay(now),
    ...lastMessagePromptVariables,
    runtime_internal_turn_context: internalTurn ? `This is an internal ${input.taskKind ?? 'background'} turn.` : '',
    runtime_internal_turn_kind: internalTurn ? (input.taskKind ?? 'background') : '',
    runtime_speaking_with_name: internalTurn ? '' : input.resolvedUserName,
    runtime_speaking_with_trust_level: internalTurn ? '' : input.trustLevel,
    runtime_channel_type: internalTurn ? '' : (input.channelType ?? 'unknown'),
    runtime_channel_visibility: internalTurn ? '' : visibility,
    runtime_capability_tier: input.capabilityTier,
    runtime_tooling_summary: `Tooling: ${activeToolSummary}`,
    runtime_tooling_active_count: String(activeCount),
    runtime_tooling_core_count: String(coreCount),
    runtime_tooling_promoted_count: String(promotedCount),
    runtime_tooling_loaded_count: String(extendedLoadedCount),
    runtime_tooling_autoload_count: String(autoloadCount),
    runtime_tooling_deferred_count: String(deferredCount),
    runtime_tooling_available_extended_count: String(extendedCount),
    ...trustState,
    ...responseStyleState,
    ...affectVariables,
    ...metacognitiveVariables,
    ...internalStateVariables,
    ...concernVariables,
    ...emotionAppraisalVariables,
    ...behavioralNotesVariables,
    ...skillsVariables,
    ...extendedToolVariables,
    runtime_emotion_appraisal_body: emotionAppraisalBody,
    runtime_behavioral_notes_body: behavioralNotesBody,
    runtime_skills_index_body: skillsIndexBody,
    runtime_appearance_context_body: appearanceContextBody,
    runtime_self_image_tool_active: String(selfImageToolActive),
  } satisfies Record<string, string>;
  const compatibilityVariables = {
    runtime_trust_guidance: renderRuntimePromptBodyTemplate(TRUST_GUIDANCE_BODY_TEMPLATE, dynamicVariables),
    runtime_emotional_affect_body: renderRuntimePromptBodyTemplate(EMOTIONAL_AFFECT_BODY_TEMPLATE, dynamicVariables),
    runtime_metacognitive_persona_guidance_body: renderRuntimePromptBodyTemplate(
      METACOGNITIVE_PERSONA_GUIDANCE_BODY_TEMPLATE,
      dynamicVariables,
    ),
    runtime_response_style_delivery_guidance: renderRuntimePromptBodyTemplate(
      RESPONSE_STYLE_DELIVERY_TEMPLATE,
      dynamicVariables,
    ),
    runtime_response_style_expansion_guidance: renderRuntimePromptBodyTemplate(
      RESPONSE_STYLE_EXPANSION_TEMPLATE,
      dynamicVariables,
    ),
    runtime_response_style_guidance: renderRuntimePromptBodyTemplate(
      RESPONSE_STYLE_GUIDANCE_COMPAT_TEMPLATE,
      dynamicVariables,
    ),
    runtime_response_style_guidance_body: renderRuntimePromptBodyTemplate(
      RESPONSE_STYLE_GUIDANCE_COMPAT_TEMPLATE,
      dynamicVariables,
    ),
    runtime_internal_state_body: renderRuntimePromptBodyTemplate(INTERNAL_STATE_BODY_TEMPLATE, dynamicVariables),
    runtime_open_threads_body: renderRuntimePromptBodyTemplate(OPEN_THREADS_BODY_TEMPLATE, dynamicVariables),
    runtime_self_image_tool_guidance_body: renderRuntimePromptBodyTemplate(
      SELF_IMAGE_TOOL_GUIDANCE_BODY_TEMPLATE,
      dynamicVariables,
    ),
    runtime_extended_tools_body: renderRuntimePromptBodyTemplate(EXTENDED_TOOLS_BODY_TEMPLATE, dynamicVariables),
  } satisfies Record<string, string>;

  return {
    ...dynamicVariables,
    ...compatibilityVariables,
  };
}

export function buildRuntimeContext(input: {
  message: SubstrateMessage;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  channelType: string | undefined;
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  responseStyle?: ResponseStyle;
  now?: Date;
  taskKind?: string;
  templateVariables?: Record<string, string>;
  internalState?: InternalState;
  metacognitiveFlags?: readonly MetacognitiveFlag[];
  emotionAppraisalChain?: readonly EmotionAppraisalEntry[];
  modelId: string;
  contextWindow: number;
  capabilityTier: CapabilityTier;
  activeToolCounts: RuntimeContextActiveToolCounts;
  extendedTools: AgentTool<any>[];
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
  skillsContext?: string;
  activeConcernsBlock?: string;
  behavioralNotesBlock?: string;
  formatTopEmotions: (discrete: Record<string, number>) => string;
  config?: Record<string, unknown>;
  internalStateContinuityGap?: InternalStateContinuityGap | null;
}): string {
  const runtimeContextExtra = (() => {
    const raw = input.templateVariables?.runtime_context_extra;
    return typeof raw === 'string' ? raw.trim() : '';
  })();
  const sections: string[] = [];
  if (runtimeContextExtra) {
    sections.push(wrapPromptSectionXml({
      id: 'companion_runtime_context',
      content: runtimeContextExtra,
    }));
  }
  const continuityGapContext = buildInternalStateContinuityGapContextBlock(input.internalStateContinuityGap);
  if (continuityGapContext) {
    sections.push(continuityGapContext);
  }
  const chargeBudgetContext = buildChargeBudgetContextBlock({ config: input.config });
  if (chargeBudgetContext) {
    sections.push(chargeBudgetContext);
  }
  const satelliteEndpointContext = buildSatelliteEndpointContextBlock(input.message);
  if (satelliteEndpointContext) {
    sections.push(satelliteEndpointContext);
  }
  return sections.join('\n\n');
}

export function buildActiveConcernsContextBlock(input: {
  activeConcernProvider: ActiveConcernContextProvider | null | undefined;
  canonicalContactKey?: string;
  logger: RuntimeContextLogger;
}): string {
  if (!input.activeConcernProvider) return '';

  try {
    const concerns = input.activeConcernProvider.getActiveConcerns(input.canonicalContactKey);
    if (concerns.length === 0) return '';
    return formatActiveConcernsContextBlock(concerns);
  } catch (error) {
    input.logger.warn('Active concerns context injection skipped due to provider error', {
      error: toErrorMessage(error),
    });
    return '';
  }
}

export function buildMetacognitiveNotesContextBlock(
  currentMetacognitiveFlags: readonly MetacognitiveFlag[],
): string {
  if (currentMetacognitiveFlags.length === 0) return '';
  return formatMetacognitiveNotesContextBlock(currentMetacognitiveFlags, {
    minConfidence: 0.4,
    maxFlags: 2,
  });
}

export function buildBehavioralNotesContextBlock(input: {
  behavioralPatternProvider: BehavioralPatternContextProvider | null | undefined;
  canonicalContactKey?: string;
  logger: RuntimeContextLogger;
}): string {
  if (!input.behavioralPatternProvider) return '';

  try {
    return input.behavioralPatternProvider.getBehavioralNotes(input.canonicalContactKey);
  } catch (error) {
    input.logger.warn('Behavioral notes context injection skipped due to provider error', {
      error: toErrorMessage(error),
    });
    return '';
  }
}

export function buildScratchpadContextBlock(input: {
  scratchpadProvider: ScratchpadProvider | null | undefined;
  logger: RuntimeContextLogger;
}): string {
  if (!input.scratchpadProvider) return '';

  try {
    const entries = input.scratchpadProvider.listScratchpadEntries(SCRATCHPAD_PROMPT_SCAN_LIMIT);
    if (entries.length === 0) return '';

    const lines = [
      '[Scratchpad]',
      'Working notes (24h temporary context; verify before acting; not for durable reminders, proactive follow-ups, journals, or stable memories):',
    ];

    let included = 0;
    let usedChars = lines.join('\n').length;
    for (const entry of entries) {
      if (included >= SCRATCHPAD_PROMPT_MAX_ENTRIES) break;

      const normalized = entry.content.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;

      const clipped = normalized.length > SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS
        ? `${normalized.slice(0, SCRATCHPAD_PROMPT_MAX_ENTRY_CHARS - 3)}...`
        : normalized;

      const line = `- ${clipped}`;
      const projectedChars = usedChars + 1 + line.length;
      if (projectedChars > SCRATCHPAD_PROMPT_MAX_TOTAL_CHARS) break;

      lines.push(line);
      usedChars = projectedChars;
      included += 1;
    }

    if (included === 0) return '';
    const omitted = Math.max(0, entries.length - included);
    if (omitted > 0) {
      lines.push(
        `- (${omitted} additional notes omitted for context budget)`
        + formatScratchpadOmissionMetadata(entries.slice(included)),
      );
    }

    return lines.join('\n');
  } catch (error) {
    input.logger.debug('Scratchpad context injection skipped due to provider error', {
      error: toErrorMessage(error),
    });
    return '';
  }
}

export function toEmotionSnapshotFromInternalState(internalState: InternalState): EmotionStateSnapshot {
  return {
    vad: { ...internalState.emotional.vad },
    mood: { ...internalState.emotional.mood },
    discrete: { ...internalState.emotional.discreteEmotions },
    confidence: internalState.emotional.confidence,
  };
}

export function getPersonaAdaptation(input: {
  trustLevel: TrustLevel;
  internalState: InternalState;
  metacognitiveFlags: readonly MetacognitiveFlag[];
  templateVariables?: Record<string, string>;
  config: Record<string, unknown>;
}): string | null {
  const runtimePersonaExtra = (() => {
    const raw = input.templateVariables?.runtime_persona_adaptation_extra;
    return typeof raw === 'string' ? raw.trim() : '';
  })();
  if (runtimePersonaExtra) {
    return wrapPromptSectionXml({
      id: 'companion_persona_adaptation',
      content: runtimePersonaExtra,
    });
  }
  return null;
}

export function resolveIdentityChannel(message: SubstrateMessage): string {
  if (message.routing?.satellite) return `satellite:${message.routing.satellite.claimType}`;
  if (message.channelType === 'discord') return 'discord';
  if (message.channelType === 'api') return 'api';
  if (message.channelType !== 'terminal') return message.channelType;
  if (message.channelId.startsWith('discord-voice:')) return 'discord';
  if (message.channelId.startsWith('api:')) return 'api';
  if (message.channelId.startsWith('internal:')) return 'internal';
  return 'unknown';
}

export function collectContinuityFallbackKeys(
  authorId: string,
  canonicalContactKey: string,
  contact?: Contact,
): string[] {
  const keys = new Set<string>();
  const addKey = (value?: string): void => {
    if (!value || value === canonicalContactKey) return;
    keys.add(value);
  };

  addKey(authorId);
  addKey(contact?.discordUserId);
  for (const identity of contact?.channelIdentities ?? []) {
    addKey(identity.userId);
  }

  return [...keys].sort((a, b) => a.localeCompare(b));
}

export function resolveContinuitySubjectKey(input: {
  canonicalContactKey?: string;
  subjectIdentityKey?: string;
  authorId?: string;
}): string | undefined {
  const canonicalContactKey = input.canonicalContactKey?.trim();
  if (canonicalContactKey) return canonicalContactKey;

  const subjectIdentityKey = input.subjectIdentityKey?.trim();
  if (subjectIdentityKey) return subjectIdentityKey;

  const authorId = input.authorId?.trim();
  return authorId || undefined;
}

export function resolvePromptUserName(message: SubstrateMessage, contact?: Contact): string {
  const preferredContactName = resolvePreferredContactName(contact);
  if (preferredContactName) return preferredContactName;

  const authorName = message.authorName.trim();
  if (authorName) return authorName;

  return 'User';
}

async function resolveGeneratedMessageSourceContext(input: {
  message: SubstrateMessage;
  contactStore: ContactStorePort | null | undefined;
  logger: RuntimeContextLogger;
  provenance: GeneratedMessageProvenanceMetadata;
}): Promise<Omit<ResolvedAuthorContext, 'speakerRole' | 'resolvedUserName'> | null> {
  const generatedSourceMessage: SubstrateMessage = {
    ...input.message,
    id: input.provenance.sourceMessageId,
    channelId: input.provenance.sourceChannelId,
    authorId: input.provenance.sourceAuthorId,
    authorName: input.provenance.sourceAuthorName,
  };
  const fallbackContinuitySubjectKey = resolveContinuitySubjectKey({
    subjectIdentityKey: input.provenance.sourceAuthorId,
    authorId: input.provenance.sourceAuthorId,
  });

  if (!input.contactStore) {
    return {
      trustLevel: 'regular',
      continuitySubjectKey: fallbackContinuitySubjectKey,
      continuityFallbackKeys: [],
    };
  }

  try {
    const channel = resolveIdentityChannel(generatedSourceMessage);
    const canonicalHint = input.message.routing?.canonicalContactId?.trim();
    const hintedContact = canonicalHint ? await input.contactStore.getById(canonicalHint) : undefined;
    const contact = hintedContact
      ?? await input.contactStore.getByChannelIdentity(channel, input.provenance.sourceAuthorId);
    const canonicalContactKey = contact?.id ?? canonicalHint;
    const explicitChannelPrivacy = normalizeChannelVisibility(input.message.routing?.channelPrivacy);
    const channelPrivacyLevel = explicitChannelPrivacy
      ?? (
        contact && canonicalContactKey
          ? normalizeChannelVisibility(
            await input.contactStore.getConversationChannelPrivacy(
              canonicalContactKey,
              channel,
              input.provenance.sourceChannelId,
            ),
          )
          : undefined
      );

    return {
      trustLevel: contact?.trustLevel ?? 'regular',
      ...(contact?.isMachineIntelligence ? { speakingWithIsMachineIntelligence: true } : {}),
      ...(canonicalContactKey ? { canonicalContactKey } : {}),
      continuitySubjectKey: resolveContinuitySubjectKey({
        canonicalContactKey,
        subjectIdentityKey: input.provenance.sourceAuthorId,
        authorId: input.provenance.sourceAuthorId,
      }),
      ...(channelPrivacyLevel ? { channelPrivacyLevel } : {}),
      continuityFallbackKeys: canonicalContactKey
        ? collectContinuityFallbackKeys(input.provenance.sourceAuthorId, canonicalContactKey, contact)
        : [],
    };
  } catch (error) {
    input.logger.warn('Failed to resolve generated message source identity for trust/context routing', {
      authorId: input.provenance.sourceAuthorId,
      channelId: input.provenance.sourceChannelId,
      error: toErrorMessage(error),
    });
    return {
      trustLevel: 'regular',
      continuitySubjectKey: fallbackContinuitySubjectKey,
      continuityFallbackKeys: [],
    };
  }
}

export async function resolveAuthorContext(input: {
  message: SubstrateMessage;
  contactStore: ContactStorePort | null | undefined;
  logger: RuntimeContextLogger;
  companionIdentityKey: string;
  companionDisplayName?: string;
}): Promise<ResolvedAuthorContext> {
  if (input.message.channelId.startsWith('internal:')) {
    const isHeartbeatChannel = input.message.channelId === 'internal:heartbeat';
    const isReflectionChannel = input.message.channelId.startsWith('internal:reflection:');
    if (isHeartbeatChannel || isReflectionChannel) {
      // Heartbeat/reflection turns are executed by the scheduler, but the subject
      // of the turn is the companion. Reflection turns may also carry a bound
      // canonical contact hint so self-model and memory subsystems can stay scoped
      // to the current primary contact while subjectIdentityKey continues to drive
      // continuity/prompt subject selection.
      const subjectIdentityKey = input.companionIdentityKey.trim();
      if (!subjectIdentityKey) {
        throw new Error('Missing companion identity key for self-directed runtime turn');
      }
      const resolvedUserName = input.companionDisplayName?.trim() || resolvePromptUserName(input.message);
      const canonicalContactKey = isReflectionChannel
        ? input.message.routing?.canonicalContactId?.trim() || undefined
        : undefined;
      return {
        trustLevel: 'primary',
        speakerRole: 'system',
        resolvedUserName,
        ...(canonicalContactKey ? { canonicalContactKey } : {}),
        ...(subjectIdentityKey ? { subjectIdentityKey } : {}),
        ...(subjectIdentityKey ? { continuitySubjectKey: subjectIdentityKey } : {}),
        continuityFallbackKeys: [],
      };
    }

    return {
      trustLevel: 'primary',
      speakerRole: 'system',
      resolvedUserName: resolvePromptUserName(input.message),
      canonicalContactKey: input.message.authorId,
      continuitySubjectKey: input.message.authorId,
      continuityFallbackKeys: [],
    };
  }

  const generatedProvenance = normalizeGeneratedMessageProvenance(input.message.routing?.generated);
  if (input.message.authorId.startsWith('system:') && generatedProvenance) {
    const generatedSourceContext = await resolveGeneratedMessageSourceContext({
      message: input.message,
      contactStore: input.contactStore,
      logger: input.logger,
      provenance: generatedProvenance,
    });
    const canonicalContactKey = generatedSourceContext?.canonicalContactKey;

    return {
      trustLevel: generatedSourceContext?.trustLevel ?? 'regular',
      speakerRole: 'system',
      resolvedUserName: resolvePromptUserName(input.message),
      ...(canonicalContactKey ? { canonicalContactKey } : {}),
      continuitySubjectKey: generatedSourceContext?.continuitySubjectKey ?? input.message.authorId,
      ...(generatedSourceContext?.channelPrivacyLevel ? { channelPrivacyLevel: generatedSourceContext.channelPrivacyLevel } : {}),
      continuityFallbackKeys: generatedSourceContext?.continuityFallbackKeys ?? [],
    };
  }

  if (input.message.authorId.startsWith('system:')) {
    return {
      trustLevel: 'regular',
      speakerRole: 'system',
      resolvedUserName: resolvePromptUserName(input.message),
      continuitySubjectKey: input.message.authorId,
      continuityFallbackKeys: [],
    };
  }

  if (!input.message.authorId || !input.contactStore) {
    return {
      trustLevel: 'regular',
      speakerRole: 'user',
      resolvedUserName: resolvePromptUserName(input.message),
      continuitySubjectKey: resolveContinuitySubjectKey({
        subjectIdentityKey: input.message.authorId,
        authorId: input.message.authorId,
      }),
      continuityFallbackKeys: [],
    };
  }

  try {
    const channel = resolveIdentityChannel(input.message);
    // If a trusted canonical contact ID hint is provided in the routing metadata (e.g. set
    // by the Garden admin chat), resolve directly by ID so the correct contact (with nickname
    // etc.) is used regardless of which API auth principal is making the request.
    const canonicalHint = input.message.routing?.canonicalContactId?.trim();
    const hintedContact = canonicalHint ? await input.contactStore.getById(canonicalHint) : undefined;
    const contact = hintedContact
      ?? await input.contactStore.resolveChannelIdentity(channel, input.message.authorId, input.message.authorName);
    if (hintedContact) {
      // Still update last seen so the contact record stays fresh.
      await input.contactStore.updateLastSeen(hintedContact.id);
    }
    const canonicalContactKey = contact.id;
    const explicitChannelPrivacy = normalizeChannelVisibility(input.message.routing?.channelPrivacy);
    const channelPrivacyLevel = explicitChannelPrivacy
      ?? normalizeChannelVisibility(
        await input.contactStore.getConversationChannelPrivacy(
          canonicalContactKey,
          channel,
          input.message.channelId,
        ),
      );

    if (canonicalContactKey) {
      await input.contactStore.recordChannelActivity(
        canonicalContactKey,
        channel,
        input.message.channelId,
        channelPrivacyLevel,
      );
    }

    return {
      trustLevel: contact.trustLevel,
      speakerRole: 'user',
      resolvedUserName: resolvePromptUserName(input.message, contact),
      ...(contact.isMachineIntelligence ? { speakingWithIsMachineIntelligence: true } : {}),
      canonicalContactKey,
      continuitySubjectKey: resolveContinuitySubjectKey({
        canonicalContactKey,
        subjectIdentityKey: input.message.authorId,
        authorId: input.message.authorId,
      }),
      ...(channelPrivacyLevel ? { channelPrivacyLevel } : {}),
      continuityFallbackKeys: canonicalContactKey
        ? collectContinuityFallbackKeys(input.message.authorId, canonicalContactKey, contact)
        : [],
    };
  } catch (error) {
    input.logger.warn('Failed to resolve contact identity for trust/context routing', {
      authorId: input.message.authorId,
      channelId: input.message.channelId,
      error: toErrorMessage(error),
    });
    return {
      trustLevel: 'regular',
      speakerRole: 'user',
      resolvedUserName: resolvePromptUserName(input.message),
      continuitySubjectKey: resolveContinuitySubjectKey({
        subjectIdentityKey: input.message.authorId,
        authorId: input.message.authorId,
      }),
      continuityFallbackKeys: [],
    };
  }
}

export function resolveTaskKind(input: {
  message: SubstrateMessage;
  resolveChannelPromptDock: (message: SubstrateMessage) => { prompt?: { resolveTaskKind?: (message: SubstrateMessage) => string | undefined } } | undefined;
}): string | undefined {
  if (isDeferredToolHandoffMessageId(input.message.id)) {
    return 'deferred_tool_handoff';
  }
  const channelDock = input.resolveChannelPromptDock(input.message);
  const adapterTaskKind = channelDock?.prompt?.resolveTaskKind?.(input.message);
  if (adapterTaskKind) return adapterTaskKind;

  if (!input.message.channelId.startsWith('internal:')) return undefined;

  const suffix = input.message.channelId.slice('internal:'.length).toLowerCase();
  if (!suffix) return undefined;

  if (suffix.includes('heartbeat')) return 'heartbeat';
  if (suffix.includes('reflection')) return 'reflection';
  if (suffix.includes('planning')) return 'planning';
  if (suffix.includes('maintenance')) return 'maintenance';
  return undefined;
}

function resolveRuntimeCharacterName(
  characterPromptVariables: Record<string, string>,
  fallbackCharacterName: string,
): string {
  const candidates = [
    characterPromptVariables.char,
    characterPromptVariables.char_name,
    characterPromptVariables.character,
    characterPromptVariables.character_name,
    characterPromptVariables['character.name'],
    characterPromptVariables.name,
  ];
  for (const candidate of candidates) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record index may be undefined at runtime
    const trimmed = candidate?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallbackCharacterName;
}
