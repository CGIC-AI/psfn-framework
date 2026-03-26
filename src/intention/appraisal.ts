import { createHash } from 'node:crypto';
import type { LLMProvider } from '../agent/contracts.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import { cloneInternalState, type InternalState } from '../self-model/state.js';
import {
  formatActiveDateTimeLabel,
  resolveActiveTimezone,
} from '../time/active-timezone.js';
import {
  formatAttributedSystemContent,
  isIntentionAppraisalArtifact,
  normalizeSessionEntryAttribution,
} from '../session/entry-attribution.js';
import { renderPromptRuntimeTokens } from '../identity/prompt-runtime.js';
import type {
  ChannelType,
  CompletionPurpose,
  ContextMessage,
  InferredPostTurnAction,
  PostTurnActionCandidate,
  SubstrateMessage,
} from '../types.js';

const DEFAULT_APPRAISAL_FREQUENCY = 3;
const DEFAULT_EMOTIONAL_SHIFT_THRESHOLD = 0.35;
const DEFAULT_RECENT_MESSAGE_COUNT = 12;
const DEFAULT_MAX_MESSAGE_CHARS = 400;
const DEFAULT_MAX_CONCERN_COUNT = 8;
const DEFAULT_MAX_DECISIONS = 4;
const DEFAULT_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_FOLLOW_UP_PENDING_DELAY_MS = 5 * 60 * 1_000;

const DEFAULT_SYSTEM_PROMPT = [
  'Given the current emotional state and conversation, decide if autonomous follow-up actions are needed.',
  'Consider unresolved concerns, emotional needs, scheduled commitments, and relationship maintenance.',
  'Most turns should return noop unless concrete action is warranted.',
  'Return JSON only, no markdown, with shape:',
  '{"decisions":[{"type":"followUp|concern|schedule|noop","priority":"low|medium|high","reason":"string","timing":"immediate|soon|scheduled|none","dueAt":number?,"followUp":{"content":"string","channelId":"string?","channelType":"string?"},"concern":{"title":"string","summary":"string?","dueAt":number?,"priority":"low|medium|high?","status":"open|pending|resolved?"},"schedule":{"templateId":"string","sendToDiscordOverride":boolean?}}]}',
  'For followUp decisions, include followUp.content as a brief internal Whisper note to self, not a user-facing message.',
  'Write Whisper notes in first person, in the companion\'s own private voice, grounded in the supplied persona context.',
  'Whisper notes should capture what she is noticing or intends to do next, not simulate a sent message to the user.',
  'Never set authorId or authorName for followUp decisions. Runtime labels them as internal Whisper notes to self.',
  'For schedule decisions, include schedule.templateId.',
  'For concern decisions, include concern.title and/or concern.summary.',
].join('\n');

export const INTENTION_FOLLOW_UP_ACTION_KIND = 'intention.follow_up';
export const INTENTION_FOLLOW_UP_AUTHOR_ID = 'system:intention';
export const INTENTION_FOLLOW_UP_AUTHOR_NAME = 'Whisper';

export type IntentionDecisionType = 'followUp' | 'concern' | 'schedule' | 'noop';
export type IntentionDecisionPriority = 'low' | 'medium' | 'high';
export type IntentionDecisionTiming = 'immediate' | 'soon' | 'scheduled' | 'none';

export interface IntentionAppraisalMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
}

export interface ActiveConcernSnapshot {
  id?: string;
  title?: string;
  summary?: string;
  status?: string;
  dueAt?: number;
  resolvedAt?: number;
  priority?: IntentionDecisionPriority | number;
}

export interface ConversationTrajectorySnapshot {
  unresolvedTopics?: string[];
  summary?: string;
  turnsSinceUserReply?: number;
}

export interface IntentionFollowUpDecision {
  content: string;
  channelId?: string;
  channelType?: ChannelType;
  authorId?: string;
  authorName?: string;
  pendingFollowUpId?: string;
}

export interface IntentionConcernDecision {
  title?: string;
  summary?: string;
  dueAt?: number;
  priority?: IntentionDecisionPriority;
  status?: 'open' | 'pending' | 'resolved';
}

export interface IntentionScheduleDecision {
  templateId: string;
  sendToDiscordOverride?: boolean;
}

export interface IntentionActionDecision {
  type: IntentionDecisionType;
  priority: IntentionDecisionPriority;
  reason: string;
  timing: IntentionDecisionTiming;
  dueAt?: number;
  followUp?: IntentionFollowUpDecision;
  concern?: IntentionConcernDecision;
  schedule?: IntentionScheduleDecision;
}

export interface IntentionAppraisalInput {
  sessionId: string;
  internalState?: InternalState | null;
  currentEmotion?: EmotionStateSnapshot | null;
  recentMessages: readonly IntentionAppraisalMessage[];
  activeConcerns?: readonly ActiveConcernSnapshot[];
  recentlyResolvedConcerns?: readonly ActiveConcernSnapshot[];
  contactEmotionalSnapshot?: EmotionalSnapshot | null;
  conversationTrajectory?: ConversationTrajectorySnapshot;
  triggerOverride?: 'motivation';
  motivationSignals?: readonly string[];
  now?: number;
}

export interface IntentionAppraisalConfig {
  llmProvider: LLMProvider;
  appraisalFrequency?: number;
  emotionalShiftThreshold?: number;
  dueSoonWindowMs?: number;
  recentMessageCount?: number;
  maxMessageChars?: number;
  maxConcernCount?: number;
  maxDecisions?: number;
  systemPrompt?: string;
  characterName?: string;
  characterPromptVariablesProvider?: () => Record<string, string>;
  onEvaluationError?: (error: unknown, context: { sessionId: string; trigger: AppraisalTrigger }) => void;
}

