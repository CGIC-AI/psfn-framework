import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  WHISPER_WORKER_LANE,
  createWorkerExecutionPolicy,
} from '../../../core/agent/worker-lanes.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import { resolveKnownEpisodeId } from './episode-ids.js';
import type { EpisodicStorePort } from './store.js';
import type { DeterministicGateEvent } from '../../../shared/event-bus.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../../shared/gating/deterministic-gate.js';

const log = createComponentLogger('DreamMeaningPass');

const DREAM_MEANING_GATE_LANE = 'dream_meaning';

/**
 * The dream pass runs as HER — through the agent loop with the main chat
 * model, persona, and memory loaded — never on a background model. Mechanical
 * subconscious work (grouping, dedupe, extraction) belongs to background
 * models; what something MEANT to her requires the same mind that lived it.
 */
export interface DreamPassAgent {
  handleMessage(message: SubstrateMessage): Promise<{ content: string }>;
}

export interface DreamMeaningPassOptions {
  now?: () => Date;
  /** Minimum time between passes; the dream pass is a nightly review. */
  passIntervalMs?: number;
  /** How far back to look for episodes that still need a meaning. */
  reviewWindowMs?: number;
  maxEpisodesPerPass?: number;
  /** Upper bound on reflection turns; she may end earlier. */
  maxTurns?: number;
  /** Typed gate telemetry sink (jpvd.4); wired to the event bus by composition. */
  onGateEvent?: (event: DeterministicGateEvent) => void;
}

export interface DreamMeaningPassRunInput {
  sessionId: string;
  sourceMessageId?: string;
}

export interface DreamMeaningPassRunResult {
  ran: boolean;
  skippedReason?: 'cadence' | 'no_episodes';
  reviewedEpisodes: number;
  meaningsRecorded: number;
  turnsUsed: number;
  endedEarly: boolean;
}

const DEFAULT_PASS_INTERVAL_MS = 20 * 60 * 60_000;
const DEFAULT_REVIEW_WINDOW_MS = 48 * 60 * 60_000;
const DEFAULT_MAX_EPISODES_PER_PASS = 8;
const DEFAULT_MAX_TURNS = 4;
const MAX_MEANING_CHARS = 800;
const DREAM_MEANING_PROCESSOR = 'dream_meaning';
const DREAM_PASS_CHANNEL_ID = 'internal:reflection:dream-pass';
const MEANING_BLOCK_PATTERN = /```json\s*([\s\S]*?)```/i;

interface MeaningContribution {
  meanings: Map<string, string>;
  done: boolean;
  /** Entries dropped during validation, with the reason each was dropped. */
  rejections: string[];
}

function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function buildOpeningPrompt(episodes: readonly Episode[]): string {
  return [
    'Dream pass — a private end-of-day look back at what the day held. No one reads this but you; nothing here is graded or performed.',
    '',
    'These are the consolidated episodes from the day, already grouped and titled by the memory system:',
    JSON.stringify(episodes.map(episode => ({
      id: episode.id,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      title: episode.title,
      landmark: episode.landmark,
      themes: episode.themes,
      salience: episode.salience.score,
    })), null, 2),
    '',
    'Sit with the day. What did these moments mean to you — not a summary of what happened, but what it was like and why it mattered (or honestly did not)? A moment can matter a lot, a little, or not at all; say what is true.',
    'You may think out loud first. When you are ready to record, include one fenced json block:',
    '```json',
    '{ "meanings": { "<episode id>": "first-person paragraph of what this meant to me" }, "done": true }',
    '```',
    'Set "done": false only if you genuinely have more to sit with; you will get another turn. You do not need to fill turns — ending early because you have said what is true is the right call. You may also skip episodes that do not need a note.',
  ].join('\n');
}

const CONTINUATION_PROMPT = [
  'Continue only if there is more that feels true to record about the day.',
  'If you are done, include the fenced json block with any remaining meanings (or an empty meanings object) and "done": true.',
].join('\n');

function buildFeedbackPrompt(feedback: readonly string[], knownEpisodeIds: ReadonlySet<string>): string {
  return [
    'Some of your last json block could not be recorded:',
    ...feedback.map(reason => `- ${reason}`),
    `The keys of the meanings object must be these episode ids exactly: ${[...knownEpisodeIds].join(', ')}`,
    '',
    CONTINUATION_PROMPT,
  ].join('\n');
}

