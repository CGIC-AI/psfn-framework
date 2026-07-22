import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import type { Pool } from 'pg';
import {
  POSTGRES_EXTENSION_SCHEMA_NAME,
  createPostgresPool,
  ensurePostgresSchemaExists,
} from '../persistence/postgres.js';

export const DEFAULT_POSTGRES_TEST_IMAGE = 'postgres:16.8-alpine';
export const PGVECTOR_POSTGRES_TEST_IMAGE = 'pgvector/pgvector:0.8.2-pg16-bookworm@sha256:6f2fedef8e4311682b3a5989a21bf527d3310ab5421258ad6e41e52955c16294';
const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'postgres';
const POSTGRES_DATABASE = 'postgres';
const POSTGRES_PORT = 5432;
const TEST_POSTGRES_LABEL = 'io.local-gate.test-postgres';
const TEST_POSTGRES_IMAGE_LABEL = 'io.local-gate.test-postgres.image';
// Crash-safe ownership labels. These keys MUST stay identical to the reader in
// scripts/ci/reap-test-postgres.mjs, which reaps containers whose owner PID is
// provably dead (killed/SIGKILLed run) while never touching a live owner's
// container (psfn-framework-ijtak.7).
const OWNER_PID_LABEL = 'psfn.gate.owner-pid';
const OWNER_START_LABEL = 'psfn.gate.owner-start';
const OWNER_BOOT_LABEL = 'psfn.gate.owner-boot-id';
const CREATED_AT_LABEL = 'psfn.gate.created-at';
// PGDATA path for the official Postgres (alpine) and pgvector (bookworm) images;
// both inherit the upstream Postgres entrypoint and default.
const POSTGRES_TMPFS_PGDATA_PATH = '/var/lib/postgresql/data';
// tmpfs ceiling for a worker's ephemeral cluster. The heaviest suite creates
// dozens of throwaway databases; 1 GiB of RAM-backed storage is ample and bounds
// a runaway. Sized in bytes for docker's `--tmpfs ...:size=`.
const POSTGRES_TMPFS_SIZE_BYTES = 1024 * 1024 * 1024;
// Absolute path to the standalone reaper, resolved from this module's location
// so it works whether tests run from source (tsx/vitest) or a checkout copy.
const TEST_POSTGRES_REAPER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'ci',
  'reap-test-postgres.mjs',
);
const READY_RETRY_LIMIT = 120;
const READY_RETRY_DELAY_MS = 500;
const MAX_DATABASES_FOR_IN_PLACE_RESET = 16;
/**
 * Before resetting a worker's databases, wait for every test-owned client
 * backend to disconnect. Properly-ended pools cost zero wait; a leaked pool closes its
 * idle sockets within pg's default 10 000 ms idle timeout (see
 * `createPostgresPool`, which leaves `idleTimeoutMillis` at that default), so
 * the 10 s deadline clears them. Force-dropping a database while a backend is
 * still open makes postgres kill it with SQLSTATE 57P01, which the owning pg
 * Pool surfaces as an unhandled 'error' event and fails a random file.
 */
const DRAIN_POLL_INTERVAL_MS = 200;
const DRAIN_DEADLINE_MS = 10_000;

export interface PostgresTestDatabase {
  databaseName: string;
  databaseUrl: string;
}

export interface PostgresTestHarness {
  readonly adminDatabaseUrl: string;
  readonly clientBinaries: PostgresTestClientBinaries;
  readonly containerName: string;
  readonly image: string;
  createDatabase(options?: PostgresTestDatabaseOptions): Promise<PostgresTestDatabase>;
  stop(): Promise<void>;
}

export interface PostgresTestClientBinaries {
  pgDumpBinary: string;
  pgRestoreBinary: string;
  psqlBinary: string;
}

export interface PostgresTestHarnessOptions {
  image?: string;
}

export interface PostgresTestDatabaseOptions {
  /**
   * Mirrors the tenancy provisioner's dedicated extension-schema bootstrap.
   * Disable only when a test explicitly exercises the unprovisioned legacy
   * database layout.
   */
  provisionExtensionSchema?: boolean;
}

interface DockerCommandResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

