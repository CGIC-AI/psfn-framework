// ── Shared-background retrieval (E4.5) ──
// "What links contact A and contact B" — a union of the memories that connect
// two people:
//   (a) edge-evidence:  memories cited as evidence on a live A<->B social edge
//   (b) co-mention:     memories whose provenance names BOTH contacts
//   (c) shared-room:    room-scoped memories from rooms BOTH are rostered in
//
// This is DATA for the operator/admin surface and a single ACTION on the
// canonical memory tool (Charter Law 33: never a new model-facing tool name).
//
// Ranking: no query text is supplied for this mode, so a semantic score is not
// computable. Candidates are ranked by evidence-source priority
// (edge_evidence > co_mention > shared_room), then salience, then recency. This
// keeps the strongest structural link (a curated edge) at the top of the set.
//
// Gating: computeSharedBackground applies the ASKING CONTEXT'S gates in full —
// every candidate flows through evaluateRetrievalAccessDecision, and blocked
// candidates are summarized (reason codes only, no text/ids leaked). Asking
// about A+B from a low-trust public room returns only what that room could see
// anyway. The operator/admin surface consumes the raw union
// (collectSharedBackgroundUnion) and applies its own E3.5 body gate instead.

import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { ChannelPrivacyLevel, Contact, SocialGraphEntity } from '../../../core/contacts/types.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { isInternalMemoryArtifact } from '../internal-artifacts.js';
import { clamp } from './scoring.js';
import {
  evaluateRetrievalAccessDecision,
  summarizeWithheldMemories,
  type RetrievalRoomVisibilityContext,
} from './access.js';
import type { MemoryWithheldSummary } from '../withheld-summary.js';

/** Default cap on the top-K shared-background set returned to a caller. */
export const SHARED_BACKGROUND_DEFAULT_LIMIT = 12;
/** Hard upper bound on a single shared-background set. */
export const SHARED_BACKGROUND_MAX_LIMIT = 25;
/**
 * Bounded cap on the ranked union assembled before gating/top-K. Keeps the
 * co-mention/shared-room full scan from producing an unbounded working set.
 */
export const SHARED_BACKGROUND_UNION_SCAN_CAP = 100;

/**
 * Which structural link surfaced a memory in the shared-background union. A
 * single memory can carry more than one source.
 */
export type SharedBackgroundSource = 'edge_evidence' | 'co_mention' | 'shared_room';

/** Provenance fields that count toward a co-mention (spec E4.5). */
const CO_MENTION_PROVENANCE_FIELDS = [
  'sourceAuthorId',
  'subjectContactId',
  'triggerContactId',
  'routedContactId',
] as const;

const SOURCE_PRIORITY: Record<SharedBackgroundSource, number> = {
  edge_evidence: 3,
  co_mention: 2,
  shared_room: 1,
};

/** One ranked candidate in the shared-background union. */
export interface SharedBackgroundCandidate {
  memory: PurrMemory;
  /** Distinct sources that surfaced this memory (deterministic order). */
  sources: SharedBackgroundSource[];
  /** Composite rank score: source priority + salience (recency breaks ties). */
  score: number;
}

/** Narrow port surface consumed by shared-background collection (read-only). */
export interface SharedBackgroundDeps {
  memoryStore: Pick<MemoryStorePort, 'getById' | 'listMemories'>;
  contactStore: {
    getById(contactId: string): PromiseLike<Contact | undefined> | Contact | undefined;
    getSocialGraphEntityByContactId(
      contactId: string,
    ): PromiseLike<SocialGraphEntity | undefined> | SocialGraphEntity | undefined;
    listSocialRelationshipEdges(query?: {
      contactId?: string;
      viewerTrustLevel?: TrustLevel;
      viewerChannelPrivacy?: ChannelPrivacyLevel;
    }): PromiseLike<Array<{
      sourceEntityId: string;
      targetEntityId: string;
      evidenceMemoryIds: string[];
    }>> | Array<{
      sourceEntityId: string;
      targetEntityId: string;
      evidenceMemoryIds: string[];
    }>;
  };
}

