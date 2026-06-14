import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PSQL_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Core tables the decant scenario depends on; presence is asserted, counts are reported. */
export const DEFAULT_RESTORE_CRITICAL_TABLES = [
  'l2_memories',
  'l01_episodes',
  'contacts',
  'reflections',
  'session_messages_projection',
  'model_usage_events',
] as const;

export interface PostgresRestoreVerificationOptions {
  dumpPath: string;
  /**
   * Dedicated scratch database used as the restore target. All user tables,
   * sequences, and views in its `public` schema are dropped by every
   * verification run — it must never point at a database holding real data.
   * One-time setup: create the database owned by the runtime role and run
   * `CREATE EXTENSION vector` in it as superuser (pgvector is untrusted on
   * stock installs, so the restore cannot recreate it).
   */
  scratchDatabaseUrl: string;
  /**
   * When set, per-table source counts are captured and any critical table
   * that has rows at the source must also have rows after restore.
   */
  sourceDatabaseUrl?: string;
  criticalTables?: readonly string[];
  psqlBinary?: string;
  pgRestoreBinary?: string;
}

export interface PostgresRestoreTableCount {
  table: string;
  restored: number;
  source?: number;
}

export interface PostgresRestoreVerificationResult {
  dumpPath: string;
  restoredTableCount: number;
  vectorExtensionPresent: boolean;
  /** `table.column` of the vector column exercised with a distance operator, when one exists with rows. */
  vectorColumnChecked: string | null;
  tableCounts: PostgresRestoreTableCount[];
  /** Non-fatal pg_restore diagnostics (ownership/ACL noise under --no-owner). */
  restoreWarnings: string | null;
}

