import { readFileSync } from 'node:fs';
import { basename, dirname, posix } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('CompanionId type gate wiring', () => {
  it('runs the negative type fixture as part of every production build', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['verify:companion-id-types']).toBe(
      'tsc --noEmit -p tsconfig.companion-id-types.json',
    );
    expect(scripts.build).toBe('npm run verify:companion-id-types && tsup');
  });

  it.each([
    'docker/Dockerfile.agent',
    'docker/Dockerfile.gateway',
  ])('%s copies every type-gate input before the production build', (dockerfilePath) => {
    const typeGateConfig = JSON.parse(
      readFileSync('tsconfig.companion-id-types.json', 'utf8'),
    ) as { include?: string[] };
    const requiredInputs = [
      'tsconfig.companion-id-types.json',
      ...(typeGateConfig.include ?? []),
    ];
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const buildIndex = dockerfile.indexOf('RUN npm run build');

    expect(buildIndex).toBeGreaterThan(-1);
    const copyLines = dockerfile
      .slice(0, buildIndex)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('COPY '));

    for (const requiredInput of requiredInputs) {
      const matchingCopy = copyLines.find((line) => {
        const [, ...copyArguments] = line.trim().split(/\s+/);
        return copyArguments.slice(0, -1).includes(requiredInput);
      });

      expect(matchingCopy, `${dockerfilePath} must copy ${requiredInput}`).toBeDefined();
      const [, ...copyArguments] = matchingCopy!.trim().split(/\s+/);
      const destination = copyArguments.at(-1)!;
      const copiedPath = destination.endsWith('/')
        ? posix.join(destination, basename(requiredInput))
        : destination;
      const expectedPath = posix.join('./', dirname(requiredInput), basename(requiredInput));

      expect(copiedPath).toBe(expectedPath);
    }
  });
});
