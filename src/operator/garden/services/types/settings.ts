import type { EditableSettings } from '../../../../system/settings.js';
import type {
  ChannelDeliveryStyle,
  ChannelEnvelopeLabel,
  ChannelPrivacy,
  ContactTrackingMode,
} from '../../../../system/trust/context-envelope.js';
import type { ChannelClassificationSource } from '../../../../system/trust/policy.js';
import type { CapabilityTierConfig } from '../../../../system/config/capability-tier-config.js';
import type { ChargePolicyConfig } from '../../../../system/config/charge-policy-config.js';
import type { SettingsContractData } from '../../../../system/config/settings-contract.js';
import type { BackupJsonConfig } from '../../../../system/config/backup-config.js';
import type { ModelsRuntimeConfig } from '../../../../system/config/models-config.js';
import type { ProvidersRuntimeConfig } from '../../../../system/config/providers-config.js';
import type { SchedulerRuntimeConfig } from '../../../../system/config/scheduler-config.js';
import type { SkillsRuntimeConfig } from '../../../../system/config/skills-config.js';
import type { TrustPolicyConfig } from '../../../../system/config/trust-policy-config.js';
import type { EnvInfo } from '../../types.js';

export interface SettingsConfigEditors {
  models: ModelsRuntimeConfig;
  providers: ProvidersRuntimeConfig;
  channels: Record<string, unknown>;
  skills: SkillsRuntimeConfig;
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  capabilities: CapabilityTierConfig;
  chargePolicy: ChargePolicyConfig;
  backup: BackupJsonConfig;
}

export interface AdminVoiceProviderOption {
  id: string;
  configured: boolean;
  requiredTokens: string[];
}

export interface AdminVoiceProviderData {
  stt: AdminVoiceProviderOption[];
  tts: AdminVoiceProviderOption[];
}

export type AdminSettingsStatusLevel = 'healthy' | 'degraded';

export interface AdminSettingsDivergence {
  key: 'models' | 'capabilities';
  state: 'diverged';
  detail: string;
  updatedAt: number;
}

export interface AdminSettingsStatus {
  status: AdminSettingsStatusLevel;
  detail: string;
  divergences: AdminSettingsDivergence[];
}

/**
 * Effective (startup-loaded) vs on-disk charge quota lanes. `restartRequired`
 * is true when the owner file on disk diverges from the quotas the running
 * process loaded at startup, so the operator knows a restart is needed before
 * an edit takes effect. `effectiveChargeQuotaByLane` is null when the runtime
 * has no loaded charge policy (e.g. Garden started without one).
 */
export interface EffectiveChargeQuotaState {
  effectiveChargeQuotaByLane: ChargePolicyConfig['runChargeQuotaByLane'] | null;
  onDiskChargeQuotaByLane: ChargePolicyConfig['runChargeQuotaByLane'];
  restartRequired: boolean;
}

export interface AdminSettingsData {
  config: EditableSettings;
  env: EnvInfo;
  editors: SettingsConfigEditors;
  voiceProviders: AdminVoiceProviderData;
  status: AdminSettingsStatus;
  effectiveChargeQuota: EffectiveChargeQuotaState;
}

export interface SettingsValidationError {
  field: string;
  message: string;
  code?: string;
}

export interface ConfigUpdateResult {
  ok: boolean;
  message: string;
  validationErrors?: SettingsValidationError[];
  status?: AdminSettingsStatus;
}

export interface AdminSettingsService {
  getSettingsData(): Promise<AdminSettingsData>;
  getSettingsContractData(): SettingsContractData;
  updateSettings(body: string): ConfigUpdateResult;
  getSubConfigJson(key: string): string | null;
  saveSubConfigJson(key: string, json: string): ConfigUpdateResult;
  getChannelEnvelopeData(): AdminChannelEnvelopeData;
  saveChannelEnvelopeLabel(channelId: string, label: unknown): ConfigUpdateResult;
}

/**
 * Garden channel list row (E3.2): the resolved Context Envelope classification
 * for one channel plus its owning source tier and review state.
 */
export interface AdminChannelEnvelopeRow {
  channelId: string;
  privacy: ChannelPrivacy;
  broadcast: boolean;
  contactTracking: ContactTrackingMode;
  /** Resolved delivery style (channel label or derived default; E3.3). */
  deliveryStyle: ChannelDeliveryStyle;
  deliveryStyleSource: 'channel_label' | 'derived_default';
  source: ChannelClassificationSource;
  /** Migration-seeded fail-closed label awaiting operator review (warning badge). */
  needsReview: boolean;
  /** True when channels.json carries an owned label for this channel. */
  hasLabel: boolean;
  label?: ChannelEnvelopeLabel;
}

export interface AdminChannelEnvelopeData {
  channels: AdminChannelEnvelopeRow[];
  /** Operator trust-policy prefix overrides (informational; tier 2). */
  prefixOverrides: Record<string, { privacy: ChannelPrivacy; broadcast: boolean }>;
  /** Demoted derived-default prefix heuristics (informational; tier 3). */
  privatePrefixes: string[];
  broadcastPrefixes: string[];
}
