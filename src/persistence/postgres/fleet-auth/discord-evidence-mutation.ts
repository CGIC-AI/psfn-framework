import type { DiscordEvidenceLifecycleMutation } from '../../../boundary/fleet-auth/discord-evidence-types.js';
import { isRfc4122Uuid } from '../../../shared/utils/types.js';

export function assertDiscordEvidenceLifecycleMutation(
  mutation: DiscordEvidenceLifecycleMutation,
): void {
  if (!isRfc4122Uuid(mutation.lifecycleId)
    || !Number.isSafeInteger(mutation.generation)
    || mutation.generation < 1) {
    throw new Error('Invalid Discord evidence lifecycle mutation');
  }
}

export function parseDiscordEvidenceLifecycleGeneration(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid fleet_auth Discord evidence lifecycle generation');
  }
  return parsed;
}
