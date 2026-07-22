import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for the emo_sim build pin (oth4.3 part 1).
 *
 * emo_sim ships in a separate repo, so it is pinned by an exact commit that the
 * Dockerfile verifies fail-closed at build time. This exercises the unit-testable
 * portion — the SHA comparison logic in docker/emosim-verify-sha.sh — and asserts
 * the Dockerfile embeds the pin and the fail-closed verification.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VERIFY_SCRIPT = path.join(REPO_ROOT, 'docker', 'emosim-verify-sha.sh');
const DOCKERFILE = path.join(REPO_ROOT, 'docker', 'Dockerfile.emosim');
const PINNED_SHA = '112cd60edecad08ae2c99df818e623cd6245b8b5';
const PINNED_PYTHON_IMAGE =
  'python:3.12.13-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runVerify(actual: string | null, expected: string | null = PINNED_SHA): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (expected === null) {
    delete env.EXPECTED_EMOSIM_SHA;
  } else {
    env.EXPECTED_EMOSIM_SHA = expected;
  }
  try {
    const stdout = execFileSync('sh', [VERIFY_SCRIPT, ...(actual === null ? [] : [actual])], {
      env,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

describe('emosim-verify-sha.sh (build pin check)', () => {
  it('exits 0 when the context SHA matches the pin', () => {
    const result = runVerify(PINNED_SHA);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('exits 1 (refuses) when the context SHA differs from the pin', () => {
    const result = runVerify('0000000000000000000000000000000000000000');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to build');
  });

  it('fails closed (exit 2) when the actual SHA is empty', () => {
    const result = runVerify(null);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/refusing/);
  });

  it('fails closed (exit 2) when the pin is unset', () => {
    const result = runVerify(PINNED_SHA, null);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/refusing/);
  });
});

describe('Dockerfile.emosim pin contract', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');

  it('pins both stages to the same immutable Python manifest', () => {
    const pinnedStages = dockerfile
      .split('\n')
      .filter((line) => line.startsWith(`FROM ${PINNED_PYTHON_IMAGE}`));
    expect(pinnedStages).toHaveLength(2);
  });

  it('pins EXPECTED_EMOSIM_SHA to the exact upstream commit', () => {
    expect(dockerfile).toContain(`ARG EXPECTED_EMOSIM_SHA=${PINNED_SHA}`);
  });

  it('verifies the context checkout SHA and refuses on mismatch (fail closed)', () => {
    expect(dockerfile).toContain('git --git-dir=/verify/.git rev-parse HEAD');
    expect(dockerfile).toMatch(/!= .*EXPECTED_EMOSIM_SHA.*; refusing to build/);
    // The final image depends on the verify stage so the check cannot be skipped.
    expect(dockerfile).toContain('COPY --from=verify');
  });
});
