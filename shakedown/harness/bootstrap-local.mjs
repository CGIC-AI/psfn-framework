#!/usr/bin/env node

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBootstrapConfig } from './lib/bootstrap-config.mjs';
import { runBootstrap } from './lib/bootstrap-runner.mjs';
import {
  proveFirstConversation,
  waitForRuntimeReadiness,
} from './lib/bootstrap-services.mjs';
import { verifyDisposablePostgresTarget } from './lib/bootstrap-postgres.mjs';

function optionalPositiveInteger(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function requireExecutable(name, env = process.env) {
  const pathEntries = env.PATH?.split(delimiter).filter(Boolean) ?? [];
  for (const pathEntry of pathEntries) {
    try {
      await access(join(pathEntry, name), constants.X_OK);
      return;
    } catch {
      // Keep checking PATH. This is read-only and runs before round creation.
    }
  }
  throw new Error(`Required bootstrap executable is unavailable on PATH: ${name}`);
}

async function assertPrerequisites() {
  await Promise.all(
    ['bash', 'curl', 'git', 'npm', 'psql', 'tmux'].map(name => requireExecutable(name)),
  );
}

const execFileAsync = promisify(execFile);

async function inspectCleanRcClone(repoRoot) {
  const [{ stdout: revisionOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot }),
  ]);
  const revision = revisionOutput.trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error('PSFN_REPO_ROOT did not resolve a full RC commit SHA');
  }
  const dirtyEntries = statusOutput.split('\n').filter(Boolean);
  if (dirtyEntries.length > 0) {
    throw new Error(
      `PSFN_REPO_ROOT must be a clean RC clone; git status reported ${dirtyEntries.length} changed path(s)`,
    );
  }
  return revision;
}

async function probePostgres(contract) {
  const schema = contract.identity.schema;
  const sql = [
    'SELECT current_database(), current_user,',
    '  (SELECT count(*) FROM pg_catalog.pg_tables',
    "   WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    "     AND schemaname NOT LIKE 'pg_toast%'),",
    `  EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = '${schema}')`,
  ].join('\n');
  const connection = contract.connection;
  const postgresEnv = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C',
    PGCONNECT_TIMEOUT: '10',
    PGHOST: connection.hostname,
    PGPORT: connection.port,
    PGDATABASE: connection.database,
    ...(connection.username ? { PGUSER: connection.username } : {}),
    ...(connection.password ? { PGPASSWORD: connection.password } : {}),
    ...(connection.ssl.sslmode ? { PGSSLMODE: connection.ssl.sslmode } : {}),
    ...(connection.ssl.sslrootcert ? { PGSSLROOTCERT: connection.ssl.sslrootcert } : {}),
    ...(connection.ssl.sslcert ? { PGSSLCERT: connection.ssl.sslcert } : {}),
    ...(connection.ssl.sslkey ? { PGSSLKEY: connection.ssl.sslkey } : {}),
  };
  const { stdout } = await execFileAsync(
    'psql',
    ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql],
    {
      env: postgresEnv,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  const [database, role, rawUserTableCount, rawSchemaExists] = stdout.trim().split('\t');
  return {
    database,
    role,
    userTableCount: Number(rawUserTableCount),
    schemaExists: rawSchemaExists === 't',
  };
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${command} ${args.join(' ')} failed`
        + (signal ? ` with signal ${signal}` : ` with exit code ${code}`),
      ));
    });
  });
}

async function main() {
  // Configuration, canonical-path, and protected-root checks complete before
  // prerequisite checks, filesystem creation, package install, or runtime work.
  const config = resolveBootstrapConfig(process.env);
  await assertPrerequisites();
  const rcRevision = await inspectCleanRcClone(config.repoRoot);
  await verifyDisposablePostgresTarget({
    contract: config.postgresContract,
    resume: config.resume,
    probe: probePostgres,
  });
  // The full live DSN exists only long enough for the read-only deny check. Do
  // not pass that protected credential into the disposable runtime process.
  delete process.env.PSFN_LIVE_POSTGRES_DATABASE_URL;
  await runBootstrap({ ...config, rcRevision }, {
    runCommand,
    waitForReadiness: ({ config: readinessConfig }) => waitForRuntimeReadiness({
      config: readinessConfig,
      timeoutMs: optionalPositiveInteger(process.env, 'PSFN_BOOTSTRAP_READY_TIMEOUT_MS', 90_000),
      pollMs: optionalPositiveInteger(process.env, 'PSFN_BOOTSTRAP_POLL_MS', 1_500),
    }),
    proveFirstConversation: input => proveFirstConversation({
      ...input,
      turnRecordTimeoutMs: optionalPositiveInteger(
        process.env,
        'PSFN_BOOTSTRAP_TURN_RECORD_TIMEOUT_MS',
        30_000,
      ),
      pollMs: optionalPositiveInteger(process.env, 'PSFN_BOOTSTRAP_POLL_MS', 1_500),
    }),
    log: line => process.stdout.write(`${line}\n`),
  });
}

main().catch((error) => {
  process.stderr.write(
    `Shakedown bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