interface PersistentPostgresContainer {
  image: string;
  imageLabel: string;
  name: string;
  running: boolean;
  testLabel: string;
}

function runDockerCommand(args: string[]): DockerCommandResult {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  };
}

function dockerFailure(args: string[], result: DockerCommandResult): Error {
  const detail = result.stderr || result.stdout || 'unknown docker failure';
  return new Error(`docker ${args.join(' ')} failed: ${detail}`);
}

function runDocker(args: string[]): string {
  const result = runDockerCommand(args);
  if (result.status !== 0) {
    throw dockerFailure(args, result);
  }
  return result.stdout;
}

// The owning process for a run's containers. In Vitest's forked-pool workers
// `isMainThread` is true and the shared owner is the Vitest main (ppid); this
// matches the scope used to name the container, so every worker of one run
// records the same live owner. The owner stays alive for the whole run and is
// provably dead once the run exits, which is exactly what the reaper checks.
function currentOwnerPid(): number {
  return isMainThread ? process.ppid : process.pid;
}

// Field 22 of /proc/<pid>/stat (start-time in clock ticks since boot). Paired
// with the PID it defeats PID recycling. The comm field can contain spaces and
// parens, so parse from the last ')'. Returns '' when unreadable.
function readPidStartTime(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return '';
  }
  const rparen = raw.lastIndexOf(')');
  if (rparen < 0) return '';
  const fields = raw.slice(rparen + 1).trim().split(/\s+/);
  return fields[19] ?? '';
}

// Host boot id; changes on every reboot so a container from a prior boot can
// never be mistaken for one owned by a live same-numbered PID. '' when
// unreadable (non-Linux/restricted); the reaper then relies on PID liveness.
function readBootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}

