#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LINTABLE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function git(args, cwd, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'inherit'],
    });
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function nullSeparated(output) {
  return output.split('\0').filter(Boolean);
}

export function collectChangedLintPaths({
  base = process.env.CI_BASE_SHA ?? 'origin/main',
  cwd = process.cwd(),
} = {}) {
  const paths = new Set();
  const mergeBase = git(['merge-base', base, 'HEAD'], cwd, true).trim();
  const commands = [
    ...(mergeBase ? [['diff', '--name-only', '--diff-filter=ACMR', '-z', mergeBase, 'HEAD']] : []),
    ['diff', '--name-only', '--diff-filter=ACMR', '-z', '--cached'],
    ['diff', '--name-only', '--diff-filter=ACMR', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];

  for (const command of commands) {
    for (const path of nullSeparated(git(command, cwd))) {
      if (LINTABLE.test(path) && existsSync(`${cwd}/${path}`)) paths.add(path);
    }
  }
  return [...paths].sort();
}

function parseBase(argv) {
  const index = argv.indexOf('--base');
  if (index === -1) return undefined;
  if (!argv[index + 1]) throw new Error('--base requires a git revision');
  return argv[index + 1];
}

export function main(argv = process.argv.slice(2)) {
  const paths = collectChangedLintPaths({ base: parseBase(argv) });
  if (paths.length === 0) {
    console.log('Changed-file lint: no lintable files changed.');
    return;
  }
  console.log(`Changed-file lint: ${paths.length} file(s).`);
  execFileSync('node_modules/.bin/eslint', paths, { stdio: 'inherit' });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
