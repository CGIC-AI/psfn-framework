import { describe, expect, it } from 'vitest';
import {
  buildEmanationPresenceMetadata,
  buildEmbodimentPresenceMetadata,
  buildSatellitePresenceMetadata,
  normalizePresenceMetadata,
  resolvePresenceMetadataResult,
  resolvePresenceSubjectId,
} from './presence-metadata.js';
import { resolveCanonicalEmbodimentContext } from './active-emanation-state.js';

describe('presence metadata contract', () => {
  it('builds canonical satellite, embodiment, and emanation metadata records', () => {
    expect(buildSatellitePresenceMetadata({
      siteId: 'ha-main',
      satelliteId: 'kitchen',
      isPrimary: true,
    })).toEqual({
      kind: 'satellite',
      siteId: 'ha-main',
      satelliteId: 'kitchen',
      isPrimary: true,
    });

    expect(buildEmbodimentPresenceMetadata({
      siteId: 'ha-main',
      embodimentId: 'display',
      satelliteId: 'kitchen',
    })).toEqual({
      kind: 'embodiment',
      siteId: 'ha-main',
      embodimentId: 'display',
      satelliteId: 'kitchen',
    });

    expect(buildEmanationPresenceMetadata({
      siteId: 'ha-main',
      emanationId: 'voice-node',
      embodimentId: 'display',
      satelliteId: 'kitchen',
    })).toEqual({
      kind: 'emanation',
      siteId: 'ha-main',
      emanationId: 'voice-node',
      embodimentId: 'display',
      satelliteId: 'kitchen',
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
      },
    });

    expect(normalized).toEqual({
      kind: 'emanation',
      siteId: 'ha-main',
      emanationId: 'voice-node',
      embodimentId: 'display',
      satelliteId: 'kitchen',
      isActive: true,
    });
    expect(resolvePresenceSubjectId(normalized)).toBe('voice-node');
  });

  it('rejects conflicting active presence flags', () => {
    expect(resolvePresenceMetadataResult({
      presence: {
        kind: 'embodiment',
        embodimentId: 'display',
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
    })).toEqual({
      kind: 'embodiment',
      embodimentId: 'display',
      siteId: 'ha-main',
      satelliteId: 'kitchen',
      channelId: 'api:wyoming:ha-main:display',
      isPrimary: true,
    });
  });
});
