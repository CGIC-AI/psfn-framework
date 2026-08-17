import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const temporaryRoots: string[] = [];

describe('injection-model offline provisioning', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails before network access when the transferred model is incomplete', () => {
    const destination = mkdtempSync(join(tmpdir(), 'psfn-injection-offline-'));
    temporaryRoots.push(destination);
    const result = spawnSync('npx', [
      'tsx',
      resolve(import.meta.dirname, 'provision-injection-model.ts'),
      '--dest',
      destination,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PSFN_INJECTION_MODEL_OFFLINE: '1',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Offline injection-model input is missing config.json; refusing network access',
    );
  });
});
