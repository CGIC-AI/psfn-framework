import { createHash, randomUUID } from 'node:crypto';
import type { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../primitives/llm/work-spec.js';
import type { PersonaPreamblePort } from '../identity/persona-preamble.js';
import type { SessionEntry } from '../session/types.js';
import type { ConcernCandidateExtractionSink } from '../../faculties/memory/extraction/types.js';
import type { ExtractedFact, MemoryFormationVAD } from '../../faculties/memory/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../shared/gating/deterministic-gate.js';
import type { ConcernStorePort } from './concern-store-port.js';
import type {
  ConcernCandidate,
  IntentionConcernCandidateExtractionContext,
  ConcernCandidateMessageContext,
  ConcernCandidateMemoryContext,
} from './concern-candidate-types.js';
import type {
  ConcernRouteDispatcher,
  ConcernRouteRequest,
  ConcernRouteTarget,
} from './concern-route-handoff.js';
import {
  buildDurableCandidateReviewSnapshot,
  MAX_CANDIDATE_TEXT_CHARS,
  MAX_CONTEXT_MESSAGES,
  MAX_RELATED_MEMORIES,
  parseDurableCandidateReviewSnapshot,
} from './concern-candidate-review-snapshot.js';
import {
  MAX_ACTIVE_CONCERNS,
  MAX_ACTIVE_CONCERN_LIFETIME_MS,
  MAX_LIST_LIMIT,
  isConcernAttentionStatus,
  type ActiveConcern,
  type ActiveConcernEvidenceRef,
  type ActiveConcernPriority,
  type ActiveConcernVAD,
} from './concerns.js';

export type {
  ConcernCandidate,
  IntentionConcernCandidateExtractionContext,
  ConcernCandidateFollowUpHint,
  ConcernCandidateMemoryContext,
  ConcernCandidateMessageContext,
  ConcernCandidateSource,
} from './concern-candidate-types.js';

const log = createComponentLogger('ConcernCandidates');

const DEFAULT_REVIEW_TURN_INTERVAL = 3;
const DEFAULT_MAX_REVIEW_BATCH = 7;
const CONCERN_REVIEW_LANE = 'concern_candidate_review';
const DURABLE_CANDIDATE_DEDUPE_PREFIX = 'concern-candidate-dedupe:';

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
const CANDIDATE_SIGNAL_PATTERN = /\b(follow\s+up|check\s+in|check\s+on|remind(?:er)?|ask\b.*\blater|tomorrow|next\s+week|due|appointment|deadline|worried|worry|concerned|hasn['’]?t|didn['’]?t)\b/i;
const POSSIBLE_EXTERNAL_FOLLOW_UP_PATTERN = /\b(follow\s+up|check\s+in|check\s+on|remind|ask\b.*\blater)\b/i;
const TOMORROW_FOLLOW_UP_DELAY_MS = 24 * 60 * 60 * 1000;
const NEXT_WEEK_FOLLOW_UP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export type ConcernCandidateReviewAction = 'create' | 'merge' | 'defer' | 'reject' | 'route';
export type ConcernCandidateRouteTarget = ConcernRouteTarget;

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

  enqueueFromExtraction(context: IntentionConcernCandidateExtractionContext): ConcernCandidate[] {
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
  context: IntentionConcernCandidateExtractionContext;
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
  context: IntentionConcernCandidateExtractionContext;
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
  context: IntentionConcernCandidateExtractionContext;
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
    const response = await completeWithWorkSpec(
      this.llmProvider,
      {
        systemPrompt: prompt,
        messages: [{
          role: 'user',
          content: 'Review the candidate follow-up threads and return the JSON decision object.',
        }],
      },
      buildLLMWorkSpec({
        purpose: 'background',
        durable: false,
        correlation: {
          requestId: `concern-candidate-review:${candidates.map(candidate => candidate.id).join(',')}`,
          callType: 'background',
          purpose: 'intention.concern_candidate_review',
          originType: 'background',
          originStage: 'intention.concern_candidate_review',
          ...(candidates[0]?.channelId ? { channelId: candidates[0].channelId } : {}),
        },
      }),
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
      'Selecting an open thread is separate from outbound delivery.',
    ],
    outputShape: {
      decisions: [{
        candidateId: 'candidate id',
        action: 'create | merge | defer | reject | route',
        reason: 'short rationale',
        priority: 'high | medium | low',
        targetOpenThreadId: 'optional existing open-thread id',
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
    const targetConcernId = typeof item.targetOpenThreadId === 'string' && item.targetOpenThreadId.trim()
      ? item.targetOpenThreadId.trim()
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

/**
 * Thrown when applying review decisions fails partway through a batch. Carries
 * the outcomes already applied so the caller can requeue ONLY unapplied
 * candidates — requeueing an applied candidate would duplicate its side
 * effects (created/merged concerns, routed handoffs) on retry.
 */
export class ConcernCandidateApplyError extends Error {
  readonly outcomes: readonly ConcernCandidateApplyOutcome[];
  readonly failedCandidateId: string;

  constructor(failedCandidateId: string, outcomes: readonly ConcernCandidateApplyOutcome[], cause: unknown) {
    super(`Concern candidate apply failed at candidate ${failedCandidateId}: ${String(cause)}`, { cause });
    this.name = 'ConcernCandidateApplyError';
    this.outcomes = outcomes;
    this.failedCandidateId = failedCandidateId;
  }
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
    try {
      outcomes.push(await applyConcernCandidateDecision({
        concernStore: options.concernStore,
        candidate,
        decision,
        ...(options.routeDispatcher ? { routeDispatcher: options.routeDispatcher } : {}),
        now: options.now,
      }));
    } catch (error) {
      // Fail loudly but keep the already-applied outcomes attached so the
      // caller can avoid duplicating their side effects on retry.
      throw new ConcernCandidateApplyError(candidate.id, outcomes, error);
    }
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
    case 'reject': {
      if (input.candidate.durableConcernId) {
        await input.concernStore.transitionConcernStatus(input.candidate.durableConcernId, {
          status: 'dismissed',
          transitionedAt: (input.now?.() ?? new Date()).toISOString(),
          evidenceRefs: input.candidate.evidenceRefs,
        });
      }
      return {
        candidateId: input.candidate.id,
        action: 'reject',
        status: 'rejected',
        reason: input.decision.reason,
      };
    }
    case 'defer': {
      if (input.candidate.durableConcernId) {
        await input.concernStore.transitionConcernStatus(input.candidate.durableConcernId, {
          status: 'deferred',
          transitionedAt: (input.now?.() ?? new Date()).toISOString(),
          evidenceRefs: input.candidate.evidenceRefs,
          ...(input.decision.dueAt ?? input.candidate.dueAt
            ? { nextReviewAt: input.decision.dueAt ?? input.candidate.dueAt }
            : {}),
        });
      }
      return {
        candidateId: input.candidate.id,
        action: 'defer',
        status: 'deferred',
        reason: input.decision.reason,
      };
    }
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
      if (input.candidate.durableConcernId && outcome.disposition === 'routed') {
        await input.concernStore.transitionConcernStatus(input.candidate.durableConcernId, {
          status: 'dismissed',
          transitionedAt: (input.now?.() ?? new Date()).toISOString(),
          evidenceRefs: input.candidate.evidenceRefs,
        });
      }
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
            reason: `target open thread ${input.decision.targetConcernId} was not available for merge`,
          };
        }
        if (input.candidate.durableConcernId
          && input.candidate.durableConcernId !== merged.id) {
          await input.concernStore.transitionConcernStatus(input.candidate.durableConcernId, {
            status: 'dismissed',
            transitionedAt: (input.now?.() ?? new Date()).toISOString(),
            evidenceRefs: input.candidate.evidenceRefs,
          });
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
      if (input.candidate.durableConcernId) {
        const activeCount = await countActiveAttentionConcerns(
          input.concernStore,
          input.now?.() ?? new Date(),
        );
        if (activeCount >= MAX_ACTIVE_CONCERNS) {
          await input.concernStore.transitionConcernStatus(input.candidate.durableConcernId, {
            status: 'dismissed',
            transitionedAt: (input.now?.() ?? new Date()).toISOString(),
            evidenceRefs: input.candidate.evidenceRefs,
          });
          return {
            candidateId: input.candidate.id,
            action: 'create',
            status: 'blocked',
            routeTarget: 'other',
            reason: `open-thread cap ${MAX_ACTIVE_CONCERNS} reached; candidate was not added`,
          };
        }
        let concern: ActiveConcern | null;
        try {
          concern = await input.concernStore.transitionConcernStatus(
            input.candidate.durableConcernId,
            {
              status: 'active',
              transitionedAt: (input.now?.() ?? new Date()).toISOString(),
              evidenceRefs: input.candidate.evidenceRefs,
              ...(input.decision.dueAt ?? input.candidate.dueAt
                ? { nextReviewAt: input.decision.dueAt ?? input.candidate.dueAt }
                : {}),
            },
          );
        } catch (error) {
          if (!String(error).includes(`Active concern cap reached (${MAX_ACTIVE_CONCERNS})`)) {
            throw error;
          }
          await input.concernStore.transitionConcernStatus(input.candidate.durableConcernId, {
            status: 'dismissed',
            transitionedAt: (input.now?.() ?? new Date()).toISOString(),
            evidenceRefs: input.candidate.evidenceRefs,
          });
          return {
            candidateId: input.candidate.id,
            action: 'create',
            status: 'blocked',
            routeTarget: 'other',
            reason: `open-thread cap ${MAX_ACTIVE_CONCERNS} reached; candidate was not added`,
          };
        }
        if (!concern) {
          throw new Error(`Durable concern candidate ${input.candidate.durableConcernId} is missing`);
        }
        return {
          candidateId: input.candidate.id,
          action: 'create',
          status: 'created',
          reason: input.decision.reason,
          concernId: concern.id,
        };
      }
      const activeCount = await countActiveAttentionConcerns(input.concernStore, input.now?.() ?? new Date());
      if (activeCount >= MAX_ACTIVE_CONCERNS) {
        return {
          candidateId: input.candidate.id,
          action: input.decision.action,
          status: 'blocked',
          routeTarget: 'other',
          reason: `open-thread cap ${MAX_ACTIVE_CONCERNS} reached; candidate was not added`,
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
        reason: `open-thread cap ${MAX_ACTIVE_CONCERNS} reached; candidate was not added`,
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
    let outcomes: ConcernCandidateApplyOutcome[];
    try {
      const review = await this.options.reviewer.review(candidates);
      outcomes = await applyConcernCandidateReview({
        concernStore: this.options.concernStore,
        candidates,
        decisions: review.decisions,
        ...(this.options.routeDispatcher ? { routeDispatcher: this.options.routeDispatcher } : {}),
        now: this.now,
      });
    } catch (error) {
      // Requeue only candidates whose apply did NOT complete — requeueing an
      // applied candidate would duplicate its side effects (e.g. a created
      // concern) on the retry run.
      const appliedIds = error instanceof ConcernCandidateApplyError
        ? new Set(error.outcomes.map(outcome => outcome.candidateId))
        : new Set<string>();
      this.options.queue.requeue(candidates.filter(candidate => !appliedIds.has(candidate.id)));
      throw error;
    }
    // The reviewed event is telemetry: an emit failure must not requeue an
    // already-applied batch, so it stays outside the requeue scope.
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

function candidateDedupeEvidenceRef(dedupeKey: string): ActiveConcernEvidenceRef {
  const digest = createHash('sha256').update(dedupeKey).digest('hex');
  return { kind: 'runtime', ref: `${DURABLE_CANDIDATE_DEDUPE_PREFIX}${digest}` };
}

function durableCandidateDedupeRef(concern: ActiveConcern): string | undefined {
  return concern.evidenceRefs.find(ref => (
    ref.kind === 'runtime' && ref.ref.startsWith(DURABLE_CANDIDATE_DEDUPE_PREFIX)
  ))?.ref;
}

function restoreDurableConcernCandidate(concern: ActiveConcern): ConcernCandidate {
  const snapshot = parseDurableCandidateReviewSnapshot(concern.candidateReviewSnapshot);
  return {
    ...snapshot,
    id: concern.id,
    dedupeKey: `durable-concern:${concern.id}`,
    durableConcernId: concern.id,
    source: 'memory_extraction',
    priorityHint: concern.priority,
    evidenceRefs: concern.evidenceRefs.filter(ref => (
      ref.kind !== 'runtime' || !ref.ref.startsWith(DURABLE_CANDIDATE_DEDUPE_PREFIX)
    )),
    createdAt: concern.createdAt,
    ...(concern.contactId ? { contactId: concern.contactId } : {}),
    ...(concern.nextReviewAt ? { dueAt: concern.nextReviewAt } : {}),
    ...(concern.formationVAD ? { formationVAD: concern.formationVAD } : {}),
  };
}

async function listAllDurableConcernCandidates(
  concernStore: ConcernStorePort,
  options: { includeExpired: boolean },
): Promise<ActiveConcern[]> {
  const candidates: ActiveConcern[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const batch = await concernStore.list({
      includeResolved: false,
      includeExpired: options.includeExpired,
      limit: MAX_LIST_LIMIT,
      offset,
    });
    candidates.push(...batch.filter(concern => concern.status === 'candidate'));
    hasMore = batch.length === MAX_LIST_LIMIT;
    if (hasMore) offset += batch.length;
  }
  return candidates;
}

export async function createAutomatedConcernRuntime(
  options: CreateAutomatedConcernRuntimeOptions,
): Promise<AutomatedConcernRuntime> {
  const queue = new ConcernCandidateQueue({
    ...(options.now ? { now: options.now } : {}),
  });
  const now = options.now?.() ?? new Date();
  const durableCandidates = await listAllDurableConcernCandidates(options.concernStore, {
    includeExpired: true,
  });
  for (const concern of durableCandidates) {
    if (concern.status !== 'candidate') continue;
    if (concern.candidateReviewSnapshot === undefined
      || concern.candidateReviewSnapshot === null) {
      log.warn('Skipping durable concern candidate because its review snapshot is missing', {
        concernId: concern.id,
      });
      continue;
    }
    const restoredCandidate = restoreDurableConcernCandidate(concern);
    if (Date.parse(concern.expiresAt) <= now.getTime()) {
      await options.concernStore.transitionConcernStatus(concern.id, {
        status: 'dismissed',
        transitionedAt: now.toISOString(),
        evidenceRefs: [{ kind: 'runtime', ref: 'concern-candidate-expired-before-review' }],
      });
      continue;
    }
    queue.enqueueMany([restoredCandidate]);
  }
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
    const derived = deriveConcernCandidatesFromExtraction({
      context,
      ...(options.now ? { now: options.now } : {}),
    });
    const existingCandidates = await listAllDurableConcernCandidates(options.concernStore, {
      includeExpired: false,
    });
    const candidatesByDedupeRef = new Map(existingCandidates.flatMap((concern) => {
      const ref = durableCandidateDedupeRef(concern);
      return ref ? [[ref, concern] as const] : [];
    }));
    const durableIds: string[] = [];
    const durableCandidates: ConcernCandidate[] = [];
    for (const candidate of derived) {
      const dedupeEvidence = candidateDedupeEvidenceRef(candidate.dedupeKey);
      const concern = candidatesByDedupeRef.get(dedupeEvidence.ref)
        ?? await options.concernStore.create({
          text: buildConcernText(candidate),
          priority: candidate.priorityHint,
          source: 'appraisal',
          status: 'candidate',
          createdAt: candidate.createdAt,
          ...(candidate.contactId ? { contactId: candidate.contactId } : {}),
          ...(candidate.formationVAD ? { formationVAD: candidate.formationVAD } : {}),
          ...(candidate.dueAt ? { nextReviewAt: candidate.dueAt } : {}),
          evidenceRefs: [...candidate.evidenceRefs, dedupeEvidence],
          candidateReviewSnapshot: buildDurableCandidateReviewSnapshot(candidate),
        });
      candidatesByDedupeRef.set(dedupeEvidence.ref, concern);
      durableIds.push(concern.id);
      if (concern.status === 'candidate') {
        durableCandidates.push({
          ...candidate,
          id: concern.id,
          dedupeKey: `durable-concern:${concern.id}`,
          durableConcernId: concern.id,
        });
      }
    }
    const enqueued = queue.enqueueMany(durableCandidates);
    if (enqueued.length > 0) {
      await options.eventBus.emit('intention.concern_candidate.enqueued', {
        candidateCount: enqueued.length,
        pendingCount: queue.pendingCount(),
        candidateIds: enqueued.map(candidate => candidate.id),
        channelId: context.channelId,
        timestamp: (options.now?.() ?? new Date()).getTime(),
        ...(context.turnId ? { turnId: context.turnId } : {}),
      });
    }
    return [...new Set(durableIds)];
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
  // Mirror the DB admission trigger (enforce_active_concern_attention_cap) exactly
  // so the app-side pre-check and the trigger cannot disagree about admission:
  //   resolved_at IS NULL AND status IN attention
  //   AND expires_at > asOf
  //   AND created_at > asOf - 7 days (MAX_ACTIVE_CONCERN_LIFETIME_MS)
  // asOf is the admission timestamp, which the trigger reads as NEW.last_reviewed_at.
  const asOfMs = asOf.getTime();
  const windowStartMs = asOfMs - MAX_ACTIVE_CONCERN_LIFETIME_MS;
  const active = await concernStore.getActiveConcerns();
  return active.filter(concern => (
    isConcernAttentionStatus(concern.status)
    && Date.parse(concern.expiresAt) > asOfMs
    && Date.parse(concern.createdAt) > windowStartMs
  )).length;
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
    return new Date(baseMs + TOMORROW_FOLLOW_UP_DELAY_MS).toISOString();
  }
  if (/\bnext\s+week\b/i.test(text)) {
    return new Date(baseMs + NEXT_WEEK_FOLLOW_UP_DELAY_MS).toISOString();
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
