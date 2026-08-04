import type { EditableSettings } from '../../../../system/settings.js';
import type {
  ChannelClassificationEpoch,
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
import type {
  IntakePolicyConfig,
  IntakeSourceListName,
  IntakeSourceListsConfig,
} from '../../../../system/config/intake-policy-config.js';
import type { EnvInfo } from '../../types.js';
import type {
  FleetAuthConfigRevision,
  FleetAuthGardenMetadata,
} from '../../../../system/config/fleet-auth-garden-projection.js';

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

/** Startup-loaded scheduler cadence compared with the canonical owner file. */
export interface EffectiveBackgroundMaintenanceState {
  ownerFile: 'scheduler.json';
  effectiveIntervalMs: number | null;
  onDiskIntervalMs: number;
  restartRequired: boolean;
}

export interface IcpAutonomyChargeOwnerProjection {
  companionSocialQuota: number;
  companionSocialContinuationCost: number;
  fatigue: ChargePolicyConfig['fatigue'];
  costBreaker: ChargePolicyConfig['icpCostBreaker'];
}

export interface EffectiveIcpAutonomySettingsState {
  scheduler: {
    ownerFile: 'scheduler.json';
    effectiveValue: SchedulerRuntimeConfig['icpAutonomy'] | null;
    onDiskValue: SchedulerRuntimeConfig['icpAutonomy'];
    restartRequired: boolean;
  };
  chargePolicy: {
    ownerFile: 'charge-policy.json';
    effectiveValue: IcpAutonomyChargeOwnerProjection | null;
    onDiskValue: IcpAutonomyChargeOwnerProjection;
    restartRequired: boolean;
  };
}

export interface LoadedFleetAuthOwnerSnapshot {
  state: 'loaded';
  revision: FleetAuthConfigRevision;
  value: FleetAuthGardenMetadata;
}

export interface UnloadedFleetAuthOwnerSnapshot {
  state: 'off' | 'absent' | 'unavailable';
  detail: string;
}

export type FleetAuthOwnerSnapshot =
  | LoadedFleetAuthOwnerSnapshot
  | UnloadedFleetAuthOwnerSnapshot;

export interface EffectiveModelSelectionView {
  purpose: 'chat';
  source: 'companion_selection' | 'fleet_default';
  slotKey?: string;
  provider: string;
  model: string;
}

export interface EffectiveModelSelectionProjection {
  chat: EffectiveModelSelectionView | null;
}

export interface EffectiveFleetAuthOwnerProjection {
  ownerFile: 'fleet-auth.json';
  scope: 'global';
  access: {
    mode: 'read_only';
    editableFields: [];
    omittedCategories: string[];
  };
  featureState: 'enabled' | 'off' | 'unavailable';
  status: 'healthy' | 'restart_required' | 'off' | 'unavailable';
  effective: FleetAuthOwnerSnapshot;
  onDisk: FleetAuthOwnerSnapshot;
  restartRequired: boolean | null;
  restartStatus: 'not_required' | 'required' | 'blocked' | 'unknown';
  provenance: {
    parser: 'validateFleetAuthConfig';
    effectiveSource: 'startup_runtime';
    onDiskSource: 'canonical_owner_file';
  };
}

export interface AdminSettingsData {
  config: EditableSettings;
  env: EnvInfo;
  editors: SettingsConfigEditors;
  effectiveModelSelection: EffectiveModelSelectionProjection;
  voiceProviders: AdminVoiceProviderData;
  status: AdminSettingsStatus;
  effectiveChargeQuota: EffectiveChargeQuotaState;
  effectiveBackgroundMaintenance: EffectiveBackgroundMaintenanceState;
  effectiveIcpAutonomy: EffectiveIcpAutonomySettingsState;
  fleetAuth: EffectiveFleetAuthOwnerProjection;
  workspaceLayout?: {
    mode: 'single' | 'fleet';
    personalWorkspacePath: string | null;
    sharedWorkspacePath: string | null;
    companionSharedAccess: 'none' | 'read_only';
    executableAutoLoad: false;
    promptAutoLoad: false;
  };
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

/**
 * One registered companion the operator may pin the Bearer API to (vknn). The
 * inbound OpenAI-compatible Bearer API is pinned to exactly one companion via
 * channels.json `api.companionId`; callers never select per request.
 */
export interface BearerApiCompanionOption {
  companionId: string;
  displayName: string;
}

/**
 * Companion Cluster view of the Bearer API pinned-companion setting (vknn): the
 * currently pinned companion plus the registered-companion roster an operator
 * may pin to.
 */
export interface BearerApiCompanionPinData {
  /** Currently pinned companion id, or null when unset (single-companion default). */
  pinnedCompanionId: string | null;
  /** Registered companions the operator may pin. */
  companions: BearerApiCompanionOption[];
  /**
   * The API channel resolves the pin once at gateway startup (api-surface builds
   * the Bearer routing contract from channels.json `api.companionId`), so a pin
   * change takes effect only after a gateway restart. There is no hot reload.
   */
  restartRequired: true;
}

/** One add/remove mutation against the intake-policy source lists (htm9.13). */
export interface AdminIntakeSourceListMutationInput {
  action: 'add' | 'remove';
  list: IntakeSourceListName;
  pattern: string;
  note?: string;
}

export interface AdminSettingsService {
  getSettingsData(context?: import('../../garden-request-context.js').GardenRequestContext): Promise<AdminSettingsData>;
  getSettingsContractData(context?: import('../../garden-request-context.js').GardenRequestContext): SettingsContractData;
  updateSettings(
    body: string,
    context?: import('../../garden-request-context.js').GardenRequestContext,
  ): Promise<ConfigUpdateResult>;
  getSubConfigJson(key: string, context?: import('../../garden-request-context.js').GardenRequestContext): string | null;
  saveSubConfigJson(
    key: string,
    json: string,
    context?: import('../../garden-request-context.js').GardenRequestContext,
  ): Promise<ConfigUpdateResult>;
  getChannelEnvelopeData(): AdminChannelEnvelopeData;
  saveChannelEnvelopeLabel(channelId: string, label: unknown): Promise<ConfigUpdateResult>;
  /**
   * Companion Cluster (vknn): read the Bearer API pinned companion and the
   * registered-companion roster the operator may pin.
   */
  getBearerApiCompanionPin(): BearerApiCompanionPinData;
  /**
   * Companion Cluster (vknn): pin the inbound OpenAI-compatible Bearer API to
   * exactly one registered companion, persisted through the channels.json
   * owner-file contract. Fails closed when the id is not a registered companion.
   * This is a single pin, never per-request companion selection.
   */
  setBearerApiCompanionPin(companionId: unknown): Promise<ConfigUpdateResult>;
  /**
   * Read the invite-only → public click-to-accept demotion notice for a channel
   * (jp36.6.2). Reports whether the channel is currently demotable so the Garden
   * UI can gate the accept affordance; the notice text itself is static.
   */
  getChannelDemotionNotice(channelId: string): AdminChannelDemotionNotice;
  /**
   * Accept the invite-only → public demotion for a channel (jp36.6.2). Blocked
   * unless the operator acknowledges the current notice version; on success it
   * atomically stamps `classificationSource: 'operator_confirmed'` and records
   * the operator-signed classification epoch. This is the ONLY write path for
   * the operator_confirmed marker.
   */
  acceptChannelDemotion(input: AdminChannelDemotionAcceptInput): Promise<AdminChannelDemotionResult>;
  /** Intake-policy source lists (htm9.13); the htm9.11 Garden tab builds on these. */
  getIntakeSourceLists(context?: import('../../garden-request-context.js').GardenRequestContext): IntakeSourceListsConfig;
  mutateIntakeSourceList(
    input: AdminIntakeSourceListMutationInput,
    context?: import('../../garden-request-context.js').GardenRequestContext,
  ): Promise<ConfigUpdateResult>;
  /**
   * Read-only typed view of intake-policy.json (mode, tiers, thresholds,
   * quarantine limits, sink gates) for the Garden Cognitive Security firewall
   * page (htm9.11). Mutations go through the owner-file editor / source-list
   * routes, never through this read.
   */
  getIntakePolicyOverview(context?: import('../../garden-request-context.js').GardenRequestContext): IntakePolicyConfig;
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
  /**
   * Operator-signed invite-only → public classification-epoch boundaries
   * (jp36.6), newest first. Queryable audit surface for the demotion flow.
   */
  epochs: ChannelClassificationEpoch[];
}

/** Click-to-accept demotion notice for a channel (jp36.6.2). */
export interface AdminChannelDemotionNotice {
  channelId: string;
  /** Current resolved classification (must be invite_only to be demotable). */
  currentPrivacy: ChannelPrivacy;
  from: 'invite_only';
  to: 'public';
  /** True only when the channel currently resolves to invite_only (non-broadcast). */
  demotable: boolean;
  /** Human-readable reason when not demotable. */
  reason?: string;
  notice: string;
  noticeVersion: string;
}

/** Operator acceptance of an invite-only → public demotion (jp36.6.2). */
export interface AdminChannelDemotionAcceptInput {
  channelId: string;
  /** Operator-acknowledged notice version; must match the current version. */
  acknowledgedNoticeVersion: unknown;
  /** Actor attribution for the epoch record; defaults to 'operator'. */
  actor?: string;
}

export interface AdminChannelDemotionResult extends ConfigUpdateResult {
  epoch?: ChannelClassificationEpoch;
  data?: AdminChannelEnvelopeData;
}
