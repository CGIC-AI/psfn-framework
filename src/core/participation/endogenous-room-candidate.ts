import { isRfc4122Uuid } from '../../shared/utils/types.js';
import type { EndogenousRoomParticipationCandidate } from './types.js';

export interface CreateEndogenousRoomParticipationCandidateInput {
  sourceEventId: string;
  candidateId: string;
  channelId: string;
  channelType: unknown;
  companionId: string;
  roomIntent: string;
  occurredAtMs: number;
}

/**
 * Build the first-class candidate emitted by a durable companion-authored room
 * disposition. This boundary deliberately accepts no inbound author/message
 * fields, so downstream generation cannot accidentally impersonate a room
 * participant as the source of an endogenous choice.
 */
export function createEndogenousRoomParticipationCandidate(
  input: CreateEndogenousRoomParticipationCandidateInput,
): EndogenousRoomParticipationCandidate {
  const sourceEventId = requireText(input.sourceEventId, 'sourceEventId');
  const candidateId = requireText(input.candidateId, 'candidateId');
  const channelId = requireText(input.channelId, 'channelId');
  const companionId = requireText(input.companionId, 'companionId');
  const roomIntent = requireText(input.roomIntent, 'roomIntent');
  if (!isRfc4122Uuid(companionId)) {
    throw new Error('endogenous room candidate requires an RFC-4122 companionId');
  }
  if (input.channelType !== 'discord' && input.channelType !== 'buzz') {
    throw new Error('endogenous room candidate requires a supported room channelType');
  }
  if (!Number.isFinite(input.occurredAtMs) || input.occurredAtMs < 0) {
    throw new Error('endogenous room candidate occurredAtMs must be finite and non-negative');
  }
  return {
    schemaVersion: 1,
    kind: 'endogenous_room_candidate',
    source: 'social_impulse_disposition',
    sourceEventId,
    candidateId,
    channelId,
    channelType: input.channelType,
    companionId,
    roomIntent,
    occurredAtMs: input.occurredAtMs,
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`endogenous room candidate ${field} is required`);
  return normalized;
}
