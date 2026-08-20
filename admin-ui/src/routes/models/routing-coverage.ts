import type { CanonicalProviderRegistry } from '$lib/types';
import {
  CANONICAL_PURPOSES,
  type CanonicalModelPurpose,
  type ModelRegistryEntry,
} from '$lib/models/registry';
import { providerIsEnabled } from '$lib/providers/registry';

export type PurposeRoutingStatus =
  | 'ready'
  | 'missing_primary'
  | 'conflicting_primaries'
  | 'model_unset'
  | 'provider_missing'
  | 'provider_disabled';

export interface PurposeRoutingCoverage {
  purpose: CanonicalModelPurpose;
  status: PurposeRoutingStatus;
  primaryCount: number;
  detail: string;
  actionHref: '#selected-model-detail' | '#models-registry' | '#models-providers';
  actionLabel: string;
  modelId?: string;
}

export function derivePurposeRoutingCoverage(
  models: readonly ModelRegistryEntry[],
  providers: CanonicalProviderRegistry,
): PurposeRoutingCoverage[] {
  const providersById = new Map(providers.providers.map(provider => [provider.id, provider]));
  return CANONICAL_PURPOSES.map((purpose) => {
    const primaries = models.filter(
      model => model.enabled !== false
        && model.purposes.some(tag => tag.purpose === purpose && tag.primary === true),
    );
    if (primaries.length === 0) {
      return {
        purpose,
        status: 'missing_primary',
        primaryCount: 0,
        detail: 'No enabled primary model is assigned.',
        actionHref: '#models-registry',
        actionLabel: 'Assign primary',
      };
    }
    if (primaries.length > 1) {
      return {
        purpose,
        status: 'conflicting_primaries',
        primaryCount: primaries.length,
        detail: `${primaries.length} enabled primaries conflict.`,
        actionHref: '#models-registry',
        actionLabel: 'Resolve conflict',
      };
    }

    const primary = primaries[0]!;
    if (!primary.identity.model.trim()) {
      return {
        purpose,
        status: 'model_unset',
        primaryCount: 1,
        detail: `${primary.id} has no model slug.`,
        actionHref: '#models-registry',
        actionLabel: 'Set model',
        modelId: primary.id,
      };
    }
    const provider = providersById.get(primary.identity.provider);
    if (!provider) {
      return {
        purpose,
        status: 'provider_missing',
        primaryCount: 1,
        detail: `${primary.id} references unregistered provider ${primary.identity.provider || 'unset'}.`,
        actionHref: '#models-providers',
        actionLabel: 'Add provider',
        modelId: primary.id,
      };
    }
    if (!providerIsEnabled(provider)) {
      return {
        purpose,
        status: 'provider_disabled',
        primaryCount: 1,
        detail: `${primary.id} routes through disabled provider ${provider.id}.`,
        actionHref: '#models-providers',
        actionLabel: 'Enable provider',
        modelId: primary.id,
      };
    }
    return {
      purpose,
      status: 'ready',
      primaryCount: 1,
      detail: `${primary.id} · ${provider.id} · ${primary.identity.model}`,
      actionHref: '#selected-model-detail',
      actionLabel: 'Inspect route',
      modelId: primary.id,
    };
  });
}
