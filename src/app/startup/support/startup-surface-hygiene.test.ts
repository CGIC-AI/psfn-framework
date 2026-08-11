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

    expect(scripts.gateway).toBe('tsx src/app/gateway/main.ts');
    expect(scripts.agent).toBe('tsx src/app/agent/main.ts');
    expect(scripts.operator).toBe('tsx src/app/operator/main.ts');
    expect(scripts).not.toHaveProperty('dev');
    expect(scripts).not.toHaveProperty('start');
    expect(scripts).not.toHaveProperty('split');
    expect(scripts).not.toHaveProperty('yolo');
    expect(Object.keys(scripts)).not.toContain('single');
    expect(Object.keys(scripts)).not.toContain('runtime');

    expect(readme).toContain('npm run gateway');
    expect(readme).toContain('npm run agent');
    expect(readme).toContain('npm run operator');
    expect(specifications).toContain('split gateway + agent');
    expect(specifications).toContain('`src/app/startup/index.ts` is disabled');
    expect(architecture).toContain('`src/app/startup/index.ts` is disabled');
    expect(indexEntrypoint).toContain('This entrypoint is disabled.');
  });
});
