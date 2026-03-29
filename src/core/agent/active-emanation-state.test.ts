import { describe, expect, it } from 'vitest';
import {
  ActiveEmanationAuthority,
  resolveCanonicalEmbodimentContext,
  resolveCanonicalSatelliteContext,
} from './active-emanation-state.js';

const TEST_COMPANION_ID = 'companion-test';

describe('ActiveEmanationAuthority', () => {
  it('persists embodied presence for the active source when later requests omit embodiment details', () => {
    const authority = new ActiveEmanationAuthority();

    expect(authority.resolve({
      presence: {
        kind: 'embodiment',
        companionId: TEST_COMPANION_ID,
        siteId: 'ha-main',
        satelliteId: 'kitchen',
        embodimentId: 'display',
        channelPrivacy: 'private',
      },
    }, {
      sourceKey: 'conn-a:session-a',
    })).toEqual({
      presence: {
        kind: 'embodiment',
        companionId: TEST_COMPANION_ID,
        siteId: 'ha-main',
        satelliteId: 'kitchen',
        embodimentId: 'display',
        channelPrivacy: 'private',
        isPrimary: true,
      },
    });

    expect(authority.resolve({
      site_id: 'ha-main',
      satellite_id: 'kitchen',
    }, {
      sourceKey: 'conn-a:session-a',
    })).toEqual({
      presence: {
        kind: 'embodiment',
        companionId: TEST_COMPANION_ID,
        siteId: 'ha-main',
        satelliteId: 'kitchen',
        embodimentId: 'display',
        channelPrivacy: 'private',
        isPrimary: true,
      },
    });
  });

  it('rejects cross-embodiment moves until an explicit handoff is supplied', () => {
    const authority = new ActiveEmanationAuthority();

    authority.resolve({
      presence: {
        kind: 'embodiment',
        companionId: TEST_COMPANION_ID,
        embodimentId: 'display',
        satelliteId: 'kitchen',
        channelPrivacy: 'private',
      },
    }, {
      sourceKey: 'conn-a:session-a',
    });

    expect(authority.resolve({
      presence: {
        kind: 'embodiment',
        companionId: TEST_COMPANION_ID,
        embodimentId: 'speaker',
        satelliteId: 'office',
        channelPrivacy: 'semi_private',
      },
    }, {
      sourceKey: 'conn-b:session-b',
    })).toEqual({
      error: 'primary embodiment handoff required: display -> speaker',
    });
  });

  it('allows explicit handoff and restores primary embodiment state from snapshot', () => {
    const authority = new ActiveEmanationAuthority();

    authority.resolve({
      presence: {
        kind: 'embodiment',
        companionId: TEST_COMPANION_ID,
        embodimentId: 'display',
        satelliteId: 'kitchen',
        channelPrivacy: 'private',
      },
    }, {
      sourceKey: 'conn-a:session-a',
    });

    const handoff = authority.resolve({
      presence: {
        kind: 'emanation',
        companionId: TEST_COMPANION_ID,
        embodimentId: 'speaker',
        emanationId: 'speaker-voice',
        satelliteId: 'office',
        channelPrivacy: 'semi_private',
      },
    }, {
      sourceKey: 'conn-b:session-b',
      allowPrimaryEmbodimentHandoff: true,
      handoffFromEmbodimentId: 'display',
    });
    expect(resolveCanonicalEmbodimentContext(handoff.presence)).toEqual({
      kind: 'embodiment',
      companionId: TEST_COMPANION_ID,
      embodimentId: 'speaker',
      satelliteId: 'office',
      channelPrivacy: 'semi_private',
      isPrimary: true,
    });

    const snapshot = authority.captureSnapshot();
    const restored = new ActiveEmanationAuthority();
    expect(restored.restoreSnapshot(snapshot)).toEqual({
      presence: handoff.presence,
    });
    expect(restored.resolve(undefined, {
      sourceKey: 'conn-b:session-b',
    })).toEqual({
      presence: handoff.presence,
    });
  });

  it('preserves canonical satellite privacy metadata', () => {
    const authority = new ActiveEmanationAuthority();

    expect(authority.resolve({
      presence: {
        kind: 'satellite',
        companionId: TEST_COMPANION_ID,
        siteId: 'ha-main',
        satelliteId: 'office',
        channelId: 'api:wyoming:ha-main:office',
        channelPrivacy: 'private',
      },
    }, {
      sourceKey: 'conn-c:session-c',
    })).toEqual({
      presence: {
        kind: 'satellite',
        companionId: TEST_COMPANION_ID,
        siteId: 'ha-main',
        satelliteId: 'office',
        channelId: 'api:wyoming:ha-main:office',
        channelPrivacy: 'private',
      },
    });

    expect(resolveCanonicalSatelliteContext({
      kind: 'satellite',
      companionId: TEST_COMPANION_ID,
      siteId: 'ha-main',
      satelliteId: 'office',
      channelId: 'api:wyoming:ha-main:office',
      channelPrivacy: 'private',
    })).toEqual({
      kind: 'satellite',
      companionId: TEST_COMPANION_ID,
      siteId: 'ha-main',
      satelliteId: 'office',
      channelId: 'api:wyoming:ha-main:office',
      channelPrivacy: 'private',
    });
  });
});
