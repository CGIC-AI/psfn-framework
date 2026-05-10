import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRootPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRootPath, relativePath), 'utf-8');
}

describe('startup surface hygiene', () => {
  it('keeps canonical startup surfaces split-only and free of obsolete startup drift', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const readme = readRepoFile('README.md');
    const specifications = readRepoFile('docs/specifications.md');
    const architecture = readRepoFile('docs/architecture.md');
    const indexEntrypoint = readRepoFile('src/app/startup/index.ts');
    const removedRuntimeFile = ['runtime', '.ts'].join('');
    const removedStartupHarnessFile = ['startup-harness', '.ts'].join('');
    const removedRuntimeReference = ['`src/', removedRuntimeFile, '`'].join('');
    const removedStartupHarnessReference = ['`src/runtime/', removedStartupHarnessFile, '`'].join('');

    expect(existsSync(resolve(repoRootPath, 'src', removedRuntimeFile))).toBe(false);
    expect(existsSync(resolve(repoRootPath, 'src', 'runtime', removedStartupHarnessFile))).toBe(false);

    for (const source of [
      readme,
      specifications,
      architecture,
      indexEntrypoint,
      JSON.stringify(scripts),
    ]) {
      expect(source).not.toContain(removedRuntimeReference);
      expect(source).not.toContain(removedStartupHarnessReference);
    }

    expect(scripts.dev).toBe('./scripts/start-gateway-agent.sh');
    expect(scripts.start).toBe('./scripts/start-gateway-agent.sh');
    expect(scripts.split).toBe('./scripts/start-gateway-agent.sh');
    expect(scripts.yolo).toBe('./scripts/start-gateway-agent.sh --yolo');
    expect(Object.keys(scripts)).not.toContain('single');
    expect(Object.keys(scripts)).not.toContain('runtime');

    for (const scriptName of ['dev', 'start', 'split', 'yolo']) {
      expect(scripts[scriptName]).not.toMatch(/src\/index\.ts|dist\/index\.js/);
    }

    expect(readme).toContain('npm run split');
    expect(specifications).toContain('split gateway + agent');
    expect(specifications).toContain('`src/app/startup/index.ts` is disabled');
    expect(architecture).toContain('`src/app/startup/index.ts` is disabled');
    expect(indexEntrypoint).toContain('This entrypoint is disabled.');
  });
});
