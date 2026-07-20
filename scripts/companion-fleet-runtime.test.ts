import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfiguredLocalCompanionFleetRuntime } from './companion-fleet-runtime.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

describe('local companion fleet runtime', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fleetEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-local-fleet-runtime-'));
    tempDirs.push(runtimeRoot);
    const systemDataDir = join(runtimeRoot, 'system-data');
    const companionDataDir = join(runtimeRoot, 'companion-data');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify({
      companions: [
        {
          companionId: COMPANION_A,
          companionDataDir: 'companions/a',
          characterCardPath: 'companions/a/character-card.json',
          postgresSchema: 'companion_a',
        },
        {
          companionId: COMPANION_B,
          companionDataDir: 'companions/b',
          characterCardPath: 'companions/b/character-card.json',
          postgresSchema: 'companion_b',
        },
      ],
    })}\n`);
    return {
      PSFN_MULTI_COMPANION: '1',
      PSFN_FLEET_AUTH: '1',
      PSFN_RUNTIME_ROOT: runtimeRoot,
      SYSTEM_DATA_DIR: systemDataDir,
      COMPANION_DATA_DIR: companionDataDir,
      ADMIN_TRANSPORT_SOCKET: join(runtimeRoot, 'run', 'garden-admin.sock'),
      ...overrides,
    };
  }

  it('builds a complete immutable registry from canonical companion IDs', () => {
    const runtime = resolveConfiguredLocalCompanionFleetRuntime(fleetEnv());
    expect(runtime?.targetRegistry.companionIds()).toEqual([COMPANION_A, COMPANION_B]);
    expect(runtime?.targetRegistry.resolve(COMPANION_A).endpoint).toMatchObject({
      mode: 'socket',
      socketPath: expect.stringMatching(
        new RegExp(`garden-admin-${COMPANION_A}\\.sock$`, 'u'),
      ),
    });
    expect(runtime?.targetRegistry.resolve(COMPANION_B).endpoint).toMatchObject({
      mode: 'socket',
      socketPath: expect.stringMatching(
        new RegExp(`garden-admin-${COMPANION_B}\\.sock$`, 'u'),
      ),
    });
  });

  it('rejects local network transport before any launch plan is emitted', () => {
    expect(() => resolveConfiguredLocalCompanionFleetRuntime(fleetEnv({
      ADMIN_TRANSPORT_MODE: 'network',
    }))).toThrow(/local startup requires ADMIN_TRANSPORT_MODE=socket/u);
  });

  it('rejects a fleet Garden without Fleet Auth before any launch plan is emitted', () => {
    expect(() => resolveConfiguredLocalCompanionFleetRuntime(fleetEnv({
      PSFN_FLEET_AUTH: '0',
    }))).toThrow(/requires PSFN_FLEET_AUTH=1/u);
  });
});