/** The asking context's gates — mirrors evaluateRetrievalAccessDecision options. */
export interface SharedBackgroundAccessOptions {
  trustLevel: TrustLevel;
  /** Context Envelope disclosure pair (E3.3). */
  channelPrivacy: ChannelPrivacy;
  broadcast: boolean;
  channelMeta?: ChannelMeta;
  canonicalContactId?: string;
  operatorApproval?: boolean;
  roomVisibility?: RetrievalRoomVisibilityContext;
}

export interface SharedBackgroundUnionQuery {
  contactAId: string;
  contactBId: string;
  /**
   * Optional viewer context used only to gate which social edges are visible
   * (read-only listSocialRelationshipEdges). Absent lists all edges.
   */
  viewerTrustLevel?: TrustLevel;
  viewerChannelPrivacy?: ChannelPrivacyLevel;
}

export interface SharedBackgroundUnion {
  contactAId: string;
  contactBId: string;
  contactADisplayName?: string;
  contactBDisplayName?: string;
  /** True only when both contacts resolved to real contact rows. */
  resolved: boolean;
  /** Contact ids that failed to resolve (subset of the requested pair). */
  missingContactIds: string[];
  /** Ranked union candidates (already capped at SHARED_BACKGROUND_UNION_SCAN_CAP). */
  candidates: SharedBackgroundCandidate[];
}

export interface SharedBackgroundQuery {
  contactAId: string;
  contactBId: string;
  access: SharedBackgroundAccessOptions;
  limit?: number;
}

export interface SharedBackgroundResult {
  contactAId: string;
  contactBId: string;
  contactADisplayName?: string;
  contactBDisplayName?: string;
  resolved: boolean;
  missingContactIds: string[];
  /** Visible, gated, top-K candidates (evidence-ranked). */
  items: SharedBackgroundCandidate[];
  /** Reason-coded summary of candidates the asking context could not see. */
  withheldSummary?: MemoryWithheldSummary;
  /** Total union candidates considered before gating/top-K. */
  totalCandidates: number;
  /** True when visible candidates exceeded the effective limit. */
  truncated: boolean;
  /** Effective top-K limit applied. */
  limit: number;
}

