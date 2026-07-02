// ── Sleeptime wiki update pass (E8.2) ──
//
// A nightly (true-sleeptime) pass that runs inside the rest-window sleeptime
// stack, AFTER the day's episodes and memories have settled (consolidation ->
// arcs -> dream). It reviews the day's newly-canonical episodes and notable
// durable memories for durable, NON-PRIVATE world knowledge worth recording in
// the wiki — interests, research results, world/environment details, project
// information — and creates or updates wiki entries through the WikiStore with
// provenance back to the source episodes/memories.
//
// Charter 6.26: the wiki is durable reference knowledge, distinct from
// L0-L2 emotional/episodic memory. Hard boundaries (encoded in BOTH the
// schema-bound prompt and a deterministic post-filter):
//   - Personal facts about a specific person stay in memory, never the wiki
//     (a partner being from a Paris neighborhood is memory; general facts about
//     that neighborhood are wiki).
//   - Repeatable procedures become skills, not wiki entries.
//   - Direct actions are tools.
//
// Deterministic gate (jpvd.4 primitive): the LLM proposal call fires only on
// evidence the day produced wiki-shaped material — enough new canonical
// episodes OR enough new durable (semantic/procedural) memories since the
// watermark. Quiet days short-circuit with ZERO LLM spend. Malformed model
// output fails closed for the run: nothing is written, the watermark is NOT
// advanced (so the same material is reviewed again next night), and a typed
// gate event records the failure.

import { createComponentLogger } from '../../shared/logger.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type { PromptRegistryStatePort } from '../../core/identity/prompt-state-port.js';
import type { PersonaPreamblePort } from '../../core/identity/persona-preamble.js';
import {
  getDefaultPromptText,
  WIKI_PASS_PROMPT_KEY,
} from '../../core/identity/prompt-registry.js';
import type { DeterministicGateEvent } from '../../shared/event-bus.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../shared/gating/deterministic-gate.js';
import type { SleeptimeWikiPassConfig } from '../../system/config/scheduler-config.js';
import { DEFAULT_SLEEPTIME_WIKI_PASS } from '../../system/config/scheduler-config.js';
import type { Episode } from '../../shared/contracts/episodic-memory.js';
import type {
  EpisodicProcessingWatermark,
  EpisodicProcessingWatermarkScope,
  EpisodicProcessingWatermarkWriteInput,
  EpisodeTimeSearchOptions,
} from '../memory/episodic/store.js';
import type { MemoryListOptions } from '../memory/memory-store-port.js';
import type { MemoryType, PurrMemory, SensitivityLevel } from '../memory/types.js';
import type {
  WikiDocument,
  WikiDocumentListEntry,
  WikiDocumentUpsertInput,
  WikiSearchInput,
  WikiSearchResult,
} from './types.js';

const log = createComponentLogger('SleeptimeWikiPass');

export const WIKI_PASS_GATE_LANE = 'wiki_pass';
const WIKI_PASS_PROCESSOR = 'wiki_pass';
const WIKI_PASS_UPDATED_BY = 'sleeptime_wiki_pass';
const HOUR_MS = 60 * 60_000;
const MAX_WIKI_BODY_CHARS = 8_000;

/** Memory types that count as durable/world-shaped material for the gate + content. */
const WORLD_MEMORY_TYPES = new Set<MemoryType>(['semantic', 'procedural']);
/** Memory types that are inherently personal-about-people and must stay in memory. */
const PERSONAL_MEMORY_TYPES = new Set<MemoryType>(['relational', 'emotional']);
/** Sensitivity levels that must never be synthesized into a wiki entry. */
const PERSONAL_SENSITIVITIES = new Set<SensitivityLevel>(['intimate', 'confidential']);
/** Sensitivity levels allowed as world-knowledge source material. */
const WORLD_SENSITIVITIES = new Set<SensitivityLevel>(['public', 'personal']);

// First-person relational markers: a body containing these is a personal fact
// about a person, not general world knowledge — reject it defensively.
const PERSONAL_MARKER_PATTERN =
  /\bmy\s+(partner|wife|husband|spouse|boyfriend|girlfriend|fianc[ée]+|mother|mom|father|dad|sister|brother|son|daughter|friend|parents?|family|ex|kid|child|children)\b/i;

