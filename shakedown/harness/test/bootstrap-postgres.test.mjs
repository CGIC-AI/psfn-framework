#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  resolvePostgresTargetContract,
  verifyDisposablePostgresTarget,
} from '../lib/bootstrap-postgres.mjs';

function contract(overrides = {}) {
  return resolvePostgresTargetContract({
    postgresUrl: 'postgresql://round:secret@127.0.0.1:5432/psfn_shakedown_round',
    livePostgresUrl: 'postgresql://live:secret@127.0.0.1:5432/psfn_live',
    expectedDatabase: 'psfn_shakedown_round',
    schema: 'shakedown_artemis',
    ...overrides,
  });
}

const target = contract();
assert.deepEqual(target.identity, {
  endpoint: '127.0.0.1:5432',
  database: 'psfn_shakedown_round',
  schema: 'shakedown_artemis',
  role: 'round',
});
assert.equal(JSON.stringify(target.identity).includes('secret'), false);

assert.throws(
  () => contract({
    postgresUrl: 'postgresql://round:secret@127.0.0.1:5432/postgres',
    expectedDatabase: 'postgres',
  }),
  /default PostgreSQL database/u,
);
assert.throws(
  () => contract({ schema: 'public' }),
  /dedicated non-default schema/u,
);
assert.throws(
  () => contract({
    livePostgresUrl: 'postgresql://live:other@127.0.0.1:5432/psfn_shakedown_round',
  }),
  /same database as the protected live target/u,
);

const proven = await verifyDisposablePostgresTarget({
  contract: target,
  resume: false,
  probe: async () => ({
    database: 'psfn_shakedown_round',
    role: 'round',
    userTableCount: 0,
    schemaExists: false,
  }),
});
assert.deepEqual(proven, target.identity);

await assert.rejects(
  () => verifyDisposablePostgresTarget({
    contract: target,
    resume: false,
    probe: async () => ({
      database: 'psfn_shakedown_round',
      role: 'round',
      userTableCount: 3,
      schemaExists: true,
    }),
  }),
  /not disposable.*3 user table/u,
);

await assert.doesNotReject(
  () => verifyDisposablePostgresTarget({
    contract: target,
    resume: true,
    probe: async () => ({
      database: 'psfn_shakedown_round',
      role: 'round',
      userTableCount: 3,
      schemaExists: true,
    }),
  }),
);

await assert.rejects(
  () => verifyDisposablePostgresTarget({
    contract: target,
    resume: false,
    probe: async () => ({
      database: 'psfn_live',
      role: 'round',
      userTableCount: 0,
      schemaExists: false,
    }),
  }),
  /reported database "psfn_live".*expected "psfn_shakedown_round"/u,
);

console.log('bootstrap PostgreSQL disposable-target tests passed');