function normalizeId(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function collectContactRoomIds(contact: Contact | undefined): Set<string> {
  const rooms = new Set<string>();
  for (const conversation of contact?.conversationChannels ?? []) {
    const roomId = normalizeId(conversation.channelId);
    if (roomId) rooms.add(roomId);
  }
  return rooms;
}

/** Resolve the source room of a memory (conversation scope ref, else provenance channel). */
function resolveMemorySourceRoomId(memory: PurrMemory): string | undefined {
  if (memory.scopeRef?.kind === 'conversation') {
    const scoped = normalizeId(memory.scopeRef.id);
    if (scoped) return scoped;
  }
  return normalizeId(memory.provenance?.channelId);
}

function memoryNamesBoth(memory: PurrMemory, contactAId: string, contactBId: string): boolean {
  const provenance = memory.provenance;
  if (!provenance) return false;
  const named = new Set<string>();
  for (const field of CO_MENTION_PROVENANCE_FIELDS) {
    const value = normalizeId(provenance[field]);
    if (value) named.add(value);
  }
  return named.has(contactAId) && named.has(contactBId);
}

function candidateSourcePriority(candidate: SharedBackgroundCandidate): number {
  let best = 0;
  for (const source of candidate.sources) {
    best = Math.max(best, SOURCE_PRIORITY[source]);
  }
  return best;
}

function compareCandidates(
  left: SharedBackgroundCandidate,
  right: SharedBackgroundCandidate,
): number {
  const priorityDelta = candidateSourcePriority(right) - candidateSourcePriority(left);
  if (priorityDelta !== 0) return priorityDelta;
  const salienceDelta = clamp(right.memory.salience, 0, 1) - clamp(left.memory.salience, 0, 1);
  if (Math.abs(salienceDelta) > 1e-9) return salienceDelta;
  const recencyDelta = right.memory.extractedAt - left.memory.extractedAt;
  if (recencyDelta !== 0) return recencyDelta;
  return left.memory.id.localeCompare(right.memory.id);
}

function orderedSources(sources: ReadonlySet<SharedBackgroundSource>): SharedBackgroundSource[] {
  return (['edge_evidence', 'co_mention', 'shared_room'] as const).filter(source => sources.has(source));
}

function intersect(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  for (const value of left) {
    if (right.has(value)) result.add(value);
  }
  return result;
}

/**
 * Assemble the ungated, ranked union of memories that link A and B. Callers
 * choose their own gate: the memory tool / retriever apply the asking context's
 * retrieval gates (computeSharedBackground); the operator surface applies its
 * own E3.5 body gate.
 */
export async function collectSharedBackgroundUnion(
  deps: SharedBackgroundDeps,
  query: SharedBackgroundUnionQuery,
): Promise<SharedBackgroundUnion> {
  const contactAId = normalizeId(query.contactAId);
  const contactBId = normalizeId(query.contactBId);

  const missingContactIds: string[] = [];
  if (!contactAId) missingContactIds.push(query.contactAId);
  if (!contactBId) missingContactIds.push(query.contactBId);
  if (!contactAId || !contactBId || contactAId === contactBId) {
    return {
      contactAId: contactAId ?? query.contactAId,
      contactBId: contactBId ?? query.contactBId,
      resolved: false,
      missingContactIds,
      candidates: [],
    };
  }

  const [contactA, contactB] = await Promise.all([
    deps.contactStore.getById(contactAId),
    deps.contactStore.getById(contactBId),
  ]);
  if (!contactA) missingContactIds.push(contactAId);
  if (!contactB) missingContactIds.push(contactBId);
  if (!contactA || !contactB) {
    return {
      contactAId,
      contactBId,
      ...(contactA ? { contactADisplayName: contactA.displayName } : {}),
      ...(contactB ? { contactBDisplayName: contactB.displayName } : {}),
      resolved: false,
      missingContactIds,
      candidates: [],
    };
  }

  const union = new Map<string, { memory: PurrMemory; sources: Set<SharedBackgroundSource> }>();
  const addSource = (memory: PurrMemory, source: SharedBackgroundSource): void => {
    if (isInternalMemoryArtifact(memory)) return;
    const existing = union.get(memory.id);
    if (existing) {
      existing.sources.add(source);
      return;
    }
    union.set(memory.id, { memory, sources: new Set([source]) });
  };

  // (a) Edge-evidence: memories cited on a live A<->B social edge.
  const [aEntity, bEntity] = await Promise.all([
    deps.contactStore.getSocialGraphEntityByContactId(contactAId),
    deps.contactStore.getSocialGraphEntityByContactId(contactBId),
  ]);
  if (aEntity && bEntity) {
    const edges = await deps.contactStore.listSocialRelationshipEdges({
      contactId: contactAId,
      ...(query.viewerTrustLevel ? { viewerTrustLevel: query.viewerTrustLevel } : {}),
      ...(query.viewerChannelPrivacy ? { viewerChannelPrivacy: query.viewerChannelPrivacy } : {}),
    });
    const evidenceIds = new Set<string>();
    for (const edge of edges) {
      const endpoints = new Set([edge.sourceEntityId, edge.targetEntityId]);
      if (endpoints.has(aEntity.id) && endpoints.has(bEntity.id)) {
        for (const id of edge.evidenceMemoryIds) {
          const normalized = normalizeId(id);
          if (normalized) evidenceIds.add(normalized);
        }
      }
    }
    for (const id of evidenceIds) {
      const memory = await deps.memoryStore.getById(id);
      if (!memory || memory.deletedAt !== undefined) continue;
      addSource(memory, 'edge_evidence');
    }
  }

  // (b) co-mention + (c) shared-room: single scan over active memories.
  const sharedRooms = intersect(collectContactRoomIds(contactA), collectContactRoomIds(contactB));
  const memories = await deps.memoryStore.listMemories();
  for (const memory of memories) {
    if (memory.deletedAt !== undefined) continue;
    if (memoryNamesBoth(memory, contactAId, contactBId)) {
      addSource(memory, 'co_mention');
    }
    if (sharedRooms.size > 0) {
      const roomId = resolveMemorySourceRoomId(memory);
      if (roomId && sharedRooms.has(roomId)) {
        addSource(memory, 'shared_room');
      }
    }
  }

  const candidates: SharedBackgroundCandidate[] = [...union.values()].map(entry => {
    const sources = orderedSources(entry.sources);
    const priority = Math.max(...sources.map(source => SOURCE_PRIORITY[source]));
    return {
      memory: entry.memory,
      sources,
      score: priority + clamp(entry.memory.salience, 0, 1),
    };
  });
  candidates.sort(compareCandidates);

  return {
    contactAId,
    contactBId,
    contactADisplayName: contactA.displayName,
    contactBDisplayName: contactB.displayName,
    resolved: true,
    missingContactIds,
    candidates: candidates.slice(0, SHARED_BACKGROUND_UNION_SCAN_CAP),
  };
}

/**
 * Shared-background retrieval with the asking context's gates applied in full.
 * Every union candidate flows through evaluateRetrievalAccessDecision; blocked
 * candidates are summarized with reason codes (no text/ids leaked). Visible
 * candidates are returned evidence-ranked and bounded to top-K.
 */
export async function computeSharedBackground(
  deps: SharedBackgroundDeps,
  query: SharedBackgroundQuery,
): Promise<SharedBackgroundResult> {
  const limit = clamp(
    Number.isFinite(query.limit) ? Math.floor(query.limit as number) : SHARED_BACKGROUND_DEFAULT_LIMIT,
    1,
    SHARED_BACKGROUND_MAX_LIMIT,
  );

  const union = await collectSharedBackgroundUnion(deps, {
    contactAId: query.contactAId,
    contactBId: query.contactBId,
    viewerTrustLevel: query.access.trustLevel,
    viewerChannelPrivacy: query.access.channelPrivacy,
  });

  const access = {
    trustLevel: query.access.trustLevel,
    channelPrivacy: query.access.channelPrivacy,
    broadcast: query.access.broadcast,
    ...(query.access.channelMeta ? { channelMeta: query.access.channelMeta } : {}),
    ...(query.access.canonicalContactId ? { canonicalContactId: query.access.canonicalContactId } : {}),
    ...(query.access.operatorApproval !== undefined ? { operatorApproval: query.access.operatorApproval } : {}),
    ...(query.access.roomVisibility ? { roomVisibility: query.access.roomVisibility } : {}),
  };

  const visible: SharedBackgroundCandidate[] = [];
  const withheldMemories: PurrMemory[] = [];
  for (const candidate of union.candidates) {
    if (evaluateRetrievalAccessDecision(candidate.memory, access).allowed) {
      visible.push(candidate);
    } else {
      withheldMemories.push(candidate.memory);
    }
  }

  const { summary } = summarizeWithheldMemories(withheldMemories, access);

  return {
    contactAId: union.contactAId,
    contactBId: union.contactBId,
    ...(union.contactADisplayName ? { contactADisplayName: union.contactADisplayName } : {}),
    ...(union.contactBDisplayName ? { contactBDisplayName: union.contactBDisplayName } : {}),
    resolved: union.resolved,
    missingContactIds: union.missingContactIds,
    items: visible.slice(0, limit),
    ...(summary ? { withheldSummary: summary } : {}),
    totalCandidates: union.candidates.length,
    truncated: visible.length > limit,
    limit,
  };
}

/** Model-surface provider consumed by the canonical memory tool (Law 33). */
export interface SharedBackgroundProvider {
  sharedBackground(query: SharedBackgroundQuery): Promise<SharedBackgroundResult>;
}

/** Build a provider over the read-only store surfaces (tool + garden wiring). */
export function createSharedBackgroundProvider(deps: SharedBackgroundDeps): SharedBackgroundProvider {
  return {
    sharedBackground: (query) => computeSharedBackground(deps, query),
  };
}
