import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type { PersonaPreamblePort } from '../identity/persona-preamble.js';
import type { SessionEntry } from '../session/types.js';
import type {
  ConcernCandidateExtractionContext,
  ConcernCandidateExtractionSink,
} from '../../faculties/memory/extraction/types.js';
import type { ExtractedFact, MemoryFormationVAD, PurrMemory } from '../../faculties/memory/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../shared/gating/deterministic-gate.js';
import type { ConcernStorePort } from './concern-store-port.js';
import type {
  ConcernRouteDispatcher,
  ConcernRouteRequest,
} from './concern-route-handoff.js';
import {
  MAX_ACTIVE_CONCERNS,
  isConcernAttentionStatus,
  type ActiveConcernEvidenceRef,
  type ActiveConcernPriority,
  type ActiveConcernVAD,
} from './concerns.js';

const log = createComponentLogger('ConcernCandidates');

const DEFAULT_REVIEW_TURN_INTERVAL = 3;
const DEFAULT_MAX_REVIEW_BATCH = 7;
const CONCERN_REVIEW_LANE = 'concern_candidate_review';

/**
 * Concern-candidate review gates (jpvd.4), expressed on the shared primitive
 * with byte-identical decisions. The pending gate needs > 1 pending candidate
 * (a single item is reviewed later, when it has company); the turn gate is the
 * cadence trigger. `already_running` stays a concurrency guard, not a
 * deterministic gate.
 */
const CONCERN_REVIEW_PENDING_GATE: DeterministicGateDefinition = {
  lane: CONCERN_REVIEW_LANE,
  openWhenAny: [{ input: 'pendingCount', comparator: 'gt', threshold: 1 }],
  closedReason: 'insufficient_candidates',
};

function buildConcernReviewTurnGate(reviewTurnInterval: number): DeterministicGateDefinition {
  return {
    lane: CONCERN_REVIEW_LANE,
    openWhenAny: [{ input: 'turnsSinceReviewCheck', comparator: 'gte', threshold: reviewTurnInterval }],
    closedReason: 'turn_interval',
  };
}
const MAX_CANDIDATE_TEXT_CHARS = 500;
const MAX_CONTEXT_MESSAGES = 12;
const MAX_RELATED_MEMORIES = 8;
const CANDIDATE_SIGNAL_PATTERN = /\b(follow\s+up|check\s+in|check\s+on|remind(?:er)?|ask\b.*\blater|tomorrow|next\s+week|due|appointment|deadline|worried|worry|concerned|hasn['’]?t|didn['’]?t)\b/i;
const POSSIBLE_EXTERNAL_FOLLOW_UP_PATTERN = /\b(follow\s+up|check\s+in|check\s+on|remind|ask\b.*\blater)\b/i;

export type ConcernCandidateSource = 'memory_extraction';
export type ConcernCandidateFollowUpHint = 'internal_only' | 'possible_follow_up';
export type ConcernCandidateReviewAction = 'create' | 'merge' | 'defer' | 'reject' | 'route';
export type ConcernCandidateRouteTarget =
  | 'north_star'
  | 'project'
  | 'reminder'
  | 'schedule'
  | 'introspection'
  | 'other';

export interface ConcernCandidateMessageContext {
  id: number;
  role: SessionEntry['role'];
  content: string;
  authorId?: string;
  authorName?: string;
  timestamp?: number;
}

export interface ConcernCandidateMemoryContext {
  id: string;
  type: PurrMemory['type'];
  text: string;
  importance: number;
  confidence: number;
  salience: number;
  sourceRef: string;
}

export interface ConcernCandidate {
  id: string;
  dedupeKey: string;
  source: ConcernCandidateSource;
  title: string;
  summary: string;
  priorityHint: ActiveConcernPriority;
  followUpHint: ConcernCandidateFollowUpHint;
  channelId: string;
  triggerReason: ConcernCandidateExtractionContext['triggerReason'];
  sourceRef: string;
  sourceMessageIds: number[];
  conversationContext: ConcernCandidateMessageContext[];
  relatedMemoryContext: ConcernCandidateMemoryContext[];
  evidenceRefs: ActiveConcernEvidenceRef[];
  createdAt: string;
  contactId?: string;
  turnId?: string;
  dueAt?: string;
  formationVAD?: ActiveConcernVAD;
}

