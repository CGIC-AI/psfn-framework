import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  executeQuery,
  POSTGRES_EXTENSION_SCHEMA_NAME,
  POSTGRES_SCHEMA_NAME_MAX_LENGTH,
  queryOne,
  queryRows,
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
    await queryRows(pool, 'SELECT 1 WHERE $1 = $1', ['portal\u0000id']);
    expect(lastValues()).toEqual(['portalid']);
  });

  it('strips a raw NUL byte embedded inside a JSON-shaped string parameter', async () => {
    const { pool, lastValues } = captureBindPool();
    // A raw 0x00 byte living inside a JSON string bound to a jsonb column —
    // the write vector behind the 22021 errors. (JSON.stringify would escape
    // NUL to the text "\u0000"; the failures come from raw bytes.)
    const payload = '{"note":"hello\u0000world","tag":"ok"}';
    await executeQuery(pool, 'INSERT INTO t(doc) VALUES ($1::jsonb)', [payload]);
    const [bound] = lastValues();
    expect(typeof bound).toBe('string');
    expect(bound as string).not.toContain('\u0000');
    expect(JSON.parse(bound as string)).toEqual({ note: 'helloworld', tag: 'ok' });
  });

  it('round-trips a string with an embedded NUL without a server error', async () => {
    const { pool, lastValues } = captureBindPool();
    // Before the fix pg rejected this with 22021; now it binds cleanly.
    const row = await queryOne<{ ok: number }>(pool, 'SELECT $1::text', ['a\u0000b\u0000c']);
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