const GUARD_STOP_WORDS = new Set([
  'about', 'after', 'again', 'along', 'also', 'because', 'been', 'before',
  'being', 'between', 'both', 'could', 'does', 'down', 'during', 'each',
  'from', 'have', 'here', 'into', 'just', 'like', 'more', 'most', 'much',
  'need', 'once', 'only', 'other', 'over', 'said', 'same', 'some', 'such',
  'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'time', 'very', 'well', 'were', 'what', 'when', 'where',
  'which', 'while', 'will', 'with', 'would', 'your',
]);

const GUARD_MIN_SHARED_ABSOLUTE = 4;
const GUARD_MIN_SHARED_RATIO = 3;
const GUARD_RATIO_THRESHOLD = 0.7;

/** Minimal episodic store surface the pass needs. */
export type WikiPassEpisodicReader = {
  searchByTime(options?: EpisodeTimeSearchOptions): Promise<Episode[]> | Episode[];
  getProcessingWatermark(
    scope: EpisodicProcessingWatermarkScope,
  ): Promise<EpisodicProcessingWatermark | undefined> | EpisodicProcessingWatermark | undefined;
  upsertProcessingWatermark(
    input: EpisodicProcessingWatermarkWriteInput,
  ): Promise<EpisodicProcessingWatermark> | EpisodicProcessingWatermark;
};

/** Minimal memory store surface: list recent active memories for the review window. */
export type WikiPassMemoryReader = {
  listActiveMemories(options?: MemoryListOptions): Promise<PurrMemory[]> | PurrMemory[];
};

/** Minimal wiki store surface: list/search for update-vs-create, upsert to write. */
export type WikiPassStore = {
  list(): WikiDocumentListEntry[];
  search(input: WikiSearchInput): WikiSearchResult;
  upsert(input: WikiDocumentUpsertInput): WikiDocument;
};

export interface SleeptimeWikiPassOptions {
  llmProvider: LLMProviderPort;
  wikiStore: WikiPassStore;
  episodicStore: WikiPassEpisodicReader;
  memoryStore: WikiPassMemoryReader;
  config?: SleeptimeWikiPassConfig;
  promptRegistry?: PromptRegistryStatePort | null;
  personaPreamble?: PersonaPreamblePort | null;
  /** Typed gate telemetry sink (jpvd.4); wired to the event bus by composition. */
  onGateEvent?: (event: DeterministicGateEvent) => void;
  now?: () => Date;
  /** Bounds how many active memories are scanned to find the review window. */
  memoryScanLimit?: number;
}

export interface SleeptimeWikiPassRunInput {
  sessionId: string;
  sourceMessageId?: string;
}

export type WikiPassSkipReason = 'disabled' | 'no_material' | 'malformed_output';

export interface SleeptimeWikiPassRunResult {
  ran: boolean;
  skippedReason?: WikiPassSkipReason;
  reviewedEpisodes: number;
  reviewedMemories: number;
  entriesCreated: number;
  entriesUpdated: number;
  proposalsRejected: number;
}

export type WikiPassProposalOperation = 'create' | 'update';

export interface WikiPassProposal {
  operation: WikiPassProposalOperation;
  id?: string;
  title: string;
  summary?: string;
  body: string;
  tags: string[];
  sourceEpisodeIds: string[];
  sourceMemoryIds: string[];
  reason?: string;
}

function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasContactLink(memory: PurrMemory): boolean {
  return typeof memory.contactId === 'string' && memory.contactId.trim().length > 0;
}

/** A memory that is personal-about-a-person and must never be duplicated into the wiki. */
export function isPersonalGuardMemory(memory: PurrMemory): boolean {
  return PERSONAL_MEMORY_TYPES.has(memory.type)
    || PERSONAL_SENSITIVITIES.has(memory.sensitivity)
    || hasContactLink(memory);
}

/** A memory that is durable, non-private world-knowledge material for the wiki. */
export function isWorldCandidateMemory(memory: PurrMemory): boolean {
  return WORLD_MEMORY_TYPES.has(memory.type)
    && WORLD_SENSITIVITIES.has(memory.sensitivity)
    && !hasContactLink(memory);
}

function normalizeStringArray(raw: unknown, maxItems = 24): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('wiki pass model returned empty output');
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
  throw new Error('wiki pass model did not return a JSON object');
}

