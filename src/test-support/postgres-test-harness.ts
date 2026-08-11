import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
const TEST_POSTGRES_LABEL = 'io.test-harness.postgres';
const TEST_POSTGRES_IMAGE_LABEL = 'io.test-harness.postgres.image';
const TEST_POSTGRES_PROFILE_LABEL = 'io.test-harness.postgres.profile';
const MIN_CONCURRENT_HARNESSES = 4;
const MAX_CONCURRENT_HARNESSES = 8;
const DEFAULT_POSTGRES_TEST_TMPFS_SIZE = '1g';

/**
 * Vitest forks one worker per core, so on a large machine dozens of integration
 * files enter `beforeAll` at once and queue on this semaphore. Every file waits
 * for a slot inside its own `beforeAll` timeout, so too few slots turns normal
 * queueing into hook timeouts on whichever files land at the back — the failure
 * is scheduling luck, not a bug in the file that reports it.
 *
 * Scale slots with the machine so the queue drains inside that timeout, while
 * staying bounded: a measured container holds ~100-360 MiB, so the ceiling of 8
 * (times the images in flight) stays well inside a dev box or CI runner. Small
 * machines keep the original 4, which is already matched to their worker count.
 */
export function resolveMaxConcurrentHarnesses(
  environment: NodeJS.ProcessEnv = process.env,
  parallelism: number = availableParallelism(),
): number {
  const override = environment.PSFN_POSTGRES_TEST_MAX_HARNESSES?.trim();
  if (override) {
    const parsed = Number(override);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `PSFN_POSTGRES_TEST_MAX_HARNESSES must be a positive integer; received "${override}"`,
      );
    }
    return parsed;
  }
  return Math.min(
    MAX_CONCURRENT_HARNESSES,
    Math.max(MIN_CONCURRENT_HARNESSES, Math.floor(parallelism / 4)),
  );
}

/**
 * PGDATA is a tmpfs and `resetWorkerPostgres` only runs between files, so every
 * `createDatabase` inside one file accumulates until that file finishes. A
 * database-heavy file is therefore sized by its whole test count, not by its
 * largest test: `postgres-store.integration.test.ts` alone stands up ~44 of
 * them, and at 512 MiB it ran the tmpfs out of space partway through. The
 * casualty is whichever test is unlucky enough to be last, which reads as a
 * flaky test rather than as the capacity limit it actually is.
 *
 * 1 GiB clears that file with room to spare. Keep the value at or below
 * `memoryLimit`: tmpfs pages are charged to the container's memory cgroup, so
 * a tmpfs larger than the limit converts an ENOSPC into an OOM kill — a worse
 * failure, because Postgres dies mid-query instead of returning an error.
 */
export function resolvePostgresTestTmpfsSize(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment.PSFN_POSTGRES_TEST_TMPFS_SIZE?.trim();
  if (override) {
    if (!/^\d+[kmg]$/i.test(override)) {
      throw new Error(
        `PSFN_POSTGRES_TEST_TMPFS_SIZE must be a Docker size such as "512m" or "2g"; received "${override}"`,
      );
    }
    return override;
  }
  return DEFAULT_POSTGRES_TEST_TMPFS_SIZE;
}

const POSTGRES_TEST_RUNTIME = Object.freeze({
  cpuLimit: '2',
  lockBasePath: join(tmpdir(), 'psfn-postgres-test-harness'),
  lockMalformedGraceMs: 5_000,
  lockRetryMs: 100,
  maxConcurrentHarnesses: resolveMaxConcurrentHarnesses(),
  memoryLimit: '1g',
  // The profile is part of the container name and is re-checked before reuse,
  // so it is what rotates warm containers when the runtime shape changes.
  // Leaving it at v1 would silently reuse existing 512m containers and the new
  // tmpfs size would never take effect on any machine that already ran tests.
  // Old v1 containers linger until `npm run test:postgres:down`.
  profile: 'tmpfs-v2',
  sharedMemorySize: '128m',
  tmpfsSize: resolvePostgresTestTmpfsSize(),
});
/**
 * PGDATA lives on a tmpfs, so `docker stop` destroys the cluster and the next
 * `docker start` pays a full `initdb`. Stopping between test files therefore
 * rebuilt the server once per file for no isolation benefit:
 * `resetWorkerPostgres` already drops every test database and role, and the
 * slot lease already guarantees one file owns a container at a time. Leave the
 * server hot and let the reset be the isolation boundary.
 *
 * Set `PSFN_POSTGRES_TEST_STOP_BETWEEN_FILES=1` to restore the stop-every-file
 * behaviour; `npm run test:postgres:down` releases the containers for good.
 */
export function shouldStopContainerBetweenFiles(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.PSFN_POSTGRES_TEST_STOP_BETWEEN_FILES === '1';
}
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
  profileLabel: string;
  running: boolean;
  testLabel: string;
}

interface PostgresTestLockOwner {
  pid: number;
  token: string;
}

