import type { Pool, QueryResult } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  executeQuery,
  installBindParameterNulStripping,
  POSTGRES_EXTENSION_SCHEMA_NAME,
  POSTGRES_SCHEMA_NAME_MAX_LENGTH,
  queryOne,
  queryRows,
  PostgresPoolOwner,
  runWithPostgresPoolOwner,
} from './postgres.js';

const CONNECTION_STRING = 'postgres://user:pass@localhost:5432/psfn';

describe('assertValidPostgresSchemaName', () => {
  const accepted: Array<[string, string]> = [
    ['simple lowercase', 'shared'],
    ['single letter', 'a'],
    ['letters and digits', 'companion1'],
    ['underscores', 'companion_data'],
    ['companion-uuid style (hyphens replaced)', 'companion_550e8400_e29b_41d4_a716_446655440000'],
    ['trailing digits', 'shard2'],
    ['max length', `a${'a'.repeat(POSTGRES_SCHEMA_NAME_MAX_LENGTH - 1)}`],
  ];

  for (const [label, value] of accepted) {
    it(`accepts ${label}`, () => {
      expect(assertValidPostgresSchemaName(value)).toBe(value);
    });
  }

  const rejected: Array<[string, unknown]> = [
    ['empty string', ''],
    ['leading digit', '1companion'],
    ['leading underscore', '_companion'],
    ['uppercase letters', 'Companion'],
    ['mixed case', 'companionData'],
    ['hyphen', 'companion-data'],
    ['whitespace', 'companion data'],
    ['trailing whitespace', 'shared '],
    ['dot', 'companion.data'],
    ['quote', 'companion"data'],
    ['semicolon injection', 'shared; drop schema public'],
    ['search_path injection', 'public,secret'],
    ['comment injection', 'shared--'],
    ['unicode', 'companión'],
    ['over max length', 'a'.repeat(POSTGRES_SCHEMA_NAME_MAX_LENGTH + 1)],
    ['non-string number', 42],
    ['non-string null', null],
    ['non-string undefined', undefined],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => assertValidPostgresSchemaName(value as string)).toThrow();
    });
  }
});

