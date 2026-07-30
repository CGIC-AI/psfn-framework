import type {
  FleetAuthConfig,
  FleetAuthVerifierConfig,
} from '../../../system/config/fleet-auth-config.js';
import { projectFleetAuthGardenMetadata } from '../../../system/config/fleet-auth-garden-projection.js';
import type {
  EffectiveFleetAuthOwnerProjection,
  FleetAuthOwnerSnapshot,
} from './types/settings.js';

export function buildEffectiveFleetAuthOwnerProjection(options: {
  effectiveGatewayConfig?: FleetAuthConfig;
  effectiveVerifierConfig?: FleetAuthVerifierConfig;
  loadOnDisk: () => FleetAuthConfig | null;
  reportUnavailable?: (error: unknown) => void;
}): EffectiveFleetAuthOwnerProjection {
  const base = {
    ownerFile: 'fleet-auth.json' as const,
    scope: 'global' as const,
    access: {
      mode: 'read_only' as const,
      editableFields: [] as [],
      omittedCategories: [
        'credential references',
        'provider identifiers, subjects, and contact bindings',
        'private and public key material',
        'database roles and credentials',
        'private Discord guild/channel/role topology',
        'recovery material',
      ],
    },
    provenance: {
      parser: 'validateFleetAuthConfig' as const,
      effectiveSource: 'startup_runtime' as const,
      onDiskSource: 'canonical_owner_file' as const,
    },
  };

  let onDisk: FleetAuthOwnerSnapshot;
  try {
    const loaded = options.loadOnDisk();
    if (loaded) {
      const value = projectFleetAuthGardenMetadata(loaded);
      onDisk = {
        state: 'loaded',
        revision: { ...value.revision },
        value,
      };
    } else {
      onDisk = {
        state: 'absent',
        detail: 'fleet-auth.json is absent from the canonical system owner root.',
      };
    }
  } catch (error) {
    options.reportUnavailable?.(error);
    onDisk = {
      state: 'unavailable',
      detail: 'fleet-auth.json is present but unavailable or invalid; inspect runtime logs.',
    };
  }

  const runtimeEnabled = options.effectiveGatewayConfig !== undefined
    || options.effectiveVerifierConfig !== undefined;
  const effectiveValue = options.effectiveGatewayConfig
    ? projectFleetAuthGardenMetadata(options.effectiveGatewayConfig)
    : options.effectiveVerifierConfig?.gardenMetadata;
  const effective: FleetAuthOwnerSnapshot = effectiveValue
    ? {
        state: 'loaded',
        revision: { ...effectiveValue.revision },
        value: structuredClone(effectiveValue),
      }
    : runtimeEnabled
      ? {
          state: 'unavailable',
          detail: 'Fleet auth is enabled but its startup Garden projection is unavailable.',
        }
      : {
          state: 'off',
          detail: 'Fleet auth was disabled when this process started.',
        };

  if (!runtimeEnabled && onDisk.state === 'absent') {
    return {
      ...base,
      featureState: 'off',
      status: 'off',
      effective,
      onDisk,
      restartRequired: false,
      restartStatus: 'not_required',
    };
  }
  if (!runtimeEnabled) {
    return {
      ...base,
      featureState: 'off',
      status: 'unavailable',
      effective,
      onDisk,
      restartRequired: true,
      restartStatus: 'blocked',
    };
  }
  if (effective.state !== 'loaded') {
    return {
      ...base,
      featureState: 'unavailable',
      status: 'unavailable',
      effective,
      onDisk,
      restartRequired: null,
      restartStatus: 'unknown',
    };
  }
  if (onDisk.state !== 'loaded') {
    return {
      ...base,
      featureState: 'enabled',
      status: 'unavailable',
      effective,
      onDisk,
      restartRequired: true,
      restartStatus: 'blocked',
    };
  }

  const restartRequired = effective.revision.canonicalSha256
    !== onDisk.revision.canonicalSha256;
  return {
    ...base,
    featureState: 'enabled',
    status: restartRequired ? 'restart_required' : 'healthy',
    effective,
    onDisk,
    restartRequired,
    restartStatus: restartRequired ? 'required' : 'not_required',
  };
}
