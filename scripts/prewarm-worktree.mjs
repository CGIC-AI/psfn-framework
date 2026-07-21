#!/usr/bin/env node

/**
 * Prewarm the shared npm content cache without sharing mutable worktree output.
 *
 * The script runs `npm ci --ignore-scripts` only in disposable directories. A
 * second, clean `npm ci --offline --ignore-scripts` proves that the lockfile's
 * complete dependency graph is available from npm's concurrency-safe cache.
 * Only then is a lockfile-SHA-256 attestation written inside the cache. No
 * node_modules, dist, test cache, git state, or other worktree output is linked
 * or reused.
 *
 * Usage:
 *   npm run prewarm
 *   npm run prewarm -- --check
 *   npm run prewarm -- --help
 *
 * After a successful prewarm, each worktree can install without network access:
 *   npm ci --offline --ignore-scripts
 *
 * A new package-lock.json hash selects a new attestation and forces a rewarm.
 * Missing attestations fail in --check mode; corrupt or mismatched attestations
 * and lockfiles that change during a run always fail with a nonzero exit.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const MARKER_SCHEMA_VERSION = 1;
const MARKER_NAMESPACE = '_worktree-prewarm-v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function hashLockfile(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function projectKey(projectName) {
  return createHash('sha256').update(projectName).digest('hex').slice(0, 24);
}

export function markerPathFor({ cacheDir, lockfileHash, projectName }) {
  if (!SHA256_PATTERN.test(lockfileHash)) {
    throw new Error(`Invalid lockfile SHA-256: ${lockfileHash}`);
  }
  if (typeof projectName !== 'string' || projectName.length === 0) {
    throw new Error('package.json must contain a non-empty name');
  }
  return join(cacheDir, MARKER_NAMESPACE, projectKey(projectName), `${lockfileHash}.json`);
}

export function parseArguments(args) {
  let checkOnly = false;
  let help = false;
  for (const argument of args) {
    if (argument === '--check') checkOnly = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { checkOnly, help };
}

function parseJson(contents, label) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${detail}`);
  }
}

function readProjectName(packageJsonPath) {
  const packageJson = parseJson(readFileSync(packageJsonPath, 'utf8'), 'package.json');
  if (
    packageJson === null ||
    typeof packageJson !== 'object' ||
    Array.isArray(packageJson) ||
    typeof packageJson.name !== 'string' ||
    packageJson.name.length === 0
  ) {
    throw new Error('package.json must contain a non-empty name');
  }
  return packageJson.name;
}

function readAttestation(markerPath, expected) {
  let contents;
  try {
    contents = readFileSync(markerPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
  const attestation = parseJson(contents, `cache attestation ${markerPath}`);
  if (attestation === null || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error(`Invalid cache attestation ${markerPath}: expected a JSON object`);
  }
  if (attestation.lockfileSha256 !== expected.lockfileHash) {
    throw new Error(
      `Cache attestation hash mismatch at ${markerPath}: recorded ${String(attestation.lockfileSha256)}, expected ${expected.lockfileHash}`,
    );
  }
  if (attestation.schemaVersion !== MARKER_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported cache attestation schema at ${markerPath}: ${String(attestation.schemaVersion)}`,
    );
  }
  if (attestation.projectName !== expected.projectName) {
    throw new Error(
      `Cache attestation project mismatch at ${markerPath}: recorded ${String(attestation.projectName)}, expected ${expected.projectName}`,
    );
  }
  return attestation;
}

function defaultRunNpm(args, { capture = false, cwd }) {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmExecutable, args, {
    cwd,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = capture && typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const detail = stderr ? `: ${stderr}` : '';
    throw new Error(`npm ${args.join(' ')} failed with exit code ${String(result.status)}${detail}`);
  }
  return capture && typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function resolveCacheDir({ cacheDir, repositoryRoot, runNpm }) {
  const configuredByCaller = cacheDir ?? process.env.npm_config_cache;
  if (configuredByCaller) return resolve(configuredByCaller);
  const configured = runNpm(['config', 'get', 'cache'], {
    capture: true,
    cwd: repositoryRoot,
  });
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new Error('npm config get cache returned an empty path');
  }
  return isAbsolute(configured) ? configured : resolve(repositoryRoot, configured);
}

function assertLockfileUnchanged(lockfilePath, expectedHash) {
  const actualHash = hashLockfile(readFileSync(lockfilePath));
  if (actualHash !== expectedHash) {
    throw new Error(
      `package-lock.json changed during prewarm (started ${expectedHash}, now ${actualHash}); cache attestation was not written`,
    );
  }
}

function withInstallFixture({ repositoryRoot, tempRoot }, callback) {
  const fixtureRoot = mkdtempSync(join(tempRoot, 'psfn-worktree-prewarm-'));
  try {
    copyFileSync(join(repositoryRoot, 'package.json'), join(fixtureRoot, 'package.json'));
    copyFileSync(join(repositoryRoot, 'package-lock.json'), join(fixtureRoot, 'package-lock.json'));
    const npmrcPath = join(repositoryRoot, '.npmrc');
    if (existsSync(npmrcPath)) copyFileSync(npmrcPath, join(fixtureRoot, '.npmrc'));
    return callback(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

function installArgs(cacheDir, offline) {
  return [
    'ci',
    ...(offline ? ['--offline'] : []),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    cacheDir,
  ];
}

function writeAttestation(markerPath, attestation) {
  mkdirSync(dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(attestation, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporaryPath, markerPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function prewarmWorktree({
  cacheDir,
  checkOnly = false,
  logger = console,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  runNpm = defaultRunNpm,
  tempRoot = tmpdir(),
} = {}) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const packageJsonPath = join(resolvedRepositoryRoot, 'package.json');
  const lockfilePath = join(resolvedRepositoryRoot, 'package-lock.json');
  const projectName = readProjectName(packageJsonPath);
  const lockfileContents = readFileSync(lockfilePath);
  parseJson(lockfileContents, 'package-lock.json');
  const lockfileHash = hashLockfile(lockfileContents);
  const resolvedCacheDir = resolveCacheDir({
    cacheDir,
    repositoryRoot: resolvedRepositoryRoot,
    runNpm,
  });
  const markerPath = markerPathFor({
    cacheDir: resolvedCacheDir,
    lockfileHash,
    projectName,
  });
  const expected = { lockfileHash, projectName };
  const attestation = readAttestation(markerPath, expected);
  let warmed = false;

  const populateCache = () => {
    logger.log(`[prewarm] Populating npm cache for lockfile SHA-256 ${lockfileHash}.`);
    withInstallFixture(
      { repositoryRoot: resolvedRepositoryRoot, tempRoot },
      (fixtureRoot) => runNpm(installArgs(resolvedCacheDir, false), { cwd: fixtureRoot }),
    );
    assertLockfileUnchanged(lockfilePath, lockfileHash);
    warmed = true;
  };

  const proveCache = () => {
    logger.log('[prewarm] Proving the cache with a clean offline install.');
    withInstallFixture(
      { repositoryRoot: resolvedRepositoryRoot, tempRoot },
      (fixtureRoot) => runNpm(installArgs(resolvedCacheDir, true), { cwd: fixtureRoot }),
    );
    assertLockfileUnchanged(lockfilePath, lockfileHash);
  };

  if (!attestation && checkOnly) {
    throw new Error(
      `No cache attestation exists for lockfile SHA-256 ${lockfileHash} at ${markerPath}; run 'npm run prewarm' before using --check`,
    );
  }

  if (!attestation) {
    populateCache();
    proveCache();
  } else {
    logger.log(`[prewarm] Found attestation for lockfile SHA-256 ${lockfileHash}.`);
    try {
      proveCache();
    } catch (error) {
      assertLockfileUnchanged(lockfilePath, lockfileHash);
      const detail = error instanceof Error ? error.message : String(error);
      if (checkOnly) {
        throw new Error(
          `Offline cache verification failed for attestation ${markerPath}: ${detail}; run 'npm run prewarm' to repopulate and reattest the cache`,
        );
      }
      logger.log(`[prewarm] Attested cache is stale (${detail}); rewarming.`);
      populateCache();
      proveCache();
    }
  }

  if (warmed) {
    writeAttestation(markerPath, {
      schemaVersion: MARKER_SCHEMA_VERSION,
      projectName,
      lockfileSha256: lockfileHash,
      platform: process.platform,
      architecture: process.arch,
      verifiedAt: new Date().toISOString(),
    });
  }
  readAttestation(markerPath, expected);
  logger.log(
    `[prewarm] PASS: npm cache is complete for ${lockfileHash}. Fresh worktrees may run npm ci --offline --ignore-scripts.`,
  );
  return {
    action: warmed ? 'warmed' : 'verified',
    cacheDir: resolvedCacheDir,
    lockfileHash,
    markerPath,
  };
}

function helpText() {
  return `Usage: npm run prewarm -- [--check]\n\nPopulate npm's shared cache from the repository package-lock.json, then prove it\nwith a clean offline install. All installs happen in disposable directories; no\nnode_modules or other mutable output is shared between worktrees.\n\nOptions:\n  --check  Require the current lock hash to be attested and verify it offline.\n  -h, --help  Show this help.\n\nAfter PASS, run this in each fresh worktree:\n  npm ci --offline --ignore-scripts`;
}

export function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    console.log(helpText());
    return;
  }
  prewarmWorktree({ checkOnly: options.checkOnly });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[prewarm] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