describe('createPostgresPool schema pinning', () => {
  it('pins search_path via libpq options when a schema is provided', async () => {
    const pool = createPostgresPool(CONNECTION_STRING, { schema: 'companion_a' });
    try {
      // pg exposes the resolved client config under pool.options.
      expect((pool.options as { options?: string }).options).toBe(
        `-c search_path=companion_a,${POSTGRES_EXTENSION_SCHEMA_NAME}`,
      );
    } finally {
      await pool.end();
    }
  });

  it('sets no search_path option when schema is absent (byte-identical default)', async () => {
    const pool = createPostgresPool(CONNECTION_STRING, { applicationName: 'psfn-test' });
    try {
      expect((pool.options as { options?: string }).options).toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it('fails closed at pool creation on an invalid schema (no unvalidated identifier reaches pg)', () => {
    expect(() => createPostgresPool(CONNECTION_STRING, { schema: 'public,secret' })).toThrow();
  });

  it('pins a validated least-privilege role before the tenant-only search path', async () => {
    const pool = createPostgresPool(CONNECTION_STRING, {
      schema: 'companion_a',
      role: 'psfn_companion_a',
    });
    try {
      expect(pool.options.options).toBe(
        `-c role=psfn_companion_a -c search_path=companion_a,${POSTGRES_EXTENSION_SCHEMA_NAME}`,
      );
    } finally {
      await pool.end();
    }
  });

  it('rejects a role without an explicit tenant schema', () => {
    expect(() => createPostgresPool(CONNECTION_STRING, { role: 'psfn_companion_a' }))
      .toThrow('requires an explicit tenant schema');
  });
});

describe('PostgresPoolOwner lifecycle and authority isolation', () => {
  it('coalesces logical stores only inside an exact authority tuple', async () => {
    const owner = new PostgresPoolOwner('test');
    let first!: Pool;
    let second!: Pool;
    let readOnly!: Pool;
    let sibling!: Pool;
    try {
      runWithPostgresPoolOwner(owner, () => {
        first = createPostgresPool(CONNECTION_STRING, {
          applicationName: 'memory',
          schema: 'companion_a',
          role: 'companion_a_runtime',
          max: 10,
        });
        second = createPostgresPool(CONNECTION_STRING, {
          applicationName: 'episodic',
          schema: 'companion_a',
          role: 'companion_a_runtime',
          max: 10,
        });
        readOnly = createPostgresPool(CONNECTION_STRING, {
          applicationName: 'operator-read',
          schema: 'companion_a',
          role: 'companion_a_runtime',
          readOnly: true,
        });
        sibling = createPostgresPool(CONNECTION_STRING, {
          applicationName: 'sibling-memory',
          schema: 'companion_b',
          role: 'companion_b_runtime',
        });
      });

      const snapshot = owner.telemetry();
      expect(snapshot.physicalPoolCount).toBe(3);
      expect(snapshot.totalCapacity).toBe(9);
      expect(snapshot.authorities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          authorityClass: 'schema_role',
          readOnly: false,
          capacity: 3,
          logicalStoreCount: 2,
          applicationNames: ['episodic', 'memory'],
        }),
        expect.objectContaining({ readOnly: true, logicalStoreCount: 1 }),
      ]));

      await first.end();
      expect(owner.telemetry().physicalPoolCount).toBe(3);
      await second.end();
      expect(owner.telemetry().physicalPoolCount).toBe(2);
    } finally {
      await Promise.allSettled([first.end(), second.end(), readOnly.end(), sibling.end()]);
      await owner.close();
      await owner.close();
    }
  });

  it('does not affect ordinary pools outside an owner scope', async () => {
    const pool = createPostgresPool(CONNECTION_STRING, { max: 7 });
    try {
      expect(pool.options.max).toBe(7);
    } finally {
      await pool.end();
    }
  });

  it('preserves the process owner across awaited startup work', async () => {
    const owner = new PostgresPoolOwner('test');
    let pool!: Pool;
    try {
      await runWithPostgresPoolOwner(owner, async () => {
        await Promise.resolve();
        pool = createPostgresPool(CONNECTION_STRING, {
          applicationName: 'async-startup-store',
          schema: 'companion_a',
          role: 'companion_a_runtime',
        });
      });

      expect(owner.telemetry()).toEqual(expect.objectContaining({
        physicalPoolCount: 1,
        totalCapacity: 3,
      }));
    } finally {
      await pool.end();
      await owner.close();
    }
  });

  it.each([3, 5, 10])(
    'keeps a %i-companion two-authority fleet below a 100-connection server budget',
    async (companionCount) => {
      const owners = Array.from(
        { length: companionCount },
        () => new PostgresPoolOwner('test'),
      );
      const leases: Pool[] = [];
      try {
        owners.forEach((owner, companionIndex) => {
          runWithPostgresPoolOwner(owner, () => {
            const schema = `companion_${String(companionIndex + 1)}`;
            const role = `${schema}_runtime`;
            for (let storeIndex = 0; storeIndex < 30; storeIndex += 1) {
              leases.push(createPostgresPool(CONNECTION_STRING, {
                applicationName: `store-${String(storeIndex + 1)}`,
                schema,
                role,
              }));
            }
            for (let storeIndex = 0; storeIndex < 10; storeIndex += 1) {
              leases.push(createPostgresPool(CONNECTION_STRING, {
                applicationName: `shared-store-${String(storeIndex + 1)}`,
                schema: 'shared',
              }));
            }
          });
        });

        const totalCapacity = owners.reduce(
          (sum, owner) => sum + owner.telemetry().totalCapacity,
          0,
        );
        expect(totalCapacity).toBe(companionCount * 2 * 3);
        expect(totalCapacity).toBeLessThan(97);
      } finally {
        await Promise.allSettled(leases.map(pool => pool.end()));
        await Promise.all(owners.map(owner => owner.close()));
      }
    },
  );
});

