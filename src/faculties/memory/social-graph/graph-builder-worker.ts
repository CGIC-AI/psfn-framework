// ── Social-graph builder worker (E4.2 — "the gremlin in the gestalt") ──
// Background job in the memory-agent lane. Reads NEW room-scoped memories since
// its watermark and proposes social-graph edges from three evidence classes.
// It NEVER runs in the chat path and NEVER writes live edges — it only emits
// proposals into the durable proposal store (see ./proposals.ts). Operator
// acceptance in Garden is what writes the edge through
// upsertSocialRelationshipEdge.
//
// Evidence classes:
//   a) Repeated co-presence — two tracked contacts co-active in the same room
//      across >= coPresenceMinSessions windows -> 'acquaintance' (undirected),
//      confidence ~0.5.
//   b) Overheard interactions — a memory addressMode 'overheard_room_context'
//      naming two tracked people (sourceContactId + subjectContactId) -> typed
//      per inferRelationshipTypeFromFact (coarse) else acquaintance,
//      confidence ~0.6.
//   c) Named-relationship facts ("my sister Iki") — a relational statement whose
//      subject is a tracked contact -> typed per fine keyword inference,
//      bidirectional for symmetric kinds, single-direction for asymmetric
//      (inverse table is E4.3), confidence ~0.7.
//
// Fail-closed: any candidate whose source OR target is not a TRACKED contact
// (no contact row) is dropped (skippedUntracked) — E3.4 guarantees untracked
// speakers have no contactId, so they can never enter the graph.

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type {
  SocialRelationshipEdge,
  SocialRelationshipKind,
} from '../../../core/contacts/types.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import { SENSITIVITY_LEVELS, sensitivityOrd } from '../../../system/trust/types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { PurrMemory } from '../types.js';
import type { ExtractedFact } from '../types.js';
import { inferRelationshipTypeFromFact } from '../extraction/mention-only-contacts.js';
import {
  coarseRelationshipTypeToKind,
  inferSocialRelationshipKindFromText,
} from './relationship-inference.js';
import {
  computeEvidenceHash,
  type SocialGraphBuilderWatermarkStore,
  type SocialGraphEvidenceClass,
  type SocialGraphProposalStore,
} from './proposals.js';

const log = createComponentLogger('SocialGraphBuilder');

export const SOCIAL_GRAPH_BUILDER_TASK_ID = 'social-graph-builder';

const CO_PRESENCE_CONFIDENCE = 0.5;
const OVERHEARD_CONFIDENCE = 0.6;
const NAMED_RELATIONSHIP_CONFIDENCE = 0.7;
const MAX_EVIDENCE_MEMORY_IDS = 24;

// Group address modes that indicate room-context (excludes 'system_api').
const ROOM_ADDRESS_MODES = new Set([
  'direct_to_companion',
  'mention_of_companion',
  'reply_to_user',
  'overheard_room_context',
]);

export interface SocialGraphBuilderConfig {
  /** Distinct co-presence windows required before an acquaintance is proposed. */
  coPresenceMinSessions: number;
  /** Fallback window size when a memory has no provenance.sessionId (minutes). */
  coPresenceWindowMinutes: number;
  /** Max memories scanned per run. */
  scanMemoryLimit: number;
}

export const DEFAULT_SOCIAL_GRAPH_BUILDER_CONFIG: SocialGraphBuilderConfig = {
  coPresenceMinSessions: 3,
  coPresenceWindowMinutes: 1440,
  scanMemoryLimit: 500,
};

export interface SocialGraphBuilderTelemetry {
  scanned: number;
  /** New pending proposals created. */
  proposed: number;
  /** New conflict proposals created (collision with a differently-typed live edge). */
  conflicts: number;
  /** Candidates dropped because a party was not a tracked contact. */
  skippedUntracked: number;
  /** Candidates skipped as already represented or already proposed (idempotency). */
  deduped: number;
  watermarkAdvancedToMs: number;
  runAtMs: number;
}

type SocialGraphBuilderContactPort = Pick<
  ContactStorePort,
  'getById' | 'getSocialGraphEntityByContactId' | 'listSocialRelationshipEdges'
>;