export interface IntentionFollowUpActionPayload {
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  content: string;
  pendingFollowUpId?: string;
}

export interface IntentionDecisionActionContext {
  message: Pick<SubstrateMessage, 'id' | 'channelId' | 'channelType'>;
  fallbackAuthorId?: string;
  fallbackAuthorName?: string;
}

export interface IntentionDecisionActionOptions {
  surfacePendingFollowUpsImmediately?: boolean;
}

export function isBackgroundAppraisalChannel(channelId: string): boolean {
  return channelId.startsWith('internal:');
}

interface SessionAppraisalState {
  turnsSinceLastAppraisal: number;
  lastEmotion: EmotionStateSnapshot | null;
}

interface NormalizedIntentionAppraisalInput {
  sessionId: string;
  internalState: InternalState | null;
  currentEmotion: EmotionStateSnapshot | null;
  recentMessages: IntentionAppraisalMessage[];
  activeConcerns: ActiveConcernSnapshot[];
  recentlyResolvedConcerns: ActiveConcernSnapshot[];
  contactEmotionalSnapshot: EmotionalSnapshot | null;
  conversationTrajectory: ConversationTrajectorySnapshot | null;
  triggerOverride: 'motivation' | null;
  motivationSignals: string[];
  now: number;
}

interface AppraisalPersonaContext {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  messageExample?: string;
  postHistoryInstructions?: string;
  visualDescription?: string;
}

type AppraisalTrigger = 'frequency' | 'emotional_shift' | 'concern_due' | 'motivation';

interface ParsedDecisionResponse {
  decisions: IntentionActionDecision[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePositiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${field} must be a positive integer, received ${String(value)}`);
  }
  return resolved;
}

function normalizePositiveNumber(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${field} must be a positive number, received ${String(value)}`);
  }
  return resolved;
}

function parseUnit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${field} must be in range [0, 1]`);
  }
  return value;
}

function parseSigned(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`${field} must be in range [-1, 1]`);
  }
  return value;
}

function normalizeEmotionSnapshot(snapshot: EmotionStateSnapshot): EmotionStateSnapshot {
  if (!isRecord(snapshot)) {
    throw new Error('Emotion snapshot must be an object');
  }

  if (!isRecord(snapshot.vad)) {
    throw new Error('Emotion snapshot field "vad" must be an object');
  }
  if (!isRecord(snapshot.mood)) {
    throw new Error('Emotion snapshot field "mood" must be an object');
  }
  if (!isRecord(snapshot.discrete)) {
    throw new Error('Emotion snapshot field "discrete" must be an object');
  }

  const discrete: Record<string, number> = {};
  for (const [rawEmotion, rawScore] of Object.entries(snapshot.discrete)) {
    const emotion = rawEmotion.trim().toLowerCase();
    if (!emotion) continue;
    discrete[emotion] = parseUnit(rawScore, `emotion.discrete.${emotion}`);
  }

  return {
    vad: {
      valence: parseSigned(snapshot.vad.valence, 'emotion.vad.valence'),
      arousal: parseSigned(snapshot.vad.arousal, 'emotion.vad.arousal'),
      dominance: parseSigned(snapshot.vad.dominance, 'emotion.vad.dominance'),
    },
    mood: {
      valence: parseSigned(snapshot.mood.valence, 'emotion.mood.valence'),
      arousal: parseSigned(snapshot.mood.arousal, 'emotion.mood.arousal'),
      dominance: parseSigned(snapshot.mood.dominance, 'emotion.mood.dominance'),
    },
    discrete,
    confidence: parseUnit(snapshot.confidence, 'emotion.confidence'),
  };
}

function normalizeInternalState(value: InternalState | null | undefined): InternalState | null {
  if (value === null || value === undefined) {
    return null;
  }
  return cloneInternalState(value);
}

function emotionSnapshotFromInternalState(state: InternalState): EmotionStateSnapshot {
  return normalizeEmotionSnapshot({
    vad: { ...state.emotional.vad },
    mood: { ...state.emotional.mood },
    discrete: { ...state.emotional.discreteEmotions },
    confidence: state.emotional.confidence,
  });
}

function activeConcernsFromInternalState(state: InternalState): ActiveConcernSnapshot[] {
  return state.attention.activeConcerns.map((concern) => {
    const dueAtRaw = Date.parse(concern.expiresAt);
    return {
      id: concern.id,
      title: concern.text,
      status: 'open',
      ...(Number.isFinite(dueAtRaw) ? { dueAt: Math.floor(dueAtRaw) } : {}),
      priority: concern.priority,
    };
  });
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`sessionId must be a string, received ${String(value)}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('sessionId must be non-empty');
  }
  return trimmed;
}

function normalizeRole(value: unknown, index: number): IntentionAppraisalMessage['role'] {
  if (value !== 'user' && value !== 'assistant' && value !== 'system' && value !== 'tool') {
    throw new Error(`recentMessages[${index}].role is invalid`);
  }
  return value;
}

function normalizeRecentMessages(
  value: readonly IntentionAppraisalMessage[],
  maxMessageCount: number,
  maxMessageChars: number,
): IntentionAppraisalMessage[] {
  if (!Array.isArray(value)) {
    throw new Error('recentMessages must be an array');
  }

  const bounded = value.slice(-maxMessageCount);
  const normalized: IntentionAppraisalMessage[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const message = bounded[index];
    if (!isRecord(message)) {
      throw new Error(`recentMessages[${index}] must be an object`);
    }
    const role = normalizeRole(message.role, index);
    if (typeof message.content !== 'string') {
      throw new Error(`recentMessages[${index}].content must be a string`);
    }

    const content = message.content.replace(/\s+/g, ' ').trim();
    if (!content) continue;
    normalized.push({
      role,
      content: content.length > maxMessageChars
        ? `${content.slice(0, maxMessageChars - 3)}...`
        : content,
      ...(typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? { timestamp: Math.max(0, Math.floor(message.timestamp)) }
        : {}),
    });
  }

  return normalized;
}

