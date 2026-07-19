import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ChannelPrivacyLevel as CanonicalChannelPrivacyLevel,
  Contact as CanonicalContact,
  RelationshipType as CanonicalRelationshipType,
  SocialGraphEntitySource as CanonicalSocialGraphEntitySource,
  SocialRelationshipKind as CanonicalSocialRelationshipKind,
} from '../../../../src/core/contacts/types.js';
import type {
  CanonicalModelRegistry as RuntimeCanonicalModelRegistry,
  ModelRegistryBudgetPolicy as RuntimeModelRegistryBudgetPolicy,
  ModelRegistryCapabilityMetadata as RuntimeModelRegistryCapabilityMetadata,
  ModelRegistryCostMetadata as RuntimeModelRegistryCostMetadata,
  ModelRegistryEntry as RuntimeModelRegistryEntry,
  ModelRegistryIdentityMetadata as RuntimeModelRegistryIdentityMetadata,
  ModelRegistryPurposeTag as RuntimeModelRegistryPurposeTag,
  ModelRegistrySourceMetadata as RuntimeModelRegistrySourceMetadata,
  ModelRegistryTuningMetadata as RuntimeModelRegistryTuningMetadata,
} from '../../../../src/shared/contracts/runtime.js';
import type { TrustLevel as CanonicalTrustLevel } from '../../../../src/system/trust/types.js';
import type {
  CanonicalModelRegistry,
  ModelRegistryBudgetPolicy,
  ModelRegistryCapabilityMetadata,
  ModelRegistryCostMetadata,
  ModelRegistryEntry,
  ModelRegistryIdentityMetadata,
  ModelRegistryPurposeTag,
  ModelRegistrySourceMetadata,
  ModelRegistryTuningMetadata,
} from '../models/registry.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  RelationshipType,
  SocialGraphEntitySource,
  SocialRelationshipKind,
  TrustLevel,
} from './index.js';

describe('admin canonical type aliases', () => {
  it('keeps contact and trust types identical to their backend contracts', () => {
    expectTypeOf<Contact>().toEqualTypeOf<CanonicalContact>();
    expectTypeOf<ChannelPrivacyLevel>().toEqualTypeOf<CanonicalChannelPrivacyLevel>();
    expectTypeOf<RelationshipType>().toEqualTypeOf<CanonicalRelationshipType>();
    expectTypeOf<SocialGraphEntitySource>().toEqualTypeOf<CanonicalSocialGraphEntitySource>();
    expectTypeOf<SocialRelationshipKind>().toEqualTypeOf<CanonicalSocialRelationshipKind>();
    expectTypeOf<TrustLevel>().toEqualTypeOf<CanonicalTrustLevel>();

    expect(true).toBe(true);
  });

  it('keeps the model registry cluster identical to its backend contracts', () => {
    expectTypeOf<CanonicalModelRegistry>().toEqualTypeOf<RuntimeCanonicalModelRegistry>();
    expectTypeOf<ModelRegistryBudgetPolicy>().toEqualTypeOf<RuntimeModelRegistryBudgetPolicy>();
    expectTypeOf<ModelRegistryCapabilityMetadata>().toEqualTypeOf<RuntimeModelRegistryCapabilityMetadata>();
    expectTypeOf<ModelRegistryCostMetadata>().toEqualTypeOf<RuntimeModelRegistryCostMetadata>();
    expectTypeOf<ModelRegistryEntry>().toEqualTypeOf<RuntimeModelRegistryEntry>();
    expectTypeOf<ModelRegistryIdentityMetadata>().toEqualTypeOf<RuntimeModelRegistryIdentityMetadata>();
    expectTypeOf<ModelRegistryPurposeTag>().toEqualTypeOf<RuntimeModelRegistryPurposeTag>();
    expectTypeOf<ModelRegistrySourceMetadata>().toEqualTypeOf<RuntimeModelRegistrySourceMetadata>();
    expectTypeOf<ModelRegistryTuningMetadata>().toEqualTypeOf<RuntimeModelRegistryTuningMetadata>();

    expect(true).toBe(true);
  });

  it('rejects retired privacy and non-canonical model registry fields', () => {
    // @ts-expect-error broadcast is an envelope flag, not a channel privacy level.
    const retiredPrivacy: ChannelPrivacyLevel = 'broadcast';
    const canonicalEntry: ModelRegistryEntry = {
      id: 'primary',
      rank: 10,
      identity: {
        provider: 'openrouter',
        model: 'example/model',
        source: { type: 'openrouter' },
      },
      purposes: [{ purpose: 'chat', primary: true }],
      // @ts-expect-error routing belongs to projected ModelCatalogEntry, not ModelRegistryEntry.
      routing: { providerOrder: ['openrouter'] },
    };

    expect(retiredPrivacy).toBe('broadcast');
    expect(canonicalEntry).toHaveProperty('routing');
  });
});