/**
 * Parse and validate the model's proposal payload. Throws on a malformed
 * envelope (the caller treats this as a fail-closed run). Individual proposals
 * that are structurally invalid are skipped, but a valid empty `proposals`
 * array is a legitimate "nothing wiki-shaped today" answer.
 */
export function parseWikiPassProposals(raw: string): WikiPassProposal[] {
  const parsed = JSON.parse(extractJsonPayload(raw)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('wiki pass plan must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (!('proposals' in record)) {
    throw new Error('wiki pass plan is missing the proposals array');
  }
  const rawProposals = record['proposals'];
  if (!Array.isArray(rawProposals)) {
    throw new Error('wiki pass plan proposals must be an array');
  }
  const proposals: WikiPassProposal[] = [];
  for (const rawProposal of rawProposals) {
    if (!rawProposal || typeof rawProposal !== 'object' || Array.isArray(rawProposal)) {
      continue;
    }
    const proposal = rawProposal as Record<string, unknown>;
    const operationRaw = typeof proposal['operation'] === 'string' ? proposal['operation'].trim() : 'create';
    const operation: WikiPassProposalOperation = operationRaw === 'update' ? 'update' : 'create';
    if (!isNonEmptyString(proposal['title']) || !isNonEmptyString(proposal['body'])) {
      continue;
    }
    proposals.push({
      operation,
      ...(isNonEmptyString(proposal['id']) ? { id: proposal['id'].trim() } : {}),
      title: proposal['title'].trim(),
      ...(isNonEmptyString(proposal['summary']) ? { summary: proposal['summary'].trim() } : {}),
      body: proposal['body'].trim().slice(0, MAX_WIKI_BODY_CHARS),
      tags: normalizeStringArray(proposal['tags']).map(tag => tag.toLowerCase()),
      sourceEpisodeIds: normalizeStringArray(proposal['source_episode_ids']),
      sourceMemoryIds: normalizeStringArray(proposal['source_memory_ids']),
      ...(isNonEmptyString(proposal['reason']) ? { reason: proposal['reason'].trim() } : {}),
    });
  }
  return proposals;
}

function distinctiveTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [];
  return new Set(tokens.filter(token => !GUARD_STOP_WORDS.has(token)));
}

function sharedTokenCount(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) {
    if (large.has(token)) shared += 1;
  }
  return shared;
}

export interface PersonalFactGuardResult {
  accepted: WikiPassProposal[];
  rejected: Array<{ proposal: WikiPassProposal; reason: string }>;
}

/**
 * Deterministic post-filter enforcing the personal/world boundary. A proposal is
 * rejected when it:
 *   1. cites a personal (guard) memory as its own source, OR
 *   2. contains a first-person relational marker ("my partner ..."), OR
 *   3. substantially restates a personal memory (distinctive-token overlap).
 * Conservative by design: it errs toward NOT writing rather than risk leaking a
 * personal fact about a person into shared reference knowledge.
 */
export function filterPersonalFactProposals(
  proposals: readonly WikiPassProposal[],
  guardMemories: readonly PurrMemory[],
): PersonalFactGuardResult {
  const guardIds = new Set(guardMemories.map(memory => memory.id));
  const guardTokenSets = guardMemories.map(memory => distinctiveTokens(memory.text));
  const accepted: WikiPassProposal[] = [];
  const rejected: Array<{ proposal: WikiPassProposal; reason: string }> = [];

  for (const proposal of proposals) {
    const citedGuard = proposal.sourceMemoryIds.find(id => guardIds.has(id));
    if (citedGuard) {
      rejected.push({ proposal, reason: `cites personal memory "${citedGuard}" as source` });
      continue;
    }
    const haystack = `${proposal.title}\n${proposal.summary ?? ''}\n${proposal.body}`;
    if (PERSONAL_MARKER_PATTERN.test(haystack)) {
      rejected.push({ proposal, reason: 'contains a first-person relational marker (personal fact)' });
      continue;
    }
    const proposalTokens = distinctiveTokens(haystack);
    let overlapReason: string | null = null;
    for (let index = 0; index < guardTokenSets.length; index += 1) {
      const guardTokens = guardTokenSets[index];
      if (guardTokens.size === 0) continue;
      const shared = sharedTokenCount(proposalTokens, guardTokens);
      const ratio = shared / guardTokens.size;
      if (shared >= GUARD_MIN_SHARED_ABSOLUTE
        || (shared >= GUARD_MIN_SHARED_RATIO && ratio >= GUARD_RATIO_THRESHOLD)) {
        overlapReason = `restates personal memory "${guardMemories[index].id}" (${String(shared)} shared terms)`;
        break;
      }
    }
    if (overlapReason) {
      rejected.push({ proposal, reason: overlapReason });
      continue;
    }
    accepted.push(proposal);
  }
  return { accepted, rejected };
}

