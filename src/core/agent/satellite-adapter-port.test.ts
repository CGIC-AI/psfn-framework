import { describe, expect, it } from 'vitest';
import { createActiveEmanationSatellitePresencePort } from './satellite-adapter-port.js';

const TEST_COMPANION_ID = 'companion-test';

describe('createActiveEmanationSatellitePresencePort', () => {
  it('resolves canonical embodiment context from active emanation metadata', () => {
    const presencePort = createActiveEmanationSatellitePresencePort();

    expect(presencePort.resolveCanonicalEmbodiment({
      kind: 'emanation',
      emanationId: 'voice-node',
      embodimentId: 'display',
      satelliteId: 'kitchen',
      siteId: 'ha-main',
      channelId: 'api:wyoming:ha-main:display',
      channelPrivacy: 'private',
      companionId: TEST_COMPANION_ID,
    })).toEqual({
      kind: 'embodiment',
      embodimentId: 'display',
      satelliteId: 'kitchen',
      siteId: 'ha-main',
      channelId: 'api:wyoming:ha-main:display',
      channelPrivacy: 'private',
      companionId: TEST_COMPANION_ID,
      isPrimary: true,
    });
  });

  it('resolves canonical satellite context from satellite presence metadata', () => {
    const presencePort = createActiveEmanationSatellitePresencePort();

    expect(presencePort.resolveCanonicalSatellite({
      kind: 'satellite',
      satelliteId: 'kitchen',
      siteId: 'ha-main',
      channelId: 'api:wyoming:ha-main:kitchen',
      channelPrivacy: 'private',
      companionId: TEST_COMPANION_ID,
    })).toEqual({
      kind: 'satellite',
      satelliteId: 'kitchen',
      siteId: 'ha-main',
      channelId: 'api:wyoming:ha-main:kitchen',
      channelPrivacy: 'private',
      companionId: TEST_COMPANION_ID,
    });
  });
});
