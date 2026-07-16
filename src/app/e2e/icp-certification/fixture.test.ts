import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAgentConfig } from '../../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../../system/config/runtime-config.js';
import {
  DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,
  loadSchedulerConfig,
} from '../../../system/config/scheduler-config.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
  CERTIFICATION_EMBEDDING_DIMS,
  CERTIFICATION_SCHEMA_A,
  CERTIFICATION_SCHEMA_B,
} from './constants.js';
import { createIcpCertificationFixture, type IcpCertificationFixture } from './fixture.js';

describe('ICP certification production-shape fixture', () => {
  let fixture: IcpCertificationFixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  it('loads two fleet-bound agents from canonical owner files and isolated roots', () => {
    fixture = createIcpCertificationFixture({
      databaseUrl: 'postgres://certification:certification@127.0.0.1:5432/certification',
    });

    const [configA, configB] = fixture.companions.map(companion => hydrateJsonBackedRuntimeConfig(
      loadAgentConfig(companion.env),
      { seedDir: companion.env.CONFIG_DIR },
    ));
    const settings = JSON.parse(
      readFileSync(join(fixture.systemDataDir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(settings.embeddingDims).toBe(CERTIFICATION_EMBEDDING_DIMS);
    expect(configA).toMatchObject({
      multiCompanion: true,
      companionId: CERTIFICATION_COMPANION_A,
      embeddingDims: CERTIFICATION_EMBEDDING_DIMS,
      postgresSchema: CERTIFICATION_SCHEMA_A,
      persistenceBackend: 'postgres',
    });
    expect(configB).toMatchObject({
      multiCompanion: true,
      companionId: CERTIFICATION_COMPANION_B,
      embeddingDims: CERTIFICATION_EMBEDDING_DIMS,
      postgresSchema: CERTIFICATION_SCHEMA_B,
      persistenceBackend: 'postgres',
    });
    expect(configA.companionDataDir).not.toBe(configB.companionDataDir);
    expect(configA.workspacePath).not.toBe(configB.workspacePath);
    expect(configA.workspacePath).toBe(join(
      fixture.runtimeRoot,
      'workspaces',
      'personal',
      CERTIFICATION_COMPANION_A,
    ));
    expect(configB.workspacePath).toBe(join(
      fixture.runtimeRoot,
      'workspaces',
      'personal',
      CERTIFICATION_COMPANION_B,
    ));
    for (const companion of fixture.companions) {
      expect(companion.env.POSTGRES_DATABASE_URL).toBeUndefined();
      expect(companion.env.POSTGRES_DATABASE_URL_FD).toBeUndefined();
      const credentialPath = companion.env.POSTGRES_DATABASE_URL_FILE;
      expect(credentialPath).toBeTypeOf('string');
      expect(readFileSync(credentialPath!, 'utf8').trim()).toBe(
        'postgres://certification:certification@127.0.0.1:5432/certification',
      );
    }
    expect(configA.companionFleet?.companions).toHaveLength(2);
    const chatModels = configA.modelRegistry?.models.filter(model => (
      model.purposes.some(purpose => purpose.purpose === 'chat')
    ));
    expect(chatModels).not.toHaveLength(0);
    expect(chatModels?.every(model => (
      model.cost?.inputPer1MUsd === 0
      && model.cost.outputPer1MUsd === 0
      && model.cost.cacheReadPer1MUsd === 0
      && model.cost.cacheWritePer1MUsd === 0
      && model.cost.currency === 'USD'
    ))).toBe(true);
    expect(configA.chargePolicy?.icpCostBreaker).toMatchObject({
      enabled: true,
      hardLimitUsd: 0.0004,
    });
    expect(configA).toMatchObject({
      compactionThresholdPct: 30,
      modelRoster: {
        chat: { contextWindow: 4_096, maxTokens: 1_024 },
      },
    });
    for (const companion of fixture.companions) {
      expect(loadSchedulerConfig(companion.companionDataDir, {
        seedDir: companion.env.CONFIG_DIR,
      }).backgroundWorkWelfare).toEqual(DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG);
    }
    expect(existsSync(fixture.artifactsPath)).toBe(false);
  });

  it('can boot the canonical owner surface with autonomous initiation disabled', () => {
    fixture = createIcpCertificationFixture({
      autonomyEnabled: false,
      databaseUrl: 'postgres://certification:certification@127.0.0.1:5432/certification',
    });

    expect(loadSchedulerConfig(fixture.systemDataDir)).toMatchObject({
      icpAutonomy: { enabled: false },
    });
  });
});