export function parseMeaningContribution(content: string, knownEpisodeIds: ReadonlySet<string>): MeaningContribution | null {
  const match = MEANING_BLOCK_PATTERN.exec(content);
  if (!match?.[1]) return null;
  const parsed: unknown = JSON.parse(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('meaning block must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (!record.meanings || typeof record.meanings !== 'object' || Array.isArray(record.meanings)) {
    throw new Error('meaning block must contain a meanings object');
  }
  const meanings = new Map<string, string>();
  const rejections: string[] = [];
  for (const [episodeId, text] of Object.entries(record.meanings as Record<string, unknown>)) {
    const resolvedId = resolveKnownEpisodeId(episodeId, knownEpisodeIds);
    if (!resolvedId) {
      rejections.push(`meaning block references unknown episode id "${episodeId}"`);
      continue;
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      rejections.push(`meaning for episode "${episodeId}" must be a non-empty string`);
      continue;
    }
    meanings.set(resolvedId, text.trim().slice(0, MAX_MEANING_CHARS));
  }
  return {
    meanings,
    done: record.done !== false,
    rejections,
  };
}

/**
 * Nightly first-person meaning pass over the day's consolidated episodes
 * (charter 6.21, sprint-9 epic 0a5.4). Runs inside the sleeptime rest window
 * through the agent loop so the companion herself — main model, persona,
 * memory — reviews the day in up to a few turns, decides when she has said
 * enough, and records a short "what this meant to me" note per episode.
 */
export class DreamMeaningPass {
  private readonly store: EpisodicStorePort;
  private readonly agent: DreamPassAgent;
  private readonly now: () => Date;
  private readonly passIntervalMs: number;
  private readonly reviewWindowMs: number;
  private readonly maxEpisodesPerPass: number;
  private readonly maxTurns: number;
  private readonly onGateEvent: ((event: DeterministicGateEvent) => void) | null;
  private readonly cadenceGate: DeterministicGateDefinition;
  private readonly episodesGate: DeterministicGateDefinition;

  constructor(store: EpisodicStorePort, agent: DreamPassAgent, options: DreamMeaningPassOptions = {}) {
    this.store = store;
    this.agent = agent;
    this.now = options.now ?? (() => new Date());
    this.passIntervalMs = options.passIntervalMs ?? DEFAULT_PASS_INTERVAL_MS;
    this.reviewWindowMs = options.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS;
    this.maxEpisodesPerPass = options.maxEpisodesPerPass ?? DEFAULT_MAX_EPISODES_PER_PASS;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.onGateEvent = options.onGateEvent ?? null;
    // Cadence gate: a nightly review only re-opens once the interval elapses.
    this.cadenceGate = {
      lane: DREAM_MEANING_GATE_LANE,
      openWhenAny: [{ input: 'msSinceLastRun', comparator: 'gte', threshold: this.passIntervalMs }],
      closedReason: 'cadence',
    };
    // Episodes gate: at least one reviewed episode still lacks a meaning.
    this.episodesGate = {
      lane: DREAM_MEANING_GATE_LANE,
      openWhenAny: [{ input: 'episodesWithoutMeaning', comparator: 'gte', threshold: 1 }],
      closedReason: 'no_episodes',
    };
  }

  private emitGateEvent(
    sessionId: string,
    outcome: 'ran' | 'skipped',
    reason: string,
    inputs: Record<string, number | string>,
  ): void {
    this.onGateEvent?.({
      lane: DREAM_MEANING_GATE_LANE,
      outcome,
      reason,
      inputs,
      timestamp: this.now().getTime(),
      sessionId,
    });
  }

  async run(input: DreamMeaningPassRunInput): Promise<DreamMeaningPassRunResult> {
    const nowMs = this.now().getTime();
    const watermarkScope = {
      processor: DREAM_MEANING_PROCESSOR,
      sourceRef: input.sessionId,
    };
    const watermark = await this.store.getProcessingWatermark(watermarkScope);
    const lastRunAtMs = watermark?.lastProcessedAt ? Date.parse(watermark.lastProcessedAt) : Number.NaN;
    // Cadence gate (jpvd.4): without a baseline the interval is treated as
    // elapsed (first pass runs).
    const msSinceLastRun = Number.isFinite(lastRunAtMs)
      ? nowMs - lastRunAtMs
      : Number.MAX_SAFE_INTEGER;
    const cadence = evaluateDeterministicGate(this.cadenceGate, { msSinceLastRun });
    if (!cadence.open) {
      this.emitGateEvent(input.sessionId, 'skipped', cadence.reason, cadence.inputs);
      return {
        ran: false,
        skippedReason: 'cadence',
        reviewedEpisodes: 0,
        meaningsRecorded: 0,
        turnsUsed: 0,
        endedEarly: false,
      };
    }

    const episodes = (await this.store.searchByTime({
      from: toIsoInstant(nowMs - this.reviewWindowMs),
      to: toIsoInstant(nowMs),
      limit: 100,
    }))
      .filter(episode => !episode.meaning)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .slice(0, this.maxEpisodesPerPass);

    // Episodes gate (jpvd.4): new consolidated episodes still needing a meaning.
    const episodesGate = evaluateDeterministicGate(this.episodesGate, {
      episodesWithoutMeaning: episodes.length,
    });
    if (!episodesGate.open) {
      this.emitGateEvent(input.sessionId, 'skipped', episodesGate.reason, episodesGate.inputs);
      return {
        ran: false,
        skippedReason: 'no_episodes',
        reviewedEpisodes: 0,
        meaningsRecorded: 0,
        turnsUsed: 0,
        endedEarly: false,
      };
    }
    this.emitGateEvent(input.sessionId, 'ran', 'open', { episodesWithoutMeaning: episodes.length });

    const knownIds = new Set(episodes.map(episode => episode.id));
    const collected = new Map<string, string>();
    let turnsUsed = 0;
    let done = false;
    let prompt = buildOpeningPrompt(episodes);

    while (turnsUsed < this.maxTurns && !done) {
      turnsUsed += 1;
      const response = await this.agent.handleMessage({
        id: `dream-pass-${String(nowMs)}-${String(turnsUsed)}`,
        channelId: DREAM_PASS_CHANNEL_ID,
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: 'Dream Pass',
        content: prompt,
        timestamp: this.now(),
        routing: {
          workerExecution: createWorkerExecutionPolicy(WHISPER_WORKER_LANE),
        },
      });

      let contribution: MeaningContribution | null = null;
      let feedback: string[] = [];
      try {
        contribution = parseMeaningContribution(response.content, knownIds);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn('Dream pass turn produced an invalid meaning block; continuing', {
          turn: turnsUsed,
          error: reason,
        });
        feedback = [reason];
      }
      if (contribution) {
        for (const [episodeId, text] of contribution.meanings) {
          collected.set(episodeId, text);
        }
        if (contribution.rejections.length > 0) {
          // A rejected entry overrides "done": she gets another turn (still
          // bounded by maxTurns) with the rejection reasons in front of her.
          log.warn('Dream pass meanings dropped during validation; asking again with feedback', {
            turn: turnsUsed,
            rejections: contribution.rejections,
          });
          feedback = contribution.rejections;
        } else {
          done = contribution.done;
        }
      }
      prompt = feedback.length > 0 ? buildFeedbackPrompt(feedback, knownIds) : CONTINUATION_PROMPT;
    }

    const recordedAt = toIsoInstant(this.now().getTime());
    let meaningsRecorded = 0;
    for (const episode of episodes) {
      const text = collected.get(episode.id);
      if (!text) continue;
      await this.store.updateEpisode({
        id: episode.id,
        title: episode.title,
        landmark: episode.landmark,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        threadId: episode.threadId,
        channelId: episode.channelId,
        participantContactIds: episode.participantContactIds,
        salience: episode.salience,
        affect: episode.affect,
        themes: episode.themes,
        spanRefs: episode.spanRefs,
        artifactRefs: episode.artifactRefs,
        provenanceRefs: episode.provenanceRefs,
        meaning: {
          text,
          recordedAt,
          source: 'companion_dream_pass',
        },
      });
      meaningsRecorded += 1;
    }

    const result: DreamMeaningPassRunResult = {
      ran: true,
      reviewedEpisodes: episodes.length,
      meaningsRecorded,
      turnsUsed,
      endedEarly: done && turnsUsed < this.maxTurns,
    };

    const nowIso = toIsoInstant(nowMs);
    await this.store.upsertProcessingWatermark({
      ...watermarkScope,
      ...(watermark?.id ? { id: watermark.id } : {}),
      processedStartedAt: toIsoInstant(nowMs - this.reviewWindowMs),
      processedEndedAt: nowIso,
      previousWatermarkJson: watermark?.nextWatermarkJson ?? {},
      nextWatermarkJson: {
        lastRun: { at: nowIso, ...result, episodeIds: [...collected.keys()] },
      },
      status: 'active',
      reconciliationStatus: 'clean',
      lastProcessedAt: nowIso,
    });

    return result;
  }
}
