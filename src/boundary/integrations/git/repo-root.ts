import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { toErrorMessage } from '../../../shared/utils/errors.js';

export interface ResolveGitRepoRootOptions {
  codebaseRoot: string;
  configuredGitRepoRoot?: string;
}

function canonicalPath(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new Error(`${label} does not exist or is inaccessible: ${path} (${toErrorMessage(error)})`);
  }
}

function detectGitTopLevel(fromPath: string, sourceLabel: string): string {
  let gitTopLevel = '';
  try {
    gitTopLevel = execFileSync(
      'git',
      ['-C', fromPath, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (error) {
    throw new Error(
      `${sourceLabel} is not a git worktree: ${fromPath} (${toErrorMessage(error)})`,
    );
  }

  if (!gitTopLevel) {
    throw new Error(`${sourceLabel} did not resolve a git repository root: ${fromPath}`);
  }

  return canonicalPath(gitTopLevel, `${sourceLabel} git root`);
}

export function resolveGitRepoRoot(options: ResolveGitRepoRootOptions): string {
  const codebaseRoot = canonicalPath(resolve(options.codebaseRoot), 'Gateway codebase root');
  const configuredRaw = options.configuredGitRepoRoot?.trim();

  if (!configuredRaw) {
    return detectGitTopLevel(codebaseRoot, 'Gateway codebase root');
  }

  const configuredPath = isAbsolute(configuredRaw)
    ? configuredRaw
    : resolve(codebaseRoot, configuredRaw);
  const configuredRoot = canonicalPath(configuredPath, 'GIT_REPO_ROOT');
  const detectedRoot = detectGitTopLevel(configuredRoot, 'GIT_REPO_ROOT');

  if (configuredRoot !== detectedRoot) {
    throw new Error(
      `GIT_REPO_ROOT must point at the repository top-level. Configured=${configuredRoot}, detected=${detectedRoot}.`,
    );
  }

  return detectedRoot;
}