// Best-effort startup sweep: reap any orphaned `local-gate-test-postgres-*`
// container whose owner is provably dead before this run creates its own. Runs
// the standalone reaper as a child so the src/scripts import boundary is never
// crossed. Never throws — a broken docker CLI surfaces as the harness's normal
// container-start failure below, not as a sweep crash (psfn-framework-ijtak.7).
let sweptOrphanedTestPostgresContainers = false;
function sweepOrphanedTestPostgresContainersOnce(): void {
  if (sweptOrphanedTestPostgresContainers) return;
  sweptOrphanedTestPostgresContainers = true;
  try {
    const result = spawnSync(process.execPath, [TEST_POSTGRES_REAPER_PATH], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (result.error) {
      process.stderr.write(
        `[test-postgres-reap] startup sweep skipped: ${result.error.message}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `[test-postgres-reap] startup sweep skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function postgresTestContainerScope({
  vitestPoolId = process.env.VITEST_POOL_ID?.trim(),
  invocationProcessId = isMainThread ? process.ppid : process.pid,
  processId = process.pid,
}: {
  vitestPoolId?: string;
  invocationProcessId?: number;
  processId?: number;
} = {}): string {
  return vitestPoolId
    ? `vitest-run-${invocationProcessId}-pool-${vitestPoolId}`
    : `process-${processId}`;
}

export function postgresTestContainerNameForImage(
  image: string,
  scope = postgresTestContainerScope(),
): string {
  const normalizedImage = image.trim();
  if (!normalizedImage) {
    throw new Error('Postgres test container image must not be empty');
  }
  const normalizedScope = scope.trim();
  if (!normalizedScope) {
    throw new Error('Postgres test container scope must not be empty');
  }
  const imageHash = createHash('sha256').update(normalizedImage).digest('hex').slice(0, 16);
  const scopeHash = createHash('sha256').update(normalizedScope).digest('hex').slice(0, 8);
  return `local-gate-test-postgres-${scopeHash}-${imageHash}`;
}

function inspectPersistentPostgresContainer(name: string): PersistentPostgresContainer | null {
  const format = [
    '{{.State.Running}}',
    '{{.Config.Image}}',
    `{{index .Config.Labels "${TEST_POSTGRES_IMAGE_LABEL}"}}`,
    `{{index .Config.Labels "${TEST_POSTGRES_LABEL}"}}`,
  ].join('\t');
  const result = runDockerCommand(['inspect', '--format', format, name]);
  if (result.status !== 0) {
    return null;
  }
  const [running, image, imageLabel, testLabel] = result.stdout.split('\t');
  if ((running !== 'true' && running !== 'false') || !image || !imageLabel || !testLabel) {
    throw new Error(`Malformed Docker metadata for persistent Postgres container ${name}`);
  }
  return { image, imageLabel, name, running: running === 'true', testLabel };
}

function ensurePersistentPostgresContainer(image: string): string {
  const name = postgresTestContainerNameForImage(image);
  let container = inspectPersistentPostgresContainer(name);
  if (!container) {
    const ownerPid = currentOwnerPid();
    const createArgs = [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `${TEST_POSTGRES_LABEL}=true`,
      '--label',
      `${TEST_POSTGRES_IMAGE_LABEL}=${image}`,
      // Crash-safe ownership: the reaper removes this container only once this
      // PID (with this start-time, on this boot) is provably gone.
      '--label',
      `${OWNER_PID_LABEL}=${ownerPid}`,
      '--label',
      `${OWNER_START_LABEL}=${readPidStartTime(ownerPid)}`,
      '--label',
      `${OWNER_BOOT_LABEL}=${readBootId()}`,
      '--label',
      `${CREATED_AT_LABEL}=${new Date().toISOString()}`,
      // RAM-back PGDATA and drop durability. These clusters are throwaway; the
      // disk I/O of leaked containers was part of what drove machine load past
      // 300. If the kernel cannot mount the tmpfs, `docker run` fails and we
      // throw below — never a silent fall back to disk.
      '--tmpfs',
      `${POSTGRES_TMPFS_PGDATA_PATH}:rw,size=${POSTGRES_TMPFS_SIZE_BYTES}`,
      '-e',
      `POSTGRES_USER=${POSTGRES_USER}`,
      '-e',
      `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
      '-e',
      `POSTGRES_DB=${POSTGRES_DATABASE}`,
      '-p',
      `127.0.0.1::${POSTGRES_PORT}`,
      image,
      // Ephemeral-test durability flags (the upstream entrypoint prepends
      // `postgres` because these start with `-`).
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ];
    const createResult = runDockerCommand(createArgs);
    container = inspectPersistentPostgresContainer(name);
    if (!container) {
      if (createResult.status !== 0) {
        throw dockerFailure(createArgs, createResult);
      }
      throw new Error(`Created persistent Postgres container ${name}, but Docker cannot inspect it`);
    }
  }
  if (container.image !== image || container.imageLabel !== image || container.testLabel !== 'true') {
    throw new Error(
      `Persistent Postgres container ${name} does not match requested image ${image}: ` +
        `configured=${container.image} labeled=${container.imageLabel}`,
    );
  }
  if (!container.running) {
    runDocker(['start', name]);
  }
  return name;
}

function recyclePersistentPostgresContainer(name: string, image: string): void {
  const container = inspectPersistentPostgresContainer(name);
  if (!container
    || container.image !== image
    || container.imageLabel !== image
    || container.testLabel !== 'true') {
    throw new Error(`Refusing to recycle unverified persistent Postgres container ${name}`);
  }
  runDocker(['rm', '-f', name]);
  ensurePersistentPostgresContainer(image);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function writeDockerPostgresClient(
  root: string,
  image: string,
  command: 'pg_dump' | 'pg_restore' | 'psql',
): string {
  const path = join(root, `${command}.mjs`);
  const source = [
    '#!/usr/bin/env node',
    "import { spawnSync } from 'node:child_process';",
    "import { dirname, isAbsolute } from 'node:path';",
    `const image = ${JSON.stringify(image)};`,
    `const command = ${JSON.stringify(command)};`,
    'const forwardedArgs = process.argv.slice(2);',
    'const mountedDirectories = new Set();',
    'for (const argument of forwardedArgs) {',
    "  const candidate = argument.startsWith('--file=') ? argument.slice('--file='.length) : argument;",
    "  if (candidate !== '-' && isAbsolute(candidate)) mountedDirectories.add(dirname(candidate));",
    '}',
    'const volumeArgs = [...mountedDirectories].flatMap(directory => [\'--volume\', `${directory}:${directory}`]);',
    'const result = spawnSync(\'docker\', [',
    "  'run', '--rm', '--pull=never', '--network=host',",
    "  '--env', 'PGPASSWORD', '--env', 'PGPASSFILE', '--env', 'KRB5CCNAME',",
    "  ...volumeArgs, '--entrypoint', command, image, ...forwardedArgs,",
    "], { stdio: 'inherit', env: process.env });",
    'if (result.error) throw result.error;',
    'process.exit(result.status ?? 1);',
    '',
  ].join('\n');
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

async function waitForDatabaseReady(databaseUrl: string): Promise<void> {
  for (let attempt = 1; attempt <= READY_RETRY_LIMIT; attempt += 1) {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-memory-test',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === READY_RETRY_LIMIT) {
        throw error;
      }
      await delay(READY_RETRY_DELAY_MS);
    } finally {
      await pool.end();
    }
  }
}

async function provisionTestDatabase(databaseUrl: string): Promise<void> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-memory-test-provision',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    await ensurePostgresSchemaExists(pool, POSTGRES_EXTENSION_SCHEMA_NAME);
  } finally {
    await pool.end();
  }
}

interface ClientBackendRow {
  datname: string | null;
  application_name: string | null;
  state: string | null;
}

function summarizeSurvivingBackends(rows: readonly ClientBackendRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `datname=${row.datname ?? '<none>'} application_name=${
      row.application_name ?? '<none>'
    } state=${row.state ?? '<none>'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key} count=${count}`).join('; ');
}

/**
 * Poll `pg_stat_activity` via the admin pool until no test-owned client
 * backends remain, so `docker stop` never SIGTERMs postgres out from under a
 * still-open pool. Excludes the admin pool's own backend via `pg_backend_pid()`.
 * Fails closed: if backends survive past the deadline the leak is reported so
 * the offending file fails loudly instead of poisoning a random sibling.
 */
async function waitForClientBackendsToDrain(
  adminPool: Pool,
  databaseNames: ReadonlySet<string>,
): Promise<void> {
  if (databaseNames.size === 0) {
    return;
  }
  const deadline = Date.now() + DRAIN_DEADLINE_MS;
  for (;;) {
    const result = await adminPool.query<ClientBackendRow>(
      "SELECT datname, application_name, state FROM pg_stat_activity " +
        "WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() " +
        'AND datname = ANY($1::text[])',
      [[...databaseNames]],
    );
    if (result.rows.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Postgres test harness stop() timed out after ${DRAIN_DEADLINE_MS} ms waiting for ` +
          `${result.rows.length} client backend(s) to disconnect; a test leaked a connection pool. ` +
          `Surviving connections: ${summarizeSurvivingBackends(result.rows)}`,
      );
    }
    await delay(DRAIN_POLL_INTERVAL_MS);
  }
}

async function dropTestDatabases(adminPool: Pool, databaseNames: ReadonlySet<string>): Promise<void> {
  await Promise.all(
    [...databaseNames].map(databaseName =>
      adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`),
    ),
  );
}

interface PostgresDatabaseRow {
  datname: string;
}

async function listTestDatabases(adminPool: Pool): Promise<Set<string>> {
  const result = await adminPool.query<PostgresDatabaseRow>(
    `SELECT datname FROM pg_database WHERE datistemplate = FALSE AND datname <> $1`,
    [POSTGRES_DATABASE],
  );
  return new Set(result.rows.map(row => row.datname));
}

interface PostgresRoleRow {
  rolname: string;
}

async function listPostgresRoles(adminPool: Pool): Promise<Set<string>> {
  const result = await adminPool.query<PostgresRoleRow>('SELECT rolname FROM pg_roles');
  return new Set(result.rows.map(row => row.rolname));
}

async function dropTestRoles(adminPool: Pool): Promise<void> {
  const currentRoles = await listPostgresRoles(adminPool);
  for (const role of currentRoles) {
    if (role === POSTGRES_USER || role.startsWith('pg_')) continue;
    await adminPool.query(`DROP OWNED BY ${quoteIdentifier(role)} CASCADE`);
    await adminPool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
  }
}

async function resetWorkerPostgres(adminPool: Pool): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await dropTestDatabases(adminPool, await listTestDatabases(adminPool));
    try {
      await dropTestRoles(adminPool);
      if ((await listTestDatabases(adminPool)).size === 0) return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Postgres test worker reset did not reach a clean state');
}

function resolveDatabaseUrl(adminDatabaseUrl: string, databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function startPostgresTestHarness(options: PostgresTestHarnessOptions = {}): Promise<PostgresTestHarness> {
  const image = options.image?.trim() || PGVECTOR_POSTGRES_TEST_IMAGE;
  // Reap dead-owner orphans (killed/SIGKILLed prior runs) before spinning up
  // this run's container, so a machine with pre-existing orphans is cleaned at
  // the first harness startup. Once per process; never touches live owners.
  sweepOrphanedTestPostgresContainersOnce();
  const containerName = ensurePersistentPostgresContainer(image);

  const mapping = runDocker(['port', containerName, `${POSTGRES_PORT}/tcp`]);
  const mappedPortText = mapping.split('\n').map(line => line.trim()).find(Boolean)?.split(':').pop();
  if (!mappedPortText) {
    throw new Error(`Unable to resolve mapped postgres port for container ${containerName}`);
  }
  const mappedPort = Number(mappedPortText);
  if (!Number.isInteger(mappedPort) || mappedPort <= 0) {
    throw new Error(`Invalid mapped postgres port "${mappedPortText}" for container ${containerName}`);
  }

  const adminDatabaseUrl = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${mappedPort}/${POSTGRES_DATABASE}`;
  await waitForDatabaseReady(adminDatabaseUrl);

  const adminPool = createPostgresPool(adminDatabaseUrl, {
    applicationName: 'psfn-memory-test-admin',
    allowExitOnIdle: true,
    // Large files create dozens of databases; parallel force-drops must finish
    // inside their 30-second Vitest teardown hook even under full-suite load.
    max: 16,
  });
  // A worker container is exclusive to one Vitest file at a time. Reset stale
  // artifacts left by an interrupted prior run before handing it to the file.
  await resetWorkerPostgres(adminPool);
  const clientRoot = mkdtempSync(join(tmpdir(), 'psfn-postgres-clients-'));
  const clientBinaries: PostgresTestClientBinaries = {
    pgDumpBinary: writeDockerPostgresClient(clientRoot, image, 'pg_dump'),
    pgRestoreBinary: writeDockerPostgresClient(clientRoot, image, 'pg_restore'),
    psqlBinary: writeDockerPostgresClient(clientRoot, image, 'psql'),
  };
  return {
    adminDatabaseUrl,
    clientBinaries,
    containerName,
    image,
    async createDatabase(
      databaseOptions: PostgresTestDatabaseOptions = {},
    ): Promise<PostgresTestDatabase> {
      const databaseName = `psfn_${randomUUID().replaceAll('-', '')}`;
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const databaseUrl = resolveDatabaseUrl(adminDatabaseUrl, databaseName);
      await waitForDatabaseReady(databaseUrl);
      if (databaseOptions.provisionExtensionSchema !== false) {
        await provisionTestDatabase(databaseUrl);
      }
      return {
        databaseName,
        databaseUrl,
      };
    },
    async stop(): Promise<void> {
      // The container persists machine-wide but belongs to one Vitest worker.
      // Drain and reset that worker's test databases and cluster-wide roles.
      // A surviving-backend timeout still force-cleans this harness's databases
      // and then rethrows so the connection leak remains loud.
      const cleanupErrors: Error[] = [];
      let recycleContainer = false;
      try {
        const testDatabases = await listTestDatabases(adminPool);
        recycleContainer = testDatabases.size > MAX_DATABASES_FOR_IN_PLACE_RESET;
        await waitForClientBackendsToDrain(adminPool, testDatabases);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
      if (!recycleContainer) {
        try {
          await resetWorkerPostgres(adminPool);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      try {
        await adminPool.end();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
      if (recycleContainer) {
        try {
          recyclePersistentPostgresContainer(containerName, image);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      try {
        rmSync(clientRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'Postgres test harness cleanup failed');
      }
      if (cleanupErrors[0]) throw cleanupErrors[0];
    },
  };
}