interface PostgresTestHarnessLease {
  release(): void;
  slot: number;
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

function readPostgresTestLockOwner(lockPath: string): PostgresTestLockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (
      typeof parsed !== 'object'
      || parsed === null
      || !('pid' in parsed)
      || !('token' in parsed)
      || typeof parsed.pid !== 'number'
      || !Number.isInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.token !== 'string'
      || !parsed.token
    ) {
      throw new Error(`Malformed PostgreSQL test harness lock: ${lockPath}`);
    }
    return {
      pid: parsed.pid as number,
      token: parsed.token,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function acquirePostgresTestHarnessLease(): Promise<PostgresTestHarnessLease> {
  for (;;) {
    for (let slot = 0; slot < POSTGRES_TEST_RUNTIME.maxConcurrentHarnesses; slot += 1) {
      const lockPath = `${POSTGRES_TEST_RUNTIME.lockBasePath}.${slot}.lock`;
      const owner: PostgresTestLockOwner = {
        pid: process.pid,
        token: randomUUID(),
      };
      try {
        writeFileSync(
          lockPath,
          `${JSON.stringify(owner)}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
        let released = false;
        return {
          release() {
            if (released) return;
            const currentOwner = readPostgresTestLockOwner(lockPath);
            if (!currentOwner || currentOwner.token !== owner.token) {
              throw new Error(
                'Refusing to release a PostgreSQL test harness slot owned by another process',
              );
            }
            unlinkSync(lockPath);
            released = true;
          },
          slot,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }

      let existingOwner: PostgresTestLockOwner | null;
      try {
        existingOwner = readPostgresTestLockOwner(lockPath);
      } catch (error) {
        let ageMs: number;
        try {
          ageMs = Date.now() - statSync(lockPath).mtimeMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (ageMs < POSTGRES_TEST_RUNTIME.lockMalformedGraceMs) {
          continue;
        }
        throw error;
      }
      if (!existingOwner) continue;
      if (!isProcessRunning(existingOwner.pid)) {
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        continue;
      }
    }
    await delay(POSTGRES_TEST_RUNTIME.lockRetryMs);
  }
}

export function postgresTestContainerNameForImage(
  image: string,
  scope: string = POSTGRES_TEST_RUNTIME.profile,
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
  return `test-postgres-${scopeHash}-${imageHash}`;
}

export function postgresTestDockerRunArgs(image: string, name: string): string[] {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `${TEST_POSTGRES_LABEL}=true`,
    '--label',
    `${TEST_POSTGRES_IMAGE_LABEL}=${image}`,
    '--label',
    `${TEST_POSTGRES_PROFILE_LABEL}=${POSTGRES_TEST_RUNTIME.profile}`,
    '--log-driver',
    'none',
    '--memory',
    POSTGRES_TEST_RUNTIME.memoryLimit,
    '--memory-swap',
    POSTGRES_TEST_RUNTIME.memoryLimit,
    '--cpus',
    POSTGRES_TEST_RUNTIME.cpuLimit,
    '--shm-size',
    POSTGRES_TEST_RUNTIME.sharedMemorySize,
    '--tmpfs',
    `/var/lib/postgresql/data:rw,noexec,nosuid,size=${POSTGRES_TEST_RUNTIME.tmpfsSize}`,
    '-e',
    `POSTGRES_USER=${POSTGRES_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '-e',
    `POSTGRES_DB=${POSTGRES_DATABASE}`,
    '-e',
    'POSTGRES_INITDB_ARGS=--nosync',
    '-p',
    `127.0.0.1::${POSTGRES_PORT}`,
    image,
    'postgres',
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
    '-c',
    'shared_buffers=32MB',
    '-c',
    'min_wal_size=32MB',
    '-c',
    'max_wal_size=64MB',
  ];
}

function inspectPersistentPostgresContainer(name: string): PersistentPostgresContainer | null {
  const format = [
    '{{.State.Running}}',
    '{{.Config.Image}}',
    `{{index .Config.Labels "${TEST_POSTGRES_IMAGE_LABEL}"}}`,
    `{{index .Config.Labels "${TEST_POSTGRES_LABEL}"}}`,
    `{{index .Config.Labels "${TEST_POSTGRES_PROFILE_LABEL}"}}`,
  ].join('\t');
  const result = runDockerCommand(['inspect', '--format', format, name]);
  if (result.status !== 0) {
    return null;
  }
  const [running, image, imageLabel, testLabel, profileLabel] = result.stdout.split('\t');
  if (
    (running !== 'true' && running !== 'false')
    || !image
    || !imageLabel
    || !testLabel
    || !profileLabel
  ) {
    throw new Error(`Malformed Docker metadata for persistent Postgres container ${name}`);
  }
  return {
    image,
    imageLabel,
    name,
    profileLabel,
    running: running === 'true',
    testLabel,
  };
}

function ensurePersistentPostgresContainer(
  image: string,
  name = postgresTestContainerNameForImage(image),
): string {
  let container = inspectPersistentPostgresContainer(name);
  if (!container) {
    const createArgs = postgresTestDockerRunArgs(image, name);
    const createResult = runDockerCommand(createArgs);
    container = inspectPersistentPostgresContainer(name);
    if (!container) {
      if (createResult.status !== 0) {
        throw dockerFailure(createArgs, createResult);
      }
      throw new Error(`Created persistent Postgres container ${name}, but Docker cannot inspect it`);
    }
  }
  if (
    container.image !== image
    || container.imageLabel !== image
    || container.testLabel !== 'true'
    || container.profileLabel !== POSTGRES_TEST_RUNTIME.profile
  ) {
    throw new Error(
      `Persistent Postgres container ${name} does not match requested image ${image}: ` +
        `configured=${container.image} labeled=${container.imageLabel} ` +
        `profile=${container.profileLabel}`,
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
    || container.testLabel !== 'true'
    || container.profileLabel !== POSTGRES_TEST_RUNTIME.profile) {
    throw new Error(`Refusing to recycle unverified persistent Postgres container ${name}`);
  }
  runDocker(['rm', '-f', name]);
  ensurePersistentPostgresContainer(image, name);
}

function stopPersistentPostgresContainer(name: string, image: string): void {
  const container = inspectPersistentPostgresContainer(name);
  if (!container) return;
  if (
    container.image !== image
    || container.imageLabel !== image
    || container.testLabel !== 'true'
    || container.profileLabel !== POSTGRES_TEST_RUNTIME.profile
  ) {
    throw new Error(`Refusing to stop unverified persistent Postgres container ${name}`);
  }
  if (container.running) {
    runDocker(['stop', '--time', '2', name]);
  }
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
  const lease = await acquirePostgresTestHarnessLease();
  const containerName = postgresTestContainerNameForImage(
    image,
    `${POSTGRES_TEST_RUNTIME.profile}-slot-${lease.slot}`,
  );
  let adminPool: Pool | undefined;
  let clientRoot: string | undefined;

  try {
    ensurePersistentPostgresContainer(image, containerName);
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

    adminPool = createPostgresPool(adminDatabaseUrl, {
      applicationName: 'psfn-memory-test-admin',
      allowExitOnIdle: true,
      // Large files create dozens of databases; parallel force-drops must finish
      // inside their 30-second Vitest teardown hook even under full-suite load.
      max: 16,
    });
    const activeAdminPool = adminPool;
    // A semaphore slot owns one RAM-backed container. Reset stale artifacts
    // left by an interrupted prior run before handing it to the test file.
    await resetWorkerPostgres(activeAdminPool);
    clientRoot = mkdtempSync(join(tmpdir(), 'psfn-postgres-clients-'));
    const activeClientRoot = clientRoot;
    const clientBinaries: PostgresTestClientBinaries = {
      pgDumpBinary: writeDockerPostgresClient(activeClientRoot, image, 'pg_dump'),
      pgRestoreBinary: writeDockerPostgresClient(activeClientRoot, image, 'pg_restore'),
      psqlBinary: writeDockerPostgresClient(activeClientRoot, image, 'psql'),
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
        await activeAdminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
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
        // Dropping every test database and role is the isolation boundary; the
        // container itself stays hot so the next file skips container start and
        // `initdb`. See shouldStopContainerBetweenFiles for why stopping is
        // wrong here and how to opt back into it.
        const cleanupErrors: Error[] = [];
        let recycleContainer = false;
        try {
          const testDatabases = await listTestDatabases(activeAdminPool);
          recycleContainer = testDatabases.size > MAX_DATABASES_FOR_IN_PLACE_RESET;
          await waitForClientBackendsToDrain(activeAdminPool, testDatabases);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
        if (!recycleContainer) {
          try {
            await resetWorkerPostgres(activeAdminPool);
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        try {
          await activeAdminPool.end();
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
        if (shouldStopContainerBetweenFiles()) {
          try {
            stopPersistentPostgresContainer(containerName, image);
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        try {
          rmSync(activeClientRoot, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
        try {
          lease.release();
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
        if (cleanupErrors.length > 1) {
          throw new AggregateError(cleanupErrors, 'Postgres test harness cleanup failed');
        }
        if (cleanupErrors[0]) throw cleanupErrors[0];
      },
    };
  } catch (error) {
    const cleanupErrors: Error[] = [
      error instanceof Error ? error : new Error(String(error)),
    ];
    if (adminPool) {
      try {
        await adminPool.end();
      } catch (cleanupError) {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        );
      }
    }
    // Startup failed, so this container is suspect. Stop it unconditionally —
    // wiping the tmpfs forces a clean `initdb` for the next run rather than
    // handing the next file a half-provisioned server.
    try {
      stopPersistentPostgresContainer(containerName, image);
    } catch (cleanupError) {
      cleanupErrors.push(
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
      );
    }
    if (clientRoot) {
      try {
        rmSync(clientRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        );
      }
    }
    try {
      lease.release();
    } catch (cleanupError) {
      cleanupErrors.push(
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
      );
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Postgres test harness startup failed');
    }
    throw cleanupErrors[0];
  }
}
