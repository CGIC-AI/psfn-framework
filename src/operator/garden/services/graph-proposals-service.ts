// ── Garden social-graph proposal review service (E4.2) ──
// Operator-facing surface over the durable edge-proposal store emitted by the
// background graph-builder worker. Proposals are NOT live edges: acceptance
// here is what writes the edge through the normal upsertSocialRelationshipEdge
// path (Law 31 — results are operator-visible, never silent). Rejection
// persists so the same evidence never re-proposes.
//
// Decision semantics:
//   approve  — writes the edge (optionally with an operator-adjusted type) and
//              marks the proposal 'accepted'.
//   reject   — marks the proposal 'rejected'; the evidence hash blocks
//              re-proposal.

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import {
  VALID_SOCIAL_RELATIONSHIP_KINDS,
  type SocialRelationshipKind,
} from '../../../core/contacts/types.js';
import type {
  SocialGraphEdgeProposal,
  SocialGraphProposalStore,
} from '../../../faculties/memory/social-graph/proposals.js';

export interface AdminGraphProposalView {
  id: string;
  evidenceClass: SocialGraphEdgeProposal['evidenceClass'];
  sourceContactId: string;
  targetContactId: string;
  sourceDisplayName: string;
  targetDisplayName: string;
  relationshipType: SocialRelationshipKind;
  directional: boolean;
  confidence: number;
  sensitivity: SocialGraphEdgeProposal['sensitivity'];
  evidenceMemoryIds: string[];
  channelId?: string;
  rationale: string;
  status: SocialGraphEdgeProposal['status'];
  conflictEdgeId?: string;
  conflictEdgeType?: SocialRelationshipKind;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  acceptedEdgeId?: string;
  acceptedRelationshipType?: SocialRelationshipKind;
}

export interface AdminGraphProposalListData {
  proposals: AdminGraphProposalView[];
}

export type AdminGraphProposalMutationResult =
  | { ok: true; edgeId?: string; relationshipType?: SocialRelationshipKind }
  | { ok: false; message: string };

export interface AdminGraphProposalsService {
  listGraphProposals(): Promise<AdminGraphProposalListData>;
  approveGraphProposal(
    id: string,
    adjustedType?: string,
  ): Promise<AdminGraphProposalMutationResult>;
  rejectGraphProposal(id: string): Promise<AdminGraphProposalMutationResult>;
}

type EdgeWriteContactPort = Pick<
  ContactStorePort,
  'getSocialGraphEntityByContactId' | 'upsertSocialGraphEntity' | 'upsertSocialRelationshipEdge' | 'getById'
>;

function toView(proposal: SocialGraphEdgeProposal): AdminGraphProposalView {
  return {
    id: proposal.id,
    evidenceClass: proposal.evidenceClass,
    sourceContactId: proposal.sourceContactId,
    targetContactId: proposal.targetContactId,
    sourceDisplayName: proposal.sourceDisplayName,
    targetDisplayName: proposal.targetDisplayName,
    relationshipType: proposal.relationshipType,
    directional: proposal.directional,
    confidence: proposal.confidence,
    sensitivity: proposal.sensitivity,
    evidenceMemoryIds: [...proposal.evidenceMemoryIds],
    ...(proposal.channelId ? { channelId: proposal.channelId } : {}),
    rationale: proposal.rationale,
    status: proposal.status,
    ...(proposal.conflictEdgeId ? { conflictEdgeId: proposal.conflictEdgeId } : {}),
    ...(proposal.conflictEdgeType ? { conflictEdgeType: proposal.conflictEdgeType } : {}),
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    ...(proposal.decidedAt ? { decidedAt: proposal.decidedAt } : {}),
    ...(proposal.decidedBy ? { decidedBy: proposal.decidedBy } : {}),
    ...(proposal.acceptedEdgeId ? { acceptedEdgeId: proposal.acceptedEdgeId } : {}),
    ...(proposal.acceptedRelationshipType ? { acceptedRelationshipType: proposal.acceptedRelationshipType } : {}),
  };
}

function normalizeAdjustedType(raw: string | undefined): SocialRelationshipKind | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  return VALID_SOCIAL_RELATIONSHIP_KINDS.includes(normalized as SocialRelationshipKind)
    ? (normalized as SocialRelationshipKind)
    : 'invalid';
}

export function createAdminGraphProposalsService(options: {
  proposalStore: SocialGraphProposalStore;
  contactStore: EdgeWriteContactPort | null;
}): AdminGraphProposalsService {
  const { proposalStore, contactStore } = options;

  async function ensureEntityId(contactId: string, displayName: string): Promise<string> {
    if (!contactStore) throw new Error('Contact store is not available');
    const existing = await contactStore.getSocialGraphEntityByContactId(contactId);
    if (existing) return existing.id;
    const created = await contactStore.upsertSocialGraphEntity({
      id: `contact:${contactId}`,
      displayName,
      contactId,
      source: 'contact',
    });
    return created.id;
  }

  return {
    async listGraphProposals(): Promise<AdminGraphProposalListData> {
      const proposals = await proposalStore.list();
      return { proposals: proposals.map(toView) };
    },

    async approveGraphProposal(
      id: string,
      adjustedTypeRaw?: string,
    ): Promise<AdminGraphProposalMutationResult> {
      const proposal = await proposalStore.getById(id);
      if (!proposal) {
        return { ok: false, message: 'Graph proposal not found' };
      }
      if (proposal.status !== 'pending' && proposal.status !== 'conflict') {
        return { ok: false, message: `Graph proposal already ${proposal.status}` };
      }
      if (!contactStore) {
        return { ok: false, message: 'Contact store is not available' };
      }
      const adjusted = normalizeAdjustedType(adjustedTypeRaw);
      if (adjusted === 'invalid') {
        return { ok: false, message: 'Invalid relationship type' };
      }
      // Fail-closed: only write edges between contacts that are still tracked.
      const [source, target] = await Promise.all([
        contactStore.getById(proposal.sourceContactId),
        contactStore.getById(proposal.targetContactId),
      ]);
      if (!source || !target) {
        return { ok: false, message: 'Source or target contact no longer tracked' };
      }
      const relationshipType = adjusted ?? proposal.relationshipType;
      const [sourceEntityId, targetEntityId] = await Promise.all([
        ensureEntityId(proposal.sourceContactId, proposal.sourceDisplayName),
        ensureEntityId(proposal.targetContactId, proposal.targetDisplayName),
      ]);
      const edge = await contactStore.upsertSocialRelationshipEdge({
        sourceEntityId,
        targetEntityId,
        relationshipType,
        directional: proposal.directional,
        sensitivity: proposal.sensitivity,
        provenanceRefs: [...proposal.provenanceRefs, 'source:memory', `proposal:${proposal.id}`],
        evidenceMemoryIds: proposal.evidenceMemoryIds,
        confidence: proposal.confidence,
      });
      await proposalStore.markAccepted(id, {
        edgeId: edge.id,
        relationshipType,
        decidedBy: 'operator',
      });
      return { ok: true, edgeId: edge.id, relationshipType };
    },

    async rejectGraphProposal(id: string): Promise<AdminGraphProposalMutationResult> {
      const rejected = await proposalStore.markRejected(id, { decidedBy: 'operator' });
      if (!rejected) {
        return { ok: false, message: 'Graph proposal not found' };
      }
      return { ok: true };
    },
  };
}
