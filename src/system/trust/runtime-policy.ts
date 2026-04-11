import type { TrustPolicyConfig } from '../config/trust-policy-config.js';

const DEFAULT_POLICY: TrustPolicyConfig = {
  trustCeiling: {
    primary: ['public', 'personal', 'intimate', 'confidential'],
    trusted: ['public', 'personal'],
    regular: ['public'],
    public: ['public'],
  },
  visibilityAllowed: {
    private: ['public', 'personal', 'intimate', 'confidential'],
    semi_private: ['public', 'personal'],
    public: ['public'],
    broadcast: ['public'],
  },
  channelClassification: {
    privatePrefixes: ['api:', 'sillytavern:', 'openwebui:', 'subagent:', 'shard:', 'internal:'],
    broadcastPrefixes: ['twitter:', 'social:'],
    defaultVisibility: 'semi_private',
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