export interface ConcernCandidateReviewDecision {
  candidateId: string;
  action: ConcernCandidateReviewAction;
  reason: string;
  priority?: ActiveConcernPriority;
  targetConcernId?: string;
  routeTarget?: ConcernCandidateRouteTarget;
  dueAt?: string;
}

export interface ConcernCandidateApplyOutcome {
  candidateId: string;
  action: ConcernCandidateReviewAction;
  status: 'created' | 'merged' | 'deferred' | 'rejected' | 'routed' | 'blocked';
  reason: string;
  concernId?: string;
  routeTarget?: ConcernCandidateRouteTarget;
  /** Substrate that accepted the routed handoff (when action=route succeeded). */
  routeSubstrate?: string;
  /** Durable id created in the destination substrate (when routed). */
  routeRef?: string;
}

export interface ConcernCandidateReviewResult {
  decisions: ConcernCandidateReviewDecision[];
  prompt: string;
}

export interface ConcernCandidateWorkerRunResult {
  status: 'skipped' | 'started' | 'completed';
  reason?: 'turn_interval' | 'insufficient_candidates' | 'already_running';
  pendingCount: number;
  reviewedCount?: number;
  outcomes?: ConcernCandidateApplyOutcome[];
}

export interface ConcernCandidateQueueOptions {
  idFactory?: () => string;
  now?: () => Date;
}

export class ConcernCandidateQueue {
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly pending: ConcernCandidate[] = [];
  private readonly pendingDedupeKeys = new Set<string>();

