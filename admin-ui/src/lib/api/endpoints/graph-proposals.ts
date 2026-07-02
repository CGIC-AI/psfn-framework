import { apiGet, apiPost } from '$lib/api/client';

export type GraphProposalStatus = 'pending' | 'accepted' | 'rejected' | 'conflict';
export type GraphEvidenceClass = 'co_presence' | 'overheard_interaction' | 'named_relationship';

export interface GraphProposal {
  id: string;
  evidenceClass: GraphEvidenceClass;
  sourceContactId: string;
  targetContactId: string;
  sourceDisplayName: string;
  targetDisplayName: string;
  relationshipType: string;
  directional: boolean;
  confidence: number;
  sensitivity: string;
  evidenceMemoryIds: string[];
  channelId?: string;
  rationale: string;
  status: GraphProposalStatus;
  conflictEdgeId?: string;
  conflictEdgeType?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  acceptedEdgeId?: string;
  acceptedRelationshipType?: string;
}

export interface GraphProposalListData {
  proposals: GraphProposal[];
}

export interface GraphProposalMutationResult {
  ok: boolean;
  edgeId?: string;
  relationshipType?: string;
  message?: string;
}

/**
 * Fetch social-graph edge proposals emitted by the background graph-builder
 * worker (E4.2). Endpoint: GET /api/admin/graph-proposals
 */
export function getGraphProposals(): Promise<GraphProposalListData> {
  return apiGet<GraphProposalListData>('/api/admin/graph-proposals');
}

/**
 * Approve a proposal, optionally adjusting the relationship type. Writes the
 * edge through the normal upsert path.
 * Endpoint: POST /api/admin/graph-proposals/:id/approve
 */
export function approveGraphProposal(
  id: string,
  relationshipType?: string,
): Promise<GraphProposalMutationResult> {
  return apiPost<GraphProposalMutationResult>(
    `/api/admin/graph-proposals/${encodeURIComponent(id)}/approve`,
    relationshipType ? { relationshipType } : {},
  );
}

/**
 * Reject a proposal. The decision persists; the same evidence never re-proposes.
 * Endpoint: POST /api/admin/graph-proposals/:id/reject
 */
export function rejectGraphProposal(id: string): Promise<GraphProposalMutationResult> {
  return apiPost<GraphProposalMutationResult>(
    `/api/admin/graph-proposals/${encodeURIComponent(id)}/reject`,
    {},
  );
}

export const SOCIAL_RELATIONSHIP_KINDS: string[] = [
  'partner',
  'family',
  'friend',
  'acquaintance',
  'colleague',
  'parent',
  'child',
  'sibling',
  'caregiver',
  'household',
  'manager',
  'direct_report',
  'other',
];
