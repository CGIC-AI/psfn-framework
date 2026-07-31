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