function buildGate(config: SleeptimeWikiPassConfig): DeterministicGateDefinition {
  return {
    lane: WIKI_PASS_GATE_LANE,
    openWhenAny: [
      { input: 'newCanonicalEpisodes', comparator: 'gte', threshold: config.minNewCanonicalEpisodes },
      { input: 'newDurableMemories', comparator: 'gte', threshold: config.minNewDurableMemories },
    ],
    closedReason: 'no_material',
    openReason: 'evidence_of_material',
  };
}

function episodeSettledAfter(episode: Episode, watermarkMs: number): boolean {
  if (!Number.isFinite(watermarkMs)) return true;
  const created = Date.parse(episode.createdAt);
  const updated = Date.parse(episode.updatedAt);
  const settledMs = Number.isFinite(updated) ? updated : created;
  return Number.isFinite(settledMs) ? settledMs > watermarkMs : true;
}

export class SleeptimeWikiPass {
  private readonly llmProvider: LLMProviderPort;
  private readonly wikiStore: WikiPassStore;
  private readonly episodicStore: WikiPassEpisodicReader;
  private readonly memoryStore: WikiPassMemoryReader;
  private readonly config: SleeptimeWikiPassConfig;
  private readonly promptRegistry: PromptRegistryStatePort | null;
  private readonly personaPreamble: PersonaPreamblePort | null;
  private readonly onGateEvent: ((event: DeterministicGateEvent) => void) | null;
  private readonly now: () => Date;
  private readonly memoryScanLimit: number;
  private readonly gate: DeterministicGateDefinition;

  constructor(options: SleeptimeWikiPassOptions) {
    this.llmProvider = options.llmProvider;
    this.wikiStore = options.wikiStore;
    this.episodicStore = options.episodicStore;
    this.memoryStore = options.memoryStore;
    this.config = options.config ?? DEFAULT_SLEEPTIME_WIKI_PASS;
    this.promptRegistry = options.promptRegistry ?? null;
    this.personaPreamble = options.personaPreamble ?? null;
    this.onGateEvent = options.onGateEvent ?? null;
    this.now = options.now ?? (() => new Date());
    this.memoryScanLimit = options.memoryScanLimit && options.memoryScanLimit > 0
      ? Math.floor(options.memoryScanLimit)
      : 500;
    this.gate = buildGate(this.config);
  }

