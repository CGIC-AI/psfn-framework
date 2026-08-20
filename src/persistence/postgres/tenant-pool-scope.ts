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
  config: Pick<
    SubstrateConfig,
    | 'multiCompanion'
    | 'companionId'
    | 'companionFleet'
    | 'postgresSchema'
    | 'postgresRole'
  >,
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
  const companionId = config.companionId?.trim();
  if (!companionId) {
    throw new Error(
      'Multi-companion per-companion Postgres pools require an exact config.companionId',
    );
  }
  const fleet = config.companionFleet;
  if (!fleet) {
    throw new Error(
      'Multi-companion per-companion Postgres pools require config.companionFleet',
    );
  }
  const identity = fleet.companions.find(companion => companion.companionId === companionId);
  if (!identity) {
    throw new Error(
      'Multi-companion config.companionId is not present in config.companionFleet',
    );
  }
  if (identity.postgresSchema.trim() !== schema || identity.postgresRole.trim() !== role) {
    throw new Error(
      'Multi-companion Postgres scope does not match the exact companion tenant authority',
    );
  }
  return { schema, role };
}

/**
 * The explicit search_path scope a fleet-wide ledger aggregation pool must pin.
 * The ledger is owned by the canonical first companion, while every agent uses
 * its own mapped runtime role. Followers therefore retain their own credential
 * and receive only the explicitly granted fleet-ledger reads.
 */
export interface FleetLedgerPoolScope {
  readonly schema: string;
  readonly role: string;
}

export interface FleetLedgerConfig {
  readonly companionFleet?: {
    readonly companions: readonly { readonly postgresSchema: string }[];
  };
  readonly multiCompanion?: boolean;
  readonly postgresRole?: string;
}

/**
 * Resolve the explicit fleet-ledger pool scope for a cluster-wide cost/usage
 * aggregation surface (the ICP admin cost projection).
 *
 * This is the fleet-wide counterpart to {@link resolveConfigTenantPoolScope}:
 * where a per-companion pool pins its own tenant schema, a fleet-ledger pool
 * pins the canonical first companion's ledger so its unqualified reads resolve deliberately
 * rather than falling through the libpq default `"$user", public` search_path —
 * the accidental-default read class fixed fail-closed in psfn-framework-3ack and
 * closed read-side here (psfn-framework-vzh0u). The aggregation semantics are
 * unchanged: this makes both the target schema and current reader role explicit.
 *
 * Fleet aggregation only exists in multi-companion mode; in single-companion
 * mode there is no fleet to aggregate, so an unscoped fleet pool would be
 * ambiguous. This fails closed there rather than silently opening a pool on the
 * default search_path.
 */
export function resolveFleetLedgerPoolScope(
  config: FleetLedgerConfig,
): FleetLedgerPoolScope {
  if (config.multiCompanion !== true) {
    throw new Error(
      'Fleet-ledger aggregation pools require multi-companion mode; '
      + 'refusing to open an unscoped pool that would default to the public search_path',
    );
  }
  const schema = config.companionFleet?.companions.at(0)?.postgresSchema.trim();
  const role = config.postgresRole?.trim();
  if (!schema || !role) {
    throw new Error(
      'Fleet-ledger aggregation pools require the canonical companion schema '
      + 'and current runtime role',
    );
  }
  return { schema, role };
}
