import { createHash } from 'node:crypto';
import {
  COMPANION_DM_CHANNEL_PREFIX,
  COMPANION_ROOM_CHANNEL_PREFIX,
  parseCompanionChannelId,
} from '../../shared/contracts/companion-channels.js';
import { parseCompanionId } from '../../shared/routing/companion-id.js';
import type { MemoryProvenance, PurrMemory } from './types.js';

const EXTRACTION_SOURCE_CHANNEL_SUFFIX = ':extract|';

export type CompanionMemoryProvenanceRejectionReason =
  | 'missing_companion_authority'
  | 'missing_companion_channel_provenance'
  | 'mismatched_companion_channel_provenance'
  | 'malformed_companion_channel'
  | 'foreign_companion_dm';

export type CompanionMemoryProvenanceDecision =
  | { allowed: true; channelKind: 'non_companion' | 'room' | 'dm' }
  | {
      allowed: false;
      channelKind: 'room' | 'dm' | 'malformed';
      reason: CompanionMemoryProvenanceRejectionReason;
    };

export interface CompanionMemoryProvenanceInput {
  sourceRef?: string;
  provenance?: MemoryProvenance;
}

export class CompanionMemoryProvenanceError extends Error {
  override readonly name = 'CompanionMemoryProvenanceError';
  readonly reason: CompanionMemoryProvenanceRejectionReason;

  constructor(reason: CompanionMemoryProvenanceRejectionReason) {
    super(`Companion memory provenance rejected: ${reason}`);
    this.reason = reason;
  }
}

function isCompanionChannelCandidate(value: string | undefined): value is string {
  return value?.startsWith(COMPANION_DM_CHANNEL_PREFIX) === true
    || value?.startsWith(COMPANION_ROOM_CHANNEL_PREFIX) === true;
}

function companionChannelFromSourceRef(sourceRef: string | undefined): string | undefined {
  const normalized = sourceRef?.trim();
  if (!isCompanionChannelCandidate(normalized)) return undefined;
  const extractionMarker = normalized.indexOf(EXTRACTION_SOURCE_CHANNEL_SUFFIX);
  return extractionMarker >= 0 ? normalized.slice(0, extractionMarker) : normalized;
}

/**
 * Validate the companion ownership encoded in durable ICP memory provenance.
 * Ordinary channels are unaffected. Companion channels require exact runtime
 * authority; extraction refs additionally require the independently persisted
 * provenance channel to match so deleting either binding cannot widen access.
 */
export function evaluateCompanionMemoryProvenance(
  input: CompanionMemoryProvenanceInput,
  localCompanionId: string | undefined,
): CompanionMemoryProvenanceDecision {
  const sourceChannelId = companionChannelFromSourceRef(input.sourceRef);
  const provenanceChannelId = isCompanionChannelCandidate(input.provenance?.channelId)
    ? input.provenance.channelId
    : undefined;
  if (!sourceChannelId && !provenanceChannelId) {
    return { allowed: true, channelKind: 'non_companion' };
  }
  if (sourceChannelId && !provenanceChannelId) {
    return {
      allowed: false,
      channelKind: sourceChannelId.startsWith(COMPANION_DM_CHANNEL_PREFIX) ? 'dm' : 'room',
      reason: 'missing_companion_channel_provenance',
    };
  }
  if (sourceChannelId && sourceChannelId !== provenanceChannelId) {
    return {
      allowed: false,
      channelKind: sourceChannelId.startsWith(COMPANION_DM_CHANNEL_PREFIX) ? 'dm' : 'room',
      reason: 'mismatched_companion_channel_provenance',
    };
  }

  const channelId = provenanceChannelId ?? sourceChannelId;
  const parsedChannel = channelId ? parseCompanionChannelId(channelId) : null;
  if (!parsedChannel) {
    return {
      allowed: false,
      channelKind: 'malformed',
      reason: 'malformed_companion_channel',
    };
  }
  const companionId = localCompanionId ? parseCompanionId(localCompanionId) : null;
  if (!companionId) {
    return {
      allowed: false,
      channelKind: parsedChannel.kind,
      reason: 'missing_companion_authority',
    };
  }
  if (parsedChannel.kind === 'dm' && !parsedChannel.participants.includes(companionId)) {
    return {
      allowed: false,
      channelKind: 'dm',
      reason: 'foreign_companion_dm',
    };
  }
  return { allowed: true, channelKind: parsedChannel.kind };
}

export function assertCompanionMemoryProvenance(
  input: CompanionMemoryProvenanceInput,
  localCompanionId: string | undefined,
): void {
  const decision = evaluateCompanionMemoryProvenance(input, localCompanionId);
  if (!decision.allowed) throw new CompanionMemoryProvenanceError(decision.reason);
}

export function isMemoryOwnedByCompanion(
  memory: Pick<PurrMemory, 'sourceRef' | 'provenance'>,
  localCompanionId: string | undefined,
): boolean {
  return evaluateCompanionMemoryProvenance(memory, localCompanionId).allowed;
}

export interface CompanionMemoryAuditInput extends Pick<PurrMemory, 'id' | 'sourceRef' | 'provenance'> {
  state?: 'active' | 'deleted' | 'superseded';
}

export interface CompanionMemoryAuditFinding {
  memoryId: string;
  state: 'active' | 'deleted' | 'superseded';
  reason: CompanionMemoryProvenanceRejectionReason;
  channelKind: 'room' | 'dm' | 'malformed';
  sourceRefDigest?: string;
  sessionRefDigest?: string;
}

export interface CompanionMemoryAuditReport {
  inspectedCount: number;
  contaminatedCount: number;
  reasonCounts: Partial<Record<CompanionMemoryProvenanceRejectionReason, number>>;
  findings: CompanionMemoryAuditFinding[];
}

function digest(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized
    ? createHash('sha256').update(normalized, 'utf8').digest('hex')
    : undefined;
}

/**
 * Produce report-only contamination evidence. Memory bodies, raw source refs,
 * channel ids, and logical session ids never leave this projection.
 */
export function auditCompanionMemoryProvenance(
  memories: readonly CompanionMemoryAuditInput[],
  localCompanionId: string | undefined,
): CompanionMemoryAuditReport {
  const findings: CompanionMemoryAuditFinding[] = [];
  const reasonCounts: CompanionMemoryAuditReport['reasonCounts'] = {};
  for (const memory of memories) {
    const decision = evaluateCompanionMemoryProvenance(memory, localCompanionId);
    if (decision.allowed) continue;
    const sourceRefDigest = digest(memory.sourceRef);
    const sessionRefDigest = digest(memory.provenance?.sessionId);
    findings.push({
      memoryId: memory.id,
      state: memory.state ?? 'active',
      reason: decision.reason,
      channelKind: decision.channelKind,
      ...(sourceRefDigest ? { sourceRefDigest } : {}),
      ...(sessionRefDigest ? { sessionRefDigest } : {}),
    });
    reasonCounts[decision.reason] = (reasonCounts[decision.reason] ?? 0) + 1;
  }
  return {
    inspectedCount: memories.length,
    contaminatedCount: findings.length,
    reasonCounts,
    findings,
  };
}
