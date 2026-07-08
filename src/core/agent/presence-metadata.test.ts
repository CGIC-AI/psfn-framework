import { describe, expect, it } from 'vitest';
import {
  buildEmanationPresenceMetadata,
  buildEmbodimentPresenceMetadata,
  buildSatellitePresenceMetadata,
  normalizePresenceMetadata,
  resolvePresenceMetadataResult,
  resolvePresenceSubjectId,
} from './presence-metadata.js';
import {
  resolveCanonicalEmbodimentContext,
  resolveCanonicalSatelliteContext,
} from './active-emanation-state.js';

const TEST_COMPANION_ID = 'companion-test';

describe('presence metadata contract', () => {
  it('builds canonical satellite, embodiment, and emanation metadata records', () => {
    expect(buildSatellitePresenceMetadata({
      siteId: 'ha-main',
      satelliteId: 'kitchen',
      companionId: TEST_COMPANION_ID,
      channelPrivacy: 'private',
      isPrimary: true,
    })).toEqual({
      kind: 'satellite',
      siteId: 'ha-main',
      satelliteId: 'kitchen',
      companionId: TEST_COMPANION_ID,
      channelPrivacy: 'private',
      isPrimary: true,
    });

    expect(buildEmbodimentPresenceMetadata({
      siteId: 'ha-main',
      embodimentId: 'display',
      satelliteId: 'kitchen',
      companionId: TEST_COMPANION_ID,
      channelPrivacy: 'invite_only',
    })).toEqual({
      kind: 'embodiment',
      siteId: 'ha-main',
      embodimentId: 'display',
      satelliteId: 'kitchen',
      companionId: TEST_COMPANION_ID,
      channelPrivacy: 'invite_only',
    });

    expect(buildEmanationPresenceMetadata({
      siteId: 'ha-main',
      emanationId: 'voice-node',
      embodimentId: 'display',
      satelliteId: 'kitchen',
      companionId: TEST_COMPANION_ID,
      channelPrivacy: 'broadcast',
    })).toEqual({
      kind: 'emanation',
      siteId: 'ha-main',
      emanationId: 'voice-node',
      embodimentId: 'display',
      satelliteId: 'kitchen',
      companionId: TEST_COMPANION_ID,
      channelPrivacy: 'broadcast',
    });
  });

  it('normalizes legacy presence records and resolves their canonical subject ids', () => {
    const normalized = normalizePresenceMetadata({
      presence: {
        kind: 'emanation',
        siteId: 'ha-main',
        emanationId: 'voice-node',
        embodimentId: 'display',
        satelliteId: 'kitchen',
        companionId: TEST_COMPANION_ID,
        channelPrivacy: 'private',
      },
    });

    expect(normalized).toEqual({
      kind: 'emanation',
      siteId: 'ha-main',
      emanationId: 'voice-node',
      embodimentId: 'display',
      satelliteId: 'kitchen',
      companionId: TEST_COMPANION_ID,
      channelPrivacy: 'private',
      isActive: true,
    });
    expect(resolvePresenceSubjectId(normalized)).toBe('voice-node');
  });

  it('rejects conflicting active presence flags', () => {
    expect(resolvePresenceMetadataResult({
      presence: {
        kind: 'embodiment',
        embodimentId: 'display',
        companionId: TEST_COMPANION_ID,
        isActive: true,
      },
    })).toEqual({
      error: 'conflicting active emanation metadata',
    });
  });

  it('derives canonical embodiment context from active emanation state', () => {
    expect(resolveCanonicalEmbodimentContext({
      kind: 'emanation',
      emanationId: 'voice-node',
      embodimentId: 'display',
      siteId: 'ha-main',
      satelliteId: 'kitchen',
      channelId: 'api:wyoming:ha-main:display',
      channelPrivacy: 'private',
      companionId: TEST_COMPANION_ID,
    })).toEqual({
      kind: 'embodiment',
      embodimentId: 'display',
      siteId: 'ha-main',
      satelliteId: 'kitchen',
      channelId: 'api:wyoming:ha-main:display',
      channelPrivacy: 'private',
      companionId: TEST_COMPANION_ID,
      isPrimary: true,
    });
  });

  it('derives canonical satellite context from active emanation state', () => {
    expect(resolveCanonicalSatelliteContext({
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
