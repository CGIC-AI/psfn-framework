#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ZIZMOR_IMAGE =
  'ghcr.io/zizmorcore/zizmor@sha256:d55c5d99dfe5f287a62294632fc512d0c921afe138746187d99e9dbce3910daf';
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
