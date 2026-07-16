import { apiGetConditional } from '$lib/api/client';
import type { AdminConfirmationsData } from '$lib/types';
import type { ContactApprovalListData } from '$lib/api/endpoints/contact-approvals';
import type { GraphProposalListData } from '$lib/api/endpoints/graph-proposals';
import type { IntakeQuarantineListData } from '$lib/api/endpoints/intake';
import { getGardenCacheStorage } from './indexeddb';
import {
  LocalFirstResource,
  type CachedResourceSnapshot,
  type ConditionalFetchResponse,
  type LocalFirstDataSource,
  type LocalFirstResult,
} from './local-first';
import {
  isFiniteNumber,
  isNonNegativeInteger,
  isNumberRecord,
  isOptionalString,
  isRecord,
  isStringArray,
} from './validation';

export interface QueuePageCache<T> {
  load(onData: (data: T, source: LocalFirstDataSource) => void): Promise<LocalFirstResult<T>>;
  read(): Promise<CachedResourceSnapshot<T> | null>;
  revalidate(): Promise<LocalFirstResult<T>>;
  remove(): Promise<void>;
}

export function createQueuePageCache<T>(options: {
  key: string;
  path: string;
  validate(value: unknown): value is T;
}): QueuePageCache<T> {
  const resource = new LocalFirstResource({
    key: `queue:${options.key}`,
    storage: getGardenCacheStorage(),
    validate: options.validate,
    fetch: async (request): Promise<ConditionalFetchResponse> => {
      const response = await apiGetConditional(
        options.path,
        request.forceFull ? undefined : request.etag,
      );
      if (response.kind === 'data') return response;
      return response.etag === null
        ? { kind: 'not_modified' }
        : { kind: 'not_modified', etag: response.etag };
    },
  });
  return {
    load: onData => resource.load(onData),
    read: () => resource.read(),
    revalidate: () => resource.revalidate(),
    remove: () => resource.remove(),
  };
}

function isConfirmationEntry(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.method === 'string'
    && typeof value.action === 'string'
    && typeof value.scope === 'string'
    && isRecord(value.params)
    && typeof value.companionReason === 'string'
    && isFiniteNumber(value.requestedAt)
    && isFiniteNumber(value.expiresAt)
    && (value.resolutionAuthority === undefined || value.resolutionAuthority === 'operator');
}

export function isAdminConfirmationsData(value: unknown): value is AdminConfirmationsData {
  return isRecord(value)
    && Array.isArray(value.entries)
    && value.entries.every(isConfirmationEntry)
    && typeof value.available === 'boolean'
    && isOptionalString(value.message);
}

function isContactApprovalPreview(value: unknown): boolean {
  return isRecord(value)
    && typeof value.messageId === 'string'
    && typeof value.preview === 'string'
    && typeof value.at === 'string';
}

function isContactApprovalEntry(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.channel === 'string'
    && typeof value.channelUserId === 'string'
    && typeof value.displayName === 'string'
    && typeof value.channelId === 'string'
    && typeof value.firstSeenAt === 'string'
    && typeof value.lastSeenAt === 'string'
    && Array.isArray(value.messagePreviews)
    && value.messagePreviews.every(isContactApprovalPreview)
    && (value.status === 'pending' || value.status === 'denied')
    && isOptionalString(value.decidedAt);
}

export function isContactApprovalListData(value: unknown): value is ContactApprovalListData {
  return isRecord(value)
    && Array.isArray(value.entries)
    && value.entries.every(isContactApprovalEntry);
}

function isGraphProposalStatus(value: unknown): boolean {
  return value === 'pending' || value === 'accepted' || value === 'rejected' || value === 'conflict';
}

function isGraphEvidenceClass(value: unknown): boolean {
  return value === 'co_presence'
    || value === 'overheard_interaction'
    || value === 'named_relationship';
}

function isGraphProposal(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && isGraphEvidenceClass(value.evidenceClass)
    && typeof value.sourceContactId === 'string'
    && typeof value.targetContactId === 'string'
    && typeof value.sourceDisplayName === 'string'
    && typeof value.targetDisplayName === 'string'
    && typeof value.relationshipType === 'string'
    && typeof value.directional === 'boolean'
    && isFiniteNumber(value.confidence)
    && typeof value.sensitivity === 'string'
    && isStringArray(value.evidenceMemoryIds)
    && isOptionalString(value.channelId)
    && typeof value.rationale === 'string'
    && isGraphProposalStatus(value.status)
    && isOptionalString(value.conflictEdgeId)
    && isOptionalString(value.conflictEdgeType)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && isOptionalString(value.decidedAt)
    && isOptionalString(value.decidedBy)
    && isOptionalString(value.acceptedEdgeId)
    && isOptionalString(value.acceptedRelationshipType);
}

export function isGraphProposalListData(value: unknown): value is GraphProposalListData {
  return isRecord(value)
    && Array.isArray(value.proposals)
    && value.proposals.every(isGraphProposal);
}

function isFlywheelTarget(value: unknown): boolean {
  return value === null || (
    isRecord(value)
    && (value.kind === 'site' || value.kind === 'person')
    && typeof value.pattern === 'string'
  );
}

function isOperatorDecision(value: unknown): boolean {
  return value === undefined || (
    isRecord(value)
    && typeof value.action === 'string'
    && typeof value.actor === 'string'
    && typeof value.reason === 'string'
    && typeof value.at === 'string'
  );
}

function isIntakeQuarantineItem(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.status === 'string'
    && (value.mode === 'shadow' || value.mode === 'enforce')
    && typeof value.sourceClass === 'string'
    && typeof value.sourceRiskTier === 'string'
    && typeof value.originRef === 'string'
    && isOptionalString(value.originDetail)
    && isOptionalString(value.canonicalContactId)
    && isStringArray(value.riskLabels)
    && isNumberRecord(value.scores)
    && isOptionalString(value.screeningDecisionReason)
    && typeof value.heldAt === 'string'
    && typeof value.expiresAt === 'string'
    && isNonNegativeInteger(value.ttlRemainingMs)
    && isOptionalString(value.contentSha256)
    && (value.contentSizeBytes === undefined || isNonNegativeInteger(value.contentSizeBytes))
    && typeof value.rawTextTruncated === 'boolean'
    && typeof value.safeRepresentationAvailable === 'boolean'
    && isOptionalString(value.summary)
    && isOptionalString(value.whyFlagged)
    && isOptionalString(value.cogSecCaseId)
    && isOperatorDecision(value.operatorDecision)
    && isFlywheelTarget(value.flywheelTarget);
}

export function isIntakeQuarantineListData(value: unknown): value is IntakeQuarantineListData {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every(isIntakeQuarantineItem);
}
