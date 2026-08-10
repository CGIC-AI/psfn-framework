import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('Satellite Hub image build uses the in-repo app and monorepo revision', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'satellite-hub-build-'));
  const argsPath = join(scratch, 'docker-args');
  const fakeDocker = join(scratch, 'docker');
  writeFileSync(fakeDocker, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$DOCKER_ARGS_PATH"\n');
  chmodSync(fakeDocker, 0o755);

  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync('bash', ['docker/satellite-hub/build-image.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH}`,
        DOCKER_ARGS_PATH: argsPath,
        SATELLITE_HUB_ALLOW_DIRTY: 'true',
        SATELLITE_HUB_MONOREPO_REF: revision,
      },
    });
    const args = readFileSync(argsPath, 'utf8').trim().split('\n');
    assert.ok(args.includes(`SOURCE_REVISION=${revision}`));
    assert.ok(args.includes(`org.opencontainers.image.revision=${revision}`));
    assert.equal(args.at(-1), join(repoRoot, 'apps/satellite-hub'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