  constructor(options: ConcernCandidateQueueOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  enqueueFromExtraction(context: ConcernCandidateExtractionContext): ConcernCandidate[] {
    return this.enqueueMany(deriveConcernCandidatesFromExtraction({
      context,
      idFactory: this.idFactory,
      now: this.now,
    }));
  }

  enqueueMany(candidates: readonly ConcernCandidate[]): ConcernCandidate[] {
    const accepted: ConcernCandidate[] = [];
    for (const candidate of candidates) {
      if (this.pendingDedupeKeys.has(candidate.dedupeKey)) {
        continue;
      }
      this.pending.push(candidate);
      this.pendingDedupeKeys.add(candidate.dedupeKey);
      accepted.push(candidate);
    }
    return accepted;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  drainPending(limit = DEFAULT_MAX_REVIEW_BATCH): ConcernCandidate[] {
    const count = Math.max(0, Math.floor(limit));
    if (count === 0) return [];
    const drained = this.pending.splice(0, count);
    for (const candidate of drained) {
      this.pendingDedupeKeys.delete(candidate.dedupeKey);
    }
    return drained;
  }

  requeue(candidates: readonly ConcernCandidate[]): void {
    const fresh = candidates.filter(candidate => !this.pendingDedupeKeys.has(candidate.dedupeKey));
    this.pending.unshift(...fresh);
    for (const candidate of fresh) {
      this.pendingDedupeKeys.add(candidate.dedupeKey);
    }
  }
}

export interface DeriveConcernCandidatesOptions {
  context: ConcernCandidateExtractionContext;
  idFactory?: () => string;
  now?: () => Date;
}

export function deriveConcernCandidatesFromExtraction(
  options: DeriveConcernCandidatesOptions,
): ConcernCandidate[] {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const context = options.context;
  const messageContext = buildMessageContext(context.recentEntries);
  const relatedMemoryContext = context.relatedMemories
    .slice(0, MAX_RELATED_MEMORIES)
    .map(memory => ({
      id: memory.id,
      type: memory.type,
      text: compactText(memory.text, MAX_CANDIDATE_TEXT_CHARS),
      importance: memory.importance,
      confidence: memory.confidence,
      salience: memory.salience,
      sourceRef: memory.sourceRef,
    }));

  const factCandidates = context.acceptedFacts
    .filter(fact => CANDIDATE_SIGNAL_PATTERN.test(fact.text))
    .slice(0, DEFAULT_MAX_REVIEW_BATCH)
    .map(fact => buildCandidateFromFact({
      fact,
      context,
      messageContext,
      relatedMemoryContext,
      id: idFactory(),
      createdAt: now().toISOString(),
    }));

  if (factCandidates.length > 0) {
    return factCandidates;
  }

  const transcriptSignal = [...context.recentEntries]
    .reverse()
    .find(entry => entry.role !== 'assistant' && CANDIDATE_SIGNAL_PATTERN.test(entry.content));
  if (!transcriptSignal) {
    return [];
  }

  return [buildCandidateFromMessage({
    entry: transcriptSignal,
    context,
    messageContext,
    relatedMemoryContext,
    id: idFactory(),
    createdAt: now().toISOString(),
  })];
}

function buildCandidateFromFact(input: {
  fact: ExtractedFact;
  context: ConcernCandidateExtractionContext;
  messageContext: ConcernCandidateMessageContext[];
  relatedMemoryContext: ConcernCandidateMemoryContext[];
  id: string;
  createdAt: string;
}): ConcernCandidate {
  const sourceMessageIds = extractSourceMessageIds(input.fact, input.context.recentEntries);
  const title = buildCandidateTitle(input.fact.text);
  const dueAt = deriveDueAtHint(input.fact.text, input.createdAt);
  return {
    id: input.id,
    dedupeKey: buildCandidateDedupeKey(input.context.channelId, input.fact.text, sourceMessageIds),
    source: 'memory_extraction',
    title,
    summary: compactText(input.fact.text, MAX_CANDIDATE_TEXT_CHARS),
    priorityHint: priorityFromFact(input.fact),
    followUpHint: POSSIBLE_EXTERNAL_FOLLOW_UP_PATTERN.test(input.fact.text)
      ? 'possible_follow_up'
      : 'internal_only',
    channelId: input.context.channelId,
    triggerReason: input.context.triggerReason,
    sourceRef: input.context.sourceRef,
    sourceMessageIds,
    conversationContext: input.messageContext,
    relatedMemoryContext: input.relatedMemoryContext,
    evidenceRefs: buildEvidenceRefs(sourceMessageIds, input.context.turnId, input.context.sourceRef),
    createdAt: input.createdAt,
    ...(input.context.canonicalContactId ? { contactId: input.context.canonicalContactId } : {}),
    ...(input.context.turnId ? { turnId: input.context.turnId } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(formationVADFromFact(input.fact) ? { formationVAD: formationVADFromFact(input.fact) } : {}),
  };
}

function buildCandidateFromMessage(input: {
  entry: SessionEntry;
  context: ConcernCandidateExtractionContext;
  messageContext: ConcernCandidateMessageContext[];
  relatedMemoryContext: ConcernCandidateMemoryContext[];
  id: string;
  createdAt: string;
}): ConcernCandidate {
  const sourceMessageIds = [input.entry.id];
  const title = buildCandidateTitle(input.entry.content);
  const dueAt = deriveDueAtHint(input.entry.content, input.createdAt);
  return {
    id: input.id,
    dedupeKey: buildCandidateDedupeKey(input.context.channelId, input.entry.content, sourceMessageIds),
    source: 'memory_extraction',
    title,
    summary: compactText(input.entry.content, MAX_CANDIDATE_TEXT_CHARS),
    priorityHint: 'medium',
    followUpHint: POSSIBLE_EXTERNAL_FOLLOW_UP_PATTERN.test(input.entry.content)
      ? 'possible_follow_up'
      : 'internal_only',
    channelId: input.context.channelId,
    triggerReason: input.context.triggerReason,
    sourceRef: input.context.sourceRef,
    sourceMessageIds,
    conversationContext: input.messageContext,
    relatedMemoryContext: input.relatedMemoryContext,
    evidenceRefs: buildEvidenceRefs(sourceMessageIds, input.context.turnId, input.context.sourceRef),
    createdAt: input.createdAt,
    ...(input.context.canonicalContactId ? { contactId: input.context.canonicalContactId } : {}),
    ...(input.context.turnId ? { turnId: input.context.turnId } : {}),
    ...(dueAt ? { dueAt } : {}),
  };
}

export class ConcernCandidateReviewer {
  constructor(
    private readonly llmProvider: LLMProviderPort,
    private readonly personaPreamble: PersonaPreamblePort | null = null,
  ) {}

  async review(candidates: readonly ConcernCandidate[]): Promise<ConcernCandidateReviewResult> {
    if (candidates.length === 0) {
      return { decisions: [], prompt: '' };
    }
    const reviewPrompt = buildConcernCandidateReviewPrompt(candidates);
    // E6.1: soft persona framing precedes the strict JSON review instructions.
    const prompt = this.personaPreamble
      ? this.personaPreamble.prepend('concern_review', reviewPrompt)
      : reviewPrompt;
    const response = await this.llmProvider.complete(
      {
        systemPrompt: prompt,
        messages: [{
          role: 'user',
          content: 'Review the candidate follow-up threads and return the JSON decision object.',
        }],
        correlation: {
          requestId: `concern-candidate-review:${candidates.map(candidate => candidate.id).join(',')}`,
          callType: 'background',
          purpose: 'intention.concern_candidate_review',
          originType: 'background',
          originStage: 'intention.concern_candidate_review',
          ...(candidates[0]?.channelId ? { channelId: candidates[0].channelId } : {}),
        },
      },
      'background',
    );
    return {
      decisions: parseConcernCandidateReviewResponse(response.content, candidates),
      prompt,
    };
  }
}

export function buildConcernCandidateReviewPrompt(
  candidates: readonly ConcernCandidate[],
): string {
  const payload = {
    question: 'Is there anything here we should follow up on soon?',
    guidance: [
      'Treat these as soft follow-up candidates for a short-time attention list.',
      'Use create for a near-term thread, merge when an existing thread fits, defer when more context would help, reject when it is noise, and route when it belongs in a north star, project, reminder, schedule, introspection, or another substrate.',
      'Keep some candidates internal-only when external contact is not clearly appropriate.',
      'Concern approval is separate from outbound delivery.',
    ],
    outputShape: {
      decisions: [{
        candidateId: 'candidate id',
        action: 'create | merge | defer | reject | route',
        reason: 'short rationale',
        priority: 'high | medium | low',
        targetConcernId: 'optional existing concern id',
        routeTarget: 'north_star | project | reminder | schedule | introspection | other',
        dueAt: 'optional ISO timestamp',
      }],
    },
    candidates: candidates.map(candidate => ({
      id: candidate.id,
      title: candidate.title,
      summary: candidate.summary,
      priorityHint: candidate.priorityHint,
      followUpHint: candidate.followUpHint,
      channelId: candidate.channelId,
      contactId: candidate.contactId ?? null,
      turnId: candidate.turnId ?? null,
      sourceMessageIds: candidate.sourceMessageIds,
      evidenceRefs: candidate.evidenceRefs,
      conversationContext: candidate.conversationContext,
      relatedMemoryContext: candidate.relatedMemoryContext,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function parseConcernCandidateReviewResponse(
  raw: string,
  candidates: readonly ConcernCandidate[],
): ConcernCandidateReviewDecision[] {
  const parsed = parseJsonObject(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.decisions)) {
    return candidates.map(candidate => ({
      candidateId: candidate.id,
      action: 'reject',
      reason: 'review response was not a usable decision object',
    }));
  }

  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const decisions: ConcernCandidateReviewDecision[] = [];
  for (const item of parsed.decisions) {
    if (!isRecord(item)) continue;
    const candidateId = typeof item.candidateId === 'string' ? item.candidateId.trim() : '';
    if (!candidateIds.has(candidateId)) continue;
    const action = normalizeReviewAction(item.action);
    if (!action) continue;
    const reason = typeof item.reason === 'string' && item.reason.trim()
      ? compactText(item.reason, 240)
      : `review selected ${action}`;
    const priority = normalizeReviewPriority(item.priority);
    const targetConcernId = typeof item.targetConcernId === 'string' && item.targetConcernId.trim()
      ? item.targetConcernId.trim()
      : undefined;
    const routeTarget = normalizeRouteTarget(item.routeTarget);
    const dueAt = normalizeOptionalIso(item.dueAt);
    decisions.push({
      candidateId,
      action,
      reason,
      ...(priority ? { priority } : {}),
      ...(targetConcernId ? { targetConcernId } : {}),
      ...(routeTarget ? { routeTarget } : {}),
      ...(dueAt ? { dueAt } : {}),
    });
  }

  const decidedIds = new Set(decisions.map(decision => decision.candidateId));
  for (const candidate of candidates) {
    if (decidedIds.has(candidate.id)) continue;
    decisions.push({
      candidateId: candidate.id,
      action: 'reject',
      reason: 'review omitted this candidate',
    });
  }
  return decisions;
}

export interface ApplyConcernCandidateReviewOptions {
  concernStore: ConcernStorePort;
  candidates: readonly ConcernCandidate[];
  decisions: readonly ConcernCandidateReviewDecision[];
  /**
   * Optional durable-substrate dispatcher. When provided, action=route
   * decisions hand off to the configured substrate handler (or produce an
   * explicit blocked outcome). When absent, routes stay an intake-only
   * acknowledgement (legacy behavior).
   */
  routeDispatcher?: ConcernRouteDispatcher;
  now?: () => Date;
}

export async function applyConcernCandidateReview(
  options: ApplyConcernCandidateReviewOptions,
): Promise<ConcernCandidateApplyOutcome[]> {
  const candidatesById = new Map(options.candidates.map(candidate => [candidate.id, candidate]));
  const outcomes: ConcernCandidateApplyOutcome[] = [];
  for (const decision of options.decisions) {
    const candidate = candidatesById.get(decision.candidateId);
    if (!candidate) continue;
    outcomes.push(await applyConcernCandidateDecision({
      concernStore: options.concernStore,
      candidate,
      decision,
      ...(options.routeDispatcher ? { routeDispatcher: options.routeDispatcher } : {}),
      now: options.now,
    }));
  }
  return outcomes;
}

async function applyConcernCandidateDecision(input: {
  concernStore: ConcernStorePort;
  candidate: ConcernCandidate;
  decision: ConcernCandidateReviewDecision;
  routeDispatcher?: ConcernRouteDispatcher;
  now?: () => Date;
}): Promise<ConcernCandidateApplyOutcome> {
  switch (input.decision.action) {
    case 'reject':
      return {
        candidateId: input.candidate.id,
        action: 'reject',
        status: 'rejected',
        reason: input.decision.reason,
      };
    case 'defer':
      return {
        candidateId: input.candidate.id,
        action: 'defer',
        status: 'deferred',
        reason: input.decision.reason,
      };
    case 'route': {
      const routeTarget = input.decision.routeTarget ?? 'other';
      if (!input.routeDispatcher) {
        return {
          candidateId: input.candidate.id,
          action: 'route',
          status: 'routed',
          routeTarget,
          reason: input.decision.reason,
        };
      }
      const outcome = await input.routeDispatcher.dispatch(
        buildCandidateRouteRequest(input.candidate, input.decision, routeTarget),
      );
      return {
        candidateId: input.candidate.id,
        action: 'route',
        status: outcome.disposition === 'routed' ? 'routed' : 'blocked',
        routeTarget,
        reason: outcome.reason,
        routeSubstrate: outcome.substrate,
        ...(outcome.targetRef ? { routeRef: outcome.targetRef } : {}),
      };
    }
    case 'merge':
      if (input.decision.targetConcernId) {
        const merged = await input.concernStore.transitionConcernStatus(input.decision.targetConcernId, {
          status: 'active',
          transitionedAt: (input.now?.() ?? new Date()).toISOString(),
          evidenceRefs: input.candidate.evidenceRefs,
          ...(input.decision.dueAt ?? input.candidate.dueAt
            ? { nextReviewAt: input.decision.dueAt ?? input.candidate.dueAt }
            : {}),
        });
        if (!merged) {
          return {
            candidateId: input.candidate.id,
            action: 'merge',
            status: 'blocked',
            routeTarget: 'other',
            reason: `target concern ${input.decision.targetConcernId} was not available for merge`,
          };
        }
        return {
          candidateId: input.candidate.id,
          action: 'merge',
          status: 'merged',
          reason: input.decision.reason,
          concernId: merged.id,
        };
      }
      return await createConcernFromCandidate({
        concernStore: input.concernStore,
        candidate: input.candidate,
        decision: input.decision,
      });
    case 'create': {
      const activeCount = await countActiveAttentionConcerns(input.concernStore, input.now?.() ?? new Date());
      if (activeCount >= MAX_ACTIVE_CONCERNS) {
        return {
          candidateId: input.candidate.id,
          action: input.decision.action,
          status: 'blocked',
          routeTarget: 'other',
          reason: `active concern cap ${MAX_ACTIVE_CONCERNS} reached; candidate kept out of active concerns`,
        };
      }
      return await createConcernFromCandidate({
        concernStore: input.concernStore,
        candidate: input.candidate,
        decision: input.decision,
      });
    }
  }
}

async function createConcernFromCandidate(input: {
  concernStore: ConcernStorePort;
  candidate: ConcernCandidate;
  decision: ConcernCandidateReviewDecision;
}): Promise<ConcernCandidateApplyOutcome> {
  try {
    const concern = await input.concernStore.create({
      text: buildConcernText(input.candidate),
      priority: input.decision.priority ?? input.candidate.priorityHint,
      source: 'appraisal',
      status: 'active',
      ...(input.candidate.contactId ? { contactId: input.candidate.contactId } : {}),
      ...(input.decision.dueAt ?? input.candidate.dueAt
        ? { expiresAt: input.decision.dueAt ?? input.candidate.dueAt }
        : {}),
      ...(input.candidate.formationVAD ? { formationVAD: input.candidate.formationVAD } : {}),
      evidenceRefs: input.candidate.evidenceRefs,
    });
    return {
      candidateId: input.candidate.id,
      action: input.decision.action,
      status: input.decision.action === 'merge' ? 'merged' : 'created',
      reason: input.decision.reason,
      concernId: concern.id,
    };
  } catch (error) {
    if (String(error).includes(`Active concern cap reached (${MAX_ACTIVE_CONCERNS})`)) {
      return {
        candidateId: input.candidate.id,
        action: input.decision.action,
        status: 'blocked',
        routeTarget: 'other',
        reason: `active concern cap ${MAX_ACTIVE_CONCERNS} reached; candidate kept out of active concerns`,
      };
    }
    throw error;
  }
}

function buildCandidateRouteRequest(
  candidate: ConcernCandidate,
  decision: ConcernCandidateReviewDecision,
  routeTarget: ConcernCandidateRouteTarget,
): ConcernRouteRequest {
  return {
    target: routeTarget,
    source: 'candidate_review',
    title: candidate.title,
    summary: candidate.summary,
    priority: decision.priority ?? candidate.priorityHint,
    reason: decision.reason,
    evidenceRefs: candidate.evidenceRefs,
    channelId: candidate.channelId,
    ...(candidate.contactId ? { contactId: candidate.contactId } : {}),
    ...(decision.dueAt ?? candidate.dueAt ? { dueAt: decision.dueAt ?? candidate.dueAt } : {}),
    candidateId: candidate.id,
  };
}

export interface ConcernCandidateWorkerOptions {
  queue: ConcernCandidateQueue;
  reviewer: ConcernCandidateReviewer;
  concernStore: ConcernStorePort;
  eventBus?: EventBus | null;
  routeDispatcher?: ConcernRouteDispatcher;
  reviewTurnInterval?: number;
  maxReviewBatch?: number;
  now?: () => Date;
}

export class ConcernCandidateWorker {
  private readonly reviewTurnInterval: number;
  private readonly maxReviewBatch: number;
  private readonly now: () => Date;
  private readonly turnGate: DeterministicGateDefinition;
  private turnsSinceReviewCheck = 0;
  private inFlight: Promise<ConcernCandidateWorkerRunResult> | null = null;

  constructor(private readonly options: ConcernCandidateWorkerOptions) {
    this.reviewTurnInterval = Math.max(
      1,
      Math.floor(options.reviewTurnInterval ?? DEFAULT_REVIEW_TURN_INTERVAL),
    );
    this.maxReviewBatch = Math.max(2, Math.floor(options.maxReviewBatch ?? DEFAULT_MAX_REVIEW_BATCH));
    this.now = options.now ?? (() => new Date());
    this.turnGate = buildConcernReviewTurnGate(this.reviewTurnInterval);
  }

  notifyTurnCompleted(): boolean {
    this.turnsSinceReviewCheck += 1;
    // Turn-interval cadence trigger (jpvd.4). The per-turn wait is a trigger,
    // not a meaningful skip, so it does not emit a gate event (that would flood
    // the health lane every turn); the review-time gate below carries the
    // observable decision.
    const turnGate = evaluateDeterministicGate(this.turnGate, {
      turnsSinceReviewCheck: this.turnsSinceReviewCheck,
    });
    if (!turnGate.open) {
      return false;
    }
    this.turnsSinceReviewCheck = 0;
    const run = this.reviewPending();
    return run.status === 'started';
  }

  reviewPending(): ConcernCandidateWorkerRunResult {
    const pendingCount = this.options.queue.pendingCount();
    if (this.inFlight) {
      return { status: 'skipped', reason: 'already_running', pendingCount };
    }
    const pendingGate = evaluateDeterministicGate(CONCERN_REVIEW_PENDING_GATE, { pendingCount });
    if (!pendingGate.open) {
      this.emitGateEvent('skipped', pendingGate.reason, { pendingCount });
      return { status: 'skipped', reason: 'insufficient_candidates', pendingCount };
    }
    this.emitGateEvent('ran', pendingGate.reason, { pendingCount });
    this.inFlight = this.runReview()
      .catch((error) => {
        log.warn('Concern candidate review failed', { error: String(error) });
        return { status: 'completed', pendingCount, reviewedCount: 0, outcomes: [] };
      })
      .finally(() => {
        this.inFlight = null;
      });
    return { status: 'started', pendingCount };
  }

  async waitForInFlight(): Promise<ConcernCandidateWorkerRunResult | null> {
    return this.inFlight ?? Promise.resolve(null);
  }

  private emitGateEvent(
    outcome: 'ran' | 'skipped',
    reason: string,
    inputs: Record<string, number | string>,
  ): void {
    const emitted = this.options.eventBus?.emit('intention.concern_candidate.gate', {
      lane: CONCERN_REVIEW_LANE,
      outcome,
      reason,
      inputs,
      timestamp: this.now().getTime(),
    });
    void Promise.resolve(emitted).catch((error: unknown) => {
      log.warn('Concern candidate gate event emit failed', { error: String(error) });
    });
  }

  private async runReview(): Promise<ConcernCandidateWorkerRunResult> {
    const candidates = this.options.queue.drainPending(this.maxReviewBatch);
    try {
      const review = await this.options.reviewer.review(candidates);
      const outcomes = await applyConcernCandidateReview({
        concernStore: this.options.concernStore,
        candidates,
        decisions: review.decisions,
        ...(this.options.routeDispatcher ? { routeDispatcher: this.options.routeDispatcher } : {}),
        now: this.now,
      });
      await this.options.eventBus?.emit('intention.concern_candidate.reviewed', {
        candidateCount: candidates.length,
        outcomeCount: outcomes.length,
        outcomes,
        timestamp: this.now().getTime(),
      });
      return {
        status: 'completed',
        pendingCount: this.options.queue.pendingCount(),
        reviewedCount: candidates.length,
        outcomes,
      };
    } catch (error) {
      this.options.queue.requeue(candidates);
      throw error;
    }
  }
}

export interface AutomatedConcernRuntime {
  queue: ConcernCandidateQueue;
  worker: ConcernCandidateWorker;
  extractionSink: ConcernCandidateExtractionSink;
  dispose(): void;
}

export interface CreateAutomatedConcernRuntimeOptions {
  eventBus: EventBus;
  llmProvider: LLMProviderPort;
  concernStore: ConcernStorePort;
  reviewTurnInterval?: number;
  now?: () => Date;
  /** Shared persona preamble service (E6.1); soft persona framing before the concern-review task prompt. */
  personaPreamble?: PersonaPreamblePort | null;
  /** Durable-substrate dispatcher for action=route decisions (etj1). */
  routeDispatcher?: ConcernRouteDispatcher;
}

export function createAutomatedConcernRuntime(
  options: CreateAutomatedConcernRuntimeOptions,
): AutomatedConcernRuntime {
  const queue = new ConcernCandidateQueue({
    ...(options.now ? { now: options.now } : {}),
  });
  const reviewer = new ConcernCandidateReviewer(options.llmProvider, options.personaPreamble ?? null);
  const worker = new ConcernCandidateWorker({
    queue,
    reviewer,
    concernStore: options.concernStore,
    eventBus: options.eventBus,
    ...(options.routeDispatcher ? { routeDispatcher: options.routeDispatcher } : {}),
    ...(options.reviewTurnInterval ? { reviewTurnInterval: options.reviewTurnInterval } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const extractionSink: ConcernCandidateExtractionSink = async (context) => {
    const enqueued = queue.enqueueFromExtraction(context);
    if (enqueued.length === 0) return;
    await options.eventBus.emit('intention.concern_candidate.enqueued', {
      candidateCount: enqueued.length,
      pendingCount: queue.pendingCount(),
      candidateIds: enqueued.map(candidate => candidate.id),
      channelId: context.channelId,
      timestamp: (options.now?.() ?? new Date()).getTime(),
      ...(context.turnId ? { turnId: context.turnId } : {}),
    });
  };
  const unsubscribe = options.eventBus.on('agent.turn.end', () => {
    worker.notifyTurnCompleted();
  });
  return {
    queue,
    worker,
    extractionSink,
    dispose: unsubscribe,
  };
}

async function countActiveAttentionConcerns(
  concernStore: ConcernStorePort,
  asOf: Date,
): Promise<number> {
  const active = await concernStore.list({
    includeResolved: false,
    includeExpired: false,
    asOf: asOf.toISOString(),
    limit: MAX_ACTIVE_CONCERNS + 1,
  });
  return active.filter(concern => isConcernAttentionStatus(concern.status)).length;
}

function buildMessageContext(entries: readonly SessionEntry[]): ConcernCandidateMessageContext[] {
  return entries
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(entry => ({
      id: entry.id,
      role: entry.role,
      content: compactText(entry.content, MAX_CANDIDATE_TEXT_CHARS),
      ...(entry.authorId ? { authorId: entry.authorId } : {}),
      ...(entry.authorName ? { authorName: entry.authorName } : {}),
      ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
    }));
}

function extractSourceMessageIds(
  fact: ExtractedFact,
  entries: readonly SessionEntry[],
): number[] {
  const sourceIds = fact.attribution?.sourceMessageIds;
  if (sourceIds && sourceIds.length > 0) {
    return sourceIds;
  }
  const matched = [...entries]
    .reverse()
    .find(entry => entry.role !== 'assistant' && CANDIDATE_SIGNAL_PATTERN.test(entry.content));
  return matched ? [matched.id] : [];
}

function buildEvidenceRefs(
  sourceMessageIds: readonly number[],
  turnId: string | undefined,
  sourceRef: string,
): ActiveConcernEvidenceRef[] {
  const refs: ActiveConcernEvidenceRef[] = sourceMessageIds.map(id => ({
    kind: 'message',
    ref: String(id),
  }));
  if (turnId) refs.push({ kind: 'turn', ref: turnId });
  refs.push({ kind: 'runtime', ref: sourceRef });
  return refs;
}

function priorityFromFact(fact: ExtractedFact): ActiveConcernPriority {
  if (fact.importance >= 0.8 || fact.emotionalValence <= -0.45) return 'high';
  if (fact.importance >= 0.55 || fact.emotionalValence <= -0.2) return 'medium';
  return 'low';
}

function formationVADFromFact(fact: ExtractedFact): ActiveConcernVAD | undefined {
  const vad = (fact as ExtractedFact & { formationVAD?: MemoryFormationVAD }).formationVAD;
  if (!vad) return undefined;
  return {
    valence: vad.valence,
    arousal: vad.arousal,
    dominance: vad.dominance,
  };
}

function deriveDueAtHint(text: string, createdAt: string): string | undefined {
  const baseMs = Date.parse(createdAt);
  if (!Number.isFinite(baseMs)) return undefined;
  if (/\btomorrow\b/i.test(text)) {
    return new Date(baseMs + 24 * 60 * 60 * 1000).toISOString();
  }
  if (/\bnext\s+week\b/i.test(text)) {
    return new Date(baseMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  return undefined;
}

function buildCandidateTitle(text: string): string {
  const compacted = compactText(text, 90)
    .replace(/^user\s+/i, '')
    .replace(/^the\s+user\s+/i, '');
  return compacted.length <= 78 ? compacted : `${compacted.slice(0, 75).trim()}...`;
}

function buildConcernText(candidate: ConcernCandidate): string {
  if (candidate.title && candidate.summary && candidate.summary !== candidate.title) {
    return compactText(`${candidate.title}: ${candidate.summary}`, MAX_CANDIDATE_TEXT_CHARS);
  }
  return compactText(candidate.summary || candidate.title, MAX_CANDIDATE_TEXT_CHARS);
}

function compactText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length <= maxChars
    ? compacted
    : `${compacted.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function buildCandidateDedupeKey(
  channelId: string,
  text: string,
  sourceMessageIds: readonly number[],
): string {
  const textKey = compactText(text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' '), 180);
  return [
    channelId,
    sourceMessageIds.join(',') || 'no-message',
    textKey,
  ].join('|');
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const jsonText = fenced?.[1]?.trim() ?? extractObjectText(trimmed);
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function extractObjectText(value: string): string {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return value;
  }
  return value.slice(start, end + 1);
}

function normalizeReviewAction(value: unknown): ConcernCandidateReviewAction | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized === 'create'
    || normalized === 'merge'
    || normalized === 'defer'
    || normalized === 'reject'
    || normalized === 'route'
    ? normalized
    : undefined;
}

function normalizeReviewPriority(value: unknown): ActiveConcernPriority | undefined {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return undefined;
}

function normalizeRouteTarget(value: unknown): ConcernCandidateRouteTarget | undefined {
  if (
    value === 'north_star'
    || value === 'project'
    || value === 'reminder'
    || value === 'schedule'
    || value === 'introspection'
    || value === 'other'
  ) {
    return value;
  }
  return undefined;
}

function normalizeOptionalIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
