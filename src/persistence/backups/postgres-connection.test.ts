import { describe, expect, it } from 'vitest';
import {
  createSanitizedPostgresChildEnv,
  redactPostgresCredential,
  sanitizePostgresConnection,
} from './postgres-connection.js';

const SAFE_LIBPQ_QUERY_PARAMETERS = [
  ['application_name', 'restore-verifier'],
  ['channel_binding', 'require'],
  ['client_encoding', 'UTF8'],
  ['connect_timeout', '10'],
  ['dbname', 'runtime'],
  ['fallback_application_name', 'psfn'],
  ['host', 'db.internal'],
  ['hostaddr', '127.0.0.1'],
  ['keepalives', '1'],
  ['keepalives_count', '3'],
  ['keepalives_idle', '30'],
  ['keepalives_interval', '10'],
  ['load_balance_hosts', 'disable'],
  ['max_protocol_version', '3.2'],
  ['min_protocol_version', '3.0'],
  ['options', '-c statement_timeout=0'],
  ['port', '5432'],
  ['replication', 'false'],
  ['requirepeer', 'postgres'],
  ['requiressl', '1'],
  ['ssl_max_protocol_version', 'TLSv1.3'],
  ['ssl_min_protocol_version', 'TLSv1.2'],
  ['ssl', 'true'],
  ['sslcompression', '0'],
  ['sslcrl', '/etc/ssl/postgres.crl'],
  ['sslcrldir', '/etc/ssl/postgres-crl'],
  ['sslmode', 'verify-full'],
  ['sslnegotiation', 'postgres'],
  ['sslrootcert', 'system'],
  ['sslsni', '1'],
  ['target_session_attrs', 'primary'],
  ['tcp_user_timeout', '10000'],
  ['user', 'restore'],
] as const;

const UNSUPPORTED_LIBPQ_CREDENTIAL_PARAMETERS = [
  'gssdelegation',
  'gssencmode',
  'gsslib',
  'krbsrvname',
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_issuer',
  'oauth_scope',
  'passfile',
  'require_auth',
  'scram_client_key',
  'scram_server_key',
  'service',
  'sslcert',
  'sslcertmode',
  'sslkey',
  'sslkeylogfile',
  'sslpassword',
] as const;

describe('redactPostgresCredential', () => {
  it('redacts percent-escape case variants without changing literal password case', () => {
    const redacted = redactPostgresCredential(
      'raw=Ab/Cd upper=Ab%2FCd lower=Ab%2fCd form=Ab%2fCd decoy=ab%2fcd',
      'Ab/Cd',
    );

    expect(redacted).toBe(
      'raw=[redacted] upper=[redacted] lower=[redacted] form=[redacted] decoy=ab%2fcd',
    );
  });
});

