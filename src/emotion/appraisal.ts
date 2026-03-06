import type { LLMProvider } from '../agent/contracts.js';
import type { CompletionPurpose, ContextMessage, LLMResponse } from '../types.js';
import { createComponentLogger } from '../logger.js';
import type { EmotionStateSnapshot, VADVector } from './state.js';

const log = createComponentLogger('EmotionAppraisal');

const DEFAULT_TURN_CADENCE = 5;
const DEFAULT_VAD_DELTA_THRESHOLD = 0.35;
const DEFAULT_RECENT_MESSAGE_COUNT = 8;
const DEFAULT_MAX_CHAIN_ENTRIES = 20;
const DEFAULT_MAX_MESSAGE_CHARS = 240;
const DEFAULT_MAX_SUMMARY_CHARS = 900;
const MAX_TRAIT_COUNT = 16;
const TOP_DISCRETE_COUNT = 5;
const APPRAISAL_SYSTEM_PROMPT = [
  'You generate an internal chain-of-emotion appraisal for an AI companion.',
  'Use recent conversation context, current VAD state, and personality traits.',
  'Write one short paragraph (60-120 words) in plain text.',
  'Do not use markdown, bullet points, or roleplay.',
  'Focus on emotional interpretation and likely trajectory for the next turn.',
].join(' ');

export interface EmotionAppraisalMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
}

export type EmotionAppraisalTrigger = 'periodic' | 'vad_shift';

export interface EmotionAppraisalEntry {
  timestamp: number;
  trigger: EmotionAppraisalTrigger;
  summary: string;
  vad: VADVector;
  turnId?: string;
}

export interface EmotionAppraisalInput {
  sessionId: string;
  currentEmotion: EmotionStateSnapshot;
  recentMessages: readonly EmotionAppraisalMessage[];
  personalityTraits?: Record<string, string>;
  turnId?: string;
  now?: number;
}

export interface EmotionAppraisalResult {
  appraised: boolean;
  trigger?: EmotionAppraisalTrigger;
  entry?: EmotionAppraisalEntry;
  turnsSinceLast: number;
  delta: number;
}

export interface EmotionAppraisalConfig {
  llmProvider?: LLMProvider;
  turnCadence?: number;
  vadDeltaThreshold?: number;
  recentMessageCount?: number;
  maxChainEntries?: number;
  maxMessageChars?: number;
  maxSummaryChars?: number;
  systemPrompt?: string;
}

interface SessionAppraisalState {
  chain: EmotionAppraisalEntry[];
  turnsSinceLast: number;
  lastAppraisedVad: VADVector | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTurnCadence(value: number | undefined): number {
  const normalized = value ?? DEFAULT_TURN_CADENCE;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Emotion appraisal turn cadence must be a positive integer, received ${String(value)}`);
  }
  return normalized;
}

function normalizeVadDeltaThreshold(value: number | undefined): number {
  const normalized = value ?? DEFAULT_VAD_DELTA_THRESHOLD;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 2) {
    throw new Error(`Emotion appraisal VAD delta threshold must be in range (0, 2], received ${String(value)}`);
  }
  return normalized;
}

function normalizePositiveInteger(value: number | undefined, field: string, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer, received ${String(value)}`);
  }
  return normalized;
}

function normalizeSigned(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`${field} must be in range [-1, 1]`);
  }
  return value;
}

