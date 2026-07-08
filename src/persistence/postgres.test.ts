import { describe, expect, it } from 'vitest';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  POSTGRES_SCHEMA_NAME_MAX_LENGTH,
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
        '-c search_path=companion_a,public',
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
});
