import {
  DEFAULT_SELFIE_EDIT_MODEL_CHAIN,
  type FalEditModel,
  type ImageOperationSettingsDefaults,
  type ImageProviderPreference,
} from './types.js';

export function resolveImageToolProvider(
  settingsDefaults: ImageOperationSettingsDefaults,
  explicitProvider: ImageProviderPreference | undefined,
  explicitModel: string | undefined,
  configuredModel: string | undefined,
): ImageProviderPreference | undefined {
  if (explicitProvider !== undefined) {
    return explicitProvider;
  }
  if (explicitModel?.trim()) {
    return 'fal';
  }
  if (settingsDefaults.provider !== undefined) {
    return settingsDefaults.provider;
  }
  return configuredModel ? 'fal' : undefined;
}

export function resolveSelfieEditModelChain(
  explicitModel: FalEditModel | undefined,
  configuredModel: FalEditModel | undefined,
): readonly FalEditModel[] {
  if (!explicitModel) {
    return configuredModel ? [configuredModel] : DEFAULT_SELFIE_EDIT_MODEL_CHAIN;
  }
  const startIndex = (DEFAULT_SELFIE_EDIT_MODEL_CHAIN as readonly string[])
    .indexOf(explicitModel);
  if (startIndex >= 0) {
    return DEFAULT_SELFIE_EDIT_MODEL_CHAIN.slice(startIndex);
  }
  // Off-chain explicit selection keeps the legacy fallback posture without
  // reintroducing the strictest first tier.
  return [
    explicitModel,
    ...DEFAULT_SELFIE_EDIT_MODEL_CHAIN
      .slice(1)
      .filter((model) => model !== explicitModel),
  ];
}
