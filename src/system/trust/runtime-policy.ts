import type { TrustPolicyConfig } from '../config/trust-policy-config.js';
import {
  DEFAULT_AUDIENCE_SCOPE_THRESHOLDS,
  DEFAULT_PARTICIPANT_RELATIONSHIP_CONFIDENCE_THRESHOLD,
} from './context-envelope.js';

const DEFAULT_POLICY: TrustPolicyConfig = {
  trustCeiling: {
    primary: ['public', 'personal', 'intimate', 'confidential'],
    trusted: ['public', 'personal'],
    regular: ['public', 'personal'],
    public: ['public'],
  },
  visibilityAllowed: {
    private: ['public', 'personal', 'intimate', 'confidential'],
    invite_only: ['public', 'personal'],
    public: ['public'],
  },
  audienceScopeThresholds: DEFAULT_AUDIENCE_SCOPE_THRESHOLDS,
  participantRelationshipConfidenceThreshold: DEFAULT_PARTICIPANT_RELATIONSHIP_CONFIDENCE_THRESHOLD,
  channelClassification: {
    privatePrefixes: ['api:', 'sillytavern:', 'openwebui:', 'subagent:', 'shard:', 'internal:'],
    broadcastPrefixes: ['twitter:', 'social:'],
    defaultVisibility: 'invite_only',
    visibilityOverrides: {
      exact: {},
      prefix: {},
    },
  },
};

let activePolicy: TrustPolicyConfig = DEFAULT_POLICY;

export function getRuntimeTrustPolicy(): TrustPolicyConfig {
  return activePolicy;
}

export function setRuntimeTrustPolicy(policy: TrustPolicyConfig): void {
  activePolicy = policy;
}

export function resetRuntimeTrustPolicy(): void {
  activePolicy = DEFAULT_POLICY;
}

export function getDefaultTrustPolicy(): TrustPolicyConfig {
  return DEFAULT_POLICY;
}
