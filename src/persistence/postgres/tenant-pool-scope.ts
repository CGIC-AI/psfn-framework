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
