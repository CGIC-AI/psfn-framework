#!/usr/bin/env node
/**
 * Release the persistent RAM-backed Postgres containers the test harness keeps
 * hot between test files (see src/test-support/postgres-test-harness.ts).
 *
 * The harness deliberately leaves its containers running so each test file
 * skips container start and `initdb`. They are named and slot-bounded, so they
 * cannot proliferate — but they do hold their bounded RAM until released.
 *
 *   node scripts/ci/stop-test-postgres.mjs          # stop (keeps the containers)
 *   node scripts/ci/stop-test-postgres.mjs --remove # stop and delete them
 *
 * Only containers carrying the harness's own label are touched.
 */
import { spawnSync } from 'node:child_process';

const TEST_POSTGRES_LABEL = 'io.test-harness.postgres';
const DOCKER_TIMEOUT_MS = 60_000;

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
  if (result.error) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'unknown docker failure';
    throw new Error(`docker ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

const remove = process.argv.includes('--remove');
const names = docker(['ps', '-a', '--filter', `label=${TEST_POSTGRES_LABEL}=true`, '--format', '{{.Names}}'])
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);

if (names.length === 0) {
  console.log('No test-postgres containers found.');
  process.exit(0);
}

// `docker stop` on an already-stopped container is a no-op, so this stays
// idempotent and safe to run at any time.
docker(['stop', '--time', '2', ...names]);
if (remove) {
  docker(['rm', '-f', ...names]);
}
console.log(`${remove ? 'Removed' : 'Stopped'} ${names.length} test-postgres container(s):`);
for (const name of names) {
  console.log(`  ${name}`);
}
