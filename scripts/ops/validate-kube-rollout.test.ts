import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const scriptPath = join(repoRoot, 'scripts/ops/validate-kube-rollout.sh');

/**
 * The bookkeeping check is bash, and its only real inputs are the two
 * `run_postgres_sql` responses, so the honest way to test it is to run it.
 * The harness lifts the real function body out of the gate script, stubs
 * `run_postgres_sql` with test-supplied responses, and reports the function's
 * exit status. Asserting on the script *source* instead cannot distinguish a
 * fail-closed check from a fail-open one.
 */
const HARNESS = String.raw`#!/usr/bin/env bash
set -euo pipefail

run_postgres_sql() {
  local sql=$1
  if [[ "$sql" == *pg_catalog.pg_tables* ]]; then
    printf '%s' "$sql" > "$HARNESS_DIR/discovery-call.sql"
    cat "$HARNESS_DIR/discovery.out"
    return 0
  fi
  printf '%s' "$sql" > "$HARNESS_DIR/executed.sql"
  cat "$HARNESS_DIR/projection.out"
  return 0
}

# Capture the function verbatim: from its header to the next top-level
# definition. A brace-terminated range would stop early, because the embedded
# node program has lines that begin with "}".
eval "$(awk '
  /^check_zero_bookkeeping_writes\(\) \{$/ { started = 1; print; next }
  started && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{$/ { exit }
  started { print }
' "$GATE_SCRIPT")"

if ! declare -F check_zero_bookkeeping_writes >/dev/null; then
  printf 'harness could not extract check_zero_bookkeeping_writes from %s\n' "$GATE_SCRIPT" >&2
  exit 97
fi

rc=0
check_zero_bookkeeping_writes || rc=$?
exit "$rc"
`;

interface Responses {
  /** Text the discovery call returns; empty means no schema holds the projection. */
  discovery: string;
  /** Text the generated per-schema query returns, one JSON row per line. */
  projection?: string;
}

interface CheckResult {
  status: number;
  output: string;
  executedSql: string | undefined;
}

/** The generated SQL a real discovery call hands back for the given schemas. */
function generatedSql(schemas: string[]): string {
  return schemas
    .map(
      (schema) =>
        `select json_build_object('schema', '${schema}', 'count', count(*)::text)::text ` +
        `from ${schema}.session_messages_projection ` +
        `where author_name in ('CompletionHandoff','BackgroundContinuation')`,
    )
    .join('\nunion all\n');
}

function jsonRows(rows: Array<{ schema: string; count: string }>): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

describe('check_zero_bookkeeping_writes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function runCheck(responses: Responses): CheckResult {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-bookkeeping-'));
    tempDirs.push(dir);

    const harnessPath = join(dir, 'harness.sh');
    writeFileSync(harnessPath, HARNESS, 'utf8');
    writeFileSync(join(dir, 'discovery.out'), responses.discovery, 'utf8');
    writeFileSync(join(dir, 'projection.out'), responses.projection ?? '', 'utf8');

    const result = spawnSync('bash', [harnessPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HARNESS_DIR: dir,
        GATE_SCRIPT: scriptPath,
      },
    });

    const executedSqlPath = join(dir, 'executed.sql');

    return {
      status: result.status ?? -1,
      output: `${result.stdout}${result.stderr}`,
      executedSql: existsSync(executedSqlPath) ? readFileSync(executedSqlPath, 'utf8') : undefined,
    };
  }

  it('fails closed when discovery finds the projection in no schema', () => {
    const result = runCheck({ discovery: '' });

    expect(result.output).toContain('no projection found in any schema');
    expect(result.status).not.toBe(0);
    // Nothing was validated, so the generated query must never have run.
    expect(result.executedSql).toBeUndefined();
  });

  it('names the schema and count when bookkeeping rows are present', () => {
    const result = runCheck({
      discovery: `${generatedSql(['companion_alpha', 'companion_beta'])}\n`,
      projection: `${jsonRows([
        { schema: 'companion_alpha', count: '0' },
        { schema: 'companion_beta', count: '3' },
      ])}\n`,
    });

    expect(result.output).toContain(
      'bookkeeping projection rows present in schema companion_beta: 3',
    );
    expect(result.status).not.toBe(0);
  });

  it('passes and reports every schema it checked when all are clean', () => {
    const schemas = ['companion_alpha', 'companion_beta', 'public'];
    const discovery = `${generatedSql(schemas)}\n`;
    const result = runCheck({
      discovery,
      projection: `${jsonRows(schemas.map((schema) => ({ schema, count: '0' })))}\n`,
    });

    expect(result.output, result.output).toContain(
      'bookkeeping projection rows=0; checked schemas=companion_alpha, companion_beta, public',
    );
    expect(result.status).toBe(0);
    // The check must execute what discovery generated, not a query of its own.
    expect(result.executedSql?.trim()).toBe(discovery.trim());
  });

  it('fails closed when the projection query returns a malformed row', () => {
    const result = runCheck({
      discovery: `${generatedSql(['companion_alpha'])}\n`,
      projection: '{"schema":"companion_alpha","count":"0"}\n{"schema":"companion_beta"\n',
    });

    expect(result.output).toContain('bookkeeping projection query returned invalid JSON');
    expect(result.status).not.toBe(0);
  });

  it('fails closed when a row carries a count that is not a number', () => {
    const result = runCheck({
      discovery: `${generatedSql(['companion_alpha'])}\n`,
      projection: `${jsonRows([{ schema: 'companion_alpha', count: 'none' }])}\n`,
    });

    expect(result.output).toContain('bookkeeping projection query returned an invalid result');
    expect(result.status).not.toBe(0);
  });

  // Discovery itself is a Postgres catalog query, so no stub can prove it is
  // schema-generic; without a live cluster that property is only observable in
  // the statement text. Every other branch of this check is executed above.
  it('discovers the projection across every schema, not just public', () => {
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('from pg_catalog.pg_tables');
    expect(script).toContain('%I.session_messages_projection');
    expect(script).not.toMatch(/\bfrom\s+session_messages_projection\b/i);
    expect(script).not.toMatch(/\bfrom\s+public\.session_messages_projection\b/i);
  });
});
