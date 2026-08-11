#!/usr/bin/env node

// Pinned, tokenless vulnerability scan for immutable container images. The
// operator-owned Helm/IaC scan lives with the private deployment configuration;
// this public wrapper deliberately knows nothing about that chart or its
// exceptions.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const TRIVY_IMAGE =
  'ghcr.io/aquasecurity/trivy@sha256:c6e969c5662a546ad5de4a73c2a6b7a7c627f86d916903e175aa623af5b97ada';
export const TRIVY_VERSION = '0.72.0';

export function interpretTrivyVersion(output, expected = TRIVY_VERSION) {
  const text = String(output);
  if (!new RegExp(`(?:^|\\s)${expected.replace(/\./g, '\\.')}((?:\\s)|$)`).test(text)) {
    throw new Error(
      `Pinned trivy image reported an unexpected version (expected ${expected}): ${text.trim() || '<empty>'}`,
    );
  }
  return expected;
}

export function parseTrivyArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  if (mode !== 'image') {
    throw new Error(`public trivy wrapper requires image mode, got: ${mode ?? '<none>'}`);
  }
  const opts = { input: '', image: '' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--input=')) opts.input = arg.slice('--input='.length);
    else if (arg === '--input') opts.input = args[(i += 1)];
    else if (arg.startsWith('--image=')) opts.image = arg.slice('--image='.length);
    else if (arg === '--image') opts.image = args[(i += 1)];
    else throw new Error(`Unknown trivy wrapper flag: ${arg}`);
  }
  if (!opts.input && !opts.image) {
    throw new Error('trivy image scan requires --input <archive.tar> or --image <ref@sha256:...>');
  }
  if (opts.input && opts.image) {
    throw new Error('trivy image scan takes exactly one of --input or --image, not both');
  }
  if (opts.image && !/@sha256:[0-9a-f]{64}$/.test(opts.image)) {
    throw new Error(`trivy image --image must be an exact digest ref (…@sha256:<64 hex>): ${opts.image}`);
  }
  return opts;
}

export function buildTrivyImageArgs({ input = '', image = '' }) {
  const container = ['run', '--rm', '--platform', 'linux/amd64'];
  const scan = [
    'image',
    '--scanners', 'vuln',
    '--severity', 'HIGH,CRITICAL',
    '--pkg-types', 'os,library',
    '--disable-telemetry', '--skip-version-check',
    '--exit-code', '1',
  ];
  if (input) {
    return [
      ...container,
      '--volume', `${input}:/scan/image.tar:ro`,
      '--workdir', '/scan',
      TRIVY_IMAGE,
      ...scan,
      '--input', '/scan/image.tar',
    ];
  }
  return [...container, TRIVY_IMAGE, ...scan, '--offline-scan', image];
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

export function runTrivy({ argv = process.argv.slice(2), runDocker = realDocker } = {}) {
  const opts = parseTrivyArgs(argv);
  const probe = runDocker(['run', '--rm', '--platform', 'linux/amd64', TRIVY_IMAGE, '--version'], {
    capture: true,
  });
  if (probe.status !== 0) {
    process.stderr.write('trivy version probe failed; refusing to scan\n');
    return probe.status || 1;
  }
  interpretTrivyVersion(probe.stdout);
  process.stderr.write(`trivy ${TRIVY_VERSION} verified\n`);
  return runDocker(buildTrivyImageArgs(opts)).status;
}

export function main(argv = process.argv.slice(2)) {
  return runTrivy({ argv });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
