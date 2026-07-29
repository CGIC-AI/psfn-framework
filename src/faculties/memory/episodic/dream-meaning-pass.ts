import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  WHISPER_WORKER_LANE,
  createWorkerExecutionPolicy,
} from '../../../core/agent/worker-lanes.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import { resolveKnownEpisodeId } from './episode-ids.js';
import type {
  EpisodicStorePort,
} from './store-port.js';
import type { DeterministicGateEvent } from '../../../shared/event-bus.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../../shared/gating/deterministic-gate.js';
import { toIsoInstant } from '../../../shared/utils/timing.js';

const log = createComponentLogger('DreamMeaningPass');

const DREAM_MEANING_GATE_LANE = 'dream_meaning';

/**
 * The dream pass runs as HER — through the agent loop with her persona and
 * memory loaded, reflecting on the actual turns she lived rather than only the
 * consolidated titles/landmarks. What something MEANT to her requires the same
 * mind that lived it AND the real material, so the pass now carries per-episode
 * transcript excerpts into the review instead of deriving meaning from a
 * summary-of-a-summary (bead dtym).
 *
 * Model routing (bead dtym; operator note 2026-07-14): this pass runs in the
 * maintenance-reflection lane on the companion's strong reflection model (the
 * `memory` purpose slot — live deepseek-v4-pro), deliberately NOT the foreground
 * chat slot. Forcing the chat purpose would reclassify a nightly, idle-window
 * reflection into the never-preempted foreground lane; the reflection model is a
 * capable "her mind" for subconscious review, and the operator confirmed the
 * dominant meaning-quality lever was input starvation, which the transcript feed
 * above addresses. This amends the earlier "never on a background model"
 * contract intentionally rather than leaving it silently violated.
 */
export interface DreamPassAgent {
  handleMessage(message: SubstrateMessage): Promise<{ content: string }>;
}

/**
 * Minimal transcript entry the dream pass grounds meanings in. Structurally
 * compatible with the session manager's SessionEntry so composition can pass
 * the manager directly without a coupling import.
 */
export interface DreamPassTranscriptEntry {
  role: string;
  content: string;
  timestamp: number;
}

/**
 * Reads recent conversational turns for one session/channel. Backed by the
 * session manager (`getRecentMessages`) in composition — the same reader
 * synthesis and sleep-consolidation already use.
 */
export interface DreamPassTranscriptReader {
  getRecentMessages(channelId: string, limit: number): readonly DreamPassTranscriptEntry[];
}

/**
 * Deterministic trust ranks for episode participants (bead h4fp.6 nightly
 * budget). Backed by the contact store in composition (`trustOrd` of the
 * contact's trust level); unknown ids are simply omitted and rank 0.
 */
