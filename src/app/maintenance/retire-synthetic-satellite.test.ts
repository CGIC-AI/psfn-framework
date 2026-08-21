import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSyntheticSatelliteRetirementArgs } from './retire-synthetic-satellite.js';

describe('synthetic satellite retirement maintenance entrypoint', () => {
  it('defaults to dry-run and preserves every exact endpoint identity', () => {
    expect(parseSyntheticSatelliteRetirementArgs([
      '--satellite', 'synthetic-one',
      '--endpoint', 'voice-one',
      '--endpoint', 'display-one',
      '--run-id', 'run-one',
      '--manifest-id', 'manifest-one',
    ])).toMatchObject({
      apply: false,
      satelliteId: 'synthetic-one',
      endpointIds: ['voice-one', 'display-one'],
      runId: 'run-one',
      manifestId: 'manifest-one',
    });
  });

  it('is registered as a production package command', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['satellite:retire-synthetic'])
      .toBe('tsx src/app/maintenance/retire-synthetic-satellite.ts');
  });
});
