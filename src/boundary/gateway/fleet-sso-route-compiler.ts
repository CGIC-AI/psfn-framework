import { createCompanionId } from '../../shared/routing/companion-id.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';

/**
 * Compile the one public Garden root accepted by the unified-origin router.
 * The result is origin-form by construction and cannot carry authority,
 * topology, a query, or a fragment.
 */
export function compileFleetSsoGardenPath(companionId: unknown): string {
  if (!isRfc4122Uuid(companionId)) {
    throw new Error('Fleet SSO Garden link requires an RFC-4122 companion ID');
  }
  const canonicalCompanionId = createCompanionId(companionId, 'Fleet SSO Garden link companionId');
  return `/companions/${canonicalCompanionId}/garden`;
}
