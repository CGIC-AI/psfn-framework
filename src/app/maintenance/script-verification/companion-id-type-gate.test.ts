import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isRecord, normalizeStringArray } from '../../../shared/utils/types.js';

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
    const typeGateConfig: unknown = JSON.parse(
      readFileSync('tsconfig.companion-id-types.json', 'utf8'),
    );
    if (!isRecord(typeGateConfig)) {
      throw new Error('tsconfig.companion-id-types.json must contain an object');
    }
    const includedInputs = normalizeStringArray(
      typeGateConfig.include,
      'include',
      { errorPrefix: 'Invalid tsconfig.companion-id-types.json' },
    );
    if (includedInputs.length === 0) {
      throw new Error('tsconfig.companion-id-types.json include must not be empty');
    }
    const requiredInputs = [
      'tsconfig.companion-id-types.json',
      ...includedInputs,
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
        ? posix.join(destination, posix.basename(requiredInput))
        : destination;
      const expectedPath = posix.join(
        './',
        posix.dirname(requiredInput),
        posix.basename(requiredInput),
      );

      expect(copiedPath).toBe(expectedPath);
    }
  });
});