  async run(input: SleeptimeWikiPassRunInput): Promise<SleeptimeWikiPassRunResult> {
    const empty: SleeptimeWikiPassRunResult = {
      ran: false,
      reviewedEpisodes: 0,
      reviewedMemories: 0,
      entriesCreated: 0,
      entriesUpdated: 0,
      proposalsRejected: 0,
    };

    if (!this.config.enabled) {
      return { ...empty, skippedReason: 'disabled' };
    }

    const nowMs = this.now().getTime();
    const windowStartMs = nowMs - this.config.reviewWindowHours * HOUR_MS;
    const watermarkScope: EpisodicProcessingWatermarkScope = {
      processor: WIKI_PASS_PROCESSOR,
      sourceRef: input.sessionId,
    };
    const watermark = await this.episodicStore.getProcessingWatermark(watermarkScope);
    const watermarkMs = watermark?.lastProcessedAt ? Date.parse(watermark.lastProcessedAt) : Number.NaN;

    // Deterministic material gathering (cheap; no LLM). New canonical episodes
    // settled since the watermark, and new durable memories formed in the window.
    const canonicalEpisodes = (await this.episodicStore.searchByTime({
      from: toIsoInstant(windowStartMs),
      to: toIsoInstant(nowMs),
      lifecycleStatus: 'canonical',
      limit: 100,
    })).filter(episode => episodeSettledAfter(episode, watermarkMs));

    const activeMemories = await this.memoryStore.listActiveMemories({ limit: this.memoryScanLimit });
    const windowMemories = activeMemories.filter((memory) => {
      const formedAt = memory.extractedAt;
      if (typeof formedAt !== 'number' || !Number.isFinite(formedAt)) return false;
      if (formedAt < windowStartMs) return false;
      if (Number.isFinite(watermarkMs) && formedAt <= watermarkMs) return false;
      return true;
    });

    const newDurableMemories = windowMemories.filter(memory => WORLD_MEMORY_TYPES.has(memory.type));
    const worldMemories = windowMemories.filter(isWorldCandidateMemory).slice(0, this.config.maxSourceMemories);
    const guardMemories = windowMemories.filter(isPersonalGuardMemory);
    const sourceEpisodes = canonicalEpisodes.slice(0, this.config.maxSourceEpisodes);

    const gateInputs = {
      newCanonicalEpisodes: canonicalEpisodes.length,
      newDurableMemories: newDurableMemories.length,
    };
    const decision = evaluateDeterministicGate(this.gate, gateInputs);
    if (!decision.open) {
      this.emitGateEvent(input.sessionId, 'skipped', decision.reason, gateInputs);
      log.info('Sleeptime wiki pass skipped: no deterministic wiki-shaped material', {
        sessionId: input.sessionId,
        ...gateInputs,
      });
      return { ...empty, skippedReason: 'no_material' };
    }
    this.emitGateEvent(input.sessionId, 'ran', decision.reason, gateInputs);

    const existingEntries = this.wikiStore.list().map(entry => ({ id: entry.id, title: entry.title }));
    let proposals: WikiPassProposal[];
    try {
      const response = await this.llmProvider.complete(
        {
          systemPrompt: this.resolveSystemPrompt(),
          messages: [{
            role: 'user',
            content: this.buildRequestPrompt(sourceEpisodes, worldMemories, existingEntries),
          }],
          correlation: {
            requestId: `wiki-pass:${input.sessionId}:${String(nowMs)}`,
            channelId: input.sessionId,
            callType: 'memory',
            purpose: 'memory.sleeptime.plan',
            originType: 'memory',
            originStage: 'memory.sleeptime.wiki',
          },
        },
        'memory',
      );
      proposals = parseWikiPassProposals(response.content);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Fail closed: nothing written, watermark NOT advanced (retry next night).
      this.emitGateEvent(input.sessionId, 'skipped', 'malformed_output', {
        ...gateInputs,
        error: reason.slice(0, 200),
      });
      log.warn('Sleeptime wiki pass produced malformed output; nothing written, will retry next night', {
        sessionId: input.sessionId,
        error: reason,
      });
      return {
        ...empty,
        skippedReason: 'malformed_output',
        reviewedEpisodes: sourceEpisodes.length,
        reviewedMemories: worldMemories.length,
      };
    }

    const guarded = filterPersonalFactProposals(proposals, guardMemories);
    if (guarded.rejected.length > 0) {
      log.warn('Sleeptime wiki pass rejected proposals crossing the personal/world boundary', {
        sessionId: input.sessionId,
        rejected: guarded.rejected.map(entry => ({ title: entry.proposal.title, reason: entry.reason })),
      });
    }

    let entriesCreated = 0;
    let entriesUpdated = 0;
    for (const proposal of guarded.accepted) {
      if (entriesCreated + entriesUpdated >= this.config.maxEntriesPerRun) break;
      const written = this.writeProposal(proposal, input.sessionId);
      if (!written) continue;
      if (written.version > 1) entriesUpdated += 1;
      else entriesCreated += 1;
    }

    // Advance the watermark: the day was reviewed (even when nothing survived
    // the guard), so the same episodes/memories are not re-reviewed next night.
    const nowIso = toIsoInstant(nowMs);
    await this.episodicStore.upsertProcessingWatermark({
      ...watermarkScope,
      ...(watermark?.id ? { id: watermark.id } : {}),
      processedStartedAt: toIsoInstant(windowStartMs),
      processedEndedAt: nowIso,
      previousWatermarkJson: watermark?.nextWatermarkJson ?? {},
      nextWatermarkJson: {
        lastRun: {
          at: nowIso,
          reviewedEpisodes: sourceEpisodes.length,
          reviewedMemories: worldMemories.length,
          entriesCreated,
          entriesUpdated,
          proposalsRejected: guarded.rejected.length,
        },
      },
      status: 'active',
      reconciliationStatus: 'clean',
      lastProcessedAt: nowIso,
    });

    const result: SleeptimeWikiPassRunResult = {
      ran: true,
      reviewedEpisodes: sourceEpisodes.length,
      reviewedMemories: worldMemories.length,
      entriesCreated,
      entriesUpdated,
      proposalsRejected: guarded.rejected.length,
    };
    log.info('Sleeptime wiki pass complete', { sessionId: input.sessionId, ...result });
    return result;
  }

