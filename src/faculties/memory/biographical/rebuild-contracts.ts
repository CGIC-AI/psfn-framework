import type {
  BiographicalClaim,
  BiographicalClaimKind,
  BiographicalSubjectRef,
} from './types.js';

export const BIOGRAPHICAL_SOURCE_LIFECYCLE_REASONS = [
  'missing',
  'deleted',
  'superseded',
  'quarantined',
  'consent-revoked',
  'revision-drift',
  'evidence-digest-drift',
  'subject-evidence-drift',
  'consent-drift',
  'channel-epoch-drift',
  'sensitivity-increased',
  'sensitivity-decreased',
  'contact-archived',
  'contact-merged',
] as const;

export type BiographicalSourceLifecycleReason =
  (typeof BIOGRAPHICAL_SOURCE_LIFECYCLE_REASONS)[number];

export const BIOGRAPHICAL_REBUILD_REASONS = [
  ...BIOGRAPHICAL_SOURCE_LIFECYCLE_REASONS,
  'source-set-drift',
] as const;

export type BiographicalRebuildReason = (typeof BIOGRAPHICAL_REBUILD_REASONS)[number];

export interface BiographicalRebuildRequest {
  readonly id: string;
  readonly claimId: string;
  readonly subject: BiographicalSubjectRef;
  readonly kind: BiographicalClaimKind;
  readonly reason: BiographicalRebuildReason;
  readonly sourceRef?: string;
  readonly priorSourceSetDigest: string;
  readonly currentSourceSetDigest?: string;
  readonly targetSubject?: BiographicalSubjectRef;
  readonly status: 'pending' | 'completed';
  readonly queuedAt: string;
  readonly completedAt?: string;
  readonly completion?: 'no-change' | 'synthesized' | 'invalidated';
}

export interface BiographicalRebuildEnqueueInput {
  readonly claim: BiographicalClaim;
  readonly reason: BiographicalRebuildReason;
  readonly sourceRef?: string;
  readonly currentSourceSetDigest?: string;
  readonly targetSubject?: BiographicalSubjectRef;
  readonly maxPending: number;
  readonly now: Date;
}

export interface BiographicalRebuildEnqueueResult {
  readonly status: 'queued' | 'coalesced' | 'capacity-exhausted';
  readonly request?: BiographicalRebuildRequest;
}

export interface BiographicalRebuildListOptions {
  readonly status?: BiographicalRebuildRequest['status'];
  readonly claimId?: string;
  readonly limit: number;
}
