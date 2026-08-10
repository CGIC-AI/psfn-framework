import { describe, expect, it } from 'vitest';

import { SETTINGS_GARDEN_FIELD_EXPOSURE } from '../../shared/contracts/settings-garden-contract.js';
import { normalizeEditableSettings, RUNTIME_SETTINGS_KEYS } from '../settings.js';
import { resolveSettingsDomainForField } from './settings-domain-registry.js';
import {
  createDefaultBiographicalDepthPolicy,
  normalizeBiographicalDepthPolicy,
} from './biographical-depth-policy.js';

describe('biographical depth owner setting', () => {
  it('pins the versioned default and keeps full retention unbounded', () => {
    const policy = createDefaultBiographicalDepthPolicy();
    expect(normalizeBiographicalDepthPolicy(policy)).toEqual(policy);
    expect(policy.schemaVersion).toBe(1);
    expect(policy.recognition.retentionClaimLimit).toBeTypeOf('number');
    expect(policy.developing.retentionClaimLimit).toBeTypeOf('number');
    expect(policy.full.retentionClaimLimit).toBeNull();
    for (const depth of ['recognition', 'developing', 'full'] as const) {
      expect(policy[depth].candidateLimitPerRefresh).toBeGreaterThan(0);
      expect(policy[depth].refreshIntervalMs).toBeGreaterThan(0);
      expect(policy[depth].operationClaimLimit).toBeGreaterThan(0);
      expect(policy[depth].turnClaimLimit).toBeGreaterThan(0);
    }
  });

  it('rejects unknown fields, unsupported versions and a product cap at full depth', () => {
    const policy = createDefaultBiographicalDepthPolicy();
    expect(() => normalizeBiographicalDepthPolicy({ ...policy, notes: 'free-form' })).toThrow(/exact versioned/);
    expect(() => normalizeBiographicalDepthPolicy({ ...policy, schemaVersion: 2 })).toThrow(/expected 1/);
    expect(() => normalizeBiographicalDepthPolicy({
      ...policy,
      full: { ...policy.full, retentionClaimLimit: 100 },
    })).toThrow(/full depth must be null/);
  });

  it('is normalized through settings.json and exposed in Garden memory settings', () => {
    const policy = createDefaultBiographicalDepthPolicy();
    expect(normalizeEditableSettings({ biographicalDepthPolicy: policy }))
      .toEqual({ biographicalDepthPolicy: policy });
    expect(RUNTIME_SETTINGS_KEYS).toContain('biographicalDepthPolicy');
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE.biographicalDepthPolicy).toEqual({
      sectionId: 'memory',
      surface: 'advanced',
    });
    expect(resolveSettingsDomainForField('biographicalDepthPolicy')).toBe('memory');
  });
});
