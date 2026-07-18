import {
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const REQUIRED_ENV = [
  'PSFN_REPO_ROOT',
  'CONFIG_DIR',
  'SHAKEDOWN_ROOT',
  'PSFN_SHAKEDOWN_ROOT',
  'PSFN_RUNTIME_ROOT',
  'PSFN_RUNTIME_MODE',
  'PSFN_RUNTIME_LAYOUT_MODE',
  'WORKSPACE_PATH',
  'DATA_DIR',
  'SYSTEM_DATA_DIR',
  'COMPANION_DATA_DIR',
  'CHARACTER_CARD_PATH',
  'PSFN_LOGS_DIR',
  'PSFN_TEMP_DIR',
  'BACKUP_ROOT_DIR',
  'POSTGRES_DATABASE_URL',
  'PSFN_API_BASE',
  'PSFN_ADMIN_BASE',
  'API_HOST',
  'API_PORT',
  'ADMIN_HOST',
  'ADMIN_PORT',
  'API_CORS_ALLOWLIST',
  'API_KEY',
  'ADMIN_TOKEN',
  'GATEWAY_SESSION_HMAC_KEY',
  'COMPANION_ID',
  'PSFN_LIVE_DATA_ROOTS',
];

const MUTABLE_PATH_ENV = [
  'WORKSPACE_PATH',
  'DATA_DIR',
  'SYSTEM_DATA_DIR',
  'COMPANION_DATA_DIR',
  'PSFN_LOGS_DIR',
  'PSFN_TEMP_DIR',
  'BACKUP_ROOT_DIR',
];

function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Source both shakedown env files before bootstrapping.`,
    );
  }
  return value;
}

function canonicalizePath(rawPath, name) {
  if (!isAbsolute(rawPath)) {
    throw new Error(`${name} must be an absolute path; received "${rawPath}"`);
  }

  let cursor = resolve(rawPath);
  const missingSegments = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`${name} has no resolvable filesystem ancestor: ${rawPath}`);
    }
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }

  return resolve(realpathSync(cursor), ...missingSegments);
}

export function pathsOverlap(left, right) {
  return left === right
    || left.startsWith(`${right}${sep}`)
    || right.startsWith(`${left}${sep}`);
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} is not an existing directory: ${path}`);
  }
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is not an existing file: ${path}`);
  }
}

function requireHttpBase(rawValue, label) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return rawValue.replace(/\/$/u, '');
}

function requireRfc4122Uuid(rawValue, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(rawValue)) {
    throw new Error(`${label} must be an RFC 4122 UUID; received "${rawValue}"`);
  }
  return rawValue.toLowerCase();
}

function parseLiveRoots(rawValue) {
  const roots = rawValue
    .split(delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .map((value, index) => canonicalizePath(value, `PSFN_LIVE_DATA_ROOTS[${index}]`));
  if (roots.length === 0) {
    throw new Error(
      'PSFN_LIVE_DATA_ROOTS must name every protected live data root; an empty protection set is unsafe.',
    );
  }
  return roots;
}

function assertDistinctMutableRoots(paths) {
  for (let leftIndex = 0; leftIndex < MUTABLE_PATH_ENV.length; leftIndex += 1) {
    const leftName = MUTABLE_PATH_ENV[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < MUTABLE_PATH_ENV.length; rightIndex += 1) {
      const rightName = MUTABLE_PATH_ENV[rightIndex];
      if (pathsOverlap(paths[leftName], paths[rightName])) {
        throw new Error(
          `${leftName} (${paths[leftName]}) overlaps ${rightName} (${paths[rightName]}). `
          + 'Every mutable runtime root must be isolated.',
        );
      }
    }
  }
}

/**
 * Resolve the bootstrap contract without writing or launching anything.
 *
 * Existing ancestors are realpathed before overlap checks, so a symlink cannot
 * make a path that looks external resolve back into the repository or live
 * runtime.
 */
export function resolveBootstrapConfig(env = process.env) {
  const values = Object.fromEntries(REQUIRED_ENV.map(name => [name, requireEnv(env, name)]));
  const repoRoot = canonicalizePath(values.PSFN_REPO_ROOT, 'PSFN_REPO_ROOT');
  const roundRoot = canonicalizePath(values.SHAKEDOWN_ROOT, 'SHAKEDOWN_ROOT');
  const psfnRoundRoot = canonicalizePath(values.PSFN_SHAKEDOWN_ROOT, 'PSFN_SHAKEDOWN_ROOT');
  const runtimeRoot = canonicalizePath(values.PSFN_RUNTIME_ROOT, 'PSFN_RUNTIME_ROOT');
  const configDir = canonicalizePath(values.CONFIG_DIR, 'CONFIG_DIR');
  const mutablePaths = Object.fromEntries(
    MUTABLE_PATH_ENV.map(name => [name, canonicalizePath(values[name], name)]),
  );
  const characterCardPath = canonicalizePath(values.CHARACTER_CARD_PATH, 'CHARACTER_CARD_PATH');
  const liveRoots = parseLiveRoots(values.PSFN_LIVE_DATA_ROOTS);

  if (roundRoot !== psfnRoundRoot) {
    throw new Error(
      `SHAKEDOWN_ROOT (${roundRoot}) must exactly match PSFN_SHAKEDOWN_ROOT (${psfnRoundRoot})`,
    );
  }
  if (roundRoot !== runtimeRoot) {
    throw new Error(
      `SHAKEDOWN_ROOT (${roundRoot}) must exactly match PSFN_RUNTIME_ROOT (${runtimeRoot})`,
    );
  }
  if (values.PSFN_RUNTIME_MODE !== 'split') {
    throw new Error(`PSFN_RUNTIME_MODE must be "split"; received "${values.PSFN_RUNTIME_MODE}"`);
  }
  if (values.PSFN_RUNTIME_LAYOUT_MODE !== 'production') {
    throw new Error(
      `PSFN_RUNTIME_LAYOUT_MODE must be "production"; received "${values.PSFN_RUNTIME_LAYOUT_MODE}"`,
    );
  }
  if (
    env.PERSISTENCE_BACKEND?.trim()
    && !['postgres', 'postgresql', 'pg'].includes(env.PERSISTENCE_BACKEND.trim().toLowerCase())
  ) {
    throw new Error('PERSISTENCE_BACKEND must be PostgreSQL for shakedown bootstrap');
  }
  if (env.PSFN_TARGET?.trim() && env.PSFN_TARGET.trim() !== 'local') {
    throw new Error('The fresh-bootstrap command only supports PSFN_TARGET=local');
  }
  for (const name of ['PSFN_MULTI_COMPANION', 'PSFN_FLEET_AUTH']) {
    const value = env[name]?.trim().toLowerCase();
    if (value && !['0', 'false', 'no', 'off'].includes(value)) {
      throw new Error(`${name} must be disabled for the single-companion fresh-bootstrap lane`);
    }
  }

  requireDirectory(repoRoot, 'PSFN_REPO_ROOT');
  requireFile(join(repoRoot, 'package.json'), 'RC package.json');
  if (configDir !== join(repoRoot, 'config')) {
    throw new Error(
      `CONFIG_DIR must be the RC clone config directory (${join(repoRoot, 'config')}); received ${configDir}`,
    );
  }
  requireDirectory(configDir, 'CONFIG_DIR');
  const characterCardSource = join(repoRoot, 'shakedown', 'artie', 'ARTIE.png');
  requireFile(characterCardSource, 'Artie character card');

  if (pathsOverlap(roundRoot, repoRoot)) {
    throw new Error(
      `SHAKEDOWN_ROOT (${roundRoot}) overlaps the repository root (${repoRoot}); refusing before any write.`,
    );
  }

  for (const name of MUTABLE_PATH_ENV) {
    const path = mutablePaths[name];
    if (pathsOverlap(path, repoRoot)) {
      throw new Error(
        `${name} (${path}) overlaps the repository root (${repoRoot}); refusing before any write.`,
      );
    }
    if (path === roundRoot || !path.startsWith(`${roundRoot}${sep}`)) {
      throw new Error(`${name} (${path}) must be contained by SHAKEDOWN_ROOT (${roundRoot})`);
    }
  }

  if (
    characterCardPath !== join(mutablePaths.COMPANION_DATA_DIR, 'companion.json')
  ) {
    throw new Error(
      `CHARACTER_CARD_PATH must be ${join(mutablePaths.COMPANION_DATA_DIR, 'companion.json')}; `
      + `received ${characterCardPath}`,
    );
  }

  assertDistinctMutableRoots(mutablePaths);

  for (const liveRoot of liveRoots) {
    if (pathsOverlap(roundRoot, liveRoot)) {
      throw new Error(
        `SHAKEDOWN_ROOT (${roundRoot}) overlaps protected live root (${liveRoot}); refusing before any write.`,
      );
    }
    for (const name of MUTABLE_PATH_ENV) {
      if (pathsOverlap(mutablePaths[name], liveRoot)) {
        throw new Error(
          `${name} (${mutablePaths[name]}) overlaps protected live root (${liveRoot}); refusing before any write.`,
        );
      }
    }
  }

  return {
    repoRoot,
    configDir,
    roundRoot,
    workspacePath: mutablePaths.WORKSPACE_PATH,
    dataDir: mutablePaths.DATA_DIR,
    systemDataDir: mutablePaths.SYSTEM_DATA_DIR,
    companionDataDir: mutablePaths.COMPANION_DATA_DIR,
    characterCardPath,
    logsDir: mutablePaths.PSFN_LOGS_DIR,
    tempDir: mutablePaths.PSFN_TEMP_DIR,
    backupRootDir: mutablePaths.BACKUP_ROOT_DIR,
    characterCardSource,
    liveRoots,
    apiBase: requireHttpBase(values.PSFN_API_BASE, 'PSFN_API_BASE'),
    adminBase: requireHttpBase(values.PSFN_ADMIN_BASE, 'PSFN_ADMIN_BASE'),
    apiKey: values.API_KEY,
    adminToken: values.ADMIN_TOKEN,
    companionId: requireRfc4122Uuid(values.COMPANION_ID, 'COMPANION_ID'),
    postgresUrl: values.POSTGRES_DATABASE_URL,
    resume: env.PSFN_SHAKEDOWN_RESUME?.trim() === '1',
  };
}