function describeExecError(error: unknown): string {
  if (error && typeof error === 'object') {
    const execError = error as NodeJS.ErrnoException & { stderr?: string };
    if (execError.code === 'ENOENT') {
      return `binary not found (${execError.message})`;
    }
    const stderr = typeof execError.stderr === 'string' ? execError.stderr.trim() : '';
    if (stderr) {
      return `${execError.message}: ${stderr}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

async function runPsql(
  binary: string,
  databaseUrl: string,
  sql: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      binary,
      ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql, databaseUrl],
      { maxBuffer: PSQL_MAX_BUFFER_BYTES },
    );
    return stdout.trim();
  } catch (error) {
    throw new Error(`psql failed (${sql.slice(0, 80)}…): ${describeExecError(error)}`);
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Drops restored user objects while preserving the pgvector extension: the
// extension requires superuser to (re)create on untrusted installs, so it is
// installed once at scratch-database setup and must survive wipes.
const WIPE_SCRATCH_OBJECTS_SQL = `
CREATE SCHEMA IF NOT EXISTS public;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.sequencename);
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.viewname);
  END LOOP;
END $$;
`;

async function wipeScratchSchema(binary: string, scratchDatabaseUrl: string): Promise<void> {
  await runPsql(binary, scratchDatabaseUrl, WIPE_SCRATCH_OBJECTS_SQL);
}

/**
 * Restores a pg_dump custom-format archive into a dedicated scratch database
 * and asserts the decant scenario essentials: the schema comes back, pgvector
 * is functional, the critical tables exist, and any critical table populated
 * at the source is populated after restore. The scratch schema is wiped
 * before and after so the verification leaves no restored data behind.
 */
export async function verifyPostgresDumpRestore(
  options: PostgresRestoreVerificationOptions,
): Promise<PostgresRestoreVerificationResult> {
  if (!existsSync(options.dumpPath)) {
    throw new Error(`Postgres dump archive missing: ${options.dumpPath}`);
  }
  const psqlBinary = options.psqlBinary?.trim() || 'psql';
  const pgRestoreBinary = options.pgRestoreBinary?.trim() || 'pg_restore';
  const criticalTables = options.criticalTables ?? DEFAULT_RESTORE_CRITICAL_TABLES;

  await wipeScratchSchema(psqlBinary, options.scratchDatabaseUrl);
  try {
    // --no-owner/--no-acl restores under the scratch role; pg_restore can exit
    // non-zero on ignorable ownership noise, so the assertions below — not the
    // exit code — are the verification.
    let restoreWarnings: string | null = null;
    try {
      const { stderr } = await execFileAsync(
        pgRestoreBinary,
        ['--no-owner', '--no-acl', `--dbname=${options.scratchDatabaseUrl}`, options.dumpPath],
        { maxBuffer: PSQL_MAX_BUFFER_BYTES },
      );
      restoreWarnings = stderr.trim() || null;
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stderr?: string };
      if (execError.code === 'ENOENT') {
        throw new Error(`pg_restore failed: ${describeExecError(error)}`);
      }
      restoreWarnings = typeof execError.stderr === 'string' && execError.stderr.trim()
        ? execError.stderr.trim()
        : describeExecError(error);
    }

    const restoredTableCount = Number(await runPsql(
      psqlBinary,
      options.scratchDatabaseUrl,
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
    ));
    if (!Number.isFinite(restoredTableCount) || restoredTableCount === 0) {
      throw new Error(`Restored scratch database has no tables (dump: ${options.dumpPath})`);
    }

    const vectorExtensionPresent = await runPsql(
      psqlBinary,
      options.scratchDatabaseUrl,
      "SELECT count(*) FROM pg_extension WHERE extname='vector'",
    ) === '1';

    const tableCounts: PostgresRestoreTableCount[] = [];
    for (const table of criticalTables) {
      let restored: number;
      try {
        restored = Number(await runPsql(
          psqlBinary,
          options.scratchDatabaseUrl,
          `SELECT count(*) FROM ${quoteIdentifier(table)}`,
        ));
      } catch (error) {
        throw new Error(`Critical table missing after restore: ${table} (${error instanceof Error ? error.message : String(error)})`);
      }

      let source: number | undefined;
      if (options.sourceDatabaseUrl) {
        source = Number(await runPsql(
          psqlBinary,
          options.sourceDatabaseUrl,
          `SELECT count(*) FROM ${quoteIdentifier(table)}`,
        ));
        if (source > 0 && restored === 0) {
          throw new Error(`Critical table ${table} has ${source} rows at the source but restored empty`);
        }
      }
      tableCounts.push({ table, restored, ...(source !== undefined ? { source } : {}) });
    }

    // Exercise a vector column with a distance operator to prove pgvector is
    // functional on restored data, not merely installed.
    let vectorColumnChecked: string | null = null;
    const vectorColumn = await runPsql(
      psqlBinary,
      options.scratchDatabaseUrl,
      "SELECT a.attrelid::regclass || '.' || a.attname FROM pg_attribute a JOIN pg_type t ON a.atttypid = t.oid JOIN pg_class c ON a.attrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid WHERE t.typname = 'vector' AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname = 'public' AND c.relkind = 'r' LIMIT 1",
    );
    if (vectorColumn) {
      const [table, column] = vectorColumn.split('.');
      if (table && column) {
        const distance = await runPsql(
          psqlBinary,
          options.scratchDatabaseUrl,
          `SELECT ${quoteIdentifier(column)} <=> ${quoteIdentifier(column)} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL LIMIT 1`,
        );
        if (distance !== '' && Number(distance) !== 0) {
          throw new Error(`Vector self-distance check failed for ${vectorColumn}: got ${distance}`);
        }
        vectorColumnChecked = distance === '' ? null : vectorColumn;
      }
    }

    return {
      dumpPath: options.dumpPath,
      restoredTableCount,
      vectorExtensionPresent,
      vectorColumnChecked,
      tableCounts,
      restoreWarnings,
    };
  } finally {
    await wipeScratchSchema(psqlBinary, options.scratchDatabaseUrl).catch(() => {
      // The next run wipes before restoring; a failed cleanup must not mask
      // the verification outcome.
    });
  }
}

/**
 * Derives the dedicated scratch database URL used for restore verification:
 * the same server and credentials with `_restore_verify` appended to the
 * database name. Returns null for connection strings that are not URLs.
 */
export function deriveRestoreVerifyDatabaseUrl(databaseUrl: string): string | null {
  try {
    const url = new URL(databaseUrl);
    const databaseName = url.pathname.replace(/^\//, '').trim();
    if (!databaseName) return null;
    url.pathname = `/${databaseName}_restore_verify`;
    return url.toString();
  } catch {
    return null;
  }
}
