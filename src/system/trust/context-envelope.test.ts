import { describe, expect, it } from 'vitest';
import {
  AUDIENCE_KNOWLEDGE_VALUES,
  AUDIENCE_SCOPE_VALUES,
  CHANNEL_PRIVACY_VALUES,
  CHANNEL_VISIBILITY_ENVELOPE_MIGRATION,
  CONTACT_TRACKING_MODES,
  DEFAULT_AUDIENCE_SCOPE_THRESHOLDS,
  DEFAULT_CHANNEL_PRIVACY,
  DEFAULT_CONTACT_TRACKING_MODE,
  assertContactTrackingModeImplemented,
  deriveAudienceKnowledge,
  deriveAudienceScope,
  deriveDefaultChannelPrivacy,
  isAudienceKnowledge,
  isAudienceScope,
  isChannelPrivacy,
  isContactTrackingMode,
  isContextEnvelope,
  normalizeChannelPrivacy,
  validateAudienceScopeThresholds,
  validateChannelEnvelopeLabel,
} from './context-envelope.js';
import { decodeStoredChannelVisibility } from './types.js';

describe('channelPrivacy vocabulary', () => {
  it('accepts exactly the three ratified privacy values', () => {
    expect(CHANNEL_PRIVACY_VALUES).toEqual(['private', 'invite_only', 'public']);
    for (const value of CHANNEL_PRIVACY_VALUES) {
      expect(isChannelPrivacy(value)).toBe(true);
    }
  });

  it('rejects the retired vocabulary with no alias', () => {
    expect(isChannelPrivacy('semi_private')).toBe(false);
    expect(isChannelPrivacy('broadcast')).toBe(false);
    expect(normalizeChannelPrivacy('semi_private')).toBeUndefined();
    expect(normalizeChannelPrivacy('broadcast')).toBeUndefined();
    expect(normalizeChannelPrivacy(42)).toBeUndefined();
  });

  it('derives private for DMs and invite_only otherwise', () => {
    expect(DEFAULT_CHANNEL_PRIVACY).toBe('invite_only');
    expect(deriveDefaultChannelPrivacy({ isDirectMessage: true })).toBe('private');
    expect(deriveDefaultChannelPrivacy({ isDirectMessage: false })).toBe('invite_only');
    expect(deriveDefaultChannelPrivacy({})).toBe('invite_only');
  });
});

describe('audienceScope derivation', () => {
  it('validates thresholds fail-closed', () => {
    expect(validateAudienceScopeThresholds({ fewMax: 10, manyMax: 100 }, 't')).toEqual({
      fewMax: 10,
      manyMax: 100,
    });
    expect(() => validateAudienceScopeThresholds({ fewMax: 0, manyMax: 100 }, 't')).toThrow(/fewMax/);
    expect(() => validateAudienceScopeThresholds({ fewMax: 10, manyMax: 10 }, 't')).toThrow(/manyMax/);
    expect(() => validateAudienceScopeThresholds({ fewMax: 2.5, manyMax: 10 }, 't')).toThrow(/fewMax/);
    expect(() => validateAudienceScopeThresholds({ fewMax: 2, manyMax: 10, junk: 1 }, 't')).toThrow(/unsupported keys/);
    expect(() => validateAudienceScopeThresholds([], 't')).toThrow(/object/);
    expect(() => validateAudienceScopeThresholds(null, 't')).toThrow(/object/);
  });

  it('classifies direct topology as one', () => {
    expect(deriveAudienceScope({ topology: 'direct' }, DEFAULT_AUDIENCE_SCOPE_THRESHOLDS)).toBe('one');
  });

  it('classifies bounded group rosters by config-owned thresholds', () => {
    const thresholds = DEFAULT_AUDIENCE_SCOPE_THRESHOLDS;
    expect(deriveAudienceScope({ topology: 'group', knownRosterSize: 2 }, thresholds)).toBe('few');
    expect(deriveAudienceScope({ topology: 'group', knownRosterSize: 10 }, thresholds)).toBe('few');
    expect(deriveAudienceScope({ topology: 'group', knownRosterSize: 11 }, thresholds)).toBe('many');
    expect(deriveAudienceScope({ topology: 'group', knownRosterSize: 100 }, thresholds)).toBe('many');
    expect(deriveAudienceScope({ topology: 'group', knownRosterSize: 101 }, thresholds)).toBe('unbounded');
  });

  it('fails closed to unbounded when the roster cannot be bounded', () => {
    expect(deriveAudienceScope({ topology: 'group' }, DEFAULT_AUDIENCE_SCOPE_THRESHOLDS)).toBe('unbounded');
  });

  it('rejects invalid roster sizes', () => {
    expect(() => deriveAudienceScope(
      { topology: 'group', knownRosterSize: -1 },
      DEFAULT_AUDIENCE_SCOPE_THRESHOLDS,
    )).toThrow(/knownRosterSize/);
    expect(() => deriveAudienceScope(
      { topology: 'group', knownRosterSize: 1.5 },
      DEFAULT_AUDIENCE_SCOPE_THRESHOLDS,
    )).toThrow(/knownRosterSize/);
  });

  it('exposes the ratified scope vocabulary', () => {
    expect(AUDIENCE_SCOPE_VALUES).toEqual(['one', 'few', 'many', 'unbounded']);
    expect(isAudienceScope('few')).toBe(true);
    expect(isAudienceScope('crowd')).toBe(false);
  });
});

