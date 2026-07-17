import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = resolve(repoRoot, 'scripts/ops/keep-kube-port-forward.sh');

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('reconnects after kubectl exits and terminates the active child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'psfn-port-forward-test-'));
  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  mkdirSync(binDir);
  mkdirSync(stateDir);

  const fakeKubectl = join(binDir, 'kubectl');
  writeFileSync(fakeKubectl, `#!/usr/bin/env bash
set -u
if [[ " $* " == *" get service/psfn-garden "* ]]; then
  exit 0
fi
if [[ " $* " != *" port-forward "* ]]; then
  echo "unexpected kubectl arguments: $*" >&2
  exit 64
fi
count_file="$FAKE_STATE_DIR/count"
count=0
[[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s' "$count" >"$count_file"
printf 'start:%s:%s\\n' "$count" "$$" >>"$FAKE_STATE_DIR/events"
if ((count == 1)); then
  exit 1
fi
trap 'printf "term:%s:%s\\n" "$count" "$$" >>"$FAKE_STATE_DIR/events"; exit 0' TERM INT
while true; do sleep 0.05; done
`, 'utf8');
  chmodSync(fakeKubectl, 0o755);

  const child = spawn('bash', [
    runner,
    '--namespace', 'psfn-test',
    '--target', 'service/psfn-garden',
    '--mapping', '10154:10054',
    '--retry-seconds', '0.05',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FAKE_STATE_DIR: stateDir,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  try {
    await waitFor(() => {
      try {
        return readFileSync(join(stateDir, 'events'), 'utf8').includes('start:2:');
      } catch {
        return false;
      }
    }, 'the second kubectl port-forward');

    const exitPromise = new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolvePromise({ code, signal }));
    });
    child.kill('SIGTERM');
    const exit = await exitPromise;
    assert.ok(
      exit.code === 0 || exit.signal === 'SIGTERM',
      `unexpected runner exit ${JSON.stringify(exit)}\nstdout=${stdout}\nstderr=${stderr}`,
    );

    const events = readFileSync(join(stateDir, 'events'), 'utf8');
    assert.match(events, /start:1:\d+/);
    assert.match(events, /start:2:\d+/);
    assert.match(events, /term:2:\d+/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  }
});
