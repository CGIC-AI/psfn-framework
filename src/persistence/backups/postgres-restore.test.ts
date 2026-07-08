import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
});

describe('verifyPostgresDumpRestore', () => {
  const roots: string[] = [];

  afterEach(() => {
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
