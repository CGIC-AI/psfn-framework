// ── Gateway intake screening composition tests (htm9.8 vision wiring) ──

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeGatewayIntakeScreening } from './compose-screening.js';

const POLICY_SEED_PATH = join(process.cwd(), 'config', 'intake-policy.seed.json');

const tempDirs: string[] = [];

function makeDataDirs(mode: 'shadow' | 'enforce', visionEnabled: boolean): {
  systemDataDir: string;
  companionDataDir: string;
} {
  const systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-system-'));
  const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-intake-companion-'));
  tempDirs.push(systemDataDir, companionDataDir);
  const seed = JSON.parse(readFileSync(POLICY_SEED_PATH, 'utf8')) as Record<string, unknown>;
  const visionScreener = {
    ...(seed.visionScreener as Record<string, unknown>),
    enabled: visionEnabled,
  };
  writeFileSync(
    join(systemDataDir, 'intake-policy.json'),
    JSON.stringify({ ...seed, mode, visionScreener }, null, 2),
  );
  return { systemDataDir, companionDataDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('composeGatewayIntakeScreening vision wiring (htm9.8)', () => {
  it('wires the vision intake screener when enabled with a backend', async () => {
    const composition = await composeGatewayIntakeScreening({
      ...makeDataDirs('enforce', true),
      screenerBackend: { apiBaseUrl: 'https://openrouter.test/api/v1', apiKey: 'sk-test' },
    });
    expect(composition.screening).not.toBeNull();
    expect(composition.visionIntake).not.toBeNull();
    await composition.dispose();
  });

  it('FAILS STARTUP when vision screening is enabled in enforce mode without a backend', async () => {
    await expect(composeGatewayIntakeScreening({
      ...makeDataDirs('enforce', true),
      screenerBackend: null,
    })).rejects.toThrow(/no OpenRouter backend is resolvable/);
  });

  it('skips loudly (null screener) in shadow mode without a backend', async () => {
    const composition = await composeGatewayIntakeScreening({
      ...makeDataDirs('shadow', true),
      screenerBackend: null,
    });
    expect(composition.screening).not.toBeNull();
    expect(composition.visionIntake).toBeNull();
    await composition.dispose();
  });

  it('does not wire the vision screener when the policy knob is disabled', async () => {
    const composition = await composeGatewayIntakeScreening({
      ...makeDataDirs('enforce', false),
      screenerBackend: { apiBaseUrl: 'https://openrouter.test/api/v1', apiKey: 'sk-test' },
    });
    expect(composition.visionIntake).toBeNull();
    await composition.dispose();
  });
});
