import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  resolveTestingSessionPurgeTarget,
  TestingSessionPurgeCompanionResolutionError,
  TestingSessionPurgeSchemaResolutionError,
} from './testing-session-purge-target.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

function createTestConfig(overrides: Partial<SubstrateConfig>): SubstrateConfig {
  return {
    characterCardPath: '',
    compactionThresholdPct: 70,
    dataDir: './data',
    databasePath: '',
    defaultContextWindow: 128_000,
    extractionInterval: 5,
    extractionMaxTokens: 8_192,
    extractionModel: 'test-extraction-model',
    extractionProvider: 'test-provider',
    extractionThresholdPct: 30,
    maintenanceIntervalMs: 300_000,
    primaryMaxTokens: 16_384,
    primaryModel: 'test-primary-model',
    primaryProvider: 'test-provider',
    ...overrides,
  };
}

describe('resolveTestingSessionPurgeTarget', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeLiveRoots() {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-purge-live-layout-'));
    roots.push(runtimeRoot);
    const systemDataDir = join(runtimeRoot, 'system-data');
    const companionDataDir = join(runtimeRoot, 'companions', COMPANION_A);
    mkdirSync(join(systemDataDir, 'state', 'sessions'), { recursive: true });
    mkdirSync(join(companionDataDir, 'state', 'sessions'), { recursive: true });
    return { runtimeRoot, systemDataDir, companionDataDir };
  }

  it('finds live-shaped journals under the companion root by default, not the split system root', () => {
    const { systemDataDir, companionDataDir } = makeLiveRoots();
    const config = createTestConfig({
      dataDir: systemDataDir,
      systemDataDir,
      companionDataDir,
      companionId: COMPANION_A as SubstrateConfig['companionId'],
    });

    const target = resolveTestingSessionPurgeTarget(
      { config, dataDir: resolve(systemDataDir) },
      {},
    );

    expect(target).toEqual({
      companionDataDir: resolve(companionDataDir),
      companionId: COMPANION_A,
      postgresSchema: 'public',
      sessionsDir: resolve(companionDataDir, 'state', 'sessions'),
    });
    expect(target.sessionsDir).not.toBe(resolve(systemDataDir, 'state', 'sessions'));
  });

  it('requires an explicit companion id and resolves its non-public schema from companions.json', () => {
    const { runtimeRoot, systemDataDir, companionDataDir } = makeLiveRoots();
    const companionBDataDir = join(runtimeRoot, 'companions', COMPANION_B);
    mkdirSync(join(companionBDataDir, 'state', 'sessions'), { recursive: true });
    const config = createTestConfig({
      dataDir: systemDataDir,
      systemDataDir,
      companionDataDir,
      multiCompanion: true,
      companionFleet: {
        persistenceRoot: runtimeRoot,
        workspacesRoot: join(runtimeRoot, 'workspaces'),
        sharedWorkspacePath: join(runtimeRoot, 'workspaces', 'shared'),
        companions: [
          {
            companionId: COMPANION_A,
            companionDataDir,
            characterCardPath: join(companionDataDir, 'companion.json'),
            personalWorkspacePath: join(runtimeRoot, 'workspaces', 'personal', COMPANION_A),
            postgresSchema: 'companion_alpha',
          },
          {
            companionId: COMPANION_B,
            companionDataDir: companionBDataDir,
            characterCardPath: join(companionBDataDir, 'companion.json'),
            personalWorkspacePath: join(runtimeRoot, 'workspaces', 'personal', COMPANION_B),
            postgresSchema: 'companion_beta',
          },
        ],
      } as SubstrateConfig['companionFleet'],
    });
    const runtime = { config, dataDir: resolve(systemDataDir) };

    expect(() => resolveTestingSessionPurgeTarget(runtime, {}))
      .toThrow(TestingSessionPurgeCompanionResolutionError);
    expect(resolveTestingSessionPurgeTarget(runtime, { companionId: COMPANION_B })).toEqual({
      companionDataDir: resolve(companionBDataDir),
      companionId: COMPANION_B,
      postgresSchema: 'companion_beta',
      sessionsDir: resolve(companionBDataDir, 'state', 'sessions'),
    });
    expect(() => resolveTestingSessionPurgeTarget(runtime, {
      companionId: COMPANION_B,
      sessionsDir: resolve(companionDataDir, 'state', 'sessions'),
    })).toThrow(TestingSessionPurgeCompanionResolutionError);
  });

  it('fails with a named error when a multi-companion target schema is absent', () => {
    const { runtimeRoot, systemDataDir, companionDataDir } = makeLiveRoots();
    const config = createTestConfig({
      dataDir: systemDataDir,
      systemDataDir,
      companionDataDir,
      multiCompanion: true,
      companionFleet: {
        persistenceRoot: runtimeRoot,
        workspacesRoot: join(runtimeRoot, 'workspaces'),
        sharedWorkspacePath: join(runtimeRoot, 'workspaces', 'shared'),
        companions: [{
          companionId: COMPANION_A,
          companionDataDir,
          characterCardPath: join(companionDataDir, 'companion.json'),
          personalWorkspacePath: join(runtimeRoot, 'workspaces', 'personal', COMPANION_A),
          postgresSchema: '',
        }],
      } as unknown as SubstrateConfig['companionFleet'],
    });

    expect(() => resolveTestingSessionPurgeTarget(
      { config, dataDir: resolve(systemDataDir) },
      { companionId: COMPANION_A },
    )).toThrow(TestingSessionPurgeSchemaResolutionError);
  });
});
