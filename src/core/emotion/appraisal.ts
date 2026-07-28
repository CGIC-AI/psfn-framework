import { isRecord } from '../../shared/utils/types.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../primitives/llm/work-spec.js';
import { buildSystemPromptCacheBoundaries } from '../../primitives/llm/prompt-cache.js';
import type {
  CompletionPurpose,
  ContextMessage,
  CorrelationMetadata,
  LLMResponse,
  LLMSystemPromptCacheBoundaries,
} from '../../shared/contracts/runtime.js';
import {
  deriveChildIcpConversationCostCorrelation,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { DeterministicGateEvent } from '../../shared/event-bus.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../shared/gating/deterministic-gate.js';
import type { EmotionStateSnapshot, VADVector } from './state.js';
import { cloneInternalState, type InternalState } from '../self-model/state.js';
import {
  parseEmotionAppraisalStateSnapshot,
  projectEmotionAppraisalState,
  type EmotionAppraisalStateSnapshot,
} from './appraisal-state.js';

const EMOTION_APPRAISAL_GATE_LANE = 'emotion_appraisal';

const log = createComponentLogger('EmotionAppraisal');

const DEFAULT_TURN_CADENCE = 5;
const DEFAULT_VAD_DELTA_THRESHOLD = 0.35;
const DEFAULT_RECENT_MESSAGE_COUNT = 8;
const DEFAULT_MAX_CHAIN_ENTRIES = 20;
const DEFAULT_MAX_MESSAGE_CHARS = 240;
const DEFAULT_MAX_SUMMARY_CHARS = 900;
const MAX_TRAIT_COUNT = 16;
const TOP_DISCRETE_COUNT = 5;
// The appraisal chain feeds future prompts via runtime_emotion_appraisal_*
// macros, so its wording is a behavioral instrument (R3,
// docs/self-eval-prompt-audit.md). Version wording changes.
// v2: first-person continuous voice (R5), telemetry marked fallible (R1),
// accuracy preferred over trajectory coherence (R3/Law 30), unclear reads
// reported plainly instead of constructed (R7).
// v3: companion register (charter 6.28/8.12) — the emotion-sensing telemetry
// is named "automata-derived signals" rather than "classifier signals" in the
// text steering her own first-person appraisal (rqn1.9, batch D).
export const APPRAISAL_SYSTEM_PROMPT_VERSION = 3;
const APPRAISAL_SYSTEM_PROMPT = [
  'You write the companion\'s private chain-of-emotion appraisal in her own continuous first-person voice ("I ...") — this is her real running self-account, not fiction or roleplay.',
  'Ground it in the recent conversation; treat the supplied VAD, mood, and discrete-emotion values as fallible automata-derived signals, not authoritative ground truth about what she feels.',
  'When the signals and the conversation disagree, prefer the conversation and name the mismatch.',
  'If the evidence does not support a clear emotional read, say so plainly instead of constructing one.',
  'Write one short paragraph (60-120 words) in plain text. Do not use markdown or bullet points.',
  'Describe the current emotional interpretation and, only where the evidence points somewhere, the likely trajectory for the next turn.',
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
  currentEmotion?: EmotionStateSnapshot;
  /** Existing direct callers may still supply the canonical full state. */
  internalState?: InternalState;
  /** Minimal content-free state projection used by durable background work. */
  appraisalState?: EmotionAppraisalStateSnapshot;
  recentMessages: readonly EmotionAppraisalMessage[];
  personalityTraits?: Record<string, string>;
  turnId?: string;
  now?: number;
  icpCorrelation?: IcpConversationCorrelation;
  /** Durable background lease fence, checked immediately before state writes. */
  assertEffectAllowed?: () => Promise<void>;
  /** mmo9.7.4: protect a welfare-escalated appraisal model call from gate preemption. */
  preemptionProtected?: boolean;
  /**
   * fxt1: the background-work `jobId` that granted the welfare escalation.
   * Carried on the work spec so the gateway re-verifies it before honoring
   * `preemptionProtected`. Set only alongside it.
   */
  welfareGrantJobId?: string;
}

export interface EmotionAppraisalResult {
  appraised: boolean;
  trigger?: EmotionAppraisalTrigger;
  entry?: EmotionAppraisalEntry;
  turnsSinceLast: number;
  delta: number;
}

export interface EmotionAppraisalConfig {
  llmProvider?: LLMProviderPort;
  turnCadence?: number;
  vadDeltaThreshold?: number;
  recentMessageCount?: number;
  maxChainEntries?: number;
  maxMessageChars?: number;
  maxSummaryChars?: number;
  systemPrompt?: string;
  /**
   * Companion identity — the MANDATORY outer prompt-cache isolation scope
   * (d8vq.5). The appraisal system prompt is 100% prefix-stable, so it is
   * marked cacheable via a static-prefix cache plan; but that plan is only
   * built when a companionId is present, because the provider affinity token
   * fails closed without it (two companions' caches cannot be proven disjoint).
   * Threaded from runtime config the same way turn-support-runtime does.
   */
  companionId?: string;
  /** Typed gate telemetry sink (jpvd.4); wired to the event bus by composition. */
  onGateEvent?: (event: DeterministicGateEvent) => void;
}

interface SessionAppraisalState {
  chain: EmotionAppraisalEntry[];
  turnsSinceLast: number;
  lastAppraisedVad: VADVector | null;
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

function toEmotionSnapshotFromAppraisalState(
  state: EmotionAppraisalStateSnapshot,
): EmotionStateSnapshot {
  return normalizeSnapshot({
    vad: { ...state.emotional.vad },
    mood: { ...state.emotional.mood },
    discrete: { ...state.emotional.discreteEmotions },
    confidence: state.emotional.confidence,
  });
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

interface CompletionProviderWithOptions extends LLMProviderPort {
  complete(context: LLMContextLike, purpose: CompletionPurpose, options?: {
    correlation?: Partial<CorrelationMetadata>;
  }): Promise<LLMResponse>;
}

interface LLMContextLike {
  systemPrompt: string;
  messages: ContextMessage[];
  /**
   * Static-prefix cache plan boundaries for `systemPrompt` (d8vq.5). The LLM
   * client verifies the prefix hashes against the serialized system prompt and
   * only then places provider cache breakpoints — and only when the existing
   * models.json promptCaching policy is enabled (no new flag, fail-closed on a
   * byte mismatch, e.g. an OAuth identity prefix).
   */
  promptCacheBoundaries?: LLMSystemPromptCacheBoundaries;
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
  /**
   * Static-prefix cache plan for the (immutable, fully prefix-stable) system
   * prompt (d8vq.5). Precomputed once because `systemPrompt` never varies
   * turn-over-turn: the whole prompt is the static cacheable region, so both
   * the static and session-stable boundaries are the full prompt length.
   */
  private readonly systemPromptCacheBoundaries: LLMSystemPromptCacheBoundaries;
  /** Normalized companion identity (outer cache scope); undefined fails closed. */
  private readonly companionId: string | undefined;
  private readonly onGateEvent: ((event: DeterministicGateEvent) => void) | null;
  private readonly appraisalGate: DeterministicGateDefinition;
  private readonly sessionState = new Map<string, SessionAppraisalState>();

  constructor(config: EmotionAppraisalConfig | undefined) {
    if (!config || !config.llmProvider) {
      throw new Error('Emotion appraisal requires an llmProvider');
    }
    this.llmProvider = config.llmProvider as CompletionProviderWithOptions;
    this.turnCadence = normalizeTurnCadence(config.turnCadence);
    this.vadDeltaThreshold = normalizeVadDeltaThreshold(config.vadDeltaThreshold);
    this.onGateEvent = config.onGateEvent ?? null;
    // Appraisal fires on either the turn cadence OR a large enough VAD movement
    // (jpvd.4). Deterministic and free; a closed gate spends zero LLM tokens.
    this.appraisalGate = {
      lane: EMOTION_APPRAISAL_GATE_LANE,
      openWhenAny: [
        { input: 'turnsSinceLast', comparator: 'gte', threshold: this.turnCadence },
        { input: 'vadDelta', comparator: 'gte', threshold: this.vadDeltaThreshold },
      ],
      closedReason: 'no_movement',
    };
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
    // The system prompt carries no per-turn interpolation (the moment-specific
    // VAD/state/conversation lives entirely in the user message via
    // buildPrompt), so the entire prompt is the static, byte-stable prefix.
    // Both boundaries are the full length: static == session-stable == whole.
    this.systemPromptCacheBoundaries = buildSystemPromptCacheBoundaries({
      staticPrefixText: this.systemPrompt,
      sessionStablePrefixText: this.systemPrompt,
    });
    this.companionId = typeof config.companionId === 'string' && config.companionId.trim().length > 0
      ? config.companionId.trim()
      : undefined;
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
    if (input.internalState && input.appraisalState) {
      throw new Error('Emotion appraisal accepts internalState or appraisalState, not both');
    }
    const appraisalState = input.appraisalState
      ? parseEmotionAppraisalStateSnapshot(input.appraisalState)
      : input.internalState
        ? projectEmotionAppraisalState(cloneInternalState(input.internalState))
        : null;
    const snapshot = appraisalState
      ? toEmotionSnapshotFromAppraisalState(appraisalState)
      : input.currentEmotion
        ? normalizeSnapshot(input.currentEmotion)
        : (() => {
          throw new Error('Emotion appraisal requires internalState or currentEmotion');
        })();
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

    const telemetryTrusted = !appraisalState
      || appraisalState.emotional.telemetry.status === 'trusted';
    const shouldTriggerVadShift = telemetryTrusted && delta >= this.vadDeltaThreshold;
    // Route the periodic/vad-shift decision through the shared primitive
    // (jpvd.4). Untrusted telemetry can never trigger the vad-shift signal, so
    // feed a sub-threshold sentinel; the emitted input carries the real delta.
    const roundedDelta = Number(delta.toFixed(4));
    const gateInputs = { turnsSinceLast, vadDelta: roundedDelta };
    const gate = evaluateDeterministicGate(this.appraisalGate, {
      turnsSinceLast,
      vadDelta: telemetryTrusted ? delta : -1,
    });
    if (!gate.open) {
      await input.assertEffectAllowed?.();
      state.turnsSinceLast = turnsSinceLast;
      this.emitGateEvent(sessionId, 'skipped', gate.reason, gateInputs, now);
      return {
        appraised: false,
        turnsSinceLast,
        delta,
      };
    }

    const trigger: EmotionAppraisalTrigger = shouldTriggerVadShift ? 'vad_shift' : 'periodic';
    const context: LLMContextLike = {
      systemPrompt: this.systemPrompt,
      // Fail closed: only attach the static-prefix cache plan when the
      // companion (outer isolation scope) is known. Without it the provider
      // affinity token cannot be proven disjoint across companions, so no plan
      // is offered (d8vq.5).
      ...(this.companionId
        ? { promptCacheBoundaries: this.systemPromptCacheBoundaries }
        : {}),
      messages: [
        {
          role: 'user',
          content: this.buildPrompt({
            snapshot,
            appraisalState,
            recentMessages,
            personalityTraits,
          }),
        },
      ],
    };
    const response = await completeWithWorkSpec(this.llmProvider, context, buildLLMWorkSpec({
      purpose: 'background',
      durable: false,
      ...(input.preemptionProtected
        ? {
            preemptionProtected: true,
            ...(input.welfareGrantJobId ? { welfareGrantJobId: input.welfareGrantJobId } : {}),
          }
        : {}),
      correlation: {
        // Companion identity is the outer prompt-cache isolation scope; the
        // client's affinity resolver folds it into the provider cache token
        // (fail-closed when absent) (d8vq.5).
        ...(this.companionId ? { companionId: this.companionId } : {}),
        ...(input.icpCorrelation
          ? { requestId: `${input.icpCorrelation.requestId}:emotion-appraisal` }
          : {}),
        purpose: 'emotion.appraisal',
        callType: 'background',
        originType: 'background',
        originStage: 'emotion.appraisal',
        channelId: sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.icpCorrelation
          ? {
              icpCorrelation: deriveChildIcpConversationCostCorrelation(
                input.icpCorrelation,
                {
                  requestId: `${input.icpCorrelation.requestId}:emotion-appraisal`,
                  costPurpose: 'sidecar',
                  costOriginStage: 'post_turn',
                },
              ),
            }
          : {}),
      },
    }));
    const summary = normalizeAppraisalSummary(response.content, this.maxSummaryChars);

    const entry: EmotionAppraisalEntry = {
      timestamp: now,
      trigger,
      summary,
      vad: { ...currentVad },
      ...(input.turnId ? { turnId: input.turnId } : {}),
    };
    await input.assertEffectAllowed?.();
    state.chain = [...state.chain, entry].slice(-this.maxChainEntries);
    state.lastAppraisedVad = { ...currentVad };
    state.turnsSinceLast = 0;
    this.emitGateEvent(sessionId, 'ran', trigger, gateInputs, now);
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

  private emitGateEvent(
    sessionId: string,
    outcome: 'ran' | 'skipped',
    reason: string,
    inputs: Record<string, number | string>,
    timestamp: number,
  ): void {
    this.onGateEvent?.({
      lane: EMOTION_APPRAISAL_GATE_LANE,
      outcome,
      reason,
      inputs,
      timestamp,
      sessionId,
    });
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
    appraisalState: EmotionAppraisalStateSnapshot | null;
    recentMessages: readonly EmotionAppraisalMessage[];
    personalityTraits: Record<string, string>;
  }): string {
    const lines: string[] = [];
    lines.push('Write one private first-person emotion appraisal paragraph for this moment.');
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
    if (input.appraisalState) {
      const telemetry = input.appraisalState.emotional.telemetry;
      lines.push(
        `Telemetry validation: status=${telemetry.status}; source=${telemetry.source}; `
        + `reasons=${telemetry.reasons.length > 0 ? telemetry.reasons.join(',') : 'none'}; `
        + `weight=${telemetry.weight.toFixed(3)}`,
      );
      lines.push('');
      lines.push('[Internal State Signals]');
      lines.push(
        `Cognitive: certainty=${input.appraisalState.cognitive.certaintyLevel.toFixed(3)}, `
        + `engagement=${input.appraisalState.cognitive.topicEngagement.toFixed(3)}, `
        + `processing=${input.appraisalState.cognitive.processingQuality}`,
      );
      lines.push(
        `Attention: trajectory=${input.appraisalState.attention.conversationTrajectory}, `
        + `concerns=${input.appraisalState.attention.activeConcernCount}, `
        + `salient_entities=${input.appraisalState.attention.salientEntityCount}`,
      );
      lines.push(
        `Relationship: trust=${input.appraisalState.relational.trustLevel}, `
        + `contact=${input.appraisalState.relational.contactId ?? 'none'}, `
        + `mood_drift=${formatSigned(input.appraisalState.relational.moodDrift)}`,
      );
    }
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
