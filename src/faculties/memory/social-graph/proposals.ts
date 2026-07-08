// ── Social-graph edge proposals (E4.2 graph-builder worker) ──
// Durable, file-backed queue of edge proposals emitted by the background
// graph-builder worker (the "gremlin in the gestalt"). Proposals are NOT live
// edges: they never touch social_relationship_edges until an operator accepts
// them in Garden. This mirrors the E3.4 pending-contact-approvals pattern —
// unaccepted proposals stay strictly out of the live graph exactly as
// unapproved speakers stay out of the contacts table.
//
// Store choice (justification): a SEPARATE durable proposal store rather than a
// status field on the edge row. The social_relationship_edges schema has no
// lifecycle/status column, and blending proposals into it would risk untrusted
// heuristic rows leaking into the live-graph consumers (retrieval, related-
// contact queries, future prompt exposure E4.4). A separate store keeps the
// live graph clean and fail-closed. File-backed (companion-data) matches the
// pending-contact-approvals precedent, is durable across restarts, and fits the
// low volume of background proposals.
//
// Idempotency + rejection blocking are keyed by an evidence-set hash: re-running
// the worker from the same watermark produces the same evidenceHash and is
// deduped; a rejected proposal's hash blocks the same evidence from ever
// re-proposing.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import type { SocialRelationshipKind } from '../../../core/contacts/types.js';

export type SocialGraphProposalStatus = 'pending' | 'accepted' | 'rejected' | 'conflict';

export type SocialGraphEvidenceClass =
  | 'co_presence'
  | 'overheard_interaction'
  | 'named_relationship';

export interface SocialGraphEdgeProposal {
  id: string;
  evidenceClass: SocialGraphEvidenceClass;
  /** Tracked source contact (the proposal never references untracked speakers). */
  sourceContactId: string;
  /** Tracked target contact. */
  targetContactId: string;
  sourceDisplayName: string;
  targetDisplayName: string;
  relationshipType: SocialRelationshipKind;
  /** false => undirected (symmetric, inherently both-ways); true => single direction. */
  directional: boolean;
  confidence: number;
  /** Max of the evidence memories' sensitivities (never below 'personal'). */
  sensitivity: SensitivityLevel;
  evidenceMemoryIds: string[];
  /** Stable dedupe/rejection identity: pair + type + directional + evidence set. */
  evidenceHash: string;
  channelId?: string;
  provenanceRefs: string[];
  rationale: string;
  status: SocialGraphProposalStatus;
  /** Set when status==='conflict': the pre-existing edge this proposal collides with. */
  conflictEdgeId?: string;
  conflictEdgeType?: SocialRelationshipKind;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Set on accept: the id of the edge the proposal was written through. */
  acceptedEdgeId?: string;
  /** Set on accept: the (possibly operator-adjusted) type actually written. */
  acceptedRelationshipType?: SocialRelationshipKind;
}

export interface SocialGraphProposalCreateInput {
  evidenceClass: SocialGraphEvidenceClass;
  sourceContactId: string;
  targetContactId: string;
  sourceDisplayName: string;
  targetDisplayName: string;
  relationshipType: SocialRelationshipKind;
  directional: boolean;
  confidence: number;
  sensitivity: SensitivityLevel;
  evidenceMemoryIds: string[];
  channelId?: string;
  provenanceRefs: string[];
  rationale: string;
  status: 'pending' | 'conflict';
  conflictEdgeId?: string;
  conflictEdgeType?: SocialRelationshipKind;
}

export interface SocialGraphProposalCreateResult {
  proposal: SocialGraphEdgeProposal;
  /** True only when a NEW proposal was persisted (an existing hash is deduped). */
  created: boolean;
}

export interface SocialGraphProposalStore {
  list(): Promise<SocialGraphEdgeProposal[]>;
  getById(id: string): Promise<SocialGraphEdgeProposal | undefined>;
  getByEvidenceHash(hash: string): Promise<SocialGraphEdgeProposal | undefined>;
  /** Idempotent create: an existing evidenceHash is returned untouched (created=false). */
  create(input: SocialGraphProposalCreateInput): Promise<SocialGraphProposalCreateResult>;
  markAccepted(
    id: string,
    outcome: { edgeId: string; relationshipType: SocialRelationshipKind; decidedBy?: string },
  ): Promise<SocialGraphEdgeProposal | undefined>;
  markRejected(
    id: string,
    outcome?: { decidedBy?: string },
  ): Promise<SocialGraphEdgeProposal | undefined>;
}

