import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRootUrl = new URL('../../', import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, repoRootUrl), 'utf-8');
}

describe('startup surface hygiene', () => {
  it('keeps canonical startup surfaces split-only and free of monolith drift', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const readme = readRepoFile('README.md');
    const specifications = readRepoFile('docs/specifications.md');
    const architecture = readRepoFile('docs/architecture.md');
    const indexEntrypoint = readRepoFile('src/index.ts');

    for (const source of [
      readme,
      specifications,
      architecture,
      indexEntrypoint,
      JSON.stringify(scripts),
    ]) {
      const lowered = source.toLowerCase();
      expect(lowered).not.toContain('monolithic runtime');
      expect(lowered).not.toContain('single-process runtime');
      expect(lowered).not.toContain('direct single-process');
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
    expect(specifications).toContain('`src/index.ts` is disabled');
    expect(architecture).toContain('`src/index.ts` is disabled');
    expect(indexEntrypoint).toContain('This entrypoint is disabled.');
  });
});
