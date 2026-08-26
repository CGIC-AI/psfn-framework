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
  return join(repositoryRoot, 'node_modules', '.psfn-lock-sha256');
}

function hasIsolatedDependencies(repositoryRoot) {
  const modulesPath = join(repositoryRoot, 'node_modules');
  return existsSync(modulesPath)
    && lstatSync(modulesPath).isDirectory()
    && !lstatSync(modulesPath).isSymbolicLink();
}

function defaultRunNpm(args, { repositoryRoot }) {
  const npmCli = realpathSync(join(dirname(process.execPath), 'npm'));
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Automatic worktree dependency install failed with exit code ${String(result.status)}. `
      + 'Run npm run prewarm in a prepared checkout, then retry the worktree checkout.',
    );
  }
}

export function bootstrapWorktree({
  cacheDir,
  repositoryRoot = process.cwd(),
  nodeVersion = process.version,
  prewarm = prewarmWorktree,
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

  let cacheState = inspectPrewarmAttestation({ cacheDir, repositoryRoot: root });
  if (!cacheState.attestation) {
    logger.log('[worktree] Preparing and attesting the npm cache for this lockfile.');
    prewarm({
      cacheDir: cacheState.cacheDir,
      repositoryRoot: root,
    });
    cacheState = inspectPrewarmAttestation({
      cacheDir: cacheState.cacheDir,
      repositoryRoot: root,
    });
  }
  if (!cacheState.attestation) {
    throw new Error(
      `Automatic cache preparation did not create an attestation for lockfile SHA-256 `
      + `${cacheState.lockfileHash} at ${cacheState.markerPath}.`,
    );
  }
  const expectedMarker = `${cacheState.lockfileHash}\n`;
  const markerPath = dependencyMarkerPath(root);
  if (hasIsolatedDependencies(root)
    && existsSync(markerPath)
    && readFileSync(markerPath, 'utf8') === expectedMarker) {
    return 'ready';
  }

  logger.log('[worktree] Installing isolated dependencies from the attested offline npm cache.');
  runNpm([...offlineInstallArgs(cacheState.cacheDir), '--loglevel=error'], { repositoryRoot: root });
  if (!hasIsolatedDependencies(root)) {
    throw new Error('npm ci completed without creating node_modules in the worktree.');
  }
  writeFileSync(markerPath, expectedMarker, { encoding: 'utf8', mode: 0o600 });
  logger.log('[worktree] Dependencies are ready.');
  return 'installed';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    bootstrapWorktree({ repositoryRoot: process.argv[2] ?? process.cwd() });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
