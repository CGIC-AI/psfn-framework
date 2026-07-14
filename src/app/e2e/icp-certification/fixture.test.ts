import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAgentConfig } from '../../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../../system/config/runtime-config.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
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
    expect(configA).toMatchObject({
      multiCompanion: true,
      companionId: CERTIFICATION_COMPANION_A,
      postgresSchema: CERTIFICATION_SCHEMA_A,
      persistenceBackend: 'postgres',
    });
    expect(configB).toMatchObject({
      multiCompanion: true,
      companionId: CERTIFICATION_COMPANION_B,
      postgresSchema: CERTIFICATION_SCHEMA_B,
      persistenceBackend: 'postgres',
    });
    expect(configA.companionDataDir).not.toBe(configB.companionDataDir);
    expect(configA.workspacePath).not.toBe(configB.workspacePath);
    expect(configA.companionFleet?.companions).toHaveLength(2);
    expect(configA.chargePolicy?.icpCostBreaker).toMatchObject({
      enabled: true,
      hardLimitUsd: 0.0004,
    });
    expect(existsSync(fixture.artifactsPath)).toBe(false);
  });
});
