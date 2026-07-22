#!/usr/bin/env node

// Pinned zizmor security gate for GitHub Actions workflows, local composite
// actions, and Dependabot configuration.
//
// Provenance caveat (do not "fix" by chasing a newer tag): the image below is
// pinned by immutable digest. The binary at this digest reports `zizmor 1.27.0`
// (verified at runtime by `interpretZizmorVersion`), but the image's own OCI
// metadata references a post-release commit and labels the version `main`. We
// keep the digest and the runtime-version assertion as the source of truth.
//
// Enforcement uses `--format=github` (or `plain`), never `sarif`: zizmor's SARIF
// output intentionally exits 0 even when findings exist, so SARIF is only ever a
// retained report, never a gate. Exit codes are the contract: 0 = clean,
// nonzero = findings OR scanner/load failure (fail closed).

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ZIZMOR_IMAGE =
  'ghcr.io/zizmorcore/zizmor@sha256:d55c5d99dfe5f287a62294632fc512d0c921afe138746187d99e9dbce3910daf';
export const ZIZMOR_VERSION = '1.27.0';
export const ACTIONLINT_IMAGE =
  'rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667';

// The exact set of inputs this gate owns. Anything outside it is refused so a
// stray path can never silently widen or narrow the scan.
const INPUT = /^\.github\/(?:workflows\/.*\.ya?ml|actions\/.*\.ya?ml|dependabot\.yml)$/;
const FORMATS = new Set(['plain', 'github', 'sarif']);

// Explicit-input mode (local gate): a caller that names paths must name at least
// one, and every path must be inside the owned set. Zero or unexpected inputs
// are a misuse and fail closed.
export function validateZizmorInputs(paths) {
  if (paths.length === 0) throw new Error('zizmor changed-workflow scan requires at least one input');
  for (const path of paths) {
    if (!INPUT.test(path)) throw new Error(`Refusing unexpected zizmor input: ${path}`);
  }
  return [...new Set(paths)].sort();
}

// Discovery mode (CI): filter an arbitrary changed-file list down to the owned
// set. An empty result is a legitimate "nothing relevant changed" state, not a
// misuse, so this never throws — the caller decides to no-op.
export function discoverZizmorInputs(paths) {
  return [...new Set(paths.filter((path) => INPUT.test(path)))].sort();
}

export function interpretZizmorVersion(output, expected = ZIZMOR_VERSION) {
  const text = String(output);
  // Match a whole-token version so `1.27.0` never satisfies `1.27.01`.
  if (!new RegExp(`(?:^|\\s)${expected.replace(/\./g, '\\.')}(?:\\s|$)`).test(text)) {
    throw new Error(
      `Pinned zizmor image reported an unexpected version (expected ${expected}): ${text.trim() || '<empty>'}`,
    );
  }
  return expected;
}

export function parseZizmorArgs(argv) {
  const args = [...argv];
  const mode = args[0] === 'audit' ? (args.shift(), 'audit') : 'changed';
  let format;
  let base = '';
  let head = '';
  const paths = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
    else if (arg === '--format') format = args[(i += 1)];
    else if (arg.startsWith('--base=')) base = arg.slice('--base='.length);
    else if (arg === '--base') base = args[(i += 1)];
    else if (arg.startsWith('--head=')) head = arg.slice('--head='.length);
    else if (arg === '--head') head = args[(i += 1)];
    else if (arg.startsWith('-')) throw new Error(`Unknown zizmor wrapper flag: ${arg}`);
    else paths.push(arg);
  }
  if (format === undefined) format = mode === 'audit' ? 'github' : 'plain';
  if (!FORMATS.has(format)) throw new Error(`Unsupported zizmor format: ${format}`);
  return { mode, format, base, head, paths };
}

export function buildActionlintArgs(workflows) {
  return [
    'run', '--rm', '--platform', 'linux/amd64',
    '--volume', `${process.cwd()}:/repo:ro`, '--workdir', '/repo',
    ACTIONLINT_IMAGE, ...workflows,
  ];
}

export function buildZizmorScanArgs({ mode, format, paths = [] }) {
  const mount = [
    'run', '--rm', '--platform', 'linux/amd64',
    '--volume', `${process.cwd()}:/repo:ro`, '--workdir', '/repo',
  ];
  if (mode === 'audit') {
    // Full audit over every collected input (default collection: workflows,
    // composite actions, and Dependabot config). Online audits activate only
    // when a GitHub token is present in the environment; the default read-only
    // token is passed through with contents:read scope. No --offline so remote
    // rules run; regular persona keeps this a real gate without pedantic noise.
    return [
      ...mount, '--env', 'GH_TOKEN',
      ZIZMOR_IMAGE, '--persona=regular', `--format=${format}`, '--color=never', '.',
    ];
  }
  // Changed-input scan: offline, deterministic, fail closed on malformed or
  // uncollectable inputs. --strict-collection turns collection/schema problems
  // into failures; the trailing --persona=regular restores the regular finding
  // persona (strict-collection is an alias for --persona=pedantic).
  return [
    ...mount, ZIZMOR_IMAGE,
    '--offline', '--strict-collection', '--persona=regular',
    `--format=${format}`, '--color=never', ...paths,
  ];
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

function realGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout ?? '';
}

export function runZizmor({ argv = process.argv.slice(2), runDocker = realDocker, runGit = realGit } = {}) {
  const opts = parseZizmorArgs(argv);

  // Always confirm the pinned image really is 1.27.0 before trusting any scan.
  // Capture stdout (rather than inherit) so this line never pollutes a SARIF
  // report written to stdout in audit --format=sarif mode.
  const probe = runDocker(['run', '--rm', '--platform', 'linux/amd64', ZIZMOR_IMAGE, '--version'], {
    capture: true,
  });
  if (probe.status !== 0) {
    process.stderr.write('zizmor version probe failed; refusing to scan\n');
    return probe.status || 1;
  }
  interpretZizmorVersion(probe.stdout);
  process.stderr.write(`zizmor ${ZIZMOR_VERSION} verified\n`);

  if (opts.mode === 'audit') {
    return runDocker(buildZizmorScanArgs({ mode: 'audit', format: opts.format })).status;
  }

  let inputs;
  if (opts.paths.length > 0) {
    inputs = validateZizmorInputs(opts.paths);
  } else {
    if (!opts.base || !opts.head) {
      throw new Error('zizmor changed scan requires explicit paths or both --base and --head');
    }
    const diff = runGit(['diff', '--name-only', '--diff-filter=d', opts.base, opts.head]);
    inputs = discoverZizmorInputs(diff.split('\n').map((line) => line.trim()).filter(Boolean));
    if (inputs.length === 0) {
      process.stderr.write('No workflow, composite-action, or Dependabot changes to scan.\n');
      return 0;
    }
  }

  const workflows = inputs.filter((path) => path.startsWith('.github/workflows/'));
  if (workflows.length > 0) {
    const actionlintVersion = runDocker([
      'run', '--rm', '--platform', 'linux/amd64', ACTIONLINT_IMAGE, '-version',
    ]);
    if (actionlintVersion.status !== 0) return actionlintVersion.status;
    const actionlint = runDocker(buildActionlintArgs(workflows));
    if (actionlint.status !== 0) return actionlint.status;
  }

  return runDocker(buildZizmorScanArgs({ mode: 'changed', format: opts.format, paths: inputs })).status;
}

// Backwards-compatible entry used by the local delivery gate:
// `node run-zizmor-changed.mjs <owned-path...>` runs an offline, plain-format,
// regular-persona scan of the named inputs.
export function main(argv = process.argv.slice(2)) {
  return runZizmor({ argv });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
