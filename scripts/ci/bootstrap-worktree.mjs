#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  hashLockfile,
  inspectPrewarmAttestation,
  offlineInstallArgs,
  prewarmWorktree,
} from '../prewarm-worktree.mjs';
import { NPM_PROJECT_PATHS } from './npm-project-contract.mjs';

const DEFAULT_PROJECT_PATHS = Object.freeze(['.']);

function assertKnownProjectPath(projectPath) {
  if (!NPM_PROJECT_PATHS.includes(projectPath)) {
    throw new Error(
      `Unknown npm project ${projectPath}; expected one of ${NPM_PROJECT_PATHS.join(', ')}`,
    );
  }
}

export function parseBootstrapArguments(argv, cwd = process.cwd()) {
  const args = [...argv];
  let repositoryRoot = cwd;
  if (args[0] && !args[0].startsWith('-')) repositoryRoot = args.shift();
  const projectPaths = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--project') {
      const projectPath = args[index + 1];
      if (!projectPath) throw new Error('--project requires a repository-relative npm project');
      assertKnownProjectPath(projectPath);
      projectPaths.push(projectPath);
      index += 1;
      continue;
    }
    if (argument === '--all') {
      projectPaths.push(...NPM_PROJECT_PATHS);
      continue;
    }
    throw new Error(`Unknown worktree bootstrap argument: ${argument}`);
  }

  return {
    repositoryRoot,
    projectPaths: projectPaths.length > 0 ? [...new Set(projectPaths)] : [...DEFAULT_PROJECT_PATHS],
  };
}

function requiredNodeVersion(repositoryRoot) {
  const versionPath = join(repositoryRoot, '.node-version');
  const version = readFileSync(versionPath, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Invalid repository Node version in ${versionPath}: ${version}`);
  }
  return `v${version}`;
}

export function lockfileSha256(repositoryRoot) {
  return hashLockfile(readFileSync(join(repositoryRoot, 'package-lock.json')));
}

export function dependencyMarkerPath(repositoryRoot) {
  return join(repositoryRoot, 'node_modules', '.worktree-lock-sha256');
}

function hasIsolatedDependencies(repositoryRoot) {
  const modulesPath = join(repositoryRoot, 'node_modules');
  return existsSync(modulesPath)
    && lstatSync(modulesPath).isDirectory()
    && !lstatSync(modulesPath).isSymbolicLink();
}

/**
 * Resolve the npm CLI *JavaScript* entry so it can run under the exact Node
 * binary. `<node bin>/npm` is a shell wrapper on some installs (mise, nvm
 * shims), which Node cannot execute; prefer the npm_execpath the invoking npm
 * exported, then the lib tree beside the binary, then the bin symlink.
 */
export function resolveNpmCliPath({
  execPath = process.execPath,
  env = process.env,
  exists = existsSync,
  realpath = realpathSync,
} = {}) {
  const fromEnv = typeof env.npm_execpath === 'string' ? env.npm_execpath.trim() : '';
  if (fromEnv.endsWith('npm-cli.js') && exists(fromEnv)) return fromEnv;
  const nodeBin = dirname(execPath);
  const libEntry = join(nodeBin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(libEntry)) return libEntry;
  const binEntry = join(nodeBin, 'npm');
  if (!exists(binEntry)) {
    throw new Error(`Cannot resolve the npm CLI next to ${execPath}; set npm_execpath to npm-cli.js.`);
  }
  const resolved = realpath(binEntry);
  if (readFileSync(resolved, 'utf8').startsWith('#!/usr/bin/env bash')) {
    throw new Error(
      `${resolved} is a shell wrapper, not the npm CLI; set npm_execpath to npm-cli.js or install npm beside the Node binary.`,
    );
  }
  return resolved;
}

function defaultRunNpm(args, { repositoryRoot }) {
  const npmCli = resolveNpmCliPath();
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Automatic worktree dependency install failed with exit code ${String(result.status)}. `
      + 'The next checkout will retry the automatic cache preparation and install.',
    );
  }
}

function bootstrapProject({
  cacheDir,
  projectRoot,
  prewarm = prewarmWorktree,
  runNpm = defaultRunNpm,
  logger = console,
}) {
  let cacheState = inspectPrewarmAttestation({ cacheDir, repositoryRoot: projectRoot });
  if (!cacheState.attestation) {
    logger.log('[worktree] Preparing and attesting the npm cache for this lockfile.');
    prewarm({
      cacheDir: cacheState.cacheDir,
      repositoryRoot: projectRoot,
    });
    cacheState = inspectPrewarmAttestation({
      cacheDir: cacheState.cacheDir,
      repositoryRoot: projectRoot,
    });
  }
  if (!cacheState.attestation) {
    throw new Error(
      `Automatic cache preparation did not create an attestation for lockfile SHA-256 `
      + `${cacheState.lockfileHash} at ${cacheState.markerPath}.`,
    );
  }
  const expectedMarker = `${cacheState.lockfileHash}\n`;
  const markerPath = dependencyMarkerPath(projectRoot);
  if (hasIsolatedDependencies(projectRoot)
    && existsSync(markerPath)
    && readFileSync(markerPath, 'utf8') === expectedMarker) {
    return 'ready';
  }

  logger.log('[worktree] Installing isolated dependencies from the attested offline npm cache.');
  runNpm([...offlineInstallArgs(cacheState.cacheDir), '--loglevel=error'], {
    repositoryRoot: projectRoot,
  });
  if (!hasIsolatedDependencies(projectRoot)) {
    throw new Error('npm ci completed without creating node_modules in the worktree.');
  }
  writeFileSync(markerPath, expectedMarker, { encoding: 'utf8', mode: 0o600 });
  logger.log('[worktree] Dependencies are ready.');
  return 'installed';
}

export function bootstrapWorktree({
  cacheDir,
  repositoryRoot = process.cwd(),
  nodeVersion = process.version,
  prewarm = prewarmWorktree,
  projectPaths = DEFAULT_PROJECT_PATHS,
  runNpm = defaultRunNpm,
  logger = console,
} = {}) {
  const root = resolve(repositoryRoot);
  const requiredVersion = requiredNodeVersion(root);
  if (nodeVersion !== requiredVersion) {
    throw new Error(
      `This worktree requires Node ${requiredVersion}; bootstrap is running under ${nodeVersion}.`,
    );
  }

  for (const projectPath of projectPaths) assertKnownProjectPath(projectPath);
  const results = projectPaths.map((projectPath) => bootstrapProject({
    cacheDir,
    projectRoot: resolve(root, projectPath),
    prewarm,
    runNpm,
    logger,
  }));
  return results.every((result) => result === 'ready') ? 'ready' : 'installed';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    bootstrapWorktree(parseBootstrapArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