function normalizeUnit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${field} must be in range [0, 1]`);
  }
  return value;
}

function normalizeVad(vad: unknown, field: string): VADVector {
  if (!isRecord(vad)) {
    throw new Error(`${field} must be an object`);
  }
  return {
    valence: normalizeSigned(vad.valence, `${field}.valence`),
    arousal: normalizeSigned(vad.arousal, `${field}.arousal`),
    dominance: normalizeSigned(vad.dominance, `${field}.dominance`),
  };
}

function normalizeSnapshot(snapshot: EmotionStateSnapshot): EmotionStateSnapshot {
  const vad = normalizeVad(snapshot.vad, 'emotion.vad');
  const mood = normalizeVad(snapshot.mood, 'emotion.mood');
  const discrete: Record<string, number> = {};
  for (const [rawLabel, rawScore] of Object.entries(snapshot.discrete)) {
    const label = rawLabel.trim().toLowerCase();
    if (!label) continue;
    discrete[label] = normalizeUnit(rawScore, `emotion.discrete.${label}`);
  }

  return {
    vad,
    mood,
    discrete,
    confidence: normalizeUnit(snapshot.confidence, 'emotion.confidence'),
  };
}

function normalizeSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string') {
    throw new Error(`Emotion appraisal sessionId must be a string, received ${String(sessionId)}`);
  }
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error('Emotion appraisal sessionId must be non-empty');
  }
  return trimmed;
}

function normalizeMessageRole(value: unknown, index: number): EmotionAppraisalMessage['role'] {
  if (value !== 'user' && value !== 'assistant' && value !== 'system' && value !== 'tool') {
    throw new Error(`Emotion appraisal recentMessages[${index}].role is invalid`);
  }
  return value;
}

function normalizeRecentMessages(
  messages: readonly EmotionAppraisalMessage[],
  maxMessages: number,
  maxMessageChars: number,
): EmotionAppraisalMessage[] {
  if (!Array.isArray(messages)) {
    throw new Error('Emotion appraisal recentMessages must be an array');
  }
  const bounded = messages.slice(-maxMessages);
  const normalized: EmotionAppraisalMessage[] = [];

  for (let index = 0; index < bounded.length; index += 1) {
    const entry = bounded[index];
    if (!isRecord(entry)) {
      throw new Error(`Emotion appraisal recentMessages[${index}] must be an object`);
    }
    const role = normalizeMessageRole(entry.role, index);
    if (typeof entry.content !== 'string') {
      throw new Error(`Emotion appraisal recentMessages[${index}].content must be a string`);
    }
    const content = entry.content.replace(/\s+/g, ' ').trim();
    if (!content) continue;
    normalized.push({
      role,
      content: content.length > maxMessageChars ? `${content.slice(0, maxMessageChars - 3)}...` : content,
      ...(typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
        ? { timestamp: entry.timestamp }
        : {}),
    });
  }

  return normalized;
}

function normalizePersonalityTraits(
  traits: Record<string, string> | undefined,
): Record<string, string> {
  if (traits === undefined) return {};
  if (!isRecord(traits)) {
    throw new Error('Emotion appraisal personalityTraits must be an object when provided');
  }

  const normalizedEntries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(traits)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string') {
      throw new Error(`Emotion appraisal trait "${key}" must be a string`);
    }
    const value = rawValue.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    normalizedEntries.push([key, value]);
  }

  normalizedEntries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(normalizedEntries.slice(0, MAX_TRAIT_COUNT));
}

function maxAbsoluteVadDelta(left: VADVector, right: VADVector): number {
  return Math.max(
    Math.abs(left.valence - right.valence),
    Math.abs(left.arousal - right.arousal),
    Math.abs(left.dominance - right.dominance),
  );
}

function maxAbsoluteVadComponent(vad: VADVector): number {
  return Math.max(
    Math.abs(vad.valence),
    Math.abs(vad.arousal),
    Math.abs(vad.dominance),
  );
}

function topDiscrete(discrete: Record<string, number>, limit: number): string {
  const top = Object.entries(discrete)
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([label, score]) => `${label}=${score.toFixed(3)}`);
  return top.length > 0 ? top.join(', ') : 'none';
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

function normalizeAppraisalSummary(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new Error('Emotion appraisal LLM response content must be a string');
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error('Emotion appraisal LLM response content must be non-empty');
  }
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

interface CompletionProviderWithOptions extends LLMProvider {
  complete(context: LLMContextLike, purpose: CompletionPurpose, options?: {
    correlation?: {
      purpose: string;
      callType: 'background';
      originType: 'background';
      originStage: string;
      channelId: string;
      turnId?: string;
    };
  }): Promise<LLMResponse>;
}

interface LLMContextLike {
  systemPrompt: string;
  messages: ContextMessage[];
}

export class EmotionAppraisal {
  private readonly llmProvider: CompletionProviderWithOptions;
  private readonly turnCadence: number;
  private readonly vadDeltaThreshold: number;
  private readonly recentMessageCount: number;
  private readonly maxChainEntries: number;
  private readonly maxMessageChars: number;
  private readonly maxSummaryChars: number;
  private readonly systemPrompt: string;
  private readonly sessionState = new Map<string, SessionAppraisalState>();

  constructor(config: EmotionAppraisalConfig | undefined) {
    if (!config || !config.llmProvider) {
      throw new Error('Emotion appraisal requires an llmProvider');
    }
    this.llmProvider = config.llmProvider as CompletionProviderWithOptions;
    this.turnCadence = normalizeTurnCadence(config.turnCadence);
    this.vadDeltaThreshold = normalizeVadDeltaThreshold(config.vadDeltaThreshold);
    this.recentMessageCount = normalizePositiveInteger(
      config.recentMessageCount,
      'Emotion appraisal recentMessageCount',
      DEFAULT_RECENT_MESSAGE_COUNT,
    );
    this.maxChainEntries = normalizePositiveInteger(
      config.maxChainEntries,
      'Emotion appraisal maxChainEntries',
      DEFAULT_MAX_CHAIN_ENTRIES,
    );
    this.maxMessageChars = normalizePositiveInteger(
      config.maxMessageChars,
      'Emotion appraisal maxMessageChars',
      DEFAULT_MAX_MESSAGE_CHARS,
    );
    this.maxSummaryChars = normalizePositiveInteger(
      config.maxSummaryChars,
      'Emotion appraisal maxSummaryChars',
      DEFAULT_MAX_SUMMARY_CHARS,
    );
    const normalizedPrompt = config.systemPrompt?.replace(/\s+/g, ' ').trim();
    this.systemPrompt = normalizedPrompt && normalizedPrompt.length > 0
      ? normalizedPrompt
      : APPRAISAL_SYSTEM_PROMPT;
  }

  getChain(sessionIdRaw: string): EmotionAppraisalEntry[] {
    const sessionId = normalizeSessionId(sessionIdRaw);
    const state = this.sessionState.get(sessionId);
    if (!state) return [];
    return state.chain.map((entry) => ({
      ...entry,
      vad: { ...entry.vad },
    }));
  }

  async maybeAppraise(input: EmotionAppraisalInput): Promise<EmotionAppraisalResult> {
    const sessionId = normalizeSessionId(input.sessionId);
    const snapshot = normalizeSnapshot(input.currentEmotion);
    const recentMessages = normalizeRecentMessages(
      input.recentMessages,
      this.recentMessageCount,
      this.maxMessageChars,
    );
    const personalityTraits = normalizePersonalityTraits(input.personalityTraits);
    const now = input.now ?? Date.now();
    if (!Number.isFinite(now) || now <= 0) {
      throw new Error(`Emotion appraisal now must be a positive finite timestamp, received ${String(input.now)}`);
    }

    const state = this.getOrCreateSessionState(sessionId);
    const currentVad = snapshot.vad;
    const delta = state.lastAppraisedVad
      ? maxAbsoluteVadDelta(state.lastAppraisedVad, currentVad)
      : maxAbsoluteVadComponent(currentVad);
    const turnsSinceLast = state.turnsSinceLast + 1;
    state.turnsSinceLast = turnsSinceLast;

    const shouldTriggerPeriodic = turnsSinceLast >= this.turnCadence;
    const shouldTriggerVadShift = delta >= this.vadDeltaThreshold;
    if (!shouldTriggerPeriodic && !shouldTriggerVadShift) {
      return {
        appraised: false,
        turnsSinceLast,
        delta,
      };
    }

    const trigger: EmotionAppraisalTrigger = shouldTriggerVadShift ? 'vad_shift' : 'periodic';
    const context: LLMContextLike = {
      systemPrompt: this.systemPrompt,
      messages: [
        {
          role: 'user',
          content: this.buildPrompt({
            snapshot,
            recentMessages,
            personalityTraits,
          }),
        },
      ],
    };
    const response = await this.llmProvider.complete(context, 'background', {
      correlation: {
        purpose: 'emotion.appraisal',
        callType: 'background',
        originType: 'background',
        originStage: 'emotion.appraisal',
        channelId: sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      },
    });
    const summary = normalizeAppraisalSummary(response.content, this.maxSummaryChars);

    const entry: EmotionAppraisalEntry = {
      timestamp: now,
      trigger,
      summary,
      vad: { ...currentVad },
      ...(input.turnId ? { turnId: input.turnId } : {}),
    };
    state.chain = [...state.chain, entry].slice(-this.maxChainEntries);
    state.lastAppraisedVad = { ...currentVad };
    state.turnsSinceLast = 0;
    log.debug('Emotion appraisal updated', {
      sessionId,
      trigger,
      delta,
      chainLength: state.chain.length,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    });

    return {
      appraised: true,
      trigger,
      entry: {
        ...entry,
        vad: { ...entry.vad },
      },
      turnsSinceLast: 0,
      delta,
    };
  }

  private getOrCreateSessionState(sessionId: string): SessionAppraisalState {
    const existing = this.sessionState.get(sessionId);
    if (existing) return existing;
    const created: SessionAppraisalState = {
      chain: [],
      turnsSinceLast: 0,
      lastAppraisedVad: null,
    };
    this.sessionState.set(sessionId, created);
    return created;
  }

  private buildPrompt(input: {
    snapshot: EmotionStateSnapshot;
    recentMessages: readonly EmotionAppraisalMessage[];
    personalityTraits: Record<string, string>;
  }): string {
    const lines: string[] = [];
    lines.push('Create one internal emotion appraisal paragraph.');
    lines.push('');
    lines.push('[Current Emotion State]');
    lines.push(
      `VAD: valence=${formatSigned(input.snapshot.vad.valence)}, `
      + `arousal=${formatSigned(input.snapshot.vad.arousal)}, `
      + `dominance=${formatSigned(input.snapshot.vad.dominance)}`,
    );
    lines.push(
      `Mood VAD: valence=${formatSigned(input.snapshot.mood.valence)}, `
      + `arousal=${formatSigned(input.snapshot.mood.arousal)}, `
      + `dominance=${formatSigned(input.snapshot.mood.dominance)}`,
    );
    lines.push(`Top discrete emotions: ${topDiscrete(input.snapshot.discrete, TOP_DISCRETE_COUNT)}`);
    lines.push(`Signal confidence: ${input.snapshot.confidence.toFixed(3)}`);
    lines.push('');
    lines.push('[Personality Traits]');
    const traitEntries = Object.entries(input.personalityTraits);
    if (traitEntries.length === 0) {
      lines.push('none');
    } else {
      for (const [key, value] of traitEntries) {
        lines.push(`- ${key}: ${value}`);
      }
    }
    lines.push('');
    lines.push('[Recent Conversation]');
    if (input.recentMessages.length === 0) {
      lines.push('none');
    } else {
      for (const message of input.recentMessages) {
        lines.push(`- ${message.role}: ${message.content}`);
      }
    }
    return lines.join('\n');
  }
}
