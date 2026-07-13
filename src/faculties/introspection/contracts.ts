export const INTROSPECTION_CONSENT_SCHEMA_VERSION = 1 as const;

export type IntrospectionDivergenceType = 'affective' | 'substantive';

export interface CompanionConsentActor {
  kind: 'companion';
  turnId: string;
  requestId: string;
}

export interface IntrospectionConsentRevision {
  schemaVersion: typeof INTROSPECTION_CONSENT_SCHEMA_VERSION;
  revision: number;
  enabled: boolean;
  allowedPublicChannelIds: string[];
  actor: CompanionConsentActor;
  reason: string;
  createdAt: string;
  previousHash: string | null;
  hash: string;
}

export interface UnconfiguredIntrospectionConsentPolicy {
  status: 'unconfigured';
  enabled: false;
  allowedPublicChannelIds: [];
}

export type IntrospectionConsentPolicy =
  | IntrospectionConsentRevision
  | UnconfiguredIntrospectionConsentPolicy;

