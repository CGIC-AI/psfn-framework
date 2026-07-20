import { isRfc4122Uuid } from '../../shared/utils/types.js';

export function normalizeOptionalIcpRootInitiationId(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRfc4122Uuid(value)) {
    throw new Error('Pending follow-up originIcpRootInitiationId must be a lowercase RFC-4122 UUID');
  }
  return value;
}
