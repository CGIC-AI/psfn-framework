import { describe, expect, it } from 'vitest';
import {
  ActiveEmanationAuthority,
  resolveCanonicalEmbodimentContext,
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
});
