import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const launcher = join(import.meta.dirname, 'run-repository-node.sh');

function writeNode(path, version, label) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' '${version}'
  exit 0
fi
printf '%s\\n' '${label}' "$@"
`,
  );
  chmodSync(path, 0o755);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'psfn-hook-node-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repositoryRoot = join(root, 'repo');
  const ambientBin = join(root, 'ambient-bin');
  const miseDataRoot = join(root, 'mise data');
  const nvmRoot = join(root, 'nvm root');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(ambientBin, { recursive: true });
  writeFileSync(join(repositoryRoot, '.node-version'), '24.19.0\n');
  return { ambientBin, miseDataRoot, nvmRoot, repositoryRoot };
}

function run({ ambientBin, miseDataRoot, nvmRoot, repositoryRoot }) {
  return spawnSync('bash', [launcher, repositoryRoot, 'hook-entry.mjs', 'hook-argument'], {
    encoding: 'utf8',
    env: {
      HOME: join(repositoryRoot, 'home-without-node'),
      MISE_DATA_DIR: miseDataRoot,
      NVM_DIR: nvmRoot,
      PATH: `${ambientBin}:/usr/bin:/bin`,
    },
  });
}

test('uses the repository-pinned NVM runtime instead of an ambient Node 22', (t) => {
  const paths = fixture(t);
  writeNode(join(paths.ambientBin, 'node'), 'v22.22.2', 'ambient');
  writeNode(join(paths.nvmRoot, 'versions/node/v24.19.0/bin/node'), 'v24.19.0', 'pinned');

  const result = run(paths);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'pinned\nhook-entry.mjs\nhook-argument\n');
});

test('uses ambient node when it already matches the repository pin', (t) => {
  const paths = fixture(t);
  writeNode(join(paths.ambientBin, 'node'), 'v24.19.0', 'ambient');

  const result = run(paths);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ambient\nhook-entry.mjs\nhook-argument\n');
});

test('uses the repository-pinned mise runtime when it is installed', (t) => {
  const paths = fixture(t);
  writeNode(join(paths.ambientBin, 'node'), 'v22.22.2', 'ambient');
  writeNode(join(paths.miseDataRoot, 'installs/node/24.19.0/bin/node'), 'v24.19.0', 'pinned');

  const result = run(paths);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'pinned\nhook-entry.mjs\nhook-argument\n');
});

test('fails with an actionable error when the pinned runtime is unavailable', (t) => {
  const paths = fixture(t);
  writeNode(join(paths.ambientBin, 'node'), 'v22.22.2', 'ambient');

  const result = run(paths);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node 24\.19\.0 is required/u);
  assert.match(result.stderr, /nvm install 24\.19\.0/u);
});
