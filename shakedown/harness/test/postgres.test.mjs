import assert from 'node:assert/strict';
import test from 'node:test';

import { closePool, getPool } from '../lib/postgres.mjs';

test('proof-reader pool bounds connection acquisition and every query', async () => {
  const previousUrl = process.env.POSTGRES_DATABASE_URL;
  process.env.POSTGRES_DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:5432/fixture';
  try {
    const pool = getPool();
    assert.equal(pool.options.connectionTimeoutMillis, 5_000);
    assert.equal(pool.options.statement_timeout, 10_000);
    assert.equal(pool.options.query_timeout, 10_000);
  } finally {
    await closePool();
    if (previousUrl === undefined) {
      delete process.env.POSTGRES_DATABASE_URL;
    } else {
      process.env.POSTGRES_DATABASE_URL = previousUrl;
    }
  }
});

// ypah0: gateway-owned tables (gateway_audit, model_usage_events) live in the
// fleet gateway schema; a follower-targeted run reads them through its own
// declared connection, never through the follower tenant pool.
import { resolveGatewayPoolTarget } from '../lib/postgres.mjs';

test('a single-schema run reads gateway tables from its own pool', () => {
  assert.deepEqual(resolveGatewayPoolTarget({}), { shared: true });
  assert.throws(
    () => resolveGatewayPoolTarget({ PSFN_GATEWAY_PG_SCHEMA: 'companion_default' }),
    /PSFN_GATEWAY_PG_SCHEMA/,
  );
});

test('a fleet tenant run must declare the gateway schema', () => {
  assert.throws(
    () => resolveGatewayPoolTarget({ COMPANION_PG_SCHEMA: 'companion_vunit00' }),
    /PSFN_GATEWAY_PG_SCHEMA.*required/,
  );
});

test('a run targeting the gateway tenant shares its pool', () => {
  assert.deepEqual(resolveGatewayPoolTarget({
    COMPANION_PG_SCHEMA: 'companion_default',
    PSFN_GATEWAY_PG_SCHEMA: 'companion_default',
  }), { shared: true });
});

test('a follower run needs a gateway read credential and pins the gateway schema', () => {
  assert.throws(() => resolveGatewayPoolTarget({
    COMPANION_PG_SCHEMA: 'companion_vunit00',
    PSFN_GATEWAY_PG_SCHEMA: 'companion_default',
  }), /PSFN_GATEWAY_POSTGRES_DATABASE_URL/);
  assert.deepEqual(resolveGatewayPoolTarget({
    COMPANION_PG_SCHEMA: 'companion_vunit00',
    PSFN_GATEWAY_PG_SCHEMA: 'companion_default',
    PSFN_GATEWAY_POSTGRES_DATABASE_URL: 'postgresql://gateway_reader:x@db.example.test/fleet',
  }), {
    shared: false,
    connectionString: 'postgresql://gateway_reader:x@db.example.test/fleet',
    schema: 'companion_default',
  });
  assert.throws(() => resolveGatewayPoolTarget({
    COMPANION_PG_SCHEMA: 'companion_vunit00',
    PSFN_GATEWAY_PG_SCHEMA: 'Companion; drop',
    PSFN_GATEWAY_POSTGRES_DATABASE_URL: 'postgresql://x@db.example.test/fleet',
  }), /PSFN_GATEWAY_PG_SCHEMA/);
});

test('the harness never reads gateway-owned tables through the tenant pool', async () => {
  const { readFileSync } = await import('node:fs');
  const harness = readFileSync(new URL('../live-system-shakedown.mjs', import.meta.url), 'utf8');
  const hardening = readFileSync(new URL('../cases/hardening.mjs', import.meta.url), 'utf8');
  const auditReads = [...harness.matchAll(/await (\w+)\(\s*[`'][^`']*\bgateway_audit\b/gu)];
  assert.equal(auditReads.length, 2, 'both gateway_audit reads are inspected');
  for (const match of auditReads) {
    assert.match(match[1], /^gatewayPg/u, `gateway_audit read via ${match[1]}`);
  }
  for (const constant of ['MODEL_USAGE_QUERY', 'UNKNOWN_EMBEDDING_ATTRIBUTION_QUERY', 'BACKGROUND_APPRAISAL_ORIGIN_QUERY']) {
    const calls = [...hardening.matchAll(new RegExp(`services\\.(\\w+)\\(\\s*${constant}`, 'gu'))];
    assert.ok(calls.length > 0, `${constant} is read`);
    for (const call of calls) {
      assert.match(call[1], /^gatewayPg/u, `${constant} read via services.${call[1]}`);
    }
  }
});
