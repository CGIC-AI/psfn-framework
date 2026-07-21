#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assessHookInstallation } from './local-delivery-contract.mjs';

function run(executable, args, { cwd = process.cwd() } = {}) {
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function normalizeAliasValue(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

export function installLocalHooks({ cwd = process.cwd() } = {}) {
  const repositoryRoot = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  run(process.execPath, ['scripts/ci/check-local-tools.mjs'], { cwd: repositoryRoot });
  const trackedHook = resolve(repositoryRoot, '.githooks/pre-push');
  if (!existsSync(trackedHook) || (statSync(trackedHook).mode & 0o111) === 0) {
    throw new Error('.githooks/pre-push is missing or is not executable');
  }

  const hooksPath = run('git', ['config', '--get', '--default', '', 'core.hooksPath'], {
    cwd: repositoryRoot,
  });
  const defaultHooksPath = resolve(
    repositoryRoot,
    run('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repositoryRoot }),
  );
  const existingHooks = existsSync(defaultHooksPath)
    ? readdirSync(defaultHooksPath).filter((name) => !name.endsWith('.sample'))
    : [];
  const assessment = assessHookInstallation({ hooksPath, existingHooks });
  if (!assessment.allowed) throw new Error(assessment.reason);

  const aliases = run('gh', ['alias', 'list'], { cwd: repositoryRoot });
  const currentAlias = aliases
    .split('\n')
    .find((line) => line.startsWith('psfn-pr:'))
    ?.slice('psfn-pr:'.length)
    .trim();
  const normalizedAlias = currentAlias ? normalizeAliasValue(currentAlias) : '';
  const expectedAlias = '!npm run pr:publish --';
  if (normalizedAlias && normalizedAlias !== expectedAlias) {
    throw new Error(`Refusing to replace existing gh alias psfn-pr: ${currentAlias}`);
  }
  if (!normalizedAlias) run('gh', ['alias', 'set', 'psfn-pr', expectedAlias], { cwd: repositoryRoot });
  if (hooksPath !== '.githooks') {
    run('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
      cwd: repositoryRoot,
    });
    run('git', ['config', '--worktree', 'core.hooksPath', '.githooks'], {
      cwd: repositoryRoot,
    });
  }

  console.log('Installed repo pre-push hook and gh psfn-pr alias.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    installLocalHooks();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