export interface SocialGraphBuilderMemoryReader {
  /** Room-scoped memories with extractedAt > sinceMs, ascending, bounded by limit. */
  listRoomScopedMemoriesSince(sinceMs: number, limit: number): Promise<PurrMemory[]>;
}

export interface SocialGraphBuilderWorkerOptions {
  memoryReader: SocialGraphBuilderMemoryReader;
  contacts: SocialGraphBuilderContactPort;
  proposalStore: SocialGraphProposalStore;
  watermarkStore: SocialGraphBuilderWatermarkStore;
  config?: Partial<SocialGraphBuilderConfig>;
  /** Completion telemetry sink (wired to the event bus by composition). */
  onComplete?: (telemetry: SocialGraphBuilderTelemetry) => void;
  now?: () => number;
}

interface EdgeCandidate {
  evidenceClass: SocialGraphEvidenceClass;
  sourceContactId: string;
  targetContactId: string;
  relationshipType: SocialRelationshipKind;
  directional: boolean;
  confidence: number;
  evidenceMemoryIds: string[];
  sensitivity: SensitivityLevel;
  channelId?: string;
  rationale: string;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeConfig(config?: Partial<SocialGraphBuilderConfig>): SocialGraphBuilderConfig {
  return {
    coPresenceMinSessions: normalizePositiveInteger(
      config?.coPresenceMinSessions,
      DEFAULT_SOCIAL_GRAPH_BUILDER_CONFIG.coPresenceMinSessions,
    ),
    coPresenceWindowMinutes: normalizePositiveInteger(
      config?.coPresenceWindowMinutes,
      DEFAULT_SOCIAL_GRAPH_BUILDER_CONFIG.coPresenceWindowMinutes,
    ),
    scanMemoryLimit: normalizePositiveInteger(
      config?.scanMemoryLimit,
      DEFAULT_SOCIAL_GRAPH_BUILDER_CONFIG.scanMemoryLimit,
    ),
  };
}

function maxSensitivity(memories: readonly PurrMemory[]): SensitivityLevel {
  let current: SensitivityLevel = 'personal';
  for (const memory of memories) {
    const level = SENSITIVITY_LEVELS.includes(memory.sensitivity) ? memory.sensitivity : 'personal';
    if (sensitivityOrd(level) > sensitivityOrd(current)) current = level;
  }
  return current;
}

function boundedEvidenceIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort().slice(0, MAX_EVIDENCE_MEMORY_IDS);
}

function memoryToFact(memory: PurrMemory): ExtractedFact {
  return {
    text: memory.text,
    type: 'relational',
    importance: memory.importance,
    emotionalValence: memory.emotionalValence,
    confidence: memory.confidence,
    tags: memory.tags,
  };
}

/**
 * (a) Repeated co-presence. Groups room-scoped memories by channel, then by
 * window (provenance.sessionId, else an extractedAt time-bucket). A pair of
 * distinct tracked authors co-present in >= minSessions windows yields one
 * undirected 'acquaintance' proposal.
 */
