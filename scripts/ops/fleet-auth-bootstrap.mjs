#!/usr/bin/env node
// ── Repository-native fleet-auth PostgreSQL bootstrap (psfn-framework-fx83b) ──
// Provisions everything the gateway's fleet-auth startup checks require from
// PostgreSQL and the host before fleet-auth.json can be enabled on the
// repository-native (npm run local:*) or Compose path: the fleet-auth login
// roles, their database grants, the <database>_restore_verify scratch database
// and its grants, and the authority floor root directory. Idempotent.
//
// Usage (after npm run onboard, with fleet-auth.json already in SYSTEM_DATA_DIR
// and the fleet-auth credential env vars it references exported):
//
//   SYSTEM_DATA_DIR=<system-data> \
//   POSTGRES_ADMIN_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<database> \
//   PSFN_FLEET_AUTH_DATABASE_CONNECTION_LIMIT=20 \
//   node scripts/ops/fleet-auth-bootstrap.mjs [--check]
//
// --check validates the owner files and environment and prints the plan
// without touching PostgreSQL or the filesystem.
// See docs/operator/fleet-auth.md ("Repository-native PostgreSQL provisioning").

import process from 'node:process';
import {
  ensureAuthorityFloorRoot,
  planFleetAuthProvisioning,
  provisionFleetAuthDatabase,
  restoreVerifyDatabaseGrants,
  runtimeDatabaseGrants,
} from './lib/postgres-fleet-auth.mjs';

async function main(argv) {
  const unknown = argv.filter(argument => argument !== '--check');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(' ')} (usage: [--check])`);
  const checkOnly = argv.includes('--check');
  const systemDataDir = process.env.SYSTEM_DATA_DIR?.trim();
  if (!systemDataDir) throw new Error('SYSTEM_DATA_DIR is required');

  const plan = planFleetAuthProvisioning({ systemDataDir, env: process.env });
  console.log(`[fleet-auth-bootstrap] database ${plan.databaseName}, scratch ${plan.restoreVerifyDatabaseName}`);
  console.log(`[fleet-auth-bootstrap] login roles: ${plan.loginRoles.map(entry => `${entry.role} (limit ${entry.connectionLimit})`).join(', ')}`);
  console.log(`[fleet-auth-bootstrap] schema owners on the scratch database: ${plan.schemaOwnerRoles.join(', ')}`);
  console.log(`[fleet-auth-bootstrap] authority floor root: ${plan.authorityFloorRoot} (mode 0700)`);
  if (checkOnly) {
    for (const statement of [...runtimeDatabaseGrants(plan), ...restoreVerifyDatabaseGrants(plan)]) {
      console.log(`  ${statement};`);
    }
    console.log('[fleet-auth-bootstrap] --check: nothing was changed');
    return;
  }
  ensureAuthorityFloorRoot(plan.authorityFloorRoot);
  await provisionFleetAuthDatabase(plan);
  console.log('[fleet-auth-bootstrap] fleet-auth roles, grants, restore-verify database, and authority floor are ready');
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`[fleet-auth-bootstrap] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
