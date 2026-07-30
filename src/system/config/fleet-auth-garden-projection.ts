import { createHash } from 'node:crypto';

export type FleetAuthGardenRole = 'owner' | 'admin' | 'member' | 'guest';
export type FleetAuthGardenKeyStatus = 'active' | 'retiring' | 'revoked';

interface FleetAuthGardenProjectionInput {
  schemaVersion: 1;
  activationGeneration: number;
  canonicalOrigin: string;
  callbackPath: string;
  provider: {
    kind: 'discord';
    scopes: readonly string[];
    tokenCustody: 'discard' | 'encrypted_refresh';
  };
  ttls: {
    oauthTransactionMs: number;
    sessionIdleMs: number;
    sessionAbsoluteMs: number;
    discordEvidenceMs: number;
    jitGrantMs: number;
    stepUpChallengeMs: number;
    internalAssertionMs: number;
  };
  rolePolicy: {
    disabledActionsByRole: Record<FleetAuthGardenRole, readonly string[]>;
  };
  accountRoster?: ReadonlyArray<{
    providerSubjectId: string;
    companionId: string;
    contactId?: string;
    role: FleetAuthGardenRole;
  }>;
  accountRosterSatisfiesStepUp?: boolean;
  discordEvidenceMappings: ReadonlyArray<{
    companionId: string;
    channelId?: string;
    requiredRoleIds: readonly string[];
  }>;
  verifierKeys: ReadonlyArray<{
    issuer: string;
    kid: string;
    notBefore: string;
    notAfter: string;
    status: FleetAuthGardenKeyStatus;
  }>;
  hubDeviceAssertions: {
    issuer: string;
    audience: string;
    maxTtlSeconds: number;
    clockSkewSeconds: number;
    keys: ReadonlyArray<{
      kid: string;
      notBefore: string;
      notAfter: string;
      status: FleetAuthGardenKeyStatus;
    }>;
  };
}

export interface FleetAuthConfigRevision {
  schemaVersion: 1;
  activationGeneration: number;
  canonicalSha256: string;
}

export interface FleetAuthGardenKeyMetadata {
  issuer?: string;
  kid: string;
  notBefore: string;
  notAfter: string;
  status: FleetAuthGardenKeyStatus;
}

/**
 * Bounded, non-secret projection of the canonical fleet-auth owner config.
 * Credential references, provider identifiers, public-key bytes, database
 * roles, recovery material, and Discord topology are deliberately absent.
 */
export interface FleetAuthGardenMetadata {
  enabled: true;
  featureMode: 'fleet-principal';
  revision: FleetAuthConfigRevision;
  canonicalOrigin: {
    value: string;
    status: 'configured_https';
  };
  callbackPath: string;
  providerPolicy: {
    kind: 'discord';
    scopes: string[];
    tokenCustody: 'discard' | 'encrypted_refresh';
  };
  ttls: FleetAuthGardenProjectionInput['ttls'];
  disabledActionsByRole: Record<FleetAuthGardenRole, string[]>;
  discordEvidence: {
    mappingCount: number;
    companionBindingCount: number;
    channelRestrictedMappingCount: number;
    roleRestrictedMappingCount: number;
    requiredRoleBindingCount: number;
  };
  verifierKeys: FleetAuthGardenKeyMetadata[];
  hubDeviceAssertions: {
    issuer: string;
    audience: string;
    maxTtlSeconds: number;
    clockSkewSeconds: number;
    keys: FleetAuthGardenKeyMetadata[];
  };
}

function canonicalRevision(config: FleetAuthGardenProjectionInput): FleetAuthConfigRevision {
  return {
    schemaVersion: config.schemaVersion,
    activationGeneration: config.activationGeneration,
    canonicalSha256: createHash('sha256')
      .update(JSON.stringify(config), 'utf8')
      .digest('hex'),
  };
}

export function projectFleetAuthGardenMetadata(
  config: FleetAuthGardenProjectionInput,
): FleetAuthGardenMetadata {
  const mappings = config.discordEvidenceMappings;
  return {
    enabled: true,
    featureMode: 'fleet-principal',
    revision: canonicalRevision(config),
    canonicalOrigin: {
      value: config.canonicalOrigin,
      status: 'configured_https',
    },
    callbackPath: config.callbackPath,
    providerPolicy: {
      kind: config.provider.kind,
      scopes: [...config.provider.scopes],
      tokenCustody: config.provider.tokenCustody,
    },
    ttls: { ...config.ttls },
    disabledActionsByRole: Object.fromEntries(
      Object.entries(config.rolePolicy.disabledActionsByRole)
        .map(([role, actions]) => [role, [...actions]]),
    ) as Record<FleetAuthGardenRole, string[]>,
    discordEvidence: {
      mappingCount: mappings.length,
      companionBindingCount: new Set(mappings.map(mapping => mapping.companionId)).size,
      channelRestrictedMappingCount: mappings.filter(mapping => mapping.channelId !== undefined).length,
      roleRestrictedMappingCount: mappings.filter(mapping => mapping.requiredRoleIds.length > 0).length,
      requiredRoleBindingCount: mappings.reduce(
        (count, mapping) => count + mapping.requiredRoleIds.length,
        0,
      ),
    },
    verifierKeys: config.verifierKeys.map(({ issuer, kid, notBefore, notAfter, status }) => ({
      issuer,
      kid,
      notBefore,
      notAfter,
      status,
    })),
    hubDeviceAssertions: {
      issuer: config.hubDeviceAssertions.issuer,
      audience: config.hubDeviceAssertions.audience,
      maxTtlSeconds: config.hubDeviceAssertions.maxTtlSeconds,
      clockSkewSeconds: config.hubDeviceAssertions.clockSkewSeconds,
      keys: config.hubDeviceAssertions.keys.map(({ kid, notBefore, notAfter, status }) => ({
        kid,
        notBefore,
        notAfter,
        status,
      })),
    },
  };
}