describe('sanitizePostgresConnection', () => {
  it('extracts a query-string password and preserves non-secret connection parameters', () => {
    expect(sanitizePostgresConnection(
      'postgresql://restore@127.0.0.1:5432/runtime?sslmode=require&password=query%2Dsecret',
      'Test restore',
    )).toEqual({
      connectionArg: 'postgresql://restore@127.0.0.1:5432/runtime?sslmode=require&sslcertmode=disable&require_auth=%21gss%2C%21sspi',
      password: 'query-secret',
    });
  });

  it.each(SAFE_LIBPQ_QUERY_PARAMETERS)('preserves supported non-credential libpq parameter %s', (parameter, value) => {
    const sanitized = sanitizePostgresConnection(
      `postgresql://restore@127.0.0.1/runtime?${parameter}=${encodeURIComponent(value)}`,
      'Test restore',
    );

    expect(sanitized.connectionArg).toContain(`${parameter}=${encodeURIComponent(value)}`);
    expect(sanitized.connectionArg).toContain('sslcertmode=disable');
    expect(sanitized.connectionArg).toContain('require_auth=%21gss%2C%21sspi');
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
      connectionArg: 'postgresql://restore@127.0.0.1:5432/runtime?sslcertmode=disable&require_auth=%21gss%2C%21sspi',
      password: expectedPassword,
    });
  });

  it.each(UNSUPPORTED_LIBPQ_CREDENTIAL_PARAMETERS)(
    'rejects unsupported credential or indirect-auth parameter %s without echoing values',
    (parameter) => {
      const secret = `${parameter}-raw/secret`;
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
    },
  );

  it('rejects unknown connection parameters without echoing the name or value', () => {
    const parameter = 'future_credential_selector';
    const secret = 'future/raw-secret';
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
    expect((error as Error).message).toMatch(/unsupported database URL parameter/);
    expect((error as Error).message).not.toContain(parameter);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain(encodeURIComponent(secret));
  });

  it.each([
    'postgresql://nested:nested-secret@127.0.0.1/other',
    'host=127.0.0.1 password=nested-secret',
  ])('rejects an extended dbname value that could hide nested credentials', (nestedConnection) => {
    let error: unknown;
    try {
      sanitizePostgresConnection(
        `postgresql://restore@127.0.0.1/runtime?dbname=${encodeURIComponent(nestedConnection)}`,
        'Test restore',
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/unsupported credential-bearing parameter/);
    expect((error as Error).message).not.toContain('nested-secret');
    expect((error as Error).message).not.toContain(encodeURIComponent(nestedConnection));
  });

  it('rejects URL fragments without echoing their content', () => {
    const secret = 'fragment-secret';
    let error: unknown;
    try {
      sanitizePostgresConnection(
        `postgresql://restore@127.0.0.1/runtime#password=${secret}`,
        'Test restore',
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/must not contain a fragment/);
    expect((error as Error).message).not.toContain(secret);
  });
});

describe('createSanitizedPostgresChildEnv', () => {
  it('removes ambient libpq and GSS credential sources and installs only the explicit password', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/restore',
      PGPASSWORD: 'ambient-password',
      PGPASSFILE: '/secret/pgpass',
      PGSERVICE: 'production',
      PGSERVICEFILE: '/secret/pg-service.conf',
      PGSSLCERT: '/secret/client.crt',
      PGSSLKEY: '/secret/client.key',
      PGSSLPASSWORD: 'ambient-key-password',
      PGOAUTHCLIENTSECRET: 'ambient-oauth-secret',
      PGSCRAMCLIENTKEY: 'ambient-scram-client-key',
      PGSCRAMSERVERKEY: 'ambient-scram-server-key',
      PGSYSCONFDIR: '/secret/system-config',
      pgservice: 'mixed-case-service',
      KRB5CCNAME: 'FILE:/secret/krb5-cache',
      KRB5_CLIENT_KTNAME: 'FILE:/secret/client.keytab',
      KRB5_KTNAME: 'FILE:/secret/server.keytab',
    } satisfies NodeJS.ProcessEnv;

    const env = createSanitizedPostgresChildEnv('explicit-password', source);

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/restore',
      PGPASSWORD: 'explicit-password',
      PGPASSFILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
      KRB5CCNAME: 'MEMORY:',
    });
    expect(Object.keys(env).filter(name => name.toUpperCase().startsWith('PG')).sort())
      .toEqual(['PGPASSFILE', 'PGPASSWORD']);
    expect(env.KRB5_CLIENT_KTNAME).toBeUndefined();
    expect(env.KRB5_KTNAME).toBeUndefined();
    expect(source.PGPASSWORD).toBe('ambient-password');
    expect(source.PGSERVICE).toBe('production');
  });

  it('does not set PGPASSWORD when the approved URL has no explicit password', () => {
    const env = createSanitizedPostgresChildEnv(undefined, {
      PATH: '/usr/bin',
      PGPASSWORD: 'ambient-password',
    });

    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.PGPASSFILE).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
  });
});
