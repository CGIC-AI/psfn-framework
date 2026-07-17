#!/usr/bin/env node
// Test A — lib/target.mjs tier flip uses the CANONICAL owner-file editor.
//
// Drives the REAL setTierAndConfirm/fetchCurrentTier against a stub Garden that
// enforces the empirically-verified contract: PATCH {capabilityTier} -> HTTP 400
// wrong_owner, POST /capabilities configJson -> 200. The flip must:
//   1. succeed via POST (not the rejected PATCH),
//   2. preserve customTokens across the whole-file write,
//   3. never touch the PATCH /api/admin/settings route.
//
// Decisive regression proof: revert setTierAndConfirm to the old
// `PATCH /api/admin/settings {capabilityTier}` and the stub returns 400 -> the
// flip throws -> this test FAILS. Drop customTokens from the POST body and the
// customTokens assertion FAILS.

import { setTierAndConfirm, fetchCurrentTier } from '../lib/target.mjs';
import { startStubSettingsServer } from './support/stub-settings-server.mjs';

const failures = [];
function check(cond, message) {
  if (cond) {
    console.log(`  ok  - ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL- ${message}`);
  }
}

async function main() {
  const adminToken = 'stub-admin-token';
  const stub = await startStubSettingsServer({
    tier: 'apprentice',
    customTokens: ['git.read', 'memory.write'],
    adminToken,
  });
  const ctx = { adminBaseUrl: stub.baseUrl, adminToken };

  try {
    const before = await fetchCurrentTier(ctx);
    check(before === 'apprentice', `read-back reports the initial tier (got '${before}')`);

    const confirmed = await setTierAndConfirm({
      ...ctx,
      tier: 'nursery',
      confirmTimeoutMs: 2000,
      pollMs: 10,
    });
    check(confirmed === 'nursery', `flip to 'nursery' confirmed (got '${confirmed}')`);

    const state = stub.getState();
    check(state.tier === 'nursery', `stub owner file now at 'nursery' (got '${state.tier}')`);
    check(
      JSON.stringify(state.customTokens) === JSON.stringify(['git.read', 'memory.write']),
      `customTokens preserved across the whole-file write (got ${JSON.stringify(state.customTokens)})`,
    );

    const after = await fetchCurrentTier(ctx);
    check(after === 'nursery', `read-back confirms the persisted flip (got '${after}')`);

    const usedPost = stub.log.some((r) => r.method === 'POST' && r.path === '/api/admin/settings/capabilities');
    const usedPatch = stub.log.some((r) => r.method === 'PATCH');
    check(usedPost, 'flip wrote via POST /api/admin/settings/capabilities');
    check(!usedPatch, 'flip never used the rejected PATCH /api/admin/settings path');
  } finally {
    await stub.close();
  }

  if (failures.length > 0) {
    console.error(`\nTest A FAILED: ${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nTest A PASSED: target.mjs uses the canonical capabilities editor contract.');
}

main().catch((error) => {
  console.error(`Test A ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
