import { createHash } from 'node:crypto';
import type { SensitivityLevel } from '../../system/trust/types.js';
import { isValidPlaceIdToken } from '../../shared/contracts/places-registry.js';
import { normalizeWikiDocumentId } from './store.js';
import { filterPersonalFactProposals } from './sleeptime-wiki-pass.js';

export type SharedWorldWikiReviewState = 'pending' | 'approved' | 'rejected';
export const SHARED_WORLD_WIKI_REVIEW_STATES = [
  'pending',
  'approved',
  'rejected',
] satisfies readonly SharedWorldWikiReviewState[];

export type SharedWorldWikiApplyState =
  | 'unreviewed'
  | 'ready'
  | 'applying'
  | 'retryable'
  | 'applied'
  | 'rejected';
export const SHARED_WORLD_WIKI_APPLY_STATES = [
  'unreviewed',
  'ready',
  'applying',
  'retryable',
  'applied',
  'rejected',
] satisfies readonly SharedWorldWikiApplyState[];

export type SharedWorldWikiRejectionCode =
  | 'operator_rejected'
  | 'invalid_site'
  | 'non_public_sensitivity'
  | 'missing_provenance'
  | 'personal_memory_provenance'
  | 'personal_fact_content'
  | 'invalid_payload';
export const SHARED_WORLD_WIKI_REJECTION_CODES = [
  'operator_rejected',
  'invalid_site',
  'non_public_sensitivity',
  'missing_provenance',
  'personal_memory_provenance',
  'personal_fact_content',
  'invalid_payload',
] satisfies readonly SharedWorldWikiRejectionCode[];

export interface SharedWorldWikiProposalInput {
  siteId: string;
  documentId?: string | undefined;
  actorId: string;
  sourceRef: string;
  title: string;
  body: string;
  tags?: readonly string[] | undefined;
  provenanceRefs: readonly string[];
  sensitivity: SensitivityLevel;
}

export interface NormalizedSharedWorldWikiProposal {
  siteId: string;
  documentId: string;
  actorId: string;
  sourceRef: string;
  title: string;
  body: string;
  tags: string[];
  provenanceRefs: string[];
  sensitivity: 'public';
  contentDigest: string;
}

export interface SharedWorldWikiProposal extends NormalizedSharedWorldWikiProposal {
  proposalId: string;
  reviewState: SharedWorldWikiReviewState;
  rejectionCode?: SharedWorldWikiRejectionCode | undefined;
  reviewedBy?: string | undefined;
  reviewedAtMs?: number | undefined;
  applyState: SharedWorldWikiApplyState;
  applyLeaseToken?: string | undefined;
  applyLeaseUntilMs?: number | undefined;
  appliedAtMs?: number | undefined;
  appliedDocumentVersion?: number | undefined;
  appliedBodySha256?: string | undefined;
  projectionBodySha256?: string | undefined;
  cleanupCheckedAtMs?: number | undefined;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type SharedWorldWikiProposalGuardResult =
  | { accepted: true; proposal: NormalizedSharedWorldWikiProposal }
  | { accepted: false; rejectionCode: Exclude<SharedWorldWikiRejectionCode, 'operator_rejected'> };

interface SharedWorldWikiProposalBounds {
  titleChars: number;
  bodyChars: number;
  actorChars: number;
  sourceRefChars: number;
  provenanceRefChars: number;
  maxProvenanceRefs: number;
  tagChars: number;
  maxTags: number;
}

const PROPOSAL_BOUNDS = {
  titleChars: 180,
  bodyChars: 16_000,
  actorChars: 160,
  sourceRefChars: 512,
  provenanceRefChars: 512,
  maxProvenanceRefs: 24,
  tagChars: 64,
  maxTags: 24,
} satisfies Readonly<SharedWorldWikiProposalBounds>;

const PERSONAL_PROVENANCE_PREFIX = /^(?:memory|l0|l0\.1|l01|l1|l2|episode|episodic|session|transcript|contact):/iu;

function normalizeRequired(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars) return null;
  return normalized;
}

function normalizeList(
  values: readonly string[] | undefined,
  maxItems: number,
  maxChars: number,
  lowerCase: boolean,
): string[] | null {
  if (!values || values.length > maxItems) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = normalizeRequired(value, maxChars);
    if (!item) return null;
    const finalValue = lowerCase ? item.toLowerCase() : item;
    if (seen.has(finalValue)) continue;
    seen.add(finalValue);
    normalized.push(finalValue);
  }
  return normalized;
}