/**
 * Stable evidence identity for dedupe + rejection blocking. Order-independent
 * over the contact pair (for undirected proposals) and the evidence-memory set,
 * so a re-run from the same watermark yields the same hash.
 */
export function computeEvidenceHash(input: {
  sourceContactId: string;
  targetContactId: string;
  relationshipType: SocialRelationshipKind;
  directional: boolean;
  evidenceMemoryIds: readonly string[];
}): string {
  const pair = input.directional
    ? [input.sourceContactId, input.targetContactId]
    : [input.sourceContactId, input.targetContactId].sort();
  const evidence = [...new Set(input.evidenceMemoryIds)].sort();
  const fingerprint = [
    pair.join('>'),
    input.relationshipType,
    input.directional ? 'directed' : 'undirected',
    evidence.join(','),
  ].join('|');
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 32);
}

interface SocialGraphProposalFileShape {
  version: 1;
  proposals: SocialGraphEdgeProposal[];
}

function assertProposalShape(value: unknown, filePath: string): SocialGraphEdgeProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid social-graph proposal in ${filePath}`);
  }
  const entry = value as Record<string, unknown>;
  for (const field of ['id', 'sourceContactId', 'targetContactId', 'relationshipType', 'evidenceHash', 'status']) {
    if (typeof entry[field] !== 'string' || !(entry[field] as string).trim()) {
      throw new Error(`Invalid social-graph proposal in ${filePath}: missing ${field}`);
    }
  }
  if (!Array.isArray(entry.evidenceMemoryIds)) {
    throw new Error(`Invalid social-graph proposal in ${filePath}: evidenceMemoryIds must be an array`);
  }
  return value as SocialGraphEdgeProposal;
}

export function createFileSocialGraphProposalStore(
  filePath: string,
  options?: { now?: () => Date },
): SocialGraphProposalStore {
  const now = options?.now ?? (() => new Date());
  let loaded: Map<string, SocialGraphEdgeProposal> | null = null;
  // Serialize mutations so concurrent worker runs cannot interleave file writes.
  let mutationChain: Promise<unknown> = Promise.resolve();

  const load = (): Map<string, SocialGraphEdgeProposal> => {
    if (loaded) return loaded;
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        loaded = new Map();
        return loaded;
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as { version?: unknown; proposals?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.proposals)) {
      throw new Error(`Unsupported social-graph proposal file shape at ${filePath}`);
    }
    loaded = new Map(
      parsed.proposals.map((entry: unknown) => {
        const validated = assertProposalShape(entry, filePath);
        return [validated.id, validated];
      }),
    );
    return loaded;
  };

  const persist = (proposals: Map<string, SocialGraphEdgeProposal>): void => {
    const payload: SocialGraphProposalFileShape = {
      version: 1,
      proposals: [...proposals.values()],
    };
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, filePath);
  };

  const enqueueMutation = <T>(mutation: () => T): Promise<T> => {
    const next = mutationChain.then(() => mutation());
    mutationChain = next.catch(() => undefined);
    return next;
  };

  const findByHash = (
    proposals: Map<string, SocialGraphEdgeProposal>,
    hash: string,
  ): SocialGraphEdgeProposal | undefined => {
    for (const proposal of proposals.values()) {
      if (proposal.evidenceHash === hash) return proposal;
    }
    return undefined;
  };

  return {
    async list(): Promise<SocialGraphEdgeProposal[]> {
      return [...load().values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async getById(id: string): Promise<SocialGraphEdgeProposal | undefined> {
      return load().get(id);
    },

    async getByEvidenceHash(hash: string): Promise<SocialGraphEdgeProposal | undefined> {
      return findByHash(load(), hash);
    },

    create(input: SocialGraphProposalCreateInput): Promise<SocialGraphProposalCreateResult> {
      return enqueueMutation(() => {
        const proposals = load();
        const evidenceHash = computeEvidenceHash(input);
        // Idempotency + rejection blocking: any existing proposal for this exact
        // evidence set is returned untouched (accepted/rejected/pending/conflict).
        const existing = findByHash(proposals, evidenceHash);
        if (existing) {
          return { proposal: existing, created: false };
        }
        const timestamp = now().toISOString();
        const proposal: SocialGraphEdgeProposal = {
          id: uuidv7(),
          evidenceClass: input.evidenceClass,
          sourceContactId: input.sourceContactId,
          targetContactId: input.targetContactId,
          sourceDisplayName: input.sourceDisplayName,
          targetDisplayName: input.targetDisplayName,
          relationshipType: input.relationshipType,
          directional: input.directional,
          confidence: input.confidence,
          sensitivity: input.sensitivity,
          evidenceMemoryIds: [...new Set(input.evidenceMemoryIds)],
          evidenceHash,
          ...(input.channelId ? { channelId: input.channelId } : {}),
          provenanceRefs: [...new Set(input.provenanceRefs)],
          rationale: input.rationale,
          status: input.status,
          ...(input.conflictEdgeId ? { conflictEdgeId: input.conflictEdgeId } : {}),
          ...(input.conflictEdgeType ? { conflictEdgeType: input.conflictEdgeType } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        proposals.set(proposal.id, proposal);
        persist(proposals);
        return { proposal, created: true };
      });
    },

    markAccepted(
      id: string,
      outcome: { edgeId: string; relationshipType: SocialRelationshipKind; decidedBy?: string },
    ): Promise<SocialGraphEdgeProposal | undefined> {
      return enqueueMutation(() => {
        const proposals = load();
        const existing = proposals.get(id);
        if (!existing) return undefined;
        const timestamp = now().toISOString();
        const accepted: SocialGraphEdgeProposal = {
          ...existing,
          status: 'accepted',
          acceptedEdgeId: outcome.edgeId,
          acceptedRelationshipType: outcome.relationshipType,
          decidedAt: timestamp,
          updatedAt: timestamp,
          ...(outcome.decidedBy ? { decidedBy: outcome.decidedBy } : {}),
        };
        proposals.set(id, accepted);
        persist(proposals);
        return accepted;
      });
    },

    markRejected(
      id: string,
      outcome?: { decidedBy?: string },
    ): Promise<SocialGraphEdgeProposal | undefined> {
      return enqueueMutation(() => {
        const proposals = load();
        const existing = proposals.get(id);
        if (!existing) return undefined;
        const timestamp = now().toISOString();
        const rejected: SocialGraphEdgeProposal = {
          ...existing,
          status: 'rejected',
          decidedAt: timestamp,
          updatedAt: timestamp,
          ...(outcome?.decidedBy ? { decidedBy: outcome.decidedBy } : {}),
        };
        proposals.set(id, rejected);
        persist(proposals);
        return rejected;
      });
    },
  };
}

// ── Worker watermark ──
// Advisory cursor over memory extractedAt so the worker only rescans NEW
// room-scoped memories. Correctness of idempotency does NOT depend on this
// cursor (the evidence-hash dedupe is the guarantee); the watermark is a
// compute-budget optimisation (charter 8.8/8.9).

export interface SocialGraphBuilderWatermark {
  schemaVersion: 1;
  coveredUpToExtractedAtMs: number;
  /**
   * Memory id tiebreaker at coveredUpToExtractedAtMs. The cursor is composite
   * (extractedAt, id): a batch truncated at the scan limit can share the boundary
   * timestamp with rows it did not include, so a bare `extractedAt > sinceMs`
   * filter would strand those same-timestamp rows. Absent means no id boundary
   * (legacy watermark or a fresh start) and the scan starts strictly after
   * coveredUpToExtractedAtMs.
   */
  coveredUpToId?: string;
  updatedAt: number;
  lastRun?: {
    scanned: number;
    proposed: number;
    skippedUntracked: number;
    conflicts: number;
  };
}

export interface SocialGraphBuilderWatermarkStore {
  get(): SocialGraphBuilderWatermark;
  set(next: SocialGraphBuilderWatermark): void;
}

export function createEmptySocialGraphBuilderWatermark(): SocialGraphBuilderWatermark {
  return { schemaVersion: 1, coveredUpToExtractedAtMs: 0, updatedAt: 0 };
}

export function createFileSocialGraphBuilderWatermarkStore(
  filePath: string,
): SocialGraphBuilderWatermarkStore {
  return {
    get(): SocialGraphBuilderWatermark {
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return createEmptySocialGraphBuilderWatermark();
        }
        throw error;
      }
      const parsed = JSON.parse(raw) as Partial<SocialGraphBuilderWatermark>;
      if (parsed.schemaVersion !== 1 || typeof parsed.coveredUpToExtractedAtMs !== 'number') {
        throw new Error(`Invalid social-graph builder watermark file at ${filePath}`);
      }
      return {
        schemaVersion: 1,
        coveredUpToExtractedAtMs: parsed.coveredUpToExtractedAtMs,
        ...(typeof parsed.coveredUpToId === 'string' ? { coveredUpToId: parsed.coveredUpToId } : {}),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        ...(parsed.lastRun ? { lastRun: parsed.lastRun } : {}),
      };
    },
    set(next: SocialGraphBuilderWatermark): void {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      renameSync(tmpPath, filePath);
    },
  };
}