function normalizeConcernPriority(value: unknown): IntentionDecisionPriority | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0.67) return 'high';
    if (value >= 0.34) return 'medium';
    return 'low';
  }
  return undefined;
}

function normalizeActiveConcerns(
  value: readonly ActiveConcernSnapshot[] | undefined,
  maxConcernCount: number,
): ActiveConcernSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('activeConcerns must be an array when provided');
  }

  const normalized: ActiveConcernSnapshot[] = [];
  for (const concern of value) {
    if (!isRecord(concern)) continue;
    const id = typeof concern.id === 'string' ? concern.id.trim() : undefined;
    const title = typeof concern.title === 'string' ? concern.title.trim() : undefined;
    const summary = typeof concern.summary === 'string' ? concern.summary.trim() : undefined;
    if (!title && !summary) continue;
    const status = typeof concern.status === 'string' ? concern.status.trim().toLowerCase() : undefined;
    const dueAt = (typeof concern.dueAt === 'number' && Number.isFinite(concern.dueAt) && concern.dueAt > 0)
      ? Math.floor(concern.dueAt)
      : undefined;
    const resolvedAt = (typeof concern.resolvedAt === 'number' && Number.isFinite(concern.resolvedAt) && concern.resolvedAt > 0)
      ? Math.floor(concern.resolvedAt)
      : undefined;
    const priority = normalizeConcernPriority(concern.priority);
    normalized.push({
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      ...(priority ? { priority } : {}),
    });
  }

  return normalized.slice(0, maxConcernCount);
}

function normalizeContactEmotionalSnapshot(value: EmotionalSnapshot | null | undefined): EmotionalSnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('contactEmotionalSnapshot must be an object when provided');
  }

  const parseOptionalEpoch = (raw: unknown): number | undefined => (
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : undefined
  );

  return {
    baselineValence: parseSigned(value.baselineValence, 'contactEmotionalSnapshot.baselineValence'),
    moodValence: parseSigned(value.moodValence, 'contactEmotionalSnapshot.moodValence'),
    moodDrift: parseSigned(value.moodDrift, 'contactEmotionalSnapshot.moodDrift'),
    moodSamples: normalizePositiveInteger(
      typeof value.moodSamples === 'number' ? Math.max(1, Math.floor(value.moodSamples)) : 1,
      1,
      'contactEmotionalSnapshot.moodSamples',
    ),
    ...(parseOptionalEpoch(value.lastMoodUpdateEpochMs) !== undefined
      ? { lastMoodUpdateEpochMs: parseOptionalEpoch(value.lastMoodUpdateEpochMs) }
      : {}),
  };
}

function normalizeConversationTrajectory(value: ConversationTrajectorySnapshot | undefined): ConversationTrajectorySnapshot | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error('conversationTrajectory must be an object when provided');
  }

  const unresolvedTopics = Array.isArray(value.unresolvedTopics)
    ? value.unresolvedTopics
      .filter(topic => typeof topic === 'string')
      .map(topic => topic.trim())
      .filter(topic => topic.length > 0)
      .slice(0, 8)
    : undefined;
  const summary = typeof value.summary === 'string' ? value.summary.trim() : undefined;
  const turnsSinceUserReply = (
    typeof value.turnsSinceUserReply === 'number'
    && Number.isFinite(value.turnsSinceUserReply)
    && value.turnsSinceUserReply >= 0
  )
    ? Math.floor(value.turnsSinceUserReply)
    : undefined;

  return {
    ...(unresolvedTopics && unresolvedTopics.length > 0 ? { unresolvedTopics } : {}),
    ...(summary ? { summary } : {}),
    ...(turnsSinceUserReply !== undefined ? { turnsSinceUserReply } : {}),
  };
}

function normalizeTriggerOverride(value: unknown): 'motivation' | null {
  if (value === undefined || value === null) return null;
  if (value === 'motivation') return value;
  throw new Error(`triggerOverride is unsupported: ${String(value)}`);
}

function normalizeMotivationSignals(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('motivationSignals must be an array when provided');
  }

  const normalized = value
    .filter(signal => typeof signal === 'string')
    .map(signal => signal.trim().toLowerCase())
    .filter(signal => signal.length > 0);
  return [...new Set(normalized)].slice(0, 8);
}