function canonicalDigest(input: {
  siteId: string;
  documentId: string;
  title: string;
  body: string;
  tags: readonly string[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    siteId: input.siteId,
    documentId: input.documentId,
    title: input.title,
    body: input.body,
    tags: [...input.tags].sort((left, right) => left.localeCompare(right)),
  })).digest('hex');
}

/**
 * Deterministic, fail-closed guard used both before persistence and immediately
 * before caretaker application. It deliberately reuses the sleeptime wiki
 * personal-fact filter instead of growing a second content-policy grammar.
 */
export function guardSharedWorldWikiProposal(
  input: SharedWorldWikiProposalInput,
  isKnownSite: (siteId: string) => boolean,
): SharedWorldWikiProposalGuardResult {
  const siteId = normalizeRequired(input.siteId, 128);
  if (!siteId || !isValidPlaceIdToken(siteId) || !isKnownSite(siteId)) {
    return { accepted: false, rejectionCode: 'invalid_site' };
  }
  if (input.sensitivity !== 'public') {
    return { accepted: false, rejectionCode: 'non_public_sensitivity' };
  }
  const actorId = normalizeRequired(input.actorId, PROPOSAL_BOUNDS.actorChars);
  const sourceRef = normalizeRequired(input.sourceRef, PROPOSAL_BOUNDS.sourceRefChars);
  const title = normalizeRequired(input.title, PROPOSAL_BOUNDS.titleChars);
  const rawBody = normalizeRequired(input.body, PROPOSAL_BOUNDS.bodyChars);
  const provenanceRefs = normalizeList(
    input.provenanceRefs,
    PROPOSAL_BOUNDS.maxProvenanceRefs,
    PROPOSAL_BOUNDS.provenanceRefChars,
    false,
  );
  const tags = normalizeList(
    input.tags ?? [],
    PROPOSAL_BOUNDS.maxTags,
    PROPOSAL_BOUNDS.tagChars,
    true,
  );
  if (!actorId || !sourceRef || !title || !rawBody || !provenanceRefs || !tags) {
    return { accepted: false, rejectionCode: 'invalid_payload' };
  }
  if (provenanceRefs.length === 0) {
    return { accepted: false, rejectionCode: 'missing_provenance' };
  }
  if (PERSONAL_PROVENANCE_PREFIX.test(sourceRef)
    || provenanceRefs.some(reference => PERSONAL_PROVENANCE_PREFIX.test(reference))) {
    return { accepted: false, rejectionCode: 'personal_memory_provenance' };
  }

  const body = rawBody.endsWith('\n') ? rawBody : `${rawBody}\n`;
  const guarded = filterPersonalFactProposals([{
    operation: 'create',
    title,
    body,
    tags,
    sourceEpisodeIds: [],
    sourceMemoryIds: [],
  }], []);
  if (guarded.accepted.length !== 1) {
    return { accepted: false, rejectionCode: 'personal_fact_content' };
  }

  let documentId: string;
  try {
    documentId = normalizeWikiDocumentId(input.documentId, title);
  } catch {
    return { accepted: false, rejectionCode: 'invalid_payload' };
  }
  return {
    accepted: true,
    proposal: {
      siteId,
      documentId,
      actorId,
      sourceRef,
      title,
      body,
      tags,
      provenanceRefs,
      sensitivity: 'public',
      contentDigest: canonicalDigest({ siteId, documentId, title, body, tags }),
    },
  };
}

export interface SharedWorldWikiProposalListQuery {
  state?: SharedWorldWikiReviewState | undefined;
  limit?: number | undefined;
}

export interface SharedWorldWikiProposalSubmissionResult {
  proposal: SharedWorldWikiProposal;
  deduplicated: boolean;
}

export interface SharedWorldWikiProposalApplyResult {
  proposal: SharedWorldWikiProposal;
  status: 'applied' | 'already_applied' | 'retryable_failure';
  documentVersion?: number | undefined;
  bodySha256?: string | undefined;
}

export interface SharedWorldWikiCleanupResult {
  checked: number;
  reprojected: number;
  failed: number;
}