  private writeProposal(proposal: WikiPassProposal, sessionId: string): WikiDocument | null {
    // Prefer updating an existing entry over duplicating it. Use the cited id
    // when the model supplied one; otherwise fall back to a title text search.
    let targetId = proposal.id;
    if (!targetId) {
      const found = this.wikiStore.search({ query: proposal.title, limit: 3 });
      const exact = found.matches.find(match => match.title.toLowerCase() === proposal.title.toLowerCase());
      if (exact) targetId = exact.id;
    }
    const provenanceRefs = [
      `wiki_pass:${sessionId}`,
      ...proposal.sourceEpisodeIds.map(id => `episode:${id}`),
      ...proposal.sourceMemoryIds.map(id => `memory:${id}`),
    ];
    if (provenanceRefs.length === 0) {
      provenanceRefs.push(`wiki_pass:${sessionId}`);
    }
    try {
      return this.wikiStore.upsert({
        ...(targetId ? { id: targetId } : {}),
        title: proposal.title,
        body: proposal.body,
        tags: [...proposal.tags, 'wiki-pass'],
        sourceClass: 'generated_synthesis',
        provenanceRefs,
        sensitivity: 'personal',
        ...(proposal.summary ? { summary: proposal.summary } : {}),
        updatedBy: WIKI_PASS_UPDATED_BY,
      });
    } catch (error) {
      log.warn('Sleeptime wiki pass entry write skipped after error', {
        sessionId,
        title: proposal.title,
        error: String(error),
      });
      return null;
    }
  }

  private resolveSystemPrompt(): string {
    const base = this.promptRegistry?.getPrompt(WIKI_PASS_PROMPT_KEY)
      ?? getDefaultPromptText(WIKI_PASS_PROMPT_KEY);
    return this.personaPreamble
      ? this.personaPreamble.prepend('wiki_curation', base)
      : base;
  }

  private buildRequestPrompt(
    episodes: readonly Episode[],
    memories: readonly PurrMemory[],
    existingEntries: ReadonlyArray<{ id: string; title: string }>,
  ): string {
    const episodeLines = episodes.map(episode => JSON.stringify({
      id: episode.id,
      title: episode.title,
      landmark: episode.landmark,
      themes: episode.themes,
      ...(episode.meaning?.text ? { meaning: episode.meaning.text } : {}),
    }));
    const memoryLines = memories.map(memory => JSON.stringify({
      id: memory.id,
      type: memory.type,
      text: memory.text,
      tags: memory.tags,
    }));
    return [
      "Today's newly-settled canonical episodes:",
      episodeLines.length > 0 ? episodeLines.join('\n') : '[none]',
      '',
      "Today's new durable memories (semantic/procedural, non-personal):",
      memoryLines.length > 0 ? memoryLines.join('\n') : '[none]',
      '',
      'Existing wiki entries (prefer updating one of these over creating a near-duplicate):',
      existingEntries.length > 0
        ? existingEntries.map(entry => `- ${entry.id}: ${entry.title}`).join('\n')
        : '[none]',
      '',
      `Propose at most ${String(this.config.maxEntriesPerRun)} wiki create/update operations. Respond with the strict JSON schema.`,
    ].join('\n');
  }

  private emitGateEvent(
    sessionId: string,
    outcome: 'ran' | 'skipped',
    reason: string,
    inputs: Record<string, number | string>,
  ): void {
    this.onGateEvent?.({
      lane: WIKI_PASS_GATE_LANE,
      outcome,
      reason,
      inputs,
      timestamp: this.now().getTime(),
      sessionId,
    });
  }
}
