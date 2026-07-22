#!/usr/bin/env node

// Crash-safe reaper for the real-Postgres test harness containers
// (`local-gate-test-postgres-*`). The harness starts long-lived, name-scoped
// Postgres containers per gate run; when a run is SIGKILLed (or the machine is
// killed) mid-flight nothing tears them down, so orphans accumulate. On
// 2026-07-22 181 orphaned containers (some 6 days old) drove machine load past
// 300 and cascaded gate flakes across every machine that runs gates
// (psfn-framework-ijtak.7).
//
// This module is the single source of truth for the sweep decision + execution.
// It is imported directly by the gate runner (scripts/ci/run-local-gate.mjs) at
// heavy-phase entry, and spawned as `node reap-test-postgres.mjs` by the harness
// itself at startup (src/test-support/postgres-test-harness.ts). Both call sites
// are best-effort: a broken docker CLI must surface as the harness's normal
// container-start failure, never as a sweep crash that fails the run.
//
// Ownership model: every harness container carries labels recording its owning
// PID, that PID's start-time (defeats PID recycling within a boot), the host
// boot id (defeats PID recycling across reboots), and a creation timestamp. A
// container is reaped only when its owner is provably dead. A live owner is
// NEVER reaped — concurrent gates on the same machine are legitimate (the
// machine-wide heavy-phase lock does not stop a second run from holding its own
// containers). Unlabeled legacy orphans (which predate this fix) are treated as
// dead-owner, but only once older than a grace age so a mid-upgrade run that has
// not yet learned to label is not raced.
//
// Manual SIGKILL repro (acceptance criterion): start a real-Postgres suite
// (e.g. `npx vitest run src/persistence/postgres.integration.test.ts`), then
// `kill -9` the vitest process group mid-run so `stop()` never fires. The
// container is left running with a now-dead owner-pid label. The next harness
// startup (or `node scripts/ci/reap-test-postgres.mjs`) sweeps it: dead owner →
// `docker rm -f`. Confirm with `docker ps -a --filter name=local-gate-test-postgres-`.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Label keys. MUST stay identical to the writer in
// src/test-support/postgres-test-harness.ts.
export const OWNER_PID_LABEL = 'psfn.gate.owner-pid';
export const OWNER_START_LABEL = 'psfn.gate.owner-start';
export const OWNER_BOOT_LABEL = 'psfn.gate.owner-boot-id';
export const CREATED_AT_LABEL = 'psfn.gate.created-at';

export const TEST_POSTGRES_NAME_PREFIX = 'local-gate-test-postgres-';

// Legacy/unverifiable orphans are only reaped once older than this, so an
// in-flight run mid-upgrade (not yet labelling) is never raced.
export const DEFAULT_UNLABELED_GRACE_MS = 30 * 60 * 1000;

const DOCKER_NO_VALUE = '<no value>';

function normalizeLabel(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === DOCKER_NO_VALUE ? '' : trimmed;
}

// Read the current host boot id. Changes on every reboot, so a container whose
// owner-boot-id label differs from this cannot have a live owner (PIDs are only
// unique within a boot). Returns '' when unreadable (non-Linux / restricted);
// the sweep then falls back to PID liveness alone.
export function readBootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}

// Read a PID's kernel start-time (field 22 of /proc/<pid>/stat, in clock ticks
// since boot). Pairing this with the PID defeats PID recycling: a reused PID has
// a different start-time. The comm field can contain spaces/parens, so parse
// from the last ')' forward. Returns '' when the PID is gone or unreadable.
export function readPidStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return '';
  }
  const rparen = raw.lastIndexOf(')');
  if (rparen < 0) return '';
  const fields = raw.slice(rparen + 1).trim().split(/\s+/);
  // After ')' the fields are state(0)…; starttime is field 22 overall, i.e.
  // index 19 of this post-comm slice (fields 3..).
  const startTime = fields[19];
  return startTime ?? '';
}

// Liveness probe. `kill(pid, 0)` never signals; ESRCH = provably dead (the only
// case a container may be reaped for), EPERM = alive under another user (never
// steal). Any other error is surfaced (fail closed).
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function parseCreatedMs(value) {
  if (typeof value !== 'string' || !value) return null;
  // Docker emits RFC3339 with nanosecond precision; JS Date only parses ms.
  const truncated = value.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(truncated);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether a single container should be reaped. Pure: all environment
 * access is injected via ctx.
 *
 * @param {{ownerPid: string, ownerStart: string, ownerBootId: string, createdAtLabel: string, dockerCreated: string}} container
 * @param {{now: number, currentBootId: string, graceMs: number, isAlive: (pid:number)=>boolean, pidStartTime: (pid:number)=>string}} ctx
 * @returns {{reap: boolean, reason: string}}
 */
export function decideReap(container, ctx) {
  const ownerPidText = normalizeLabel(container.ownerPid);
  const ownerPid = Number.parseInt(ownerPidText, 10);
  const createdMs = parseCreatedMs(
    normalizeLabel(container.createdAtLabel) || container.dockerCreated,
  );
  const ageMs = createdMs === null ? null : ctx.now - createdMs;
  const oldEnough = ageMs === null || ageMs >= ctx.graceMs;

  // No usable owner PID: unlabeled legacy orphan or a malformed label. Cannot
  // verify ownership, so only reap once past the grace age (never race a live
  // run whose labels we simply cannot read).
  if (!ownerPidText || !Number.isInteger(ownerPid) || ownerPid <= 0) {
    return oldEnough
      ? { reap: true, reason: ownerPidText ? 'malformed-owner-label-old' : 'unlabeled-legacy-old' }
      : { reap: false, reason: ownerPidText ? 'malformed-owner-label-young' : 'unlabeled-young' };
  }

  // Boot id recorded and differs from the current boot: the machine rebooted, so
  // the owning PID is gone and may since have been recycled. Reap.
  const ownerBootId = normalizeLabel(container.ownerBootId);
  if (ownerBootId && ctx.currentBootId && ownerBootId !== ctx.currentBootId) {
    return { reap: true, reason: 'stale-boot-id' };
  }

  if (!ctx.isAlive(ownerPid)) {
    return { reap: true, reason: 'dead-owner-pid' };
  }

  // Owner PID is alive, but a recorded start-time that no longer matches means
  // the kernel recycled the PID onto a different process. Reap.
  const ownerStart = normalizeLabel(container.ownerStart);
  if (ownerStart) {
    const liveStart = ctx.pidStartTime(ownerPid);
    if (liveStart && liveStart !== ownerStart) {
      return { reap: true, reason: 'recycled-owner-pid' };
    }
  }

  return { reap: false, reason: 'owner-alive' };
}

function defaultDocker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error,
  };
}

