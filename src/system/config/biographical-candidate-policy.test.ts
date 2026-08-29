import { describe, expect, it } from 'vitest';

import { SETTINGS_GARDEN_FIELD_EXPOSURE } from '../../shared/contracts/settings-garden-contract.js';
import { normalizeEditableSettings, RUNTIME_SETTINGS_KEYS } from '../settings.js';
import {
  createDefaultBiographicalCandidatePolicy,
  normalizeBiographicalCandidatePolicy,
} from './biographical-candidate-policy.js';
import { resolveSettingsDomainForField } from './settings-domain-registry.js';

describe('biographical candidate owner policy', () => {
  it('loads the privacy-preserving canonical defaults', () => {
    expect(createDefaultBiographicalCandidatePolicy()).toMatchObject({
      admittedSourceTypes: ['semantic', 'episodic', 'reflection', 'relational'],
      maximumSourceSensitivity: 'personal',
      excludedLifecycleStates: [
        'quarantined',
        'tombstoned',
        'cogsec_blocked',
        'revoked',
        'superseded',
      ],
      companionOnlyAutoactivation: {
        enabled: true,
        scopes: ['companion_self'],
        maximumSensitivity: 'personal',
      },
    });
  });

  it.each([
    { name: 'unknown source type', patch: { admittedSourceTypes: ['semantic', 'invented'] } },
    { name: 'unknown sensitivity', patch: { maximumSourceSensitivity: 'secret' } },
    { name: 'missing lifecycle exclusion', patch: { excludedLifecycleStates: ['quarantined'] } },
    { name: 'unknown review trigger', patch: { reviewTriggers: ['model_decides'] } },
    { name: 'unknown projection scope', patch: { projectionScopes: ['ambient_room_member'] } },
  ])('fails closed for $name', ({ patch }) => {
    const valid = createDefaultBiographicalCandidatePolicy();
    expect(() => normalizeBiographicalCandidatePolicy({ ...valid, ...patch }))
      .toThrow(/Invalid settings at biographicalCandidatePolicy/u);
  });

  it('is a canonical settings.json owner field exposed read-only in Garden', () => {
    const policy = createDefaultBiographicalCandidatePolicy();
    expect(normalizeEditableSettings({ biographicalCandidatePolicy: policy }))
      .toEqual({ biographicalCandidatePolicy: policy });
    expect(RUNTIME_SETTINGS_KEYS).toContain('biographicalCandidatePolicy');
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE.biographicalCandidatePolicy).toEqual({
      sectionId: 'memory',
      surface: 'advanced',
    });
    expect(resolveSettingsDomainForField('biographicalCandidatePolicy')).toBe('memory');
  });
});
