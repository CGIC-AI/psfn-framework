#!/usr/bin/env node

// Pinned OSV-Scanner supply-chain gate for every committed npm lockfile.
//
// OSV-Scanner is the sole owner of npm dependency-vulnerability scanning here.
// The image is pinned by immutable digest (never a latest/stable tag or a
// floating Action). The binary at this digest reports `osv-scanner version:
// 2.4.0`, verified at runtime by `interpretOsvVersion`; a version drift fails
// closed before any scan runs.
//
// Authority: the scan runs ONLINE against the live osv.dev API (it sends only
// package names/versions from the lockfiles, never source). The pinned image
// ships no bundled offline database (`--offline` exits 127 with "no offline
// version of the OSV database is available"), so online is the only authoritative
// source and matches how this repo's advisory baseline was reproduced.
//
// Exit codes are the contract and hold across every output format: 0 = clean,
// 1 = at least one non-ignored vulnerability, 127/128 = load/resolve/network
// failure. Any non-zero result fails the gate (fail closed). Unlike some
// scanners, OSV-Scanner exits non-zero on findings under --format=json too, so
// a JSON report is still a real gate, not merely a retained artifact.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const OSV_IMAGE =
  'ghcr.io/google/osv-scanner@sha256:bcb04b6bab5ab578898b3ff8b81b381e7961b1eac6aa87639b53aaea0d266003';
export const OSV_VERSION = '2.4.0';

// The exact, complete set of committed npm lockfiles this gate owns. Every one is
// named explicitly and scanned on every run; a missing or unreadable lockfile is
// a loud failure, never a silent skip.
export const OSV_LOCKFILES = Object.freeze([
  'package-lock.json',
  'admin-ui/package-lock.json',
  'companion-ui/package-lock.json',
  'apps/satellite-hub/package-lock.json',
  'tools/evals/package-lock.json',
]);

const FORMATS = new Set(['table', 'json', 'sarif']);

export function parseOsvArgs(argv) {
  const args = [...argv];
  let format = 'table';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
    else if (arg === '--format') format = args[(i += 1)];
    else throw new Error(`Unknown osv wrapper flag: ${arg}`);
  }
  if (!FORMATS.has(format)) throw new Error(`Unsupported osv format: ${format}`);
  return { format };
}

export function interpretOsvVersion(output, expected = OSV_VERSION) {
  const text = String(output);
  // Match a whole-token version so `2.4.0` never satisfies `2.4.01`.
  if (!new RegExp(`(?:^|\\s)${expected.replace(/\./g, '\\.')}(?:\\s|$)`).test(text)) {
    throw new Error(
      `Pinned osv-scanner image reported an unexpected version (expected ${expected}): ${text.trim() || '<empty>'}`,
    );
  }
  return expected;
}

export function buildOsvScanArgs({ format = 'table', lockfiles = OSV_LOCKFILES } = {}) {
  const mount = [
    'run', '--rm', '--platform', 'linux/amd64',
    '--volume', `${process.cwd()}:/repo:ro`, '--workdir', '/repo',
  ];
  // Every owned lockfile is named explicitly; only lockfiles are scanned, so the
  // read-only mount plus fixed --lockfile set is fully deterministic.
  const lockArgs = lockfiles.map((path) => `--lockfile=/repo/${path}`);
  return [...mount, OSV_IMAGE, `--format=${format}`, ...lockArgs];
}

function realDocker(args, { capture = false } = {}) {
  const result = spawnSync(
    'docker',
    args,
    capture ? { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' } : { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

export function runOsv({
  argv = process.argv.slice(2),
  runDocker = realDocker,
  fileExists = existsSync,
  lockfiles = OSV_LOCKFILES,
} = {}) {
  const { format } = parseOsvArgs(argv);

  // Fail closed before spending a scan: an owned lockfile that is missing or
  // unreadable is a loud error, never a silently narrowed scan.
  const missing = lockfiles.filter((path) => !fileExists(path));
  if (missing.length > 0) {
    throw new Error(`Refusing to scan: missing committed lockfile(s): ${missing.join(', ')}`);
  }

  // Confirm the pinned image really is 2.4.0 before trusting any scan. Capture
  // stdout (rather than inherit) so this line never pollutes a JSON/SARIF report
  // written to stdout.
  const probe = runDocker(['run', '--rm', '--platform', 'linux/amd64', OSV_IMAGE, '--version'], {
    capture: true,
  });
  if (probe.status !== 0) {
    process.stderr.write('osv-scanner version probe failed; refusing to scan\n');
    return probe.status || 1;
  }
  interpretOsvVersion(probe.stdout);
  process.stderr.write(`osv-scanner ${OSV_VERSION} verified\n`);

  return runDocker(buildOsvScanArgs({ format, lockfiles })).status;
}

export function main(argv = process.argv.slice(2)) {
  return runOsv({ argv });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
