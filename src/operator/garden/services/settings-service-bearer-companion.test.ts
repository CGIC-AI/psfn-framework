// vknn — Companion Cluster Bearer API pin: roster read, fail-closed validation,
// and channels.json owner-file round-trip (the API channel reads api.companionId
// once at gateway startup, so the pin change is restart-required, not hot-reloaded).

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnerFileConfigStore } from '../../../system/config/config-store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { AdminSettingsDataService } from './settings-service.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_UNKNOWN = '33333333-3333-4333-8333-333333333333';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-bearer-companion-service-'));
  return tempDir;
}

function buildFleetService(root: string): AdminSettingsDataService {
  const config = {
    dataDir: root,
    defaultContextWindow: 128_000,
    companionFleet: {
      companions: [
        { companionId: COMPANION_A, displayName: 'Aria' },
        { companionId: COMPANION_B, displayName: 'Bex' },
      ],
    },
  } as unknown as SubstrateConfig;
  return new AdminSettingsDataService({
    config,
    configStore: createOwnerFileConfigStore({ dataDir: root, defaultContextWindow: 128_000 }),
  });
}

function buildSingleService(root: string): AdminSettingsDataService {
  const config = {
    dataDir: root,
    defaultContextWindow: 128_000,
    companionId: COMPANION_A,
    characterName: 'Aria',
  } as unknown as SubstrateConfig;
  return new AdminSettingsDataService({
    config,
    configStore: createOwnerFileConfigStore({ dataDir: root, defaultContextWindow: 128_000 }),
  });
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('AdminSettingsDataService Bearer API companion pin (vknn)', () => {
  it('reports no pin and the full roster when channels.json has no api section', () => {
    const root = makeTempDir();
    const pin = buildFleetService(root).getBearerApiCompanionPin();
    expect(pin).toEqual({
      pinnedCompanionId: null,
      companions: [
        { companionId: COMPANION_A, displayName: 'Aria' },
        { companionId: COMPANION_B, displayName: 'Bex' },
      ],
      restartRequired: true,
    });
    // fail-closed: nothing persisted by a read
    expect(existsSync(join(root, 'channels.json'))).toBe(false);
  });

  it('falls back to the single configured companion when there is no fleet', () => {
    const root = makeTempDir();
    const pin = buildSingleService(root).getBearerApiCompanionPin();
    expect(pin.companions).toEqual([{
      companionId: COMPANION_A,
      displayName: 'Aria',
    }]);
  });

  it('rejects a companion id that is not a registered companion (fail closed)', async () => {
    const root = makeTempDir();
    const service = buildFleetService(root);
    const result = await service.setBearerApiCompanionPin(COMPANION_UNKNOWN);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('is not a registered companion');
    // no partial write
    expect(existsSync(join(root, 'channels.json'))).toBe(false);
    expect(service.getBearerApiCompanionPin().pinnedCompanionId).toBeNull();
  });

  it('rejects a missing or non-string companion id', async () => {
    const root = makeTempDir();
    const service = buildFleetService(root);
    expect((await service.setBearerApiCompanionPin('')).ok).toBe(false);
    expect((await service.setBearerApiCompanionPin(undefined)).ok).toBe(false);
    expect((await service.setBearerApiCompanionPin(42)).ok).toBe(false);
  });

  it('pins a registered companion through the channels.json owner-file and round-trips', async () => {
    const root = makeTempDir();
    const service = buildFleetService(root);

    const result = await service.setBearerApiCompanionPin(COMPANION_B);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Bex');
    expect(result.message).not.toContain(COMPANION_B);
    expect(result.message).toContain('Restart the gateway');

    // persisted to the owner file under api.companionId
    const persisted = JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8'));
    expect(persisted.api.companionId).toBe(COMPANION_B);

    // round-trips through the read path
    expect(service.getBearerApiCompanionPin().pinnedCompanionId).toBe(COMPANION_B);

    // re-pin overwrites cleanly
    expect((await service.setBearerApiCompanionPin(COMPANION_A)).ok).toBe(true);
    expect(service.getBearerApiCompanionPin().pinnedCompanionId).toBe(COMPANION_A);
  });

  it('preserves unrelated channels.json sections when writing the pin', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'channels.json'), JSON.stringify({
      contextEnvelope: {
        channels: { 'discord:friends-room': { privacy: 'invite_only', contactTracking: 'approval' } },
      },
    }, null, 2));

    const service = buildFleetService(root);
    expect((await service.setBearerApiCompanionPin(COMPANION_A)).ok).toBe(true);

    const persisted = JSON.parse(readFileSync(join(root, 'channels.json'), 'utf8'));
    expect(persisted.api.companionId).toBe(COMPANION_A);
    expect(persisted.contextEnvelope.channels['discord:friends-room']).toEqual({
      privacy: 'invite_only',
      contactTracking: 'approval',
    });
  });
});
