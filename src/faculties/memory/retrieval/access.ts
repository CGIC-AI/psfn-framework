import {
  isHighIntimacySensitivityLevel,
  type ChannelVisibility,
  type TrustLevel,
} from '../../../system/trust/types.js';
import {
  evaluateMemoryPolicy,
  type ChannelMeta,
  type DisclosureBoundaryDirective,
} from '../../../system/trust/policy.js';
import type { PurrMemory } from '../types.js';
import {
  createEmptyMemoryWithheldSummary,
  incrementMemoryWithheldRelevanceBand,
  incrementMemoryWithheldReason,
  resolveMemoryWithheldRelevanceBand,
  type MemoryWithheldReasonTag,
  type MemoryWithheldSummary,
} from '../withheld-summary.js';
import type { RetrievalAccessDecision } from './types.js';

const WITHHOLD_BOUNDARY_TAGS = new Set([
  'withhold',
  'withheld',
  'boundary_withhold',
  'do_not_disclose',
  'no_disclose',
  'private_boundary',
]);
const CONSENT_REQUIRED_BOUNDARY_TAGS = new Set([
  'consent_required',
  'requires_consent',
  'disclosure_requires_consent',
  'gate_consent',
]);

function violatesHighIntimacyContactScope(
  memory: Pick<PurrMemory, 'sensitivity' | 'contactId'>,
  canonicalContactId?: string,
): boolean {
  if (!isHighIntimacySensitivityLevel(memory.sensitivity)) return false;
  if (!canonicalContactId) return false;
  return memory.contactId !== canonicalContactId;
}

export function evaluateRetrievalAccessDecision(
  memory: Pick<PurrMemory, 'sensitivity' | 'contactId' | 'consentFlags' | 'tags'>,
  options: {
    trustLevel: TrustLevel;
    channelVisibility: ChannelVisibility;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval?: boolean;
  },
): RetrievalAccessDecision {
  if (violatesHighIntimacyContactScope(memory, options.canonicalContactId)) {
    return {
      allowed: false,
      rejectionKind: 'contact_scope',
      withheldReason: 'contact_scope.high_intimacy',
    };
  }

  const policy = evaluateMemoryPolicy({
    trustLevel: options.trustLevel,
    channelVisibility: options.channelVisibility,
    memorySensitivity: memory.sensitivity,
    consentFlags: memory.consentFlags,
    disclosureBoundary: resolveDisclosureBoundaryDirective(memory, options.channelMeta),
    operatorApproval: options.operatorApproval,
  });
  if (policy.decision === 'allow') {
    return { allowed: true };
  }

  if (
    policy.reasonTag === 'trust.ceiling_exceeded'
    || policy.reasonTag === 'visibility.channel_restricted'
  ) {
    return {
      allowed: false,
      rejectionKind: 'sensitivity',
      withheldReason: policy.reasonTag,
    };
  }

  return {
    allowed: false,
    rejectionKind: 'policy',
    withheldReason: policy.reasonTag as Exclude<MemoryWithheldReasonTag, 'contact_scope.high_intimacy'>,
  };
}

export function summarizeWithheldMemories<T extends Pick<PurrMemory, 'id' | 'sensitivity' | 'contactId' | 'consentFlags' | 'tags'> & { similarity?: number }>(
  memories: readonly T[],
  options: {
    trustLevel: TrustLevel;
    channelVisibility: ChannelVisibility;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval?: boolean;
  },
): { summary?: MemoryWithheldSummary; withheldIds: string[] } {
  const summary = createEmptyMemoryWithheldSummary();
  const withheldIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const memory of memories) {
    if (seenIds.has(memory.id)) continue;
    seenIds.add(memory.id);

    const decision = evaluateRetrievalAccessDecision(memory, options);
    if (!decision.allowed && decision.withheldReason) {
      incrementMemoryWithheldReason(summary, decision.withheldReason);
      incrementMemoryWithheldRelevanceBand(
        summary,
        resolveMemoryWithheldRelevanceBand(memory.similarity),
      );
      withheldIds.add(memory.id);
    }
  }

  return {
    ...(summary.totalCount > 0 ? { summary } : {}),
    withheldIds: [...withheldIds],
  };
}

function normalizeBoundaryTag(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function hasBoundaryDirectiveTag(
  tags: readonly string[],
  candidates: ReadonlySet<string>,
): boolean {
  for (const rawTag of tags) {
    const normalized = normalizeBoundaryTag(rawTag);
    if (normalized.length === 0) continue;
    if (candidates.has(normalized)) return true;
  }
  return false;
}

function resolveDisclosureBoundaryDirective(
  memory: Pick<PurrMemory, 'tags'>,
  channelMeta?: ChannelMeta,
): DisclosureBoundaryDirective | undefined {
  const withhold = hasBoundaryDirectiveTag(memory.tags, WITHHOLD_BOUNDARY_TAGS);
  const consentRequired = hasBoundaryDirectiveTag(memory.tags, CONSENT_REQUIRED_BOUNDARY_TAGS);
  if (!withhold && !consentRequired) return undefined;

  return {
    withhold,
    consentRequired,
    consentGranted: channelMeta?.disclosureConsentGranted === true,
  };
}