function buildCoPresenceCandidates(
  memories: readonly PurrMemory[],
  config: SocialGraphBuilderConfig,
): EdgeCandidate[] {
  const windowMs = config.coPresenceWindowMinutes * 60_000;
  // channelId -> windowKey -> authorContactId -> memory[]
  const byChannel = new Map<string, Map<string, Map<string, PurrMemory[]>>>();
  for (const memory of memories) {
    const channelId = memory.provenance?.channelId;
    const author = memory.provenance?.sourceContactId;
    if (!channelId || !author) continue;
    const windowKey = memory.provenance?.sessionId
      ?? `${channelId}#${Math.floor(memory.extractedAt / windowMs)}`;
    const windows = byChannel.get(channelId) ?? new Map<string, Map<string, PurrMemory[]>>();
    byChannel.set(channelId, windows);
    const authors = windows.get(windowKey) ?? new Map<string, PurrMemory[]>();
    windows.set(windowKey, authors);
    const authored = authors.get(author) ?? [];
    authored.push(memory);
    authors.set(author, authored);
  }

  const candidates: EdgeCandidate[] = [];
  for (const [channelId, windows] of byChannel) {
    // pairKey -> { windowKeys, memories }
    const pairs = new Map<string, { a: string; b: string; windowKeys: Set<string>; memories: Map<string, PurrMemory> }>();
    for (const [windowKey, authors] of windows) {
      const authorIds = [...authors.keys()];
      for (let i = 0; i < authorIds.length; i += 1) {
        for (let j = i + 1; j < authorIds.length; j += 1) {
          const [a, b] = [authorIds[i], authorIds[j]].sort();
          if (a === b) continue;
          const key = `${a}${b}`;
          const entry = pairs.get(key) ?? { a, b, windowKeys: new Set<string>(), memories: new Map<string, PurrMemory>() };
          pairs.set(key, entry);
          entry.windowKeys.add(windowKey);
          for (const memory of [...(authors.get(a) ?? []), ...(authors.get(b) ?? [])]) {
            entry.memories.set(memory.id, memory);
          }
        }
      }
    }
    for (const entry of pairs.values()) {
      if (entry.windowKeys.size < config.coPresenceMinSessions) continue;
      const evidenceMemories = [...entry.memories.values()];
      candidates.push({
        evidenceClass: 'co_presence',
        sourceContactId: entry.a,
        targetContactId: entry.b,
        relationshipType: 'acquaintance',
        directional: false,
        confidence: CO_PRESENCE_CONFIDENCE,
        evidenceMemoryIds: boundedEvidenceIds([...entry.memories.keys()]),
        sensitivity: maxSensitivity(evidenceMemories),
        channelId,
        rationale: `Co-present in ${entry.windowKeys.size} room sessions in ${channelId}.`,
      });
    }
  }
  return candidates;
}

/**
 * (b) Overheard interactions. A memory addressMode 'overheard_room_context'
 * naming two tracked people (sourceContactId + subjectContactId).
 */
function buildOverheardCandidates(memories: readonly PurrMemory[]): EdgeCandidate[] {
  const candidates: EdgeCandidate[] = [];
  for (const memory of memories) {
    if (memory.provenance?.addressMode !== 'overheard_room_context') continue;
    const source = memory.provenance.sourceContactId;
    const target = memory.provenance.subjectContactId;
    if (!source || !target || source === target) continue;
    const coarse = inferRelationshipTypeFromFact(memoryToFact(memory));
    const kind: SocialRelationshipKind = coarse ? coarseRelationshipTypeToKind(coarse) : 'acquaintance';
    candidates.push({
      evidenceClass: 'overheard_interaction',
      sourceContactId: source,
      targetContactId: target,
      relationshipType: kind,
      directional: false,
      confidence: OVERHEARD_CONFIDENCE,
      evidenceMemoryIds: [memory.id],
      sensitivity: maxSensitivity([memory]),
      ...(memory.provenance.channelId ? { channelId: memory.provenance.channelId } : {}),
      rationale: `Overheard interaction naming both contacts (${kind}).`,
    });
  }
  return candidates;
}

/**
 * (c) Named-relationship facts. First-person relational statements (NOT
 * overheard) whose subject is a tracked contact and whose text carries a fine
 * relationship keyword -> typed proposal. Symmetric kinds are undirected
 * (bidirectional); asymmetric kinds are single-direction (inverse edge is E4.3).
 */
function buildNamedRelationshipCandidates(memories: readonly PurrMemory[]): EdgeCandidate[] {
  const candidates: EdgeCandidate[] = [];
  for (const memory of memories) {
    if (memory.provenance?.addressMode === 'overheard_room_context') continue;
    const source = memory.provenance?.sourceContactId;
    const target = memory.provenance?.subjectContactId;
    if (!source || !target || source === target) continue;
    const inference = inferSocialRelationshipKindFromText(memory.text);
    if (!inference) continue;
    candidates.push({
      evidenceClass: 'named_relationship',
      sourceContactId: source,
      targetContactId: target,
      relationshipType: inference.kind,
      directional: inference.directional,
      confidence: NAMED_RELATIONSHIP_CONFIDENCE,
      evidenceMemoryIds: [memory.id],
      sensitivity: maxSensitivity([memory]),
      ...(memory.provenance?.channelId ? { channelId: memory.provenance.channelId } : {}),
      rationale: inference.directional
        ? `Named-relationship fact: target is source's ${inference.kind} (single direction; inverse is E4.3).`
        : `Named-relationship fact: ${inference.kind} (bidirectional).`,
    });
  }
  return candidates;
}