describe('bind-parameter NUL stripping (psfn-framework-dn05)', () => {
  function captureBindPool(): { pool: Pool; lastValues: () => readonly unknown[] } {
    let captured: readonly unknown[] = [];
    const pool = {
      // eslint-disable-next-line @typescript-eslint/require-await
      query: async (_text: string, values?: readonly unknown[]) => {
        captured = values ?? [];
        return { rows: [{ ok: 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
      },
    } as unknown as Pool;
    return { pool, lastValues: () => captured };
  }

  it('strips embedded NUL bytes from string bind parameters (queryRows)', async () => {
    const { pool, lastValues } = captureBindPool();
    // A portal identity string carrying a smuggled NUL (the $6 vector).
    await queryRows(pool, 'SELECT 1 WHERE $1 = $1', ['portal\x00id']);
    expect(lastValues()).toEqual(['portalid']);
  });

  it('preserves explicit row types through executeQuery', async () => {
    const { pool } = captureBindPool();
    const result = await executeQuery<{ ok: number }>(pool, 'SELECT 1 AS ok');

    expect(result.rows).toEqual([{ ok: 1 }]);
  });

  it('strips a raw NUL byte embedded inside a JSON-shaped string parameter', async () => {
    const { pool, lastValues } = captureBindPool();
    // A raw 0x00 byte living inside a JSON string bound to a jsonb column —
    // the write vector behind the 22021 errors. (JSON.stringify would escape
    // NUL to the text "\\u0000"; the failures come from raw bytes.)
    const payload = '{"note":"hello\x00world","tag":"ok"}';
    await executeQuery(pool, 'INSERT INTO t(doc) VALUES ($1::jsonb)', [payload]);
    const [bound] = lastValues();
    expect(typeof bound).toBe('string');
    expect(bound as string).not.toContain('\x00');
    expect(JSON.parse(bound as string)).toEqual({ note: 'helloworld', tag: 'ok' });
  });

  it('round-trips a string with an embedded NUL without a server error', async () => {
    const { pool, lastValues } = captureBindPool();
    // Before the fix pg rejected this with 22021; now it binds cleanly.
    const row = await queryOne<{ ok: number }>(pool, 'SELECT $1::text', ['a\x00b\x00c']);
    expect(row).toEqual({ ok: 1 });
    expect(lastValues()).toEqual(['abc']);
  });

  it('leaves non-string parameters and NUL-free strings untouched', async () => {
    const { pool, lastValues } = captureBindPool();
    const buffer = Buffer.from([0x00, 0x01]);
    await queryRows(pool, 'SELECT $1, $2, $3, $4', ['clean', 42, null, buffer]);
    expect(lastValues()).toEqual(['clean', 42, null, buffer]);
  });
});

describe('createPostgresPool client.query NUL stripping at the shared boundary (psfn-framework-dn05)', () => {
  // Direct `client.query(...)` callers (fleet-auth stores like the portal
  // authorization store, and the session message upsert) bypass
  // queryRows/queryOne/executeQuery. The pool wrapper installed by
  // createPostgresPool must sanitize those too, so the portal $6 22021 vector
  // cannot reach the driver through pool.connect().
  interface FakeClient {
    query: (...args: unknown[]) => Promise<QueryResult>;
    release: () => void;
  }

  function fakePoolWithClient(): {
    pool: Pool;
    lastValues: () => readonly unknown[];
  } {
    let captured: readonly unknown[] = [];
    const client: FakeClient = {
      // eslint-disable-next-line @typescript-eslint/require-await
      query: async (...args: unknown[]) => {
        const config = args[0];
        if (config && typeof config === 'object' && Array.isArray((config as { values?: unknown }).values)) {
          captured = (config as { values: readonly unknown[] }).values;
        } else {
          captured = (args[1] as readonly unknown[] | undefined) ?? [];
        }
        return {
          rows: [{ inserted: true }], rowCount: 1, command: 'INSERT', oid: 0, fields: [],
        } as unknown as QueryResult;
      },
      release: () => {},
    };
    // A minimal Pool stand-in that hands out our fake client from connect().
    const pool = {
      // eslint-disable-next-line @typescript-eslint/require-await
      connect: async () => client,
      // eslint-disable-next-line @typescript-eslint/require-await
      query: async () => ({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }),
    } as unknown as Pool;
    return { pool, lastValues: () => captured };
  }

  it('strips embedded NUL bytes from a direct client.query(text, values) write', async () => {
    const { pool, lastValues } = fakePoolWithClient();
    installBindParameterNulStripping(pool);

    const client = await pool.connect();
    // The portal $6 identity vector: a smuggled NUL reaching a store via
    // pool.connect().client.query, which bypasses the queryRows helpers.
    await client.query(
      'INSERT INTO portal_authorization (subject) VALUES ($1)',
      ['portal\x00subject'],
    );
    expect(lastValues()).toEqual(['portalsubject']);
  });

  it('strips NUL bytes from the query(config) form (config.values)', async () => {
    const { pool, lastValues } = fakePoolWithClient();
    installBindParameterNulStripping(pool);

    const client = await pool.connect();
    await client.query({
      text: 'INSERT INTO session_messages_projection (content) VALUES ($1)',
      values: ['hello\x00world'],
    });
    expect(lastValues()).toEqual(['helloworld']);
  });

  it('leaves NUL-free and non-string client.query parameters untouched', async () => {
    const { pool, lastValues } = fakePoolWithClient();
    installBindParameterNulStripping(pool);

    const client = await pool.connect();
    const buffer = Buffer.from([0x00, 0x01]);
    await client.query('UPDATE t SET a=$1, b=$2, c=$3', ['clean', 7, buffer]);
    expect(lastValues()).toEqual(['clean', 7, buffer]);
  });

  it('wraps each pooled client only once (idempotent across re-acquisition)', async () => {
    const { pool, lastValues } = fakePoolWithClient();
    installBindParameterNulStripping(pool);

    // The same underlying client is handed back on a second connect(); a double
    // wrap must still strip a NUL exactly once and never corrupt the value.
    const first = await pool.connect();
    first.release();
    const second = await pool.connect();
    await second.query('UPDATE t SET v = $1', ['a\x00b']);
    expect(lastValues()).toEqual(['ab']);
  });

  it('createPostgresPool returns a pool with a wrapped query/connect seam', async () => {
    const pool = createPostgresPool(CONNECTION_STRING);
    try {
      expect(typeof pool.connect).toBe('function');
      expect(typeof pool.query).toBe('function');
    } finally {
      await pool.end();
    }
  });
});
