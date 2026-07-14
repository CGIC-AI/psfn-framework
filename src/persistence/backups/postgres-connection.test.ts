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

  it.each([
    ['literal plus', 'literal+plus', 'literal+plus'],
    ['percent-encoded plus', 'encoded%2Bplus', 'encoded+plus'],
    ['percent-encoded space', 'encoded%20space', 'encoded space'],
    ['percent-encoded percent', 'encoded%25percent', 'encoded%percent'],
    [
      'percent-encoded reserved characters',
      '%3A%2F%3F%23%5B%5D%40%21%24%26%27%28%29%2A%2B%2C%3B%3D',
      ":/?#[]@!$&'()*+,;=",
    ],
  ])('decodes %s using RFC3986 query semantics', (_label, encodedPassword, expectedPassword) => {
    expect(sanitizePostgresConnection(
      `postgresql://restore@127.0.0.1:5432/runtime?password=${encodedPassword}`,
      'Test restore',
    )).toEqual({
      connectionArg: 'postgresql://restore@127.0.0.1:5432/runtime',
      password: expectedPassword,
    });
  });

  it.each([
    ['sslpassword', 'tls-secret'],
    ['passfile', '/secret/password-file'],
    ['sslkey', '/secret/client-key'],
    ['oauth_client_secret', 'oauth-secret'],
  ])('rejects unsupported credential-bearing %s parameters without echoing values', (parameter, secret) => {
    let error: unknown;
    try {
      sanitizePostgresConnection(
        `postgresql://restore@127.0.0.1/runtime?${parameter}=${encodeURIComponent(secret)}`,
        'Test restore',
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/unsupported credential-bearing parameter/);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain(encodeURIComponent(secret));
  });
});
