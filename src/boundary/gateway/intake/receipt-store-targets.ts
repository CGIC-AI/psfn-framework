// ── Gateway ingress receipt store tenancy (psfn-framework-ccgdz.2) ──
//
// The gateway writes one companion's admission receipts into that companion's
// own tenant schema, and it must open the pool with the SAME authority the
// agent uses for `cogsec_receipts` (`persistence/runtime-factory.ts`): schema
// AND the companion's dedicated Postgres role.
//
// Role, not just schema, is load-bearing on a fresh multi-role fleet deploy.
// `ensurePostgresSchema` creates the receipts table on first connect, and the
// creating session's role owns it. Whichever process boots first wins that
// ownership. If the gateway connects on the bare gateway login role, the table
// is owned by that role, and the agent's REQUIRED `cogsec_receipts` readiness
// — which runs `SET ROLE <companion role>` — then fails on a table it cannot
// touch, taking the agent down over a proof-of-admission store.
//
// So the target list is resolved here, in one place both the wiring and its
// test can name, rather than inline in the 500-line privileged-core composer.

import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';

/**
 * One receipt store the gateway opens. `companionId` is absent only in
 * single-companion mode, where the map key is the empty string and the store is
 * the whole deployment's.
 */
export interface GatewayReceiptStoreTarget {
  readonly companionId?: CompanionId;
  /** Connection options handed straight to `PostgresCogSecReceiptStore.connect`. */
  readonly connectOptions: { schema?: string; role?: string };
}

/**
 * The per-companion receipt stores this gateway process must open.
 *
 * Fleet mode yields one target per manifest companion, each pinned to that
 * companion's schema and role — the exact tenant authority the agent's own
 * receipt store uses. Single-companion mode yields one unscoped target and no
 * role, mirroring `resolveConfigTenantPoolScope`, which returns `undefined`
 * without a fleet manifest so a non-fleet pool stays byte-identical to the
 * historical public-schema behavior.
 */
export function resolveGatewayReceiptStoreTargets(
  config: Pick<SubstrateConfig, 'companionFleet' | 'postgresSchema'>,
): GatewayReceiptStoreTarget[] {
  if (config.companionFleet) {
    return config.companionFleet.companions.map((companion) => {
      const schema = companion.postgresSchema.trim();
      const role = companion.postgresRole.trim();
      if (!schema || !role) {
        throw new Error(
          'Fleet companion receipt stores require an exact postgresSchema and postgresRole; '
          + 'refusing to open a receipt pool that would default to the public search_path',
        );
      }
      return {
        companionId: companion.companionId,
        connectOptions: { schema, role },
      };
    });
  }
  const schema = config.postgresSchema?.trim();
  return [{ connectOptions: schema ? { schema } : {} }];
}
