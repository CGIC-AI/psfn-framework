// ── Mode-normalized build context for the Compose smoke stack (psfn-framework-1080c) ──
// Docker COPY and bind mounts preserve the checkout's permission bits. A
// checkout written under umask 0027 leaves files 0640 / dirs 0750, which the
// smoke containers' non-root uid 999 cannot read (model-prefetch failed with
// MODULE_NOT_FOUND on the bind-mounted scripts/ops; the hub's package.json and
// companion-ui's nginx.conf are COPYed the same way). Staging the working tree
// into a fresh directory with normalized modes makes the stack independent of
// the checkout umask, the same fix the private runtime-image build applies with
// git archive — but it includes uncommitted edits, so a smoke run still tests
// the working tree.
//
// Staged files: every tracked or untracked-but-not-ignored path in the working
// tree (`git ls-files --cached --others --exclude-standard`), regular files as
// 0644 (0755 when owner-executable), directories 0755, symlinks as symlinks.
// Tracked paths deleted from the working tree are skipped.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const DIRECTORY_MODE = 0o755;

function listWorkingTreePaths(repoRoot) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-files failed in ${repoRoot}: ${result.stderr.trim()}`);
  }
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}

function makeDirectories(root, relativeDir) {
  if (!relativeDir || relativeDir === '.') return;
  let current = root;
  for (const segment of relativeDir.split(sep)) {
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      continue;
    }
    // mkdir's mode is masked by the process umask; set it explicitly.
    chmodSync(current, DIRECTORY_MODE);
  }
}

/**
 * Stage the repository working tree into a new directory under `stageRoot`
 * with normalized permission bits. Returns the staged repository root.
 */
export function stageSmokeBuildContext({ repoRoot, stageRoot }) {
  if (!isAbsolute(repoRoot) || !isAbsolute(stageRoot)) {
    throw new Error('stageSmokeBuildContext requires absolute repoRoot and stageRoot paths');
  }
  mkdirSync(stageRoot, { recursive: true });
  const target = mkdtempSync(join(stageRoot, 'smoke-context-'));
  chmodSync(target, DIRECTORY_MODE);
  let staged = 0;
  for (const relativePath of listWorkingTreePaths(repoRoot)) {
    const normalized = normalize(relativePath);
    if (isAbsolute(normalized) || normalized.startsWith('..')) {
      throw new Error(`refusing to stage a path outside the repository: ${relativePath}`);
    }
    const source = join(repoRoot, normalized);
    let stats;
    try {
      stats = lstatSync(source);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const destination = join(target, normalized);
    makeDirectories(target, dirname(normalized));
    if (stats.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), destination);
    } else if (stats.isFile()) {
      copyFileSync(source, destination);
      chmodSync(destination, (stats.mode & 0o100) !== 0 ? EXECUTABLE_MODE : FILE_MODE);
    } else {
      // Gitlinks (submodules) and other special entries are not build inputs.
      continue;
    }
    staged += 1;
  }
  return { root: target, files: staged };
}
