import { describe, expect, it } from 'vitest';
import { sanitizePostgresConnection } from './postgres-connection.js';

describe('sanitizePostgresConnection', () => {
  it('extracts a query-string password and preserves non-secret connection parameters', () => {
    expect(sanitizePostgresConnection(
      'postgresql://restore@127.0.0.1:5432/runtime?sslmode=require&password=query%2Dsecret',
      'Test restore',
    )).toEqual({
      connectionArg: 'postgresql://restore@127.0.0.1:5432/runtime?sslmode=require',
      password: 'query-secret',
    });
  });

  it('rejects conflicting userinfo and query password sources without echoing either secret', () => {
    let error: unknown;
    try {
      sanitizePostgresConnection(
        'postgresql://restore:userinfo-secret@127.0.0.1/runtime?password=query-secret',
        'Test restore',
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/conflicting password sources/);
    expect((error as Error).message).not.toContain('userinfo-secret');
    expect((error as Error).message).not.toContain('query-secret');
  });
});
