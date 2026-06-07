import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { evaluateRestWindowEligibility } from '../../core/scheduler/rest-window.js';
import type { InferredPostTurnAction, PostTurnActionCandidate, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';
import type { CoreMemoryStorePort } from './memory-store-port.js';
import type { MemoryWriteOptions, MemoryWriter } from './writer.js';
import type { EpisodicSynthesisRunResult, EpisodicSynthesizer } from './episodic/synthesis.js';
import {
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
  type MemoryType,
  type SensitivityLevel,
} from './types.js';

const log = createComponentLogger('SleeptimeMemoryAgent');

export const SLEEPTIME_MEMORY_ACTION_KIND = 'memory.sleeptime.run';

const DEFAULT_CADENCE_TURNS = 3;
const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 24;
const DEFAULT_MAX_MEMORY_WRITES = 4;
const MAX_TRANSCRIPT_ENTRY_CHARS = 600;

type CoreMemoryRewriter = Pick<CoreMemoryStorePort, 'getSnapshot' | 'rethink'>;
type SessionMemoryReader = Pick<SessionManager, 'resolveSessionChannelId' | 'getRecentMessages'>;
type SleeptimeMemoryWriter = Pick<MemoryWriter, 'write'>;
type SleeptimeEpisodicSynthesizer = Pick<EpisodicSynthesizer, 'run'>;

interface NormalizedMemoryWrite {
  text: string;
  type: MemoryType;
  importance: number;
  confidence: number;
  emotionalValence: number;
  tags: string[];
  sensitivity: SensitivityLevel;
}

interface NormalizedSleeptimePlan {
  orient: {
    persona: string;
    human: string;
    goals: string;
  };
  memoryWrites: NormalizedMemoryWrite[];
}

export interface SleeptimeMemoryAgentOptions {
  llmProvider: LLMProviderPort;
  sessionManager: SessionMemoryReader;
  coreMemoryStore: CoreMemoryRewriter;
  memoryWriter: SleeptimeMemoryWriter;
  cadenceTurns?: number;
  transcriptMessageLimit?: number;
  maxMemoryWrites?: number;
  restWindow?: EpisodicProcessingRestWindowConfig;
  episodicSynthesizer?: SleeptimeEpisodicSynthesizer | null;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function clampUnit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(-1, Math.min(1, value));
}

function normalizeText(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('Sleeptime plan contains non-string text field');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Sleeptime plan contains empty text field');
  }
  return trimmed;
}

function normalizeMemoryType(raw: unknown): MemoryType {
  if (typeof raw !== 'string') {
    throw new Error('Sleeptime memory write type must be a string');
  }
  const normalized = raw.trim() as MemoryType;
  if (!VALID_MEMORY_TYPES.includes(normalized)) {
    throw new Error(`Sleeptime memory write type "${raw}" is invalid`);
  }
  return normalized;
}

function normalizeSensitivity(raw: unknown): SensitivityLevel {
  if (typeof raw !== 'string') return 'personal';
  const normalized = raw.trim() as SensitivityLevel;
  if (!VALID_SENSITIVITY_LEVELS.includes(normalized)) {
    return 'personal';
  }
  return normalized;
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().toLowerCase();
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out];
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Sleeptime model returned empty output');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      return candidate;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Sleeptime model did not return a JSON object');
}

