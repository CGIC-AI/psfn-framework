import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';

export const PRIMARY_EMBODIMENT_HANDOFF_REASONS = [
  'user_requested',
  'device_replacement',
  'recovery',
] as const;

export type PrimaryEmbodimentHandoffReason = typeof PRIMARY_EMBODIMENT_HANDOFF_REASONS[number];

export interface PrimaryEmbodimentSnapshot {
  readonly companionId: string;
  readonly generation: number;
  readonly version: number;
  readonly current: Readonly<{
    attachmentId: string;
    deviceId: string;
    enrollmentVersion: number;
    hubSessionId: string;
  }> | null;
  readonly lastDecision: Readonly<{
    decisionId: string;
    decision: 'handoff' | 'invalidated';
    reason: PrimaryEmbodimentHandoffReason | 'device_revoked' | 'enrollment_revoked';
    decidedAt: string;
  }> | null;
}

export interface PrimaryEmbodimentAuthorityPort {
  read(companionId: string): Promise<PrimaryEmbodimentSnapshot>;
  handoff(input: {
    companionId: string;
    attachment: HubDeviceAttachmentSnapshot;
    expectedGeneration: number;
    decisionId: string;
    reason: PrimaryEmbodimentHandoffReason;
  }): Promise<PrimaryEmbodimentSnapshot>;
}

export class PrimaryEmbodimentHandoffDeniedError extends Error {
  constructor(readonly code:
    | 'decision_replay'
    | 'decision_cross_companion'
    | 'stale_generation'
    | 'attachment_not_current'
    | 'human_authority_required'
    | 'already_primary') {
    super('Primary embodiment handoff was denied');
    this.name = 'PrimaryEmbodimentHandoffDeniedError';
  }
}