describe('audienceKnowledge derivation', () => {
  it('derives from the resolvable-speaker fraction', () => {
    expect(deriveAudienceKnowledge({ recentSpeakerCount: 3, resolvedContactCount: 3 })).toBe('all_known');
    expect(deriveAudienceKnowledge({ recentSpeakerCount: 3, resolvedContactCount: 1 })).toBe('partially_known');
    expect(deriveAudienceKnowledge({ recentSpeakerCount: 3, resolvedContactCount: 0 })).toBe('anonymous');
  });

  it('fails closed to anonymous for an empty speaker window', () => {
    expect(deriveAudienceKnowledge({ recentSpeakerCount: 0, resolvedContactCount: 0 })).toBe('anonymous');
  });

  it('rejects incoherent counts', () => {
    expect(() => deriveAudienceKnowledge({ recentSpeakerCount: 1, resolvedContactCount: 2 })).toThrow(/exceed/);
    expect(() => deriveAudienceKnowledge({ recentSpeakerCount: -1, resolvedContactCount: 0 })).toThrow(/recentSpeakerCount/);
    expect(() => deriveAudienceKnowledge({ recentSpeakerCount: 1, resolvedContactCount: 0.5 })).toThrow(/resolvedContactCount/);
  });

  it('exposes the ratified knowledge vocabulary', () => {
    expect(AUDIENCE_KNOWLEDGE_VALUES).toEqual(['all_known', 'partially_known', 'anonymous']);
    expect(isAudienceKnowledge('all_known')).toBe(true);
    expect(isAudienceKnowledge('unknown')).toBe(false);
  });
});

describe('contactTracking modes', () => {
  it('validates the three modes with auto as default', () => {
    expect(CONTACT_TRACKING_MODES).toEqual(['auto', 'approval', 'role_gated']);
    expect(DEFAULT_CONTACT_TRACKING_MODE).toBe('auto');
    for (const mode of CONTACT_TRACKING_MODES) {
      expect(isContactTrackingMode(mode)).toBe(true);
    }
    expect(isContactTrackingMode('manual')).toBe(false);
  });

  it('fails closed when role_gated is activated before it is implemented', () => {
    expect(() => assertContactTrackingModeImplemented('role_gated')).toThrow(/reserved/);
    expect(() => assertContactTrackingModeImplemented('auto')).not.toThrow();
    expect(() => assertContactTrackingModeImplemented('approval')).not.toThrow();
  });
});

describe('ContextEnvelope shape', () => {
  it('recognizes a complete envelope', () => {
    expect(isContextEnvelope({
      channelPrivacy: 'invite_only',
      audienceScope: 'few',
      audienceKnowledge: 'all_known',
      broadcast: false,
    })).toBe(true);
  });

  it('rejects partial or mistyped envelopes', () => {
    expect(isContextEnvelope(null)).toBe(false);
    expect(isContextEnvelope({})).toBe(false);
    expect(isContextEnvelope({
      channelPrivacy: 'broadcast',
      audienceScope: 'few',
      audienceKnowledge: 'all_known',
      broadcast: true,
    })).toBe(false);
    expect(isContextEnvelope({
      channelPrivacy: 'public',
      audienceScope: 'few',
      audienceKnowledge: 'all_known',
      broadcast: 'yes',
    })).toBe(false);
  });
});

