import type { GardenRequestContext } from './garden-request-context.js';

/**
 * Invariant 11 (docs/garden-control-plane.md) enforcement chokepoint.
 *
 * In the fleet-scoped Garden a single process serves many companions, but every
 * direct-database Garden service instance is bound to exactly one companion —
 * by its Postgres schema, by a companion-id column filter, by its companion
 * data root, or by the connection-selected companion identity captured when the
 * service was constructed. The companion whose rows a request is allowed to read
 * or write must therefore be derived from the immutable, authenticated request
 * context, never from a cached prior selection or a process-global default.
 *
 * This guard refuses to run any companion-scoped route unless the request's
 * authenticated companion target equals the companion binding of the services
 * that will handle it. It fails closed on a mismatch, on a missing request
 * companion, and on a missing service binding, so a request authenticated for
 * companion A can never reach companion B's service instances (and thus B's
 * schema/rows/writes), and vice versa.
 *
 * Legacy-token and public request contexts carry no fleet companion target and
 * are intentionally unaffected: the single-companion Garden binds one process to
 * one companion, so its behavior is unchanged.
 *
 * @returns a denial reason string when the request must be rejected, or `null`
 *   when the request companion is in scope for the bound companion.
 */
export function gardenRequestCompanionScopeDenial(
  context: GardenRequestContext,
  boundCompanionId: string | undefined,
): string | null {
  if (context.kind !== 'fleet_principal') {
    return null;
  }
  const requestCompanionId = context.resource.companionId;
  if (typeof requestCompanionId !== 'string' || requestCompanionId.length === 0) {
    return 'Fleet Garden request carries no authenticated companion target';
  }
  if (typeof boundCompanionId !== 'string' || boundCompanionId.length === 0) {
    return 'Fleet Garden dispatch has no companion binding to scope the request';
  }
  if (requestCompanionId !== boundCompanionId) {
    return 'Fleet Garden request companion does not match the dispatch companion binding';
  }
  return null;
}

/**
 * Fail-closed variant for service-boundary call sites that hold a bound
 * companion and want to assert scope before touching durable storage. Throws a
 * {@link GardenCompanionScopeError} when the request companion is not in scope
 * for the bound companion.
 */
export function assertGardenRequestCompanionScope(
  context: GardenRequestContext,
  boundCompanionId: string | undefined,
): void {
  const denial = gardenRequestCompanionScopeDenial(context, boundCompanionId);
  if (denial) {
    throw new GardenCompanionScopeError(denial);
  }
}

export class GardenCompanionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GardenCompanionScopeError';
  }
}
