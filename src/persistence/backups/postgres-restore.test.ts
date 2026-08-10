import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveRestoreVerifyDatabaseUrl,
  verifyPostgresDumpRestore,
} from './postgres-restore.js';

describe('deriveRestoreVerifyDatabaseUrl', () => {
  it('appends _restore_verify to the database name', () => {
    expect(deriveRestoreVerifyDatabaseUrl('postgresql://u:p@127.0.0.1:5432/psfn'))
      .toBe('postgresql://u:p@127.0.0.1:5432/psfn_restore_verify');
  });

  it('returns null for non-URL connection strings', () => {
    expect(deriveRestoreVerifyDatabaseUrl('host=localhost dbname=psfn')).toBeNull();
  });

  it.each([
    'dbname=production',
    'host=production.internal',
    'hostaddr=192.0.2.10',
    'port=6432',
    'service=production',
  ])('rejects destination-routing override %s', (query) => {
    expect(deriveRestoreVerifyDatabaseUrl(
      `postgresql://u:p@127.0.0.1:5432/psfn?${query}`,
    )).toBeNull();
  });
});

describe('verifyPostgresDumpRestore', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  function makeRoot(): string {
    const root = join(tmpdir(), `psfn-pg-restore-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    return root;
  }

  function writeStubPgRestore(root: string): string {
    const stubPath = join(root, 'stub-pg-restore.sh');
    writeFileSync(stubPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return stubPath;
  }

  function writeCredentialRecordingStubPgRestore(root: string): {
    stubPath: string;
    argvPath: string;
    envPath: string;
  } {
    const stubPath = join(root, 'stub-pg-restore-credential-recording.sh');
    const argvPath = join(root, 'pg-restore.argv');
    const envPath = join(root, 'pg-restore.env');
    writeFileSync(stubPath, [
      '#!/bin/sh',
      `printf '%s\n' "$@" > '${argvPath}'`,
      `printf 'PGPASSWORD=%s|PGPASSFILE=%s|PGSERVICE=%s|PGSERVICEFILE=%s|PGSSLKEY=%s|KRB5CCNAME=%s\n' "$PGPASSWORD" "$PGPASSFILE" "$PGSERVICE" "$PGSERVICEFILE" "$PGSSLKEY" "$KRB5CCNAME" > '${envPath}'`,
      "printf '%s' 'restore warning Ab Cd/Ef Ab%20Cd%2FEf Ab%20Cd%2fEf Ab+Cd%2FEf Ab+Cd%2fEf' >&2",
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    return { stubPath, argvPath, envPath };
  }

  function writeFailingCredentialStubPsql(root: string): string {
    const stubPath = join(root, 'stub-psql-credential-error.sh');
    writeFileSync(stubPath, [
      '#!/bin/sh',
      "printf '%s' 'connection failed Wx Yz/Qr Wx%20Yz%2FQr Wx%20Yz%2fQr Wx+Yz%2FQr Wx+Yz%2fQr' >&2",
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    return stubPath;
  }

  /**
   * Stub psql that answers the verification queries; restored-side counts come
   * from URLs containing `restore_verify`, source-side counts otherwise.
   */
  function writeStubPsql(
    root: string,
    behavior: { emptyRestoredMemories?: boolean; failOnReflections?: boolean; missingVectorExtension?: boolean } = {},
  ): string {
    const stubPath = join(root, 'stub-psql.sh');
    const restoredMemories = behavior.emptyRestoredMemories ? '0' : '1200';
    const vectorExtensionCount = behavior.missingVectorExtension ? '0' : '1';
    const reflectionsCase = behavior.failOnReflections
      ? '    echo "ERROR: relation \\"reflections\\" does not exist" >&2; exit 1 ;;'
      : '    echo 7 ;;';
    writeFileSync(stubPath, [
      '#!/bin/sh',
      'sql=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-c" ]; then sql="$arg"; fi',
      '  prev="$arg"',
      'done',
      'url="$prev"',
      'case "$sql" in',
      '  *information_schema.tables*)',
      '    echo 33 ;;',
      '  *pg_extension*)',
      `    echo ${vectorExtensionCount} ;;`,
      '  *typname*)',
      '    echo "l2_memories.embedding" ;;',
      '  *"<=>"*)',
      '    echo 0 ;;',
      '  *\'FROM "l2_memories"\'*)',
      `    case "$url" in *restore_verify*) echo ${restoredMemories} ;; *) echo 1250 ;; esac ;;`,
      '  *\'FROM "reflections"\'*)',
      reflectionsCase,
      '  *\'FROM "\'*)',
      '    echo 5 ;;',
      '  *)',
      '    : ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    return stubPath;
  }

  function writeCredentialRecordingStubPsql(root: string): {
    stubPath: string;
    argvPath: string;
    envPath: string;
  } {
    const argvPath = join(root, 'psql.argv');
    const envPath = join(root, 'psql.env');
    const stubPath = writeStubPsql(root);
    const original = join(root, 'stub-psql-original.sh');
    writeFileSync(original, readFileSync(stubPath, 'utf8'), { mode: 0o755 });
    writeFileSync(stubPath, [
      '#!/bin/sh',
      `printf '%s\n' "$@" >> '${argvPath}'`,
      `printf 'PGPASSWORD=%s|PGPASSFILE=%s|PGSERVICE=%s|PGSERVICEFILE=%s|PGSSLKEY=%s|KRB5CCNAME=%s\n' "$PGPASSWORD" "$PGPASSFILE" "$PGSERVICE" "$PGSERVICEFILE" "$PGSSLKEY" "$KRB5CCNAME" >> '${envPath}'`,
      `exec '${original}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    return { stubPath, argvPath, envPath };
  }

  function writeDump(root: string): string {
    const dumpPath = join(root, 'psfn.dump');
    writeFileSync(dumpPath, 'PGDMP-stub');
    return dumpPath;
  }

  it('restores into the scratch database and reports fidelity checks', async () => {
    const root = makeRoot();
    const result = await verifyPostgresDumpRestore({
      dumpPath: writeDump(root),
      scratchDatabaseUrl: 'postgresql://u:p@127.0.0.1:5432/psfn_restore_verify',
      sourceDatabaseUrl: 'postgresql://u:p@127.0.0.1:5432/psfn',
      psqlBinary: writeStubPsql(root),
      pgRestoreBinary: writeStubPgRestore(root),
    });

    expect(result.restoredTableCount).toBe(33);
    expect(result.vectorExtensionPresent).toBe(true);
    expect(result.vectorColumnChecked).toBe('l2_memories.embedding');
    const memories = result.tableCounts.find(entry => entry.table === 'l2_memories');
    expect(memories).toEqual({ table: 'l2_memories', restored: 1200, source: 1250 });
    expect(result.tableCounts.find(entry => entry.table === 'recent_contact_shapes'))
      .toEqual({ table: 'recent_contact_shapes', restored: 5, source: 5 });
    expect(result.tableCounts.filter(entry => entry.table.startsWith('biographical_')))
      .toEqual([
        { table: 'biographical_claims', restored: 5, source: 5 },
        { table: 'biographical_grants', restored: 5, source: 5 },
        { table: 'biographical_rebuild_queue', restored: 5, source: 5 },
        { table: 'biographical_review_audits', restored: 5, source: 5 },
      ]);
  });

  it('keeps explicit credentials only in sanitized child environments and redacts diagnostics', async () => {
    const root = makeRoot();
    const psql = writeCredentialRecordingStubPsql(root);
    const pgRestore = writeCredentialRecordingStubPgRestore(root);
    vi.stubEnv('PGPASSWORD', 'ambient-password');
    vi.stubEnv('PGPASSFILE', '/secret/ambient.pgpass');
    vi.stubEnv('PGSERVICE', 'production');
    vi.stubEnv('PGSERVICEFILE', '/secret/pg_service.conf');
    vi.stubEnv('PGSSLKEY', '/secret/client.key');
    vi.stubEnv('KRB5CCNAME', 'FILE:/secret/krb5-cache');

    const result = await verifyPostgresDumpRestore({
      dumpPath: writeDump(root),
      scratchDatabaseUrl: 'postgresql://u@127.0.0.1:5432/psfn_restore_verify?password=Ab%20Cd%2FEf',
      sourceDatabaseUrl: 'postgresql://u:source-secret@127.0.0.1:5432/psfn',
      psqlBinary: psql.stubPath,
      pgRestoreBinary: pgRestore.stubPath,
    });

    const argv = `${readFileSync(psql.argvPath, 'utf8')}\n${readFileSync(pgRestore.argvPath, 'utf8')}`;
    expect(argv).not.toContain('Ab Cd/Ef');
    expect(argv).not.toContain('Ab%20Cd%2FEf');
    expect(argv).not.toContain('source-secret');
    expect(argv).not.toContain('password=');
    expect(argv).toContain('--no-password');

    const psqlEnv = readFileSync(psql.envPath, 'utf8');
    const pgRestoreEnv = readFileSync(pgRestore.envPath, 'utf8');
    expect(psqlEnv).toContain('PGPASSWORD=Ab Cd/Ef');
    expect(psqlEnv).toContain('PGPASSWORD=source-secret');
    expect(pgRestoreEnv).toContain('PGPASSWORD=Ab Cd/Ef');
    for (const env of [psqlEnv, pgRestoreEnv]) {
      expect(env).toContain(`PGPASSFILE=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`);
      expect(env).toContain('PGSERVICE=|PGSERVICEFILE=|PGSSLKEY=');
      expect(env).not.toContain('ambient-password');
      expect(env).not.toContain('/secret/');
    }
    expect(result.restoreWarnings).toContain('[redacted]');
    for (const secretSpelling of [
      'Ab Cd/Ef',
      'Ab%20Cd%2FEf',
      'Ab%20Cd%2fEf',
      'Ab+Cd%2FEf',
      'Ab+Cd%2fEf',
    ]) {
      expect(result.restoreWarnings).not.toContain(secretSpelling);
    }
  });

  it('redacts raw, URI-encoded, and form-encoded passwords from wrapped psql errors', async () => {
    const root = makeRoot();
    let error: unknown;
    try {
      await verifyPostgresDumpRestore({
        dumpPath: writeDump(root),
        scratchDatabaseUrl: 'postgresql://u@127.0.0.1:5432/psfn_restore_verify?password=Wx%20Yz%2FQr',
        psqlBinary: writeFailingCredentialStubPsql(root),
        pgRestoreBinary: writeStubPgRestore(root),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[redacted]');
    for (const secretSpelling of [
      'Wx Yz/Qr',
      'Wx%20Yz%2FQr',
      'Wx%20Yz%2fQr',
      'Wx+Yz%2FQr',
      'Wx+Yz%2fQr',
    ]) {
      expect((error as Error).message).not.toContain(secretSpelling);
    }
  });

  it('fails closed when a critical table restores empty while the source has rows', async () => {
    const root = makeRoot();
    await expect(verifyPostgresDumpRestore({
      dumpPath: writeDump(root),
      scratchDatabaseUrl: 'postgresql://u:p@127.0.0.1:5432/psfn_restore_verify',
      sourceDatabaseUrl: 'postgresql://u:p@127.0.0.1:5432/psfn',
      psqlBinary: writeStubPsql(root, { emptyRestoredMemories: true }),
      pgRestoreBinary: writeStubPgRestore(root),
    })).rejects.toThrow('l2_memories has 1250 rows at the source but restored empty');
  });

  it('fails closed when a critical table is missing after restore', async () => {
    const root = makeRoot();
    await expect(verifyPostgresDumpRestore({
      dumpPath: writeDump(root),
      scratchDatabaseUrl: 'postgresql://u:p@127.0.0.1:5432/psfn_restore_verify',
      psqlBinary: writeStubPsql(root, { failOnReflections: true }),
      pgRestoreBinary: writeStubPgRestore(root),
    })).rejects.toThrow('Critical table missing after restore: reflections');
  });

  it('fails closed when the pgvector extension is missing from the scratch database', async () => {
    const root = makeRoot();
    await expect(verifyPostgresDumpRestore({
      dumpPath: writeDump(root),
      scratchDatabaseUrl: 'postgresql://u:p@127.0.0.1:5432/psfn_restore_verify',
      psqlBinary: writeStubPsql(root, { missingVectorExtension: true }),
      pgRestoreBinary: writeStubPgRestore(root),
    })).rejects.toThrow('pgvector extension is missing in the scratch database');
  });

  it('fails closed when the dump archive is missing', async () => {
    const root = makeRoot();
    await expect(verifyPostgresDumpRestore({
      dumpPath: join(root, 'missing.dump'),
      scratchDatabaseUrl: 'postgresql://u:p@127.0.0.1:5432/psfn_restore_verify',
      psqlBinary: writeStubPsql(root),
      pgRestoreBinary: writeStubPgRestore(root),
    })).rejects.toThrow('Postgres dump archive missing');
  });
});