export class SocialGraphBuilderWorker {
  private readonly memoryReader: SocialGraphBuilderMemoryReader;
  private readonly contacts: SocialGraphBuilderContactPort;
  private readonly proposalStore: SocialGraphProposalStore;
  private readonly watermarkStore: SocialGraphBuilderWatermarkStore;
  private readonly config: SocialGraphBuilderConfig;
  private readonly onComplete?: (telemetry: SocialGraphBuilderTelemetry) => void;
  private readonly now: () => number;

  constructor(options: SocialGraphBuilderWorkerOptions) {
    this.memoryReader = options.memoryReader;
    this.contacts = options.contacts;
    this.proposalStore = options.proposalStore;
    this.watermarkStore = options.watermarkStore;
    this.config = normalizeConfig(options.config);
    this.onComplete = options.onComplete;
    this.now = options.now ?? (() => Date.now());
  }

  async run(): Promise<SocialGraphBuilderTelemetry> {
    const runAtMs = this.now();
    const watermark = this.watermarkStore.get();
    const memories = await this.memoryReader.listRoomScopedMemoriesSince(
      watermark.coveredUpToExtractedAtMs,
      this.config.scanMemoryLimit,
    );

    const candidates: EdgeCandidate[] = [
      ...buildCoPresenceCandidates(memories, this.config),
      ...buildOverheardCandidates(memories),
      ...buildNamedRelationshipCandidates(memories),
    ];

    let proposed = 0;
    let conflicts = 0;
    let skippedUntracked = 0;
    let deduped = 0;
    for (const candidate of candidates) {
      const outcome = await this.processCandidate(candidate);
      if (outcome === 'proposed') proposed += 1;
      else if (outcome === 'conflict') conflicts += 1;
      else if (outcome === 'skipped_untracked') skippedUntracked += 1;
      else deduped += 1;
    }

    const maxExtractedAt = memories.reduce(
      (max, memory) => Math.max(max, memory.extractedAt),
      watermark.coveredUpToExtractedAtMs,
    );
    const telemetry: SocialGraphBuilderTelemetry = {
      scanned: memories.length,
      proposed,
      conflicts,
      skippedUntracked,
      deduped,
      watermarkAdvancedToMs: maxExtractedAt,
      runAtMs,
    };
    this.watermarkStore.set({
      schemaVersion: 1,
      coveredUpToExtractedAtMs: maxExtractedAt,
      updatedAt: runAtMs,
      lastRun: { scanned: telemetry.scanned, proposed, skippedUntracked, conflicts },
    });
    this.onComplete?.(telemetry);
    log.info('Social-graph builder run complete', { ...telemetry });
    return telemetry;
  }