function normalizeInput(
  input: IntentionAppraisalInput,
  options: {
    recentMessageCount: number;
    maxMessageChars: number;
    maxConcernCount: number;
  },
): NormalizedIntentionAppraisalInput {
  const sessionId = normalizeSessionId(input.sessionId);
  const internalState = normalizeInternalState(input.internalState);
  const currentEmotion = internalState
    ? emotionSnapshotFromInternalState(internalState)
    : input.currentEmotion
      ? normalizeEmotionSnapshot(input.currentEmotion)
      : null;
  const recentMessages = normalizeRecentMessages(
    input.recentMessages,
    options.recentMessageCount,
    options.maxMessageChars,
  );
  const activeConcerns = normalizeActiveConcerns(
    input.activeConcerns ?? (internalState ? activeConcernsFromInternalState(internalState) : undefined),
    options.maxConcernCount,
  );
  const recentlyResolvedConcerns = normalizeActiveConcerns(
    input.recentlyResolvedConcerns,
    options.maxConcernCount,
  );
  const contactEmotionalSnapshot = normalizeContactEmotionalSnapshot(input.contactEmotionalSnapshot);
  const conversationTrajectory = normalizeConversationTrajectory(input.conversationTrajectory);
  const triggerOverride = normalizeTriggerOverride(input.triggerOverride);
  const motivationSignals = normalizeMotivationSignals(input.motivationSignals);
  const now = (
    typeof input.now === 'number'
    && Number.isFinite(input.now)
    && input.now > 0
  )
    ? Math.floor(input.now)
    : Date.now();

  return {
    sessionId,
    internalState,
    currentEmotion,
    recentMessages,
    activeConcerns,
    recentlyResolvedConcerns,
    contactEmotionalSnapshot,
    conversationTrajectory,
    triggerOverride,
    motivationSignals,
    now,
  };
}

function maxEmotionShift(previous: EmotionStateSnapshot | null, current: EmotionStateSnapshot | null): number {
  if (!previous || !current) return 0;
  return Math.max(
    Math.abs(current.vad.valence - previous.vad.valence),
    Math.abs(current.vad.arousal - previous.vad.arousal),
    Math.abs(current.vad.dominance - previous.vad.dominance),
    Math.abs(current.mood.valence - previous.mood.valence),
    Math.abs(current.mood.arousal - previous.mood.arousal),
    Math.abs(current.mood.dominance - previous.mood.dominance),
  );
}

function hasDueSoonConcern(
  concerns: readonly ActiveConcernSnapshot[],
  now: number,
  dueSoonWindowMs: number,
): boolean {
  const windowEnd = now + dueSoonWindowMs;
  return concerns.some((concern) => (
    typeof concern.dueAt === 'number'
    && Number.isFinite(concern.dueAt)
    && concern.dueAt > 0
    && concern.dueAt <= windowEnd
    && concern.status !== 'resolved'
  ));
}

function normalizePriority(value: unknown): IntentionDecisionPriority {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return 'medium';
}

function normalizeTiming(value: unknown): IntentionDecisionTiming {
  if (value === 'immediate' || value === 'soon' || value === 'scheduled' || value === 'none') {
    return value;
  }
  return 'soon';
}

function parseOptionalDueAt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function formatPromptTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return formatActiveDateTimeLabel(new Date(Math.floor(value)));
}

