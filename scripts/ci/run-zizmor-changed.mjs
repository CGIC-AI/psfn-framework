#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ZIZMOR_IMAGE =
  'ghcr.io/zizmorcore/zizmor@sha256:d55c5d99dfe5f287a62294632fc512d0c921afe138746187d99e9dbce3910daf';
const ACTIONLINT_IMAGE =
  'rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667';
const INPUT = /^\.github\/(?:workflows\/.*\.ya?ml|actions\/.*\.ya?ml|dependabot\.yml)$/;

export function validateZizmorInputs(paths) {
  if (paths.length === 0) throw new Error('zizmor changed-workflow scan requires at least one input');
  for (const path of paths) {
    if (!INPUT.test(path)) throw new Error(`Refusing unexpected zizmor input: ${path}`);
  }
  return [...new Set(paths)].sort();
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status ?? 1;
}

export function main(argv = process.argv.slice(2)) {
  const paths = validateZizmorInputs(argv);
  const workflows = paths.filter((path) => path.startsWith('.github/workflows/'));
  if (workflows.length > 0) {
    const actionlintVersion = docker([
      'run', '--rm', '--platform', 'linux/amd64', ACTIONLINT_IMAGE, '-version',
    ]);
    if (actionlintVersion !== 0) return actionlintVersion;
    const actionlint = docker([
      'run', '--rm', '--platform', 'linux/amd64',
      '--volume', `${process.cwd()}:/repo:ro`, '--workdir', '/repo',
      ACTIONLINT_IMAGE, ...workflows,
    ]);
    if (actionlint !== 0) return actionlint;
  }
  const imageCheck = docker(['run', '--rm', '--platform', 'linux/amd64', ZIZMOR_IMAGE, '--version']);
  if (imageCheck !== 0) return imageCheck;
  return docker([
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--volume',
    `${process.cwd()}:/repo:ro`,
    '--workdir',
    '/repo',
    ZIZMOR_IMAGE,
    '--offline',
    '--strict-collection',
    '--persona=regular',
    '--format=plain',
    '--color=never',
    ...paths,
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