function defaultLog(line) {
  process.stderr.write(`${line}\n`);
}

function describeAge(container, now) {
  const createdMs = parseCreatedMs(
    normalizeLabel(container.createdAtLabel) || container.dockerCreated,
  );
  if (createdMs === null) return 'age=unknown';
  const seconds = Math.max(0, Math.round((now - createdMs) / 1000));
  if (seconds < 3600) return `age=${Math.round(seconds / 60)}m`;
  return `age=${(seconds / 3600).toFixed(1)}h`;
}

const INSPECT_FIELDS = [
  '{{.Name}}',
  `{{index .Config.Labels "${OWNER_PID_LABEL}"}}`,
  `{{index .Config.Labels "${OWNER_START_LABEL}"}}`,
  `{{index .Config.Labels "${OWNER_BOOT_LABEL}"}}`,
  `{{index .Config.Labels "${CREATED_AT_LABEL}"}}`,
  '{{.Created}}',
].join('\t');

/**
 * List every `local-gate-test-postgres-*` container, decide per-container, and
 * `docker rm -f` those whose owner is provably dead. Never removes a live
 * owner's container. Best-effort: any docker failure is logged loudly and the
 * function returns without throwing (the caller's real container start will fail
 * on its own if docker is genuinely broken).
 *
 * @returns {{reaped: string[], kept: string[], swept: boolean}}
 */
export function sweepTestPostgresContainers({
  docker = defaultDocker,
  log = defaultLog,
  now = Date.now(),
  currentBootId = readBootId(),
  graceMs = DEFAULT_UNLABELED_GRACE_MS,
  isAlive = isProcessAlive,
  pidStartTime = readPidStartTime,
} = {}) {
  const reaped = [];
  const kept = [];

  const listed = docker(['ps', '-a', '--filter', `name=${TEST_POSTGRES_NAME_PREFIX}`, '--format', '{{.Names}}']);
  if (listed.status !== 0) {
    const detail = listed.error ? listed.error.message : listed.stderr || 'unknown docker failure';
    log(`[test-postgres-reap] skipped: docker ps failed (${detail})`);
    return { reaped, kept, swept: false };
  }
  const names = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (names.length === 0) {
    return { reaped, kept, swept: true };
  }

  for (const name of names) {
    const inspected = docker(['inspect', '--format', INSPECT_FIELDS, name]);
    if (inspected.status !== 0) {
      // Vanished between list and inspect (a concurrent reaper or normal exit),
      // or an inspect error. Either way skip it; do not fail the sweep.
      continue;
    }
    const [inspectedName, ownerPid, ownerStart, ownerBootId, createdAtLabel, dockerCreated] =
      inspected.stdout.split('\t');
    const container = {
      name: (inspectedName ?? name).replace(/^\//, ''),
      ownerPid,
      ownerStart,
      ownerBootId,
      createdAtLabel,
      dockerCreated: (dockerCreated ?? '').trim(),
    };
    const decision = decideReap(container, { now, currentBootId, graceMs, isAlive, pidStartTime });
    if (!decision.reap) {
      kept.push(container.name);
      continue;
    }
    const removed = docker(['rm', '-f', container.name]);
    if (removed.status === 0) {
      reaped.push(container.name);
      log(
        `[test-postgres-reap] removed ${container.name} (${describeAge(container, now)}, reason=${decision.reason})`,
      );
    } else {
      const detail = removed.error ? removed.error.message : removed.stderr || 'unknown docker failure';
      log(
        `[test-postgres-reap] FAILED to remove ${container.name} (reason=${decision.reason}): ${detail}`,
      );
    }
  }
  return { reaped, kept, swept: true };
}

// CLI entry: `node scripts/ci/reap-test-postgres.mjs`. Always exits 0 — the
// sweep must never fail a run. This is how the TypeScript harness invokes the
// sweep at startup (it spawns node rather than importing across the src/scripts
// boundary).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const { reaped } = sweepTestPostgresContainers();
    if (reaped.length > 0) {
      process.stderr.write(`[test-postgres-reap] reaped ${reaped.length} orphaned container(s)\n`);
    }
  } catch (error) {
    process.stderr.write(
      `[test-postgres-reap] sweep error (ignored): ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exit(0);
}
