import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

/**
 * The tenant search_path/role a per-companion runtime pool must pin at
 * connection startup. Both are always present together: {@link createPostgresPool}
 * refuses a role without an explicit schema.
 */
export interface TenantPoolScope {
  readonly schema: string;
  readonly role: string;
}

/**
 * Resolve the tenant boundary a per-companion runtime pool must pin, or
 * `undefined` when there is no tenant boundary to pin (single-companion mode).
 *
 * Multi-companion followers own only their companion schema; `public` belongs
 * to the primary tenant role. A per-companion pool that omits the tenant scope
 * silently defaults to the libpq `"$user", public` search_path, which is unsafe
 * two ways: an unqualified CREATE fails at boot with
 * `no schema has been selected to create in` (the reported crash), and — worse —
 * any unqualified READ would resolve against the primary tenant's `public`
 * schema instead of the follower's own data. So in multi-companion mode this
 * fails closed: the pool is scoped to the companion boundary or the call is
 * refused, never defaulted to `public`.
 *
 * In single-companion mode there is exactly one tenant, `public` is its own,
 * and the pool stays unscoped (byte-identical to the pre-tenancy behavior).
 */
export function resolveConfigTenantPoolScope(
  config: Pick<SubstrateConfig, 'multiCompanion' | 'postgresSchema' | 'postgresRole'>,
): TenantPoolScope | undefined {
  if (config.multiCompanion !== true) return undefined;
  const schema = config.postgresSchema?.trim();
  if (!schema) {
    throw new Error(
      'Multi-companion per-companion Postgres pools require config.postgresSchema; refusing to default to public',
    );
  }
  const role = config.postgresRole?.trim();
  if (!role) {
    throw new Error(
      'Multi-companion per-companion Postgres pools require config.postgresRole; refusing to default to public',
    );
  }
  return { schema, role };
}

/**
 * The fleet-wide ledger schema. ICP conversation cost decisions live in the
 * primary `public` schema: they are a shared, cluster-wide budget ledger — a
 * conversation charges both participating companions against one pool — written
 * there by the fleet-scoped model-usage store (the gateway) and aggregated
 * across every companion by the operator/admin projections. This is the same
 * fleet-wide intent recorded for `model_usage_events` in psfn-framework-3ack and
 * ratified for this cost pool by the operator ruling on psfn-framework-vzh0u
 * (2026-07-28). It is deliberately NOT a per-companion tenant schema.
 */
export const FLEET_LEDGER_SCHEMA = 'public';

/**
 * The explicit search_path scope a fleet-wide ledger aggregation pool must pin.
 * A single-field marker (never a role) so the aggregation surface states its
 * fleet-wide intent deliberately at connection startup instead of inheriting the
 * libpq default `"$user", public` search_path.
 */
export interface FleetLedgerPoolScope {
  readonly schema: typeof FLEET_LEDGER_SCHEMA;
}

/**
 * Resolve the explicit fleet-ledger pool scope for a cluster-wide cost/usage
 * aggregation surface (the ICP admin cost projection).
 *
 * This is the fleet-wide counterpart to {@link resolveConfigTenantPoolScope}:
 * where a per-companion pool pins its own tenant schema, a fleet-ledger pool
 * pins the shared `public` ledger so its unqualified reads resolve deliberately
 * rather than falling through the libpq default `"$user", public` search_path —
 * the accidental-default read class fixed fail-closed in psfn-framework-3ack and
 * closed read-side here (psfn-framework-vzh0u). The aggregation semantics are
 * unchanged: this only makes the target schema explicit.
 *
 * Fleet aggregation only exists in multi-companion mode; in single-companion
 * mode there is no fleet to aggregate, so an unscoped fleet pool would be
 * ambiguous. This fails closed there rather than silently opening a pool on the
 * default search_path.
 */
export function resolveFleetLedgerPoolScope(
  config: Pick<SubstrateConfig, 'multiCompanion'>,
): FleetLedgerPoolScope {
  if (config.multiCompanion !== true) {
    throw new Error(
      'Fleet-ledger aggregation pools require multi-companion mode; '
      + 'refusing to open an unscoped pool that would default to the public search_path',
    );
  }
  return { schema: FLEET_LEDGER_SCHEMA };
}