function normalizeSleeptimePlan(raw: string, maxMemoryWrites: number): NormalizedSleeptimePlan {
  const parsed = JSON.parse(extractJsonPayload(raw)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sleeptime plan must be a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  const orientRaw = record['orient'];
  if (!orientRaw || typeof orientRaw !== 'object' || Array.isArray(orientRaw)) {
    throw new Error('Sleeptime plan is missing orient object');
  }

  const orientRecord = orientRaw as Record<string, unknown>;
  const orient = {
    persona: normalizeText(orientRecord['persona']),
    human: normalizeText(orientRecord['human']),
    goals: normalizeText(orientRecord['goals']),
  };

  const memoryWritesRaw = Array.isArray(record['memory_writes'])
    ? record['memory_writes']
    : [];
  const memoryWrites: NormalizedMemoryWrite[] = [];

  for (const rawWrite of memoryWritesRaw) {
    if (!rawWrite || typeof rawWrite !== 'object' || Array.isArray(rawWrite)) {
      continue;
    }
    const writeRecord = rawWrite as Record<string, unknown>;
    memoryWrites.push({
      text: normalizeText(writeRecord['text']),
      type: normalizeMemoryType(writeRecord['type']),
      importance: clampUnit(writeRecord['importance'], 0.65),
      confidence: clampUnit(writeRecord['confidence'], 0.75),
      emotionalValence: clampSigned(writeRecord['emotionalValence'], 0),
      tags: normalizeTags(writeRecord['tags']),
      sensitivity: normalizeSensitivity(writeRecord['sensitivity']),
    });
    if (memoryWrites.length >= maxMemoryWrites) {
      break;
    }
  }

  return {
    orient,
    memoryWrites,
  };
}

function summarizeSessionEntry(entry: SessionEntry): string {
  const rolePrefix = entry.role === 'assistant'
    ? 'ASSISTANT'
    : entry.role === 'user'
      ? 'USER'
      : entry.role.toUpperCase();
  const collapsed = entry.content.replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > MAX_TRANSCRIPT_ENTRY_CHARS
    ? `${collapsed.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS)}...`
    : collapsed;
  return `${rolePrefix}: ${clipped || '[empty]'}`;
}

function summarizeEpisodicSynthesis(result: EpisodicSynthesisRunResult): {
  episodicCandidateEpisodes: number;
  episodicCreatedEpisodes: number;
  episodicSkippedEpisodes: number;
  episodicLinkedArcs: number;
} {
  return {
    episodicCandidateEpisodes: result.candidateEpisodeCount,
    episodicCreatedEpisodes: result.createdEpisodes.length,
    episodicSkippedEpisodes: result.skippedEpisodeIds.length,
    episodicLinkedArcs: result.linkedArcs.length,
  };
}

export class SleeptimeMemoryAgent {
  private readonly llmProvider: LLMProviderPort;
  private readonly sessionManager: SessionMemoryReader;
  private readonly coreMemoryStore: CoreMemoryRewriter;
  private readonly memoryWriter: SleeptimeMemoryWriter;
  private readonly cadenceTurns: number;
  private readonly transcriptMessageLimit: number;
  private readonly maxMemoryWrites: number;
  private readonly restWindow?: EpisodicProcessingRestWindowConfig;
  private readonly episodicSynthesizer: SleeptimeEpisodicSynthesizer | null;
  private readonly turnCountBySession = new Map<string, number>();

  constructor(options: SleeptimeMemoryAgentOptions) {
    this.llmProvider = options.llmProvider;
    this.sessionManager = options.sessionManager;
    this.coreMemoryStore = options.coreMemoryStore;
    this.memoryWriter = options.memoryWriter;
    this.cadenceTurns = normalizePositiveInteger(options.cadenceTurns, DEFAULT_CADENCE_TURNS);
    this.transcriptMessageLimit = normalizePositiveInteger(
      options.transcriptMessageLimit,
      DEFAULT_TRANSCRIPT_MESSAGE_LIMIT,
    );
    this.maxMemoryWrites = normalizePositiveInteger(
      options.maxMemoryWrites,
      DEFAULT_MAX_MEMORY_WRITES,
    );
    this.restWindow = options.restWindow;
    this.episodicSynthesizer = options.episodicSynthesizer ?? null;
  }

  inferPostTurnActions(input: {
    message: Pick<SubstrateMessage, 'id' | 'channelId'> & { timestamp?: Date };
  }): PostTurnActionCandidate[] {
    const candidate = this.inferPostTurnAction(input.message);
    return candidate ? [candidate] : [];
  }

  inferPostTurnAction(
    message: Pick<SubstrateMessage, 'id' | 'channelId'> & { timestamp?: Date },
  ): PostTurnActionCandidate | null {
    if (message.channelId.startsWith('internal:')) {
      return null;
    }

    const sessionId = this.sessionManager.resolveSessionChannelId(message.channelId);
    const nextCount = (this.turnCountBySession.get(sessionId) ?? 0) + 1;
    this.turnCountBySession.set(sessionId, nextCount);
    if (nextCount % this.cadenceTurns !== 0) {
      return null;
    }

    const lastUserActivityAtMs = message.timestamp instanceof Date
      ? message.timestamp.getTime()
      : Date.now();
    const restWindowDecision = this.restWindow
      ? evaluateRestWindowEligibility({
        config: this.restWindow,
        nowMs: lastUserActivityAtMs,
        lastUserActivityAtMs,
      })
      : null;

    return {
      kind: SLEEPTIME_MEMORY_ACTION_KIND,
      payload: {
        sessionId,
        sourceChannelId: message.channelId,
        cadenceTurn: nextCount,
        lastUserActivityAtMs,
      },
      dedupeKey: `${SLEEPTIME_MEMORY_ACTION_KIND}:${sessionId}`,
      maxRetries: 1,
      ...(restWindowDecision?.nextEligibleAtMs !== undefined
        ? { runAt: restWindowDecision.nextEligibleAtMs }
        : {}),
    };
  }

  async execute(action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>): Promise<void> {
    const sessionId = this.resolveActionSessionId(action);
    const restWindowDecision = this.restWindow
      ? evaluateRestWindowEligibility({
        config: this.restWindow,
        lastUserActivityAtMs: this.resolveActionLastUserActivityAtMs(action),
      })
      : null;
    if (restWindowDecision && !restWindowDecision.allowed) {
      log.info('Skipping sleeptime run outside rest-window eligibility', {
        sessionId,
        actionId: action.id,
        reasonCode: restWindowDecision.reasonCode,
        nextEligibleAtMs: restWindowDecision.nextEligibleAtMs,
        inactiveForMs: restWindowDecision.inactiveForMs,
        requiredInactiveMs: restWindowDecision.requiredInactiveMs,
        timeZone: restWindowDecision.timeZone,
      });
      return;
    }

    const recentEntries = this.sessionManager
      .getRecentMessages(sessionId, this.transcriptMessageLimit)
      .filter(entry => entry.role === 'user' || entry.role === 'assistant');
    if (recentEntries.length === 0) {
      log.debug('Skipping sleeptime run: no recent conversational transcript', {
        sessionId,
        actionId: action.id,
      });
      return;
    }

    const episodicSynthesis = this.episodicSynthesizer
      ? await this.episodicSynthesizer.run({
        sessionId,
        sourceMessageId: action.sourceMessageId,
      })
      : null;

    const currentSnapshot = this.coreMemoryStore.getSnapshot();
    const transcript = recentEntries.map(summarizeSessionEntry).join('\n');
    const requestPrompt = [
      'Current orientation blocks:',
      `persona:\n${currentSnapshot.blocks.persona.content || '[empty]'}`,
      `human:\n${currentSnapshot.blocks.human.content || '[empty]'}`,
      `goals:\n${currentSnapshot.blocks.goals.content || '[empty]'}`,
      '',
      'Recent transcript:',
      transcript,
      '',
      `Return strict JSON with keys "orient" and "memory_writes" (max ${this.maxMemoryWrites}).`,
    ].join('\n');

    const response = await this.llmProvider.complete(
      {
        systemPrompt: [
          'You are a sleeptime orientation maintainer.',
          'Reorient the active persona, human, and goals blocks using only grounded transcript evidence.',
          'Propose optional durable memory writes for the long-term memory store.',
          'Never invent facts. Keep orientation concise, stable, and action-guiding.',
          'Respond with JSON only:',
          '{',
          '  "orient": { "persona": "...", "human": "...", "goals": "..." },',
          '  "memory_writes": [',
          '    {',
          '      "text": "...",',
          '      "type": "semantic|episodic|emotional|procedural|boundary|reflection|relational",',
          '      "importance": 0.0,',
          '      "confidence": 0.0,',
          '      "emotionalValence": 0.0,',
          '      "tags": ["..."],',
          '      "sensitivity": "public|personal|intimate|confidential"',
          '    }',
          '  ]',
          '}',
        ].join('\n'),
        messages: [{ role: 'user', content: requestPrompt }],
        correlation: {
          requestId: `sleeptime:${sessionId}:${action.id}`,
          channelId: action.channelId,
          callType: 'memory',
          purpose: 'memory.sleeptime.plan',
          originType: 'memory',
          originStage: 'memory.sleeptime.plan',
        },
      },
      'memory',
    );
    const plan = normalizeSleeptimePlan(response.content, this.maxMemoryWrites);

    this.coreMemoryStore.rethink({
      persona: plan.orient.persona,
      human: plan.orient.human,
      goals: plan.orient.goals,
    });

    let writtenCount = 0;
    for (const memory of plan.memoryWrites) {
      const writePayload: MemoryWriteOptions = {
        text: memory.text,
        type: memory.type,
        importance: memory.importance,
        confidence: memory.confidence,
        emotionalValence: memory.emotionalValence,
        sensitivity: memory.sensitivity,
        sourceRef: `source:sleeptime|session:${sessionId}|message:${action.sourceMessageId}`,
        tags: [...memory.tags, 'sleeptime'],
      };
      try {
        await this.memoryWriter.write(writePayload);
        writtenCount += 1;
      } catch (error) {
        log.warn('Sleeptime memory write skipped after error', {
          sessionId,
          actionId: action.id,
          type: memory.type,
          error: String(error),
        });
      }
    }

    log.info('Sleeptime memory run complete', {
      sessionId,
      actionId: action.id,
      sourceMessageId: action.sourceMessageId,
      transcriptEntries: recentEntries.length,
      memoryWritesRequested: plan.memoryWrites.length,
      memoryWritesSucceeded: writtenCount,
      ...(episodicSynthesis ? summarizeEpisodicSynthesis(episodicSynthesis) : {}),
    });
  }

  private resolveActionSessionId(action: Pick<InferredPostTurnAction, 'channelId' | 'payload'>): string {
    const payloadSession = action.payload['sessionId'];
    if (typeof payloadSession === 'string' && payloadSession.trim().length > 0) {
      return payloadSession.trim();
    }
    return this.sessionManager.resolveSessionChannelId(action.channelId);
  }

  private resolveActionLastUserActivityAtMs(action: Pick<InferredPostTurnAction, 'payload'>): number | undefined {
    const value = action.payload['lastUserActivityAtMs'];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    return undefined;
  }
}