describe('channel envelope labels (channels.json contract)', () => {
  it('validates well-formed labels', () => {
    expect(validateChannelEnvelopeLabel(
      { privacy: 'invite_only', broadcast: false, contactTracking: 'auto' },
      'label',
    )).toEqual({ privacy: 'invite_only', broadcast: false, contactTracking: 'auto' });
    expect(validateChannelEnvelopeLabel({ privacy: 'public' }, 'label')).toEqual({ privacy: 'public' });
  });

  it('validates the channel-owned deliveryStyle field (E3.3)', () => {
    expect(validateChannelEnvelopeLabel({ deliveryStyle: 'concise' }, 'label'))
      .toEqual({ deliveryStyle: 'concise' });
    expect(validateChannelEnvelopeLabel({ privacy: 'private', deliveryStyle: 'expressive' }, 'label'))
      .toEqual({ privacy: 'private', deliveryStyle: 'expressive' });
    expect(() => validateChannelEnvelopeLabel({ deliveryStyle: 'verbose' }, 'label')).toThrow(/deliveryStyle/);
    expect(() => validateChannelEnvelopeLabel({ deliveryStyle: true }, 'label')).toThrow(/deliveryStyle/);
  });

  it('fails closed on retired vocabulary, unknown keys, and empty labels', () => {
    expect(() => validateChannelEnvelopeLabel({ privacy: 'semi_private' }, 'label')).toThrow(/privacy/);
    expect(() => validateChannelEnvelopeLabel({ privacy: 'broadcast' }, 'label')).toThrow(/privacy/);
    expect(() => validateChannelEnvelopeLabel({ broadcast: 'yes' }, 'label')).toThrow(/broadcast/);
    expect(() => validateChannelEnvelopeLabel({ contactTracking: 'manual' }, 'label')).toThrow(/contactTracking/);
    expect(() => validateChannelEnvelopeLabel({ visibility: 'private' }, 'label')).toThrow(/unsupported keys/);
    expect(() => validateChannelEnvelopeLabel({}, 'label')).toThrow(/at least one field/);
    expect(() => validateChannelEnvelopeLabel('private', 'label')).toThrow(/object/);
  });

  it('rejects labels pairing broadcast=true with a non-public privacy', () => {
    expect(() => validateChannelEnvelopeLabel({ privacy: 'private', broadcast: true }, 'label'))
      .toThrow(/always 'public'/);
    expect(() => validateChannelEnvelopeLabel({ privacy: 'invite_only', broadcast: true }, 'label'))
      .toThrow(/always 'public'/);
    expect(validateChannelEnvelopeLabel({ privacy: 'public', broadcast: true }, 'label'))
      .toEqual({ privacy: 'public', broadcast: true });
  });
});

describe('migration map and stored-vocabulary decoding', () => {
  it('maps every legacy visibility to the envelope pair', () => {
    // Keyed by LegacyChannelVisibility: the retired 4-value stored vocabulary.
    expect(Object.keys(CHANNEL_VISIBILITY_ENVELOPE_MIGRATION).sort())
      .toEqual(['broadcast', 'invite_only', 'private', 'public']);
    expect(CHANNEL_VISIBILITY_ENVELOPE_MIGRATION.private).toEqual({ channelPrivacy: 'private', broadcast: false });
    expect(CHANNEL_VISIBILITY_ENVELOPE_MIGRATION.invite_only).toEqual({ channelPrivacy: 'invite_only', broadcast: false });
    expect(CHANNEL_VISIBILITY_ENVELOPE_MIGRATION.public).toEqual({ channelPrivacy: 'public', broadcast: false });
    expect(CHANNEL_VISIBILITY_ENVELOPE_MIGRATION.broadcast).toEqual({ channelPrivacy: 'public', broadcast: true });
  });

  it('decodes persisted legacy vocabulary onto ChannelPrivacy, everything else strictly', () => {
    expect(decodeStoredChannelVisibility('semi_private')).toBe('invite_only');
    expect(decodeStoredChannelVisibility('broadcast')).toBe('public');
    expect(decodeStoredChannelVisibility('private')).toBe('private');
    expect(decodeStoredChannelVisibility('invite_only')).toBe('invite_only');
    expect(decodeStoredChannelVisibility('public')).toBe('public');
    expect(decodeStoredChannelVisibility('semi-private')).toBeUndefined();
    expect(decodeStoredChannelVisibility(undefined)).toBeUndefined();
    expect(decodeStoredChannelVisibility(42)).toBeUndefined();
  });
});