function parseDecisionType(value: unknown): IntentionDecisionType | null {
  if (value === 'followUp' || value === 'concern' || value === 'schedule' || value === 'noop') {
    return value;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'followup':
      return 'followUp';
    case 'concern':
      return 'concern';
    case 'schedule':
      return 'schedule';
    case 'noop':
      return 'noop';
    default:
      return null;
  }
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Intention appraisal response is empty');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const body = fenced[1].trim();
    if (body.startsWith('{') && body.endsWith('}')) {
      return body;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Intention appraisal response does not contain a JSON object');
}

function parseFollowUpPayload(value: unknown): IntentionFollowUpDecision | undefined {
  if (!isRecord(value)) return undefined;
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  if (!content) return undefined;
  const channelId = typeof value.channelId === 'string' ? value.channelId.trim() : '';
  const channelType = (
    value.channelType === 'terminal'
    || value.channelType === 'api'
    || value.channelType === 'discord'
    || value.channelType === 'telegram'
  )
    ? value.channelType
    : undefined;
  const authorId = typeof value.authorId === 'string' ? value.authorId.trim() : '';
  const authorName = typeof value.authorName === 'string' ? value.authorName.trim() : '';
  const pendingFollowUpId = typeof value.pendingFollowUpId === 'string'
    ? value.pendingFollowUpId.trim()
    : '';

  return {
    content,
    ...(channelId ? { channelId } : {}),
    ...(channelType ? { channelType } : {}),
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    ...(pendingFollowUpId ? { pendingFollowUpId } : {}),
  };
}

function parseConcernPayload(value: unknown): IntentionConcernDecision | undefined {
  if (!isRecord(value)) return undefined;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (!title && !summary) return undefined;
  const status = value.status === 'open' || value.status === 'pending' || value.status === 'resolved'
    ? value.status
    : undefined;
  const priority = normalizeConcernPriority(value.priority);
  return {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(parseOptionalDueAt(value.dueAt) !== undefined ? { dueAt: parseOptionalDueAt(value.dueAt) } : {}),
    ...(priority ? { priority } : {}),
    ...(status ? { status } : {}),
  };
}

function parseSchedulePayload(value: unknown): IntentionScheduleDecision | undefined {
  if (!isRecord(value)) return undefined;
  const templateId = typeof value.templateId === 'string' ? value.templateId.trim() : '';
  if (!templateId) return undefined;
  const sendToDiscordOverride = typeof value.sendToDiscordOverride === 'boolean'
    ? value.sendToDiscordOverride
    : undefined;
  return {
    templateId,
    ...(sendToDiscordOverride !== undefined ? { sendToDiscordOverride } : {}),
  };
}

function parseDecisionResponse(raw: string, maxDecisions: number): ParsedDecisionResponse {
  const jsonObject = extractJsonObject(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonObject);
  } catch (error) {
    throw new Error(`Intention appraisal response is invalid JSON: ${String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Intention appraisal response must be a JSON object');
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error('Intention appraisal response field "decisions" must be an array');
  }

  const decisions: IntentionActionDecision[] = [];
  for (const rawDecision of parsed.decisions.slice(0, maxDecisions)) {
    if (!isRecord(rawDecision)) continue;
    const type = parseDecisionType(rawDecision.type);
    if (!type) continue;

    const reason = typeof rawDecision.reason === 'string'
      ? rawDecision.reason.trim()
      : '';
    if (!reason) continue;
    const dueAt = parseOptionalDueAt(rawDecision.dueAt);

    if (type === 'followUp') {
      const followUp = parseFollowUpPayload(rawDecision.followUp);
      if (!followUp) continue;
      decisions.push({
        type,
        priority: normalizePriority(rawDecision.priority),
        reason,
        timing: normalizeTiming(rawDecision.timing),
        ...(dueAt !== undefined ? { dueAt } : {}),
        followUp,
      });
      continue;
    }

    if (type === 'schedule') {
      const schedule = parseSchedulePayload(rawDecision.schedule);
      if (!schedule) continue;
      decisions.push({
        type,
        priority: normalizePriority(rawDecision.priority),
        reason,
        timing: normalizeTiming(rawDecision.timing),
        ...(dueAt !== undefined ? { dueAt } : {}),
        schedule,
      });
      continue;
    }

    if (type === 'concern') {
      const concern = parseConcernPayload(rawDecision.concern);
      if (!concern) continue;
      decisions.push({
        type,
        priority: normalizePriority(rawDecision.priority),
        reason,
        timing: normalizeTiming(rawDecision.timing),
        ...(dueAt !== undefined ? { dueAt } : {}),
        concern,
      });
      continue;
    }

    decisions.push({
      type,
      priority: normalizePriority(rawDecision.priority),
      reason,
      timing: normalizeTiming(rawDecision.timing),
      ...(dueAt !== undefined ? { dueAt } : {}),
    });
  }

  return { decisions };
}

function topDiscreteLabels(discrete: Record<string, number>, limit = 5): Record<string, number> {
  return Object.fromEntries(
    Object.entries(discrete)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit),
  );
}

function buildNoopDecision(reason: string): IntentionActionDecision {
  return {
    type: 'noop',
    priority: 'low',
    reason,
    timing: 'none',
  };
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function normalizeActionRunAt(value: unknown): number | undefined {
  return parseOptionalDueAt(value);
}

function resolveFollowUpRunAt(
  decision: IntentionActionDecision,
  now: number,
  options: IntentionDecisionActionOptions = {},
): number | undefined {
  const runAt = normalizeActionRunAt(decision.dueAt);
  if (decision.timing === 'immediate') {
    return runAt ?? now;
  }

  if (decision.timing === 'soon') {
    if (runAt !== undefined) {
      return Math.max(now, runAt);
    }
    if (options.surfacePendingFollowUpsImmediately) {
      return now;
    }
    return now + DEFAULT_FOLLOW_UP_PENDING_DELAY_MS;
  }

  if (decision.timing === 'scheduled') {
    if (runAt !== undefined) {
      return Math.max(now, runAt);
    }
    if (options.surfacePendingFollowUpsImmediately) {
      return now;
    }
    return now + DEFAULT_FOLLOW_UP_PENDING_DELAY_MS;
  }

  return undefined;
}

function normalizeCandidatePayload(payload: PostTurnActionCandidate['payload']): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const normalizedEntries = Object.entries(payload)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(normalizedEntries);
}

function pickFirstTrimmedString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function renderPersonaField(
  value: string | undefined,
  variables: Record<string, string>,
): string | undefined {
  if (!value) return undefined;
  const rendered = renderPromptRuntimeTokens(value, { variables }).text.trim();
  return rendered.length > 0 ? rendered : undefined;
}

function buildAppraisalPersonaContext(
  characterPromptVariables: Record<string, string>,
  fallbackCharacterName?: string,
): AppraisalPersonaContext | null {
  const name = pickFirstTrimmedString(
    characterPromptVariables['character.name'],
    characterPromptVariables.char_name,
    characterPromptVariables.character_name,
    characterPromptVariables.name,
    fallbackCharacterName,
  );
  const renderVariables: Record<string, string> = {
    ...characterPromptVariables,
    ...(name ? {
      char: name,
      char_name: name,
      character: name,
      character_name: name,
      name,
      'character.name': name,
    } : {}),
    user: 'the user',
    user_name: 'the user',
  };

  const persona: AppraisalPersonaContext = {
    ...(name ? { name } : {}),
    ...(renderPersonaField(
      pickFirstTrimmedString(
        characterPromptVariables['character.description'],
        characterPromptVariables.description,
      ),
      renderVariables,
    ) ? {
      description: renderPersonaField(
        pickFirstTrimmedString(
          characterPromptVariables['character.description'],
          characterPromptVariables.description,
        ),
        renderVariables,
      ),
    } : {}),
    ...(renderPersonaField(
      pickFirstTrimmedString(
        characterPromptVariables['character.personality'],
        characterPromptVariables.personality,
      ),
      renderVariables,
    ) ? {
      personality: renderPersonaField(
        pickFirstTrimmedString(
          characterPromptVariables['character.personality'],
          characterPromptVariables.personality,
        ),
        renderVariables,
      ),
    } : {}),
    ...(renderPersonaField(
      pickFirstTrimmedString(
        characterPromptVariables['character.scenario'],
        characterPromptVariables.scenario,
      ),
      renderVariables,
    ) ? {
      scenario: renderPersonaField(
        pickFirstTrimmedString(
          characterPromptVariables['character.scenario'],
          characterPromptVariables.scenario,
        ),
        renderVariables,
      ),
    } : {}),
    ...(renderPersonaField(
      pickFirstTrimmedString(
        characterPromptVariables['character.mes_example'],
        characterPromptVariables.mes_example,
      ),
      renderVariables,
    ) ? {
      messageExample: renderPersonaField(
        pickFirstTrimmedString(
          characterPromptVariables['character.mes_example'],
          characterPromptVariables.mes_example,
        ),
        renderVariables,
      ),
    } : {}),
    ...(renderPersonaField(
      pickFirstTrimmedString(
        characterPromptVariables['character.post_history_instructions'],
        characterPromptVariables.post_history_instructions,
      ),
      renderVariables,
    ) ? {
      postHistoryInstructions: renderPersonaField(
        pickFirstTrimmedString(
          characterPromptVariables['character.post_history_instructions'],
          characterPromptVariables.post_history_instructions,
        ),
        renderVariables,
      ),
    } : {}),
    ...(renderPersonaField(
      pickFirstTrimmedString(
        characterPromptVariables['character.visual_description'],
        characterPromptVariables.visual_description,
        characterPromptVariables.extensions_visual_description,
      ),
      renderVariables,
    ) ? {
      visualDescription: renderPersonaField(
        pickFirstTrimmedString(
          characterPromptVariables['character.visual_description'],
          characterPromptVariables.visual_description,
          characterPromptVariables.extensions_visual_description,
        ),
        renderVariables,
      ),
    } : {}),
  };

  return Object.keys(persona).length > 0 ? persona : null;
}

function buildRuntimeAppraisalSystemPrompt(
  basePrompt: string,
  persona: AppraisalPersonaContext | null,
): string {
  if (!persona) {
    return basePrompt;
  }

  const personaLines = [
    persona.name ? `Name: ${persona.name}` : null,
    persona.description ? `Description: ${persona.description}` : null,
    persona.personality ? `Personality: ${persona.personality}` : null,
    persona.scenario ? `Scenario: ${persona.scenario}` : null,
    persona.visualDescription ? `Appearance: ${persona.visualDescription}` : null,
    persona.messageExample ? `Example dialogue style:\n${persona.messageExample}` : null,
    persona.postHistoryInstructions ? `Post-history instructions: ${persona.postHistoryInstructions}` : null,
  ].filter((line): line is string => Boolean(line));

  if (personaLines.length === 0) {
    return basePrompt;
  }

  return [
    basePrompt,
    'Current companion persona context for Whisper notes to self:',
    ...personaLines,
  ].join('\n\n');
}

export function decisionsToPostTurnActionCandidates(
  decisions: readonly IntentionActionDecision[],
  context: IntentionDecisionActionContext,
  options: IntentionDecisionActionOptions = {},
): PostTurnActionCandidate[] {
  const candidates: PostTurnActionCandidate[] = [];

  for (const decision of decisions) {
    if (decision.type === 'followUp') {
      const content = decision.followUp?.content.trim() ?? '';
      if (!content) continue;
      const runAt = resolveFollowUpRunAt(decision, Date.now(), options);
      const channelId = decision.followUp?.channelId?.trim() || context.message.channelId;
      const channelType = decision.followUp?.channelType ?? context.message.channelType;
      const dedupeKey = `${INTENTION_FOLLOW_UP_ACTION_KIND}:${context.message.id}:${hashString(content)}`;
      candidates.push({
        kind: INTENTION_FOLLOW_UP_ACTION_KIND,
        dedupeKey,
        payload: {
          channelId,
          channelType,
          authorId: INTENTION_FOLLOW_UP_AUTHOR_ID,
          authorName: INTENTION_FOLLOW_UP_AUTHOR_NAME,
          content,
          ...(decision.followUp?.pendingFollowUpId
            ? { pendingFollowUpId: decision.followUp.pendingFollowUpId }
            : {}),
        } satisfies IntentionFollowUpActionPayload,
        maxRetries: 1,
        ...(runAt !== undefined ? { runAt } : {}),
      });
      continue;
    }

    if (decision.type === 'schedule') {
      const templateId = decision.schedule?.templateId.trim() ?? '';
      if (!templateId) continue;
      candidates.push({
        kind: 'heartbeat.run_template',
        dedupeKey: `heartbeat.run_template:${templateId}:${context.message.id}`,
        payload: {
          templateId,
          ...(decision.schedule?.sendToDiscordOverride !== undefined
            ? { sendToDiscordOverride: decision.schedule.sendToDiscordOverride }
            : {}),
        },
        maxRetries: 2,
      });
      continue;
    }
  }

  return candidates;
}

export function normalizeIntentionFollowUpActionPayload(payload: unknown): IntentionFollowUpActionPayload | null {
  if (!isRecord(payload)) return null;
  const channelId = typeof payload.channelId === 'string' ? payload.channelId.trim() : '';
  const authorId = typeof payload.authorId === 'string' ? payload.authorId.trim() : '';
  const authorName = typeof payload.authorName === 'string' ? payload.authorName.trim() : '';
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  const pendingFollowUpId = typeof payload.pendingFollowUpId === 'string'
    ? payload.pendingFollowUpId.trim()
    : '';
  const channelType = payload.channelType;
  if (!channelId || !authorId || !authorName || !content) return null;
  if (
    channelType !== 'terminal'
    && channelType !== 'api'
    && channelType !== 'discord'
    && channelType !== 'telegram'
    && channelType !== 'psfn-amica'
  ) {
    return null;
  }

  return {
    channelId,
    channelType,
    authorId,
    authorName,
    content,
    ...(pendingFollowUpId ? { pendingFollowUpId } : {}),
  };
}

export function toInferredPostTurnActions(
  candidates: readonly PostTurnActionCandidate[],
  message: Pick<SubstrateMessage, 'id' | 'channelId'>,
): InferredPostTurnAction[] {
  const inferred: InferredPostTurnAction[] = [];
  const seenDedupeKeys = new Set<string>();

  for (const [ordinal, candidate] of candidates.entries()) {
    if (typeof candidate.kind !== 'string') continue;
    const kind = candidate.kind.trim();
    if (!kind) continue;
    const payload = normalizeCandidatePayload(candidate.payload);
    const explicitDedupeKey = typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey.trim() : '';
    const dedupeKey = explicitDedupeKey
      || `${kind}:${message.channelId}:${hashString(stableStringify(payload))}`;
    if (seenDedupeKeys.has(dedupeKey)) continue;
    seenDedupeKeys.add(dedupeKey);

    const id = createHash('sha256')
      .update(`${message.id}:${kind}:${dedupeKey}:${ordinal}`)
      .digest('hex')
      .slice(0, 24);
    const maxRetries = (
      typeof candidate.maxRetries === 'number'
      && Number.isFinite(candidate.maxRetries)
      && candidate.maxRetries >= 0
    )
      ? Math.floor(candidate.maxRetries)
      : undefined;
    const runAt = normalizeActionRunAt(candidate.runAt);

    inferred.push({
      id,
      kind,
      payload,
      dedupeKey,
      channelId: message.channelId,
      sourceMessageId: message.id,
      inferredAt: Date.now(),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(runAt !== undefined ? { runAt } : {}),
    });
  }

  return inferred;
}

export function sessionEntriesToIntentionMessages(
  entries: ReadonlyArray<{
    role: string;
    content: string;
    timestamp: number;
    authorId?: string;
    authorName?: string;
    metadata?: string;
    channelId?: string;
  }>,
): IntentionAppraisalMessage[] {
  const messages: IntentionAppraisalMessage[] = [];
  for (const entry of entries) {
    if (typeof entry.role !== 'string' || typeof entry.content !== 'string') {
      continue;
    }
    if (isIntentionAppraisalArtifact(entry)) {
      continue;
    }
    const normalized = normalizeSessionEntryAttribution({
      role: (
        entry.role === 'assistant'
        || entry.role === 'system'
        || entry.role === 'tool'
        || entry.role === 'user'
      )
        ? entry.role
        : 'user',
      content: entry.content,
      authorId: entry.authorId,
      authorName: entry.authorName,
      metadata: entry.metadata,
      channelId: entry.channelId ?? '',
    });
    const role = normalized.role;
    const content = (
      role === 'system'
        ? formatAttributedSystemContent(entry.content, normalized.authorName)
        : entry.content
    ).trim();
    if (!content) continue;
    messages.push({
      role,
      content,
      ...(typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
        ? { timestamp: Math.floor(entry.timestamp) }
        : {}),
    });
  }
  return messages;
}

export class IntentionAppraisal {
  private readonly llmProvider: LLMProvider;
  private readonly appraisalFrequency: number;
  private readonly emotionalShiftThreshold: number;
  private readonly dueSoonWindowMs: number;
  private readonly recentMessageCount: number;
  private readonly maxMessageChars: number;
  private readonly maxConcernCount: number;
  private readonly maxDecisions: number;
  private readonly systemPrompt: string;
  private readonly fallbackCharacterName?: string;
  private readonly resolveCharacterPromptVariables: () => Record<string, string>;
  private readonly onEvaluationError?: IntentionAppraisalConfig['onEvaluationError'];
  private readonly sessionState = new Map<string, SessionAppraisalState>();

  constructor(config: IntentionAppraisalConfig) {
    this.llmProvider = config.llmProvider;
    this.appraisalFrequency = normalizePositiveInteger(
      config.appraisalFrequency,
      DEFAULT_APPRAISAL_FREQUENCY,
      'Intention appraisal frequency',
    );
    this.emotionalShiftThreshold = normalizePositiveNumber(
      config.emotionalShiftThreshold,
      DEFAULT_EMOTIONAL_SHIFT_THRESHOLD,
      'Intention appraisal emotionalShiftThreshold',
    );
    this.dueSoonWindowMs = normalizePositiveNumber(
      config.dueSoonWindowMs,
      DEFAULT_DUE_SOON_WINDOW_MS,
      'Intention appraisal dueSoonWindowMs',
    );
    this.recentMessageCount = normalizePositiveInteger(
      config.recentMessageCount,
      DEFAULT_RECENT_MESSAGE_COUNT,
      'Intention appraisal recentMessageCount',
    );
    this.maxMessageChars = normalizePositiveInteger(
      config.maxMessageChars,
      DEFAULT_MAX_MESSAGE_CHARS,
      'Intention appraisal maxMessageChars',
    );
    this.maxConcernCount = normalizePositiveInteger(
      config.maxConcernCount,
      DEFAULT_MAX_CONCERN_COUNT,
      'Intention appraisal maxConcernCount',
    );
    this.maxDecisions = normalizePositiveInteger(
      config.maxDecisions,
      DEFAULT_MAX_DECISIONS,
      'Intention appraisal maxDecisions',
    );
    this.systemPrompt = config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    this.fallbackCharacterName = config.characterName?.trim() || undefined;
    this.resolveCharacterPromptVariables = config.characterPromptVariablesProvider
      ?? (() => ({}));
    this.onEvaluationError = config.onEvaluationError;
  }

  async evaluate(input: IntentionAppraisalInput): Promise<IntentionActionDecision[]> {
    const normalized = normalizeInput(input, {
      recentMessageCount: this.recentMessageCount,
      maxMessageChars: this.maxMessageChars,
      maxConcernCount: this.maxConcernCount,
    });

    const state = this.sessionState.get(normalized.sessionId) ?? {
      turnsSinceLastAppraisal: 0,
      lastEmotion: null,
    };

    const turnsSinceLast = state.turnsSinceLastAppraisal + 1;
    const emotionalShift = maxEmotionShift(state.lastEmotion, normalized.currentEmotion);
    const concernDueSoon = hasDueSoonConcern(
      normalized.activeConcerns,
      normalized.now,
      this.dueSoonWindowMs,
    );
    const trigger: AppraisalTrigger | null = (
      normalized.triggerOverride
      ?? (emotionalShift >= this.emotionalShiftThreshold
        ? 'emotional_shift'
        : concernDueSoon
          ? 'concern_due'
          : turnsSinceLast >= this.appraisalFrequency
            ? 'frequency'
            : null)
    );

    state.lastEmotion = normalized.currentEmotion;
    state.turnsSinceLastAppraisal = trigger ? 0 : turnsSinceLast;
    this.sessionState.set(normalized.sessionId, state);

    if (!trigger) {
      return [buildNoopDecision('no appraisal trigger matched')];
    }

    const promptRecentMessages = normalized.recentMessages.map((message) => {
      const timestampLabel = formatPromptTimestamp(message.timestamp);
      return {
        role: message.role,
        content: message.content,
        ...(timestampLabel ? { at: timestampLabel } : {}),
      };
    });
    const promptActiveConcerns = normalized.activeConcerns.map((concern) => {
      const dueAtLabel = formatPromptTimestamp(concern.dueAt);
      return {
        ...(concern.id ? { id: concern.id } : {}),
        ...(concern.title ? { title: concern.title } : {}),
        ...(concern.summary ? { summary: concern.summary } : {}),
        ...(concern.status ? { status: concern.status } : {}),
        ...(concern.priority !== undefined ? { priority: concern.priority } : {}),
        ...(dueAtLabel ? { dueAt: dueAtLabel } : {}),
      };
    });
    const promptRecentlyResolvedConcerns = normalized.recentlyResolvedConcerns.map((concern) => {
      const resolvedAtLabel = formatPromptTimestamp(concern.resolvedAt);
      return {
        ...(concern.id ? { id: concern.id } : {}),
        ...(concern.title ? { title: concern.title } : {}),
        ...(concern.summary ? { summary: concern.summary } : {}),
        ...(concern.status ? { status: concern.status } : {}),
        ...(concern.priority !== undefined ? { priority: concern.priority } : {}),
        ...(resolvedAtLabel ? { resolvedAt: resolvedAtLabel } : {}),
      };
    });
    let persona: AppraisalPersonaContext | null;
    try {
      persona = buildAppraisalPersonaContext(
        this.resolveCharacterPromptVariables(),
        this.fallbackCharacterName,
      );
    } catch (error) {
      this.onEvaluationError?.(error, { sessionId: normalized.sessionId, trigger });
      return [buildNoopDecision('appraisal failed closed')];
    }

    const promptPayload = {
      trigger,
      sessionId: normalized.sessionId,
      turnsSinceLastAppraisal: turnsSinceLast,
      emotionalShift: Number(emotionalShift.toFixed(4)),
      internalState: normalized.internalState
        ? {
          emotional: {
            vad: normalized.internalState.emotional.vad,
            mood: normalized.internalState.emotional.mood,
            confidence: normalized.internalState.emotional.confidence,
            topDiscrete: topDiscreteLabels(normalized.internalState.emotional.discreteEmotions),
          },
          cognitive: normalized.internalState.cognitive,
          attention: {
            conversationTrajectory: normalized.internalState.attention.conversationTrajectory,
            salientEntities: normalized.internalState.attention.salientEntities,
            activeConcernCount: normalized.internalState.attention.activeConcerns.length,
          },
          relational: normalized.internalState.relational,
        }
        : null,
      currentEmotion: normalized.currentEmotion
        ? {
          vad: normalized.currentEmotion.vad,
          mood: normalized.currentEmotion.mood,
          confidence: normalized.currentEmotion.confidence,
          topDiscrete: topDiscreteLabels(normalized.currentEmotion.discrete),
        }
        : null,
      contactEmotionalSnapshot: normalized.contactEmotionalSnapshot,
      activeConcerns: promptActiveConcerns,
      recentlyResolvedConcerns: promptRecentlyResolvedConcerns,
      conversationTrajectory: normalized.conversationTrajectory,
      ...(normalized.motivationSignals.length > 0 ? { motivationSignals: normalized.motivationSignals } : {}),
      recentMessages: promptRecentMessages,
      ...(persona ? { persona } : {}),
      now: formatPromptTimestamp(normalized.now) ?? null,
      timezone: resolveActiveTimezone(),
    };

    const completionPurpose: CompletionPurpose = 'background';
    const promptMessage: ContextMessage = {
      role: 'user',
      content: JSON.stringify(promptPayload, null, 2),
    };

    try {
      const completion = await this.llmProvider.complete({
        systemPrompt: buildRuntimeAppraisalSystemPrompt(this.systemPrompt, persona),
        messages: [promptMessage],
      }, completionPurpose);
      const parsed = parseDecisionResponse(completion.content, this.maxDecisions);
      const decisions = parsed.decisions.length > 0
        ? parsed.decisions
        : [buildNoopDecision('model returned no valid decisions')];
      return decisions;
    } catch (error) {
      this.onEvaluationError?.(error, { sessionId: normalized.sessionId, trigger });
      return [buildNoopDecision('appraisal failed closed')];
    }
  }
}