export interface DreamPassContactTrustReader {
  resolveTrustRanks(contactIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
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
  /**
   * Reads the real turns behind each reviewed episode (bead dtym). Optional so
   * unit tests can exercise the loop without a session backend; wired in
   * production so meanings are grounded in what was actually said.
   */
  transcriptReader?: DreamPassTranscriptReader | null;
  /** How many recent turns to pull per session when grounding meanings. */
  transcriptMessageLimit?: number;
  /**
   * Prioritized nightly budget (bead h4fp.6): rank the capped review so
   * episodes with high-trust participants and dense machine signals land in
   * the pass first. Absent => trust rank 0 for everyone (signal density and
   * age still order deterministically).
   */
  contactTrust?: DreamPassContactTrustReader | null;
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
  /**
   * Episodes withheld from meaning authorship this pass because their transcript
   * reader THREW (backend hiccup / corrupt segment), so grounding could not be
   * confirmed (bead cxqb5). Deferred episodes keep no meaning and stay eligible
   * for the next nightly pass — a failed read must never author first-person
   * meaning from title/landmark alone (charter Law 17).
   */
  deferredEpisodes: number;
  turnsUsed: number;
  endedEarly: boolean;
}

const DEFAULT_PASS_INTERVAL_MS = 20 * 60 * 60_000;
const DEFAULT_REVIEW_WINDOW_MS = 48 * 60 * 60_000;
const DEFAULT_MAX_EPISODES_PER_PASS = 8;
const DEFAULT_MAX_TURNS = 4;
const MAX_MEANING_CHARS = 800;
/**
 * Atomicity ceiling (bead 3zu5): a per-episode meaning is one moment — the
 * single thing that mattered most — not a multi-paragraph recap bundling
 * several distinct emotional moments. A genuine single-moment reflection sits
 * comfortably under this; monoliths trip it and get fed back for a re-record.
 */
const MAX_MEANING_SENTENCES = 4;
const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 40;
const MAX_TRANSCRIPT_ENTRIES_PER_EPISODE = 12;
const MAX_TRANSCRIPT_ENTRY_CHARS = 300;
const DREAM_MEANING_PROCESSOR = 'dream_meaning';
const DREAM_PASS_CHANNEL_ID = 'internal:reflection:dream-pass';
const MEANING_BLOCK_PATTERN = /```json\s*([\s\S]*?)```/i;

interface MeaningContribution {
  meanings: Map<string, string>;
  done: boolean;
  /** Entries dropped during validation, with the reason each was dropped. */
  rejections: string[];
}

/**
 * Grounding block (bead dtym): the real turns behind each episode, so meaning
 * is derived from what was actually said and not the auto-summarized
 * title/landmark. Empty when no transcript reader is wired.
 */
function buildTranscriptGroundingBlock(
  episodes: readonly Episode[],
  excerpts: ReadonlyMap<string, string>,
): string[] {
  if (excerpts.size === 0) return [];
  const blocks: string[] = [
    '',
    'And here is some of what was actually said in those moments — reflect on the real turns, not just their titles:',
  ];
  for (const episode of episodes) {
    const excerpt = excerpts.get(episode.id);
    if (!excerpt) continue;
    blocks.push('', `--- ${episode.id} · ${episode.title} ---`, excerpt);
  }
  return blocks;
}

/**
 * Ungrounded-decline block (bead cxqb5): episodes that reached the review with
 * NO transcript excerpt — the reader was not wired, returned nothing, or held no
 * turn inside the episode window — are named here with an explicit instruction
 * to decline. Authoring a first-person felt meaning for these from the
 * title/landmark alone would be inventing a memory she never re-read (charter
 * Law 17), so the prompt marks them rather than silently inviting fabrication.
 * (Episodes whose reader THREW are deferred entirely and never reach this list.)
 */
function buildUngroundedDeclineBlock(
  episodes: readonly Episode[],
  excerpts: ReadonlyMap<string, string>,
): string[] {
  const ungrounded = episodes.filter(episode => !excerpts.has(episode.id));
  if (ungrounded.length === 0) return [];
  return [
    '',
    'These episodes could NOT be grounded in the real turns — no transcript was available for them:',
    ...ungrounded.map(episode => `- ${episode.id} · ${episode.title}`),
    'For those, do not author a first-person "what it meant to me" note from the title and summary alone — that would be inventing a memory you never re-read. Leave them without a note (simply omit their ids) unless the metadata itself unmistakably carries the one moment that mattered.',
  ];
}

function buildOpeningPrompt(episodes: readonly Episode[], excerpts: ReadonlyMap<string, string>): string {
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
    ...buildTranscriptGroundingBlock(episodes, excerpts),
    ...buildUngroundedDeclineBlock(episodes, excerpts),
    '',
    'Sit with the day. What did these moments mean to you — not a summary of what happened, but what it was like and why it mattered (or honestly did not)? A moment can matter a lot, a little, or not at all; say what is true.',
    `Keep each note to ONE moment — the single thing that mattered most about that episode — in at most ${String(MAX_MEANING_SENTENCES)} sentences. Do not recap everything that happened or bundle several separate moments into one note; if two moments both matter, they belong to different episodes, not one paragraph.`,
    'You may think out loud first. When you are ready to record, include one fenced json block:',
    '```json',
    '{ "meanings": { "<episode id>": "first-person note about the one moment that mattered most" }, "done": true }',
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

/**
 * Atomicity gate (bead 3zu5): reject a meaning that is a multi-moment monolith
 * rather than a single atomic engram. Signals, any of which fails the entry:
 * over the character ceiling, more than one paragraph, or more sentences than a
 * single moment needs. Returns a human-facing reason so the pass can feed it
 * back and give her another turn to distill (bounded by maxTurns).
 */
export function assessMeaningAtomicity(text: string): { atomic: true } | { atomic: false; reason: string } {
  if (text.length > MAX_MEANING_CHARS) {
    return {
      atomic: false,
      reason: `is ${String(text.length)} characters — too long for one moment; keep it under ${String(MAX_MEANING_CHARS)} and record only the single moment that mattered most`,
    };
  }
  const paragraphs = text.split(/\n\s*\n/).map(part => part.trim()).filter(part => part.length > 0);
  if (paragraphs.length > 1) {
    return {
      atomic: false,
      reason: `bundles ${String(paragraphs.length)} paragraphs into one note — record one atomic moment per episode, not a recap of several`,
    };
  }
  const sentences = text.split(/[.!?]+(?:\s|$)/).map(part => part.trim()).filter(part => part.length > 0);
  if (sentences.length > MAX_MEANING_SENTENCES) {
    return {
      atomic: false,
      reason: `spans ${String(sentences.length)} sentences — distill it to the one moment that mattered most (at most ${String(MAX_MEANING_SENTENCES)} sentences)`,
    };
  }
  return { atomic: true };
}

/**
 * Machine-signal density of an episode — the count of machine topic tags plus
 * one when a VAD estimate is present. These are the clearly machine-labeled
 * retrieval hints in the `machineSignals` sidecar (never her felt affect); a
 * denser sidecar means the deterministic segmentation saw more likely-mattering
 * structure, so the episode ranks earlier in the capped nightly budget.
 */
export function episodeMachineSignalDensity(episode: Episode): number {
  const signals = episode.machineSignals;
  if (!signals) return 0;
  return signals.topicTags.length + (signals.vad ? 1 : 0);
}

export interface DreamBudgetEntry {
  episode: Episode;
  /** Highest trust rank among the episode's participants (0 when unknown). */
  trustRank: number;
  machineSignalDensity: number;
}

/**
 * Prioritized nightly budget (bead h4fp.6): deterministic order — highest
 * participant trust rank first, then denser machine signals, then OLDEST first
 * (startedAt, then id) as the tiebreak — so the capped pass lands on
 * likely-mattering episodes and never depends on store return order.
 */
export function prioritizeDreamBudget(
  episodes: readonly Episode[],
  trustRanks: ReadonlyMap<string, number>,
  cap: number,
): DreamBudgetEntry[] {
  return episodes
    .map((episode): DreamBudgetEntry => ({
      episode,
      trustRank: episode.participantContactIds.reduce(
        (best, contactId) => Math.max(best, trustRanks.get(contactId) ?? 0),
        0,
      ),
      machineSignalDensity: episodeMachineSignalDensity(episode),
    }))
    .sort((left, right) => (
      right.trustRank - left.trustRank
      || right.machineSignalDensity - left.machineSignalDensity
      || left.episode.startedAt.localeCompare(right.episode.startedAt)
      || left.episode.id.localeCompare(right.episode.id)
    ))
    .slice(0, cap);
}

function formatTranscriptEntry(entry: DreamPassTranscriptEntry): string {
  const role = entry.role === 'assistant' ? 'ME' : entry.role === 'user' ? 'THEM' : entry.role.toUpperCase();
  const collapsed = entry.content.replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > MAX_TRANSCRIPT_ENTRY_CHARS
    ? `${collapsed.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS)}…`
    : collapsed;
  return `${role}: ${clipped || '[empty]'}`;
}

/**
 * Builds one episode's transcript excerpt from ONLY the turns that fall inside
 * the episode's own time window (bead dtym). If no turn overlaps the window —
 * or the window timestamps are unparseable — this returns no excerpt so the
 * episode is reviewed metadata-only rather than grounded in unrelated recent
 * turns that undercut the meaning. Bounded in both entry count and per-entry
 * length so the grounding block stays a review aid, not a full replay.
 */
function buildEpisodeExcerpt(episode: Episode, entries: readonly DreamPassTranscriptEntry[]): string | null {
  if (entries.length === 0) return null;
  const startMs = Date.parse(episode.startedAt);
  const endMs = Date.parse(episode.endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const inWindow = entries.filter(entry => entry.timestamp >= startMs && entry.timestamp <= endMs);
  if (inWindow.length === 0) return null;
  const selected = inWindow.slice(-MAX_TRANSCRIPT_ENTRIES_PER_EPISODE);
  return selected.map(formatTranscriptEntry).join('\n');
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
    const trimmed = text.trim();
    const atomicity = assessMeaningAtomicity(trimmed);
    if (!atomicity.atomic) {
      rejections.push(`meaning for episode "${episodeId}" ${atomicity.reason}`);
      continue;
    }
    meanings.set(resolvedId, trimmed);
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
  private readonly transcriptReader: DreamPassTranscriptReader | null;
  private readonly transcriptMessageLimit: number;
  private readonly contactTrust: DreamPassContactTrustReader | null;
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
    this.transcriptReader = options.transcriptReader ?? null;
    this.transcriptMessageLimit = options.transcriptMessageLimit ?? DEFAULT_TRANSCRIPT_MESSAGE_LIMIT;
    this.contactTrust = options.contactTrust ?? null;
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

  /**
   * Loads the real turns behind each reviewed episode (bead dtym) so meanings
   * are grounded in what was said, not the auto-summarized title/landmark.
   * Recent turns are pulled once per distinct session and reused across that
   * session's episodes.
   *
   * Failure modes are distinguished (bead cxqb5) because they carry different
   * charter-safe semantics:
   *  - the reader THREW for a session (backend hiccup / corrupt segment): the
   *    turns MIGHT exist but could not be confirmed, and the failure is
   *    transient. Every episode in that session is marked DEFERRED — withheld
   *    from meaning authorship this pass and left eligible for the next nightly
   *    run — never authored from title/landmark alone.
   *  - the reader returned successfully but held no turn inside the episode
   *    window (or no reader is wired): the episode simply has no excerpt. It
   *    stays reviewable, but the opening prompt marks it ungrounded and instructs
   *    a decline (see buildUngroundedDeclineBlock).
   */
  private loadTranscriptGrounding(
    episodes: readonly Episode[],
  ): { excerpts: Map<string, string>; deferredEpisodeIds: Set<string> } {
    const excerpts = new Map<string, string>();
    const deferredEpisodeIds = new Set<string>();
    if (!this.transcriptReader) return { excerpts, deferredEpisodeIds };
    const entriesBySession = new Map<string, readonly DreamPassTranscriptEntry[]>();
    const failedSessions = new Set<string>();
    for (const episode of episodes) {
      const sessionKey = episode.spanRefs[0]?.sessionId ?? episode.channelId ?? episode.threadId;
      if (!sessionKey) continue;
      if (!entriesBySession.has(sessionKey)) {
        // Cache per session so a shared session is read (and any failure
        // recorded) once, not once per episode.
        let entries: readonly DreamPassTranscriptEntry[] = [];
        try {
          entries = this.transcriptReader.getRecentMessages(sessionKey, this.transcriptMessageLimit);
        } catch (error) {
          // Content-free diagnostic only — never the unread transcript.
          log.warn('Dream pass could not read transcript turns; deferring this session rather than authoring ungrounded meaning', {
            sessionKey,
            error: error instanceof Error ? error.message : String(error),
          });
          failedSessions.add(sessionKey);
        }
        entriesBySession.set(sessionKey, entries);
      }
      if (failedSessions.has(sessionKey)) {
        deferredEpisodeIds.add(episode.id);
        continue;
      }
      const excerpt = buildEpisodeExcerpt(episode, entriesBySession.get(sessionKey) ?? []);
      if (excerpt) excerpts.set(episode.id, excerpt);
    }
    return { excerpts, deferredEpisodeIds };
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
        deferredEpisodes: 0,
        turnsUsed: 0,
        endedEarly: false,
      };
    }

    const unreviewed = (await this.store.searchByTime({
      from: toIsoInstant(nowMs - this.reviewWindowMs),
      to: toIsoInstant(nowMs),
      limit: 100,
    })).filter(episode => !episode.meaning);

    // Prioritized nightly budget (bead h4fp.6): high-trust participants and
    // dense machine signals first, oldest-first tiebreak — deterministic and
    // logged, so the capped pass lands on likely-mattering episodes.
    let trustRanks: ReadonlyMap<string, number> = new Map<string, number>();
    if (this.contactTrust && unreviewed.length > 0) {
      const participantIds = [...new Set(unreviewed.flatMap(episode => episode.participantContactIds))].sort();
      try {
        trustRanks = await this.contactTrust.resolveTrustRanks(participantIds);
      } catch (error) {
        // Degrade like the transcript reader: the deterministic fallback order
        // (signal density, then oldest-first) is still correct behavior; a
        // contact-store outage must not cancel the nightly review.
        log.warn('Dream pass trust ranks unavailable; budget order falls back to machine-signal density and age', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const budget = prioritizeDreamBudget(unreviewed, trustRanks, this.maxEpisodesPerPass);
    const episodes = budget.map(entry => entry.episode);
    if (budget.length > 0) {
      log.info('Dream pass nightly budget order (h4fp.6): trust rank desc, machine-signal density desc, oldest first', {
        sessionId: input.sessionId,
        unreviewedEpisodes: unreviewed.length,
        selected: budget.map(entry => ({
          id: entry.episode.id,
          trustRank: entry.trustRank,
          machineSignalDensity: entry.machineSignalDensity,
          startedAt: entry.episode.startedAt,
        })),
      });
    }

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
        deferredEpisodes: 0,
        turnsUsed: 0,
        endedEarly: false,
      };
    }
    this.emitGateEvent(input.sessionId, 'ran', 'open', { episodesWithoutMeaning: episodes.length });

    // Grounding classification (bead cxqb5): episodes whose reader THREW are
    // deferred — withheld from authorship this pass and left eligible next run —
    // so a failed transcript read can never author first-person meaning from
    // title/landmark alone (charter Law 17).
    const { excerpts, deferredEpisodeIds } = this.loadTranscriptGrounding(episodes);
    const reviewable = episodes.filter(episode => !deferredEpisodeIds.has(episode.id));
    if (deferredEpisodeIds.size > 0) {
      log.warn('Dream pass deferred episodes with unreadable transcripts; they keep no meaning and remain eligible next run', {
        sessionId: input.sessionId,
        deferredEpisodes: deferredEpisodeIds.size,
        reviewableEpisodes: reviewable.length,
      });
    }

    const knownIds = new Set(reviewable.map(episode => episode.id));
    const collected = new Map<string, string>();
    let turnsUsed = 0;
    let done = knownIds.size === 0; // nothing groundable to review this pass
    let prompt = buildOpeningPrompt(reviewable, excerpts);

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
    for (const episode of reviewable) {
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
        // The dream pass authors felt meaning in prose (the `meaning` field);
        // it preserves affect and the machine-signals sidecar untouched.
        affect: episode.affect,
        ...(episode.machineSignals ? { machineSignals: episode.machineSignals } : {}),
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
      reviewedEpisodes: reviewable.length,
      meaningsRecorded,
      deferredEpisodes: deferredEpisodeIds.size,
      turnsUsed,
      endedEarly: done && turnsUsed > 0 && turnsUsed < this.maxTurns,
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