  private async processCandidate(
    candidate: EdgeCandidate,
  ): Promise<'proposed' | 'conflict' | 'skipped_untracked' | 'deduped'> {
    // Fail-closed tracked-contact assertion (AC3): both parties must have a row.
    const source = await this.contacts.getById(candidate.sourceContactId);
    const target = await this.contacts.getById(candidate.targetContactId);
    if (!source || !target || source.id === target.id) {
      return 'skipped_untracked';
    }

    const evidenceHash = computeEvidenceHash(candidate);
    // Idempotency + rejection blocking: an existing proposal for this exact
    // evidence set is never re-created (pending/accepted/rejected/conflict alike).
    const existing = await this.proposalStore.getByEvidenceHash(evidenceHash);
    if (existing) {
      return 'deduped';
    }

    const { sameType, conflictEdge } = await this.inspectExistingEdges(
      candidate.sourceContactId,
      candidate.targetContactId,
      candidate.relationshipType,
    );
    // Already represented by a same-type live edge -> nothing to propose.
    if (sameType) {
      return 'deduped';
    }

    const provenanceRefs = [
      'source:social_graph_builder',
      `evidence_class:${candidate.evidenceClass}`,
      ...(candidate.channelId ? [`channel:${candidate.channelId}`] : []),
    ];

    if (conflictEdge) {
      // Conflict is NOT auto-resolved: it lands in review, live edge untouched.
      const result = await this.proposalStore.create({
        evidenceClass: candidate.evidenceClass,
        sourceContactId: candidate.sourceContactId,
        targetContactId: candidate.targetContactId,
        sourceDisplayName: source.displayName,
        targetDisplayName: target.displayName,
        relationshipType: candidate.relationshipType,
        directional: candidate.directional,
        confidence: candidate.confidence,
        sensitivity: candidate.sensitivity,
        evidenceMemoryIds: candidate.evidenceMemoryIds,
        ...(candidate.channelId ? { channelId: candidate.channelId } : {}),
        provenanceRefs,
        rationale: candidate.rationale,
        status: 'conflict',
        conflictEdgeId: conflictEdge.id,
        conflictEdgeType: conflictEdge.relationshipType,
      });
      return result.created ? 'conflict' : 'deduped';
    }

    const result = await this.proposalStore.create({
      evidenceClass: candidate.evidenceClass,
      sourceContactId: candidate.sourceContactId,
      targetContactId: candidate.targetContactId,
      sourceDisplayName: source.displayName,
      targetDisplayName: target.displayName,
      relationshipType: candidate.relationshipType,
      directional: candidate.directional,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      evidenceMemoryIds: candidate.evidenceMemoryIds,
      ...(candidate.channelId ? { channelId: candidate.channelId } : {}),
      provenanceRefs,
      rationale: candidate.rationale,
      status: 'pending',
    });
    return result.created ? 'proposed' : 'deduped';
  }

  private async inspectExistingEdges(
    sourceContactId: string,
    targetContactId: string,
    relationshipType: SocialRelationshipKind,
  ): Promise<{ sameType: boolean; conflictEdge?: SocialRelationshipEdge }> {
    const sourceEntity = await this.contacts.getSocialGraphEntityByContactId(sourceContactId);
    const targetEntity = await this.contacts.getSocialGraphEntityByContactId(targetContactId);
    if (!sourceEntity || !targetEntity) {
      return { sameType: false };
    }
    // Full visibility: the worker is a system actor, not a channel viewer.
    const edges = await this.contacts.listSocialRelationshipEdges({
      entityId: sourceEntity.id,
      viewerTrustLevel: 'primary',
      viewerChannelVisibility: 'private',
    });
    const between = edges.filter(edge => (
      (edge.sourceEntityId === sourceEntity.id && edge.targetEntityId === targetEntity.id)
      || (edge.sourceEntityId === targetEntity.id && edge.targetEntityId === sourceEntity.id)
    ));
    if (between.length === 0) {
      return { sameType: false };
    }
    if (between.some(edge => edge.relationshipType === relationshipType)) {
      return { sameType: true };
    }
    // Same pair, different type -> conflict (surface the first differing edge).
    return { sameType: false, conflictEdge: between[0] };
  }
}

/**
 * Adapter: room-scoped memory reader over the runtime contact + memory stores.
 * Pulls the latest memories per known room and filters to group room-context
 * memories newer than the watermark. Wired by composition (agent/main.ts).
 */
export function createSocialGraphBuilderMemoryReader(deps: {
  listRoomChannelIds: () => Promise<string[]>;
  getMemoriesByChannel: (channelId: string, limit: number) => Promise<PurrMemory[]>;
}): SocialGraphBuilderMemoryReader {
  return {
    async listRoomScopedMemoriesSince(sinceMs: number, limit: number): Promise<PurrMemory[]> {
      const channelIds = await deps.listRoomChannelIds();
      const collected: PurrMemory[] = [];
      for (const channelId of channelIds) {
        const memories = await deps.getMemoriesByChannel(channelId, limit);
        for (const memory of memories) {
          if (memory.extractedAt <= sinceMs) continue;
          const addressMode = memory.provenance?.addressMode;
          if (!addressMode || !ROOM_ADDRESS_MODES.has(addressMode)) continue;
          if (!memory.provenance?.channelId) continue;
          collected.push(memory);
        }
      }
      return collected
        .sort((left, right) => left.extractedAt - right.extractedAt)
        .slice(0, limit);
    },
  };
}
