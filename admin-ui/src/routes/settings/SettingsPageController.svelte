<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { base } from '$app/paths';
  import {
    getSettings,
    getSettingsSchema,
    updateSettings,
    getSubConfig,
    saveSubConfig,
  } from '$lib/api/endpoints/settings';
  import type {
    AdminSettingsData,
    CanonicalProviderRegistry,
    ProviderRegistryEntry,
    ConfigUpdateResult,
    SettingsContractData,
    SettingsContractField,
  } from '$lib/types';
  import { SETTINGS_GARDEN_SECTION_FIELDS } from '$lib/settings-garden-contract';
  import {
    resolveBudgetContextWindowAuthority,
    resolveSettingAuthority,
  } from '$lib/settings/authority';
  import SettingsAdvancedOwnerPanels from './SettingsAdvancedOwnerPanels.svelte';
  import SettingsEnvironmentSummary from '$lib/components/settings/SettingsEnvironmentSummary.svelte';
  import SettingsPageChrome from '$lib/components/settings/SettingsPageChrome.svelte';
  import SettingsSidebarNav from '$lib/components/settings/SettingsSidebarNav.svelte';
  import SettingsSimplePanels from './SettingsSimplePanels.svelte';
  import {
    buildSettingsSimpleSectionGroups,
    isSettingsSimpleSectionId,
    parseSettingsSimpleSectionHash,
    resolveActiveSettingsSimpleSection,
    settingsSimpleSectionAnchorId,
    type SettingsSimpleSectionId,
  } from '$lib/components/settings/navigation';
  import { buildContextBudgetPreview } from '$lib/settings/context-budget-preview';
  import {
    normalizeProvidersRuntimeConfig,
  } from '$lib/providers/registry';
  import {
    appendProviderEntry,
    cloneProviderRegistry,
    providerRegistryIsDirty,
    removeProviderEntry as removeProviderRegistryEntry,
    serializeProviderRegistry,
    setProviderField as setProviderRegistryField,
    setProviderType as setProviderRegistryType,
    type ProviderEditableField,
    updateProviderEntry as updateProviderRegistryEntry,
    validateProviderRegistry,
  } from '$lib/providers/editor';
  import {
    COMPOSITIONAL_CHANNEL_TYPE_OPTIONS,
    COMPOSITIONAL_PURPOSE_OPTIONS,
    COMPOSITIONAL_TIER_OPTIONS,
    DELEGATED_WORKSPACES,
    DISABLED_PROVIDER_ID,
    RAW_EDITORS,
    SIMPLE_SECTION_ORDER,
    SYSTEM_PROMPT_ESTIMATE_TOKENS,
    buildAdvancedSettingsSections,
    buildBackupSettingsPayload,
    buildCapabilitiesSettingsPayload,
    buildRawEditorJsonMap,
    buildSettingsSnapshot,
    collectSimpleSettingsPayload,
    formatSettingOptionLabel,
    humanizeSettingValue,
    listDirtyRawEditorKeys,
    normalizeStringList,
    parseBackupSettings,
    populateSimpleSettingsForm,
    resolveRawEditorOwnerFile,
    syncCuratedSettingsField,
    summarizeCompositionalPolicy,
    tryPrettyPrint,
    type CapabilitiesEditorConfig,
    type CompositionalListKey,
    type CompositionalPolicyFormValue,
    type ModelsEditorConfig,
    type RawEditorKey,
    type SchedulerEditorConfig,
    type SettingsSimpleFormState,
  } from './settings-page-helpers';

  // ── Core state ──
  let data = $state<AdminSettingsData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let saving = $state(false);
  let saveMessage = $state('');
  let saveOk = $state(true);
  let settingsSchema = $state<SettingsContractData | null>(null);
  let providerRegistry = $state<CanonicalProviderRegistry>({ schemaVersion: 1, providers: [] });
  let providerRegistryInitialJson = $state('{"schemaVersion":1,"providers":[]}');
  let providerValidationErrors = $state<string[]>([]);

  // ── Dirty tracking ──
  let initialSnapshot = $state('');
  let initialAdvancedSnapshot = $state('');
  let dirty = $state(false);
  let curatedDirty = $state(false);
  let advancedDirty = $state(false);
  let rawDirty = $state(false);
  let generalSettingsSaveDirty = $derived(curatedDirty || rawDirty);

  let initialRawJsonByKey = $state<Record<RawEditorKey, string>>(
    buildRawEditorJsonMap(() => ''),
  );

  function computeSnapshot(): string {
    return buildSettingsSnapshot({
      state: currentSimpleFormState(),
      compositionalPolicy: configValue('compositionalPolicy') ?? null,
      providerRegistry,
    });
  }

  function computeAdvancedSnapshot(): string {
    return JSON.stringify(data?.config ?? null);
  }

  $effect(() => {
    if (initialSnapshot) {
      curatedDirty = computeSnapshot() !== initialSnapshot;
      advancedDirty = initialAdvancedSnapshot !== '' && computeAdvancedSnapshot() !== initialAdvancedSnapshot;
      rawDirty = dirtyRawEditorKeys().length > 0;
      dirty = curatedDirty || advancedDirty || rawDirty;
    }
  });

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (dirty) {
      e.preventDefault();
    }
  }

  // ── Curated workspace fields ──
  let sessionRestartBehavior = $state<'reuse_latest_session' | 'new_session'>('reuse_latest_session');
  let sessionHistoryBudgetPct = $state(6);
  let memoryRetrievalBudgetPct = $state(2);
  let extractionThresholdPct = $state(30);
  let compactionThresholdPct = $state(70);
  let maxResponseTokens = $state(4096);
  let retryMaxAttempts = $state(3);

  // ── Import processing ──
  let importRouteMode = $state('background');
  let importStrictPolicy = $state(false);
  let importLocalEndpointUrl = $state('');
  let importLocalModel = $state('');
  let openRouterProviderOrder = $state('');

  // ── Gateway web fetch ──
  let webFetchAllowHttp = $state(false);
  let webFetchDomainAllowlist = $state('');
  let webFetchAllowInternalNetwork = $state(false);
  let webFetchTlsCaCertPaths = $state('');

  // ── Voice / TTS ──
  let ttsProvider = $state('disabled');
  let voiceId = $state('');
  let echoTtsUrl = $state('');
  let echoTtsVoice = $state('');
  let echoTtsPreset = $state('');
  let sttProvider = $state('disabled');
  let deepgramModel = $state('');

  // ── External Obsidian Bridge ──
  let obsidianVaultName = $state('');
  let obsidianCliPath = $state('obsidian');
  let obsidianAutoPublish = $state(false);
  let obsidianTimeoutMs = $state(10000);

  // ── Channels ──
  let discordTriggerWords = $state('');
  let discordTriggerReactions = $state('👆');
  let discordTriggerListenWindowSeconds = $state(120);
  let telegramEnabled = $state(false);
  let telegramAuthorizedUsers = $state('');

  // ── Capability tier ──
  let capabilityTier = $state('apprentice');
  let capabilityCustomTokens = $state('');

  // ── LLM retries ──
  let retryBaseDelayMs = $state(2000);

  // ── Memory & Extraction ──
  let extractionInterval = $state(5);
  let compactionEmotionalSalienceThresholdPct = $state(75);
  let maintenanceIntervalMs = $state(300000);

  // ── Memory Extraction Tuning ──
  let memoryExtractionMinImportance = $state(0.3);
  let memoryExtractionMinConfidence = $state(0.4);
  let memoryExtractionMinNovelty = $state(0.1);
  let memoryExtractionMaxWrites = $state(20);
  let memoryExtractionTelemetryEnabled = $state(true);
  let memoryRetrievalTelemetryEnabled = $state(true);

  // ── Profile Synthesis ──
  let profileSynthesisEnabled = $state(true);
  let profileSynthesisRefreshIntervalMs = $state(3600000);
  let profileSynthesisCooldownMs = $state(300000);
  let profileSynthesisMinWrites = $state(1);
  let profileSynthesisMinImportance = $state(0.65);
  let profileSynthesisMinConfidence = $state(0.7);
  let profileSynthesisMinNovelty = $state(0.12);
  let profileSynthesisSourceMemoryLimit = $state(16);
  let profileSynthesisMinSourceMemories = $state(2);

  // ── Analysis Workbench ──
  let analysisWorkbenchMaxTokens = $state(76000);
  let analysisWorkbenchMaxWallTimeMs = $state(300000);
  let analysisWorkbenchMaxSubQueries = $state(12);

  // ── Raw editor states ──
  let modelsJson = $state('');
  let providersJson = $state('');
  let channelsJson = $state('');
  let skillsJson = $state('');
  let schedulerJson = $state('');
  let trustPolicyJson = $state('');
  let capabilitiesJson = $state('');
  let chargePolicyJson = $state('');
  let backupJson = $state('');
  let settingsJson = $state('');

  // ── Backup form fields ──
  let backupIntervalHours = $state(12);
  let backupMaxRotating = $state(9);
  let backupMaxWeekly = $state(2);
  let backupMaxMonthly = $state(1);
  let backupMirrorDir = $state('');
  let backupVerifyRestore = $state(true);
  let rawSaveStatus = $state<Record<string, { ok: boolean; msg: string }>>({});
  let validationErrorsByField = $state<Record<string, string[]>>({});

  function currentSimpleFormState(): SettingsSimpleFormState {
    return {
      sessionRestartBehavior,
      sessionHistoryBudgetPct,
      memoryRetrievalBudgetPct,
      extractionThresholdPct,
      compactionThresholdPct,
      maxResponseTokens,
      retryMaxAttempts,
      retryBaseDelayMs,
      importRouteMode,
      importStrictPolicy,
      importLocalEndpointUrl,
      importLocalModel,
      openRouterProviderOrder,
      webFetchAllowHttp,
      webFetchDomainAllowlist,
      webFetchAllowInternalNetwork,
      webFetchTlsCaCertPaths,
      capabilityTier,
      capabilityCustomTokens,
      extractionInterval,
      compactionEmotionalSalienceThresholdPct,
      maintenanceIntervalMs,
      memoryExtractionMinImportance,
      memoryExtractionMinConfidence,
      memoryExtractionMinNovelty,
      memoryExtractionMaxWrites,
      memoryExtractionTelemetryEnabled,
      memoryRetrievalTelemetryEnabled,
      profileSynthesisEnabled,
      profileSynthesisRefreshIntervalMs,
      profileSynthesisCooldownMs,
      profileSynthesisMinWrites,
      profileSynthesisMinImportance,
      profileSynthesisMinConfidence,
      profileSynthesisMinNovelty,
      profileSynthesisSourceMemoryLimit,
      profileSynthesisMinSourceMemories,
      analysisWorkbenchMaxTokens,
      analysisWorkbenchMaxWallTimeMs,
      analysisWorkbenchMaxSubQueries,
      ttsProvider,
      voiceId,
      echoTtsUrl,
      echoTtsVoice,
      echoTtsPreset,
      sttProvider,
      deepgramModel,
      obsidianVaultName,
      obsidianCliPath,
      obsidianAutoPublish,
      obsidianTimeoutMs,
      discordTriggerWords,
      discordTriggerReactions,
      discordTriggerListenWindowSeconds,
      telegramEnabled,
      telegramAuthorizedUsers,
      backupIntervalHours,
      backupMaxRotating,
      backupMaxWeekly,
      backupMaxMonthly,
      backupMirrorDir,
      backupVerifyRestore,
    };
  }

  function applySimpleFormState(next: Partial<SettingsSimpleFormState>): void {
    if (next.sessionRestartBehavior !== undefined) sessionRestartBehavior = next.sessionRestartBehavior;
    if (next.sessionHistoryBudgetPct !== undefined) sessionHistoryBudgetPct = next.sessionHistoryBudgetPct;
    if (next.memoryRetrievalBudgetPct !== undefined) memoryRetrievalBudgetPct = next.memoryRetrievalBudgetPct;
    if (next.extractionThresholdPct !== undefined) extractionThresholdPct = next.extractionThresholdPct;
    if (next.compactionThresholdPct !== undefined) compactionThresholdPct = next.compactionThresholdPct;
    if (next.maxResponseTokens !== undefined) maxResponseTokens = next.maxResponseTokens;
    if (next.retryMaxAttempts !== undefined) retryMaxAttempts = next.retryMaxAttempts;
    if (next.retryBaseDelayMs !== undefined) retryBaseDelayMs = next.retryBaseDelayMs;
    if (next.importRouteMode !== undefined) importRouteMode = next.importRouteMode;
    if (next.importStrictPolicy !== undefined) importStrictPolicy = next.importStrictPolicy;
    if (next.importLocalEndpointUrl !== undefined) importLocalEndpointUrl = next.importLocalEndpointUrl;
    if (next.importLocalModel !== undefined) importLocalModel = next.importLocalModel;
    if (next.openRouterProviderOrder !== undefined) openRouterProviderOrder = next.openRouterProviderOrder;
    if (next.webFetchAllowHttp !== undefined) webFetchAllowHttp = next.webFetchAllowHttp;
    if (next.webFetchDomainAllowlist !== undefined) webFetchDomainAllowlist = next.webFetchDomainAllowlist;
    if (next.webFetchAllowInternalNetwork !== undefined) webFetchAllowInternalNetwork = next.webFetchAllowInternalNetwork;
    if (next.webFetchTlsCaCertPaths !== undefined) webFetchTlsCaCertPaths = next.webFetchTlsCaCertPaths;
    if (next.capabilityTier !== undefined) capabilityTier = next.capabilityTier;
    if (next.capabilityCustomTokens !== undefined) capabilityCustomTokens = next.capabilityCustomTokens;
    if (next.extractionInterval !== undefined) extractionInterval = next.extractionInterval;
    if (next.compactionEmotionalSalienceThresholdPct !== undefined) compactionEmotionalSalienceThresholdPct = next.compactionEmotionalSalienceThresholdPct;
    if (next.maintenanceIntervalMs !== undefined) maintenanceIntervalMs = next.maintenanceIntervalMs;
    if (next.memoryExtractionMinImportance !== undefined) memoryExtractionMinImportance = next.memoryExtractionMinImportance;
    if (next.memoryExtractionMinConfidence !== undefined) memoryExtractionMinConfidence = next.memoryExtractionMinConfidence;
    if (next.memoryExtractionMinNovelty !== undefined) memoryExtractionMinNovelty = next.memoryExtractionMinNovelty;
    if (next.memoryExtractionMaxWrites !== undefined) memoryExtractionMaxWrites = next.memoryExtractionMaxWrites;
    if (next.memoryExtractionTelemetryEnabled !== undefined) memoryExtractionTelemetryEnabled = next.memoryExtractionTelemetryEnabled;
    if (next.memoryRetrievalTelemetryEnabled !== undefined) memoryRetrievalTelemetryEnabled = next.memoryRetrievalTelemetryEnabled;
    if (next.profileSynthesisEnabled !== undefined) profileSynthesisEnabled = next.profileSynthesisEnabled;
    if (next.profileSynthesisRefreshIntervalMs !== undefined) profileSynthesisRefreshIntervalMs = next.profileSynthesisRefreshIntervalMs;
    if (next.profileSynthesisCooldownMs !== undefined) profileSynthesisCooldownMs = next.profileSynthesisCooldownMs;
    if (next.profileSynthesisMinWrites !== undefined) profileSynthesisMinWrites = next.profileSynthesisMinWrites;
    if (next.profileSynthesisMinImportance !== undefined) profileSynthesisMinImportance = next.profileSynthesisMinImportance;
    if (next.profileSynthesisMinConfidence !== undefined) profileSynthesisMinConfidence = next.profileSynthesisMinConfidence;
    if (next.profileSynthesisMinNovelty !== undefined) profileSynthesisMinNovelty = next.profileSynthesisMinNovelty;
    if (next.profileSynthesisSourceMemoryLimit !== undefined) profileSynthesisSourceMemoryLimit = next.profileSynthesisSourceMemoryLimit;
    if (next.profileSynthesisMinSourceMemories !== undefined) profileSynthesisMinSourceMemories = next.profileSynthesisMinSourceMemories;
    if (next.analysisWorkbenchMaxTokens !== undefined) analysisWorkbenchMaxTokens = next.analysisWorkbenchMaxTokens;
    if (next.analysisWorkbenchMaxWallTimeMs !== undefined) analysisWorkbenchMaxWallTimeMs = next.analysisWorkbenchMaxWallTimeMs;
    if (next.analysisWorkbenchMaxSubQueries !== undefined) analysisWorkbenchMaxSubQueries = next.analysisWorkbenchMaxSubQueries;
    if (next.ttsProvider !== undefined) ttsProvider = next.ttsProvider;
    if (next.voiceId !== undefined) voiceId = next.voiceId;
    if (next.echoTtsUrl !== undefined) echoTtsUrl = next.echoTtsUrl;
    if (next.echoTtsVoice !== undefined) echoTtsVoice = next.echoTtsVoice;
    if (next.echoTtsPreset !== undefined) echoTtsPreset = next.echoTtsPreset;
    if (next.sttProvider !== undefined) sttProvider = next.sttProvider;
    if (next.deepgramModel !== undefined) deepgramModel = next.deepgramModel;
    if (next.obsidianVaultName !== undefined) obsidianVaultName = next.obsidianVaultName;
    if (next.obsidianCliPath !== undefined) obsidianCliPath = next.obsidianCliPath;
    if (next.obsidianAutoPublish !== undefined) obsidianAutoPublish = next.obsidianAutoPublish;
    if (next.obsidianTimeoutMs !== undefined) obsidianTimeoutMs = next.obsidianTimeoutMs;
    if (next.discordTriggerWords !== undefined) discordTriggerWords = next.discordTriggerWords;
    if (next.discordTriggerReactions !== undefined) discordTriggerReactions = next.discordTriggerReactions;
    if (next.discordTriggerListenWindowSeconds !== undefined) discordTriggerListenWindowSeconds = next.discordTriggerListenWindowSeconds;
    if (next.telegramEnabled !== undefined) telegramEnabled = next.telegramEnabled;
    if (next.telegramAuthorizedUsers !== undefined) telegramAuthorizedUsers = next.telegramAuthorizedUsers;
    if (next.backupIntervalHours !== undefined) backupIntervalHours = next.backupIntervalHours;
    if (next.backupMaxRotating !== undefined) backupMaxRotating = next.backupMaxRotating;
    if (next.backupMaxWeekly !== undefined) backupMaxWeekly = next.backupMaxWeekly;
    if (next.backupMaxMonthly !== undefined) backupMaxMonthly = next.backupMaxMonthly;
    if (next.backupMirrorDir !== undefined) backupMirrorDir = next.backupMirrorDir;
    if (next.backupVerifyRestore !== undefined) backupVerifyRestore = next.backupVerifyRestore;
  }

  // ── Section IA navigation ──
  const SIMPLE_SECTION_SCROLL_OFFSET_PX = 108;
  const SIMPLE_SECTION_ACTIVE_THRESHOLD_PX = 168;
  let activeSimpleSectionId = $state<SettingsSimpleSectionId>('models');
  const simpleSectionNodes = new Map<SettingsSimpleSectionId, HTMLElement>();
  let suppressSimpleSectionSyncUntil = 0;
  let simpleViewportChangeHandler: (() => void) | null = null;
  let simpleHashChangeHandler: (() => void) | null = null;

  let visibleSimpleSectionIds = $derived.by(() => {
    const ids = new Set<SettingsSimpleSectionId>(SIMPLE_SECTION_ORDER);
    if (!data?.env) {
      ids.delete('advanced-secrets');
    }
    return ids;
  });

  let simpleSectionGroups = $derived.by(() => (
    buildSettingsSimpleSectionGroups({ includeSections: visibleSimpleSectionIds })
  ));

  let simpleQuickJumpSections = $derived.by(() => (
    SIMPLE_SECTION_ORDER.filter((sectionId) => visibleSimpleSectionIds.has(sectionId))
  ));

  // ── Collapsible sections ──
  let openSections = $state(new Set<string>(['budget']));

  const MODEL_OWNED_FIELDS = new Set<string>(SETTINGS_GARDEN_SECTION_FIELDS.models);

  let SECTIONS = $derived.by(() => buildAdvancedSettingsSections({
    state: currentSimpleFormState(),
    compositionalPolicySummary: summarizeCompositionalPolicy(configValue('compositionalPolicy')),
  }));

  let advancedSectionSummaries = $derived.by(() => Object.fromEntries(
    SECTIONS.map((section) => [section.id, section.summary()]),
  ));

  function getSchedulerEditorConfig(): SchedulerEditorConfig {
    return (data?.editors?.scheduler as SchedulerEditorConfig | undefined) ?? {};
  }

  const EMPTY_MODELS_EDITOR_CONFIG: ModelsEditorConfig = {
    modelRoster: {},
  };

  function getCapabilitiesEditorConfig(): CapabilitiesEditorConfig {
    return (data?.editors?.capabilities as CapabilitiesEditorConfig | undefined) ?? {};
  }

  function getModelsEditorConfig(): ModelsEditorConfig {
    return (data?.editors?.models as ModelsEditorConfig | undefined) ?? EMPTY_MODELS_EDITOR_CONFIG;
  }

  function fieldErrors(field: string): string[] {
    const nestedPrefix = `${field}.`;
    const collected = new Set<string>();
    for (const [path, messages] of Object.entries(validationErrorsByField)) {
      if (path !== field && !path.startsWith(nestedPrefix)) continue;
      for (const message of messages) {
        collected.add(message);
      }
    }
    return [...collected];
  }

  function hasFieldErrors(field: string): boolean {
    return fieldErrors(field).length > 0;
  }

  function applyValidationErrors(result: ConfigUpdateResult): number {
    const next: Record<string, string[]> = {};
    for (const entry of result.validationErrors ?? []) {
      const field = entry.field?.trim();
      const message = entry.message?.trim();
      if (!field || !message) continue;
      const existing = next[field] ?? [];
      if (!existing.includes(message)) {
        existing.push(message);
      }
      next[field] = existing;
    }
    validationErrorsByField = next;

    const invalidFields = new Set(Object.keys(next).filter((field) => field !== '$root'));
    if (invalidFields.size > 0) {
      const invalidFieldList = [...invalidFields];
      const matchesField = (candidate: string, key: string): boolean => (
        candidate === key || candidate.startsWith(`${key}.`)
      );
      const nextOpenSections = new Set(openSections);
      for (const section of SECTIONS) {
        if (section.keys.some((key) => invalidFieldList.some((field) => matchesField(field, key)))) {
          nextOpenSections.add(section.id);
        }
      }
      const isCategorizedField = (field: string): boolean => (
        SECTIONS.some((section) => section.keys.some((key) => matchesField(field, key)))
      );
      if (invalidFieldList.some((field) => !isCategorizedField(field))) {
        nextOpenSections.add('other');
      }
      openSections = nextOpenSections;
    }

    return invalidFields.size;
  }

  // ── Source attribution ──
  function fieldContract(key: string): SettingsContractField | undefined {
    return settingsSchema?.fields?.[key];
  }

  function subsystemOwnerFile(subsystemId: keyof SettingsContractData['subsystems']): string | undefined {
    return settingsSchema?.subsystems?.[subsystemId]?.ownerFile;
  }

  function fieldOwnerFile(key: string): string | undefined {
    return fieldContract(key)?.ownerFile;
  }

  function fieldMinimum(key: string): number | undefined {
    return fieldContract(key)?.minimum;
  }

  function fieldMaximum(key: string): number | undefined {
    return fieldContract(key)?.maximum;
  }

  function fieldEnumValues(key: string, fallback: readonly string[] = []): string[] {
    const values = [
      ...(fieldContract(key)?.enumValues ?? []),
      ...fallback,
    ];
    return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
  }

  function isDeprecatedField(key: string): boolean {
    return fieldContract(key)?.deprecated === true;
  }

  function rawEditorOwnerFile(key: RawEditorKey): string {
    return resolveRawEditorOwnerFile(key, subsystemOwnerFile);
  }

  function getSettingAuthority(key: string) {
    return resolveSettingAuthority(data, settingsSchema, key);
  }

  function getSource(key: string): string {
    return getSettingAuthority(key).sourceLabel;
  }

  function getBudgetContextWindowAuthority() {
    return resolveBudgetContextWindowAuthority(data, budgetPreview);
  }

  function fieldEditorType(
    key: string,
    value: unknown,
  ): 'text' | 'number' | 'checkbox' | 'array' | 'object' | 'enum' {
    const schemaType = fieldContract(key)?.type;
    if (schemaType === 'boolean') return 'checkbox';
    if (schemaType === 'integer' || schemaType === 'number') return 'number';
    if (schemaType === 'string_array') return 'array';
    if (schemaType === 'object') return 'object';
    if (schemaType === 'enum') return 'enum';
    if (typeof value === 'boolean') return 'checkbox';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'array';
    if (value !== null && typeof value === 'object') return 'object';
    return 'text';
  }

  function getCompositionalPolicy(): CompositionalPolicyFormValue {
    const value = configValue('compositionalPolicy');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        enabled: false,
        allowedTiers: [],
        allowedChannelTypes: [],
        allowedPurposes: [],
      };
    }

    const policy = value as {
      enabled?: unknown;
      allowedTiers?: unknown;
      allowedChannelTypes?: unknown;
      allowedPurposes?: unknown;
    };
    return {
      enabled: policy.enabled === true,
      allowedTiers: normalizeStringList(policy.allowedTiers),
      allowedChannelTypes: normalizeStringList(policy.allowedChannelTypes),
      allowedPurposes: normalizeStringList(policy.allowedPurposes),
    };
  }

  function setCompositionalPolicy(policy: CompositionalPolicyFormValue): void {
    setConfigValue('compositionalPolicy', {
      enabled: policy.enabled === true,
      allowedTiers: [...new Set(policy.allowedTiers)],
      allowedChannelTypes: [...new Set(policy.allowedChannelTypes)],
      allowedPurposes: [...new Set(policy.allowedPurposes)],
    });
  }

  function toggleCompositionalPolicyValue(listKey: CompositionalListKey, value: string): void {
    const policy = getCompositionalPolicy();
    const currentList = policy[listKey];
    const nextList = currentList.includes(value)
      ? currentList.filter((entry) => entry !== value)
      : [...currentList, value];
    setCompositionalPolicy({
      ...policy,
      [listKey]: nextList,
    } as CompositionalPolicyFormValue);
  }

  function setCompositionalPolicyEnabled(enabled: boolean): void {
    setCompositionalPolicy({
      ...getCompositionalPolicy(),
      enabled,
    });
  }

  function hasCompositionalPolicyValue(listKey: CompositionalListKey, value: string): boolean {
    return getCompositionalPolicy()[listKey].includes(value);
  }

  // ── Derived ──
  let ttsProviderOptions = $derived(
    fieldEnumValues('ttsProvider', [DISABLED_PROVIDER_ID, ttsProvider]),
  );
  let sttProviderOptions = $derived(
    fieldEnumValues('sttProvider', [DISABLED_PROVIDER_ID, sttProvider]),
  );
  let capabilityTierOptions = $derived(
    fieldEnumValues('capabilityTier', COMPOSITIONAL_TIER_OPTIONS),
  );
  let importRouteModeOptions = $derived(
    fieldEnumValues('importProcessingRouteMode', [importRouteMode]),
  );
  let sessionRestartBehaviorOptions = $derived(
    fieldEnumValues('sessionRestartBehavior', [sessionRestartBehavior]),
  );

  function buildBudgetPreviewConfig() {
    if (!data) return null;
    const models = getModelsEditorConfig();
    return {
      defaultContextWindow: 128_000,
      modelRoster: models.modelRoster ?? {},
      ...(models.modelCatalog ? { modelCatalog: models.modelCatalog } : {}),
      ...(models.modelRoleAssignments ? { modelRoleAssignments: models.modelRoleAssignments } : {}),
      sessionHistoryBudgetPct,
      memoryRetrievalBudgetPct,
      ...(data.config.adaptiveContextBudgetsEnabled !== undefined
        ? { adaptiveContextBudgetsEnabled: data.config.adaptiveContextBudgetsEnabled === true }
        : {}),
    };
  }

  let budgetPreview = $derived.by(() => {
    const budgetConfig = buildBudgetPreviewConfig();
    if (!budgetConfig) return null;
    return buildContextBudgetPreview(budgetConfig, {
      systemPromptTokens: SYSTEM_PROMPT_ESTIMATE_TOKENS,
      maxResponseTokens,
    });
  });

  // ── Helpers ──
  function populateSimpleFields(settingsData: AdminSettingsData): void {
    applySimpleFormState(populateSimpleSettingsForm(settingsData));
  }

  function flash(ok: boolean, msg: string) {
    saveOk = ok;
    saveMessage = msg;
    setTimeout(() => { saveMessage = ''; }, 4000);
  }

  function flashRaw(key: string, ok: boolean, msg: string) {
    rawSaveStatus = { ...rawSaveStatus, [key]: { ok, msg } };
    setTimeout(() => {
      const next = { ...rawSaveStatus };
      delete next[key];
      rawSaveStatus = next;
    }, 4000);
  }

  function configValue(key: string): unknown {
    if (!data) return undefined;
    return (data.config as Record<string, unknown>)[key];
  }

  // Advanced editors write data.config directly; keep overlapping curated controls from saving stale values.
  function syncCuratedFieldFromConfig(key: string, value: unknown): void {
    applySimpleFormState(syncCuratedSettingsField(key, value, currentSimpleFormState()));
  }

  function setConfigValue(key: string, value: unknown) {
    if (!data) return;
    (data.config as Record<string, unknown>)[key] = value;
    syncCuratedFieldFromConfig(key, value);
  }

  function toggleSection(id: string) {
    const next = new Set(openSections);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openSections = next;
  }

  function syncActiveSimpleSection(): void {
    if (typeof window === 'undefined') return;
    if (Date.now() < suppressSimpleSectionSyncUntil) return;

    const topBySectionId: Partial<Record<SettingsSimpleSectionId, number>> = {};
    for (const sectionId of simpleQuickJumpSections) {
      const node = simpleSectionNodes.get(sectionId);
      if (!node) continue;
      topBySectionId[sectionId] = node.getBoundingClientRect().top;
    }
    const resolved = resolveActiveSettingsSimpleSection(
      simpleQuickJumpSections,
      topBySectionId,
      SIMPLE_SECTION_ACTIVE_THRESHOLD_PX,
    );
    if (resolved) {
      activeSimpleSectionId = resolved;
    }
  }

  function jumpToSimpleSection(
    sectionId: SettingsSimpleSectionId,
    behavior: ScrollBehavior = 'smooth',
  ): void {
    if (typeof window === 'undefined') return;
    const node = simpleSectionNodes.get(sectionId);
    if (!node) return;

    activeSimpleSectionId = sectionId;
    suppressSimpleSectionSyncUntil = Date.now() + 900;
    const top = window.scrollY + node.getBoundingClientRect().top - SIMPLE_SECTION_SCROLL_OFFSET_PX;
    window.history.replaceState(null, '', `#${settingsSimpleSectionAnchorId(sectionId)}`);
    window.scrollTo({
      top: Math.max(0, top),
      behavior,
    });
  }

  function jumpToHashSection(behavior: ScrollBehavior = 'auto'): void {
    if (typeof window === 'undefined') return;
    const sectionId = parseSettingsSimpleSectionHash(window.location.hash);
    if (!sectionId || !visibleSimpleSectionIds.has(sectionId)) return;
    jumpToSimpleSection(sectionId, behavior);
  }

  function simpleSectionAnchor(node: HTMLElement, sectionId: SettingsSimpleSectionId) {
    let currentId = sectionId;
    simpleSectionNodes.set(currentId, node);
    syncActiveSimpleSection();

    return {
      update(nextSectionId: SettingsSimpleSectionId) {
        if (nextSectionId === currentId) return;
        simpleSectionNodes.delete(currentId);
        currentId = nextSectionId;
        simpleSectionNodes.set(currentId, node);
        syncActiveSimpleSection();
      },
      destroy() {
        simpleSectionNodes.delete(currentId);
      },
    };
  }

  function handleSimpleQuickJump(event: Event): void {
    const sectionId = (event.currentTarget as HTMLSelectElement).value;
    if (isSettingsSimpleSectionId(sectionId) && visibleSimpleSectionIds.has(sectionId)) {
      jumpToSimpleSection(sectionId);
    }
  }

  function getRawJson(key: string): string {
    switch (key) {
      case 'settings': return settingsJson;
      case 'models': return modelsJson;
      case 'providers': return providersJson;
      case 'channels': return channelsJson;
      case 'skills': return skillsJson;
      case 'scheduler': return schedulerJson;
      case 'trust-policy': return trustPolicyJson;
      case 'capabilities': return capabilitiesJson;
      case 'charge-policy': return chargePolicyJson;
      case 'backup': return backupJson;
      default: return '';
    }
  }

  function setRawJson(key: string, val: string) {
    switch (key) {
      case 'settings': settingsJson = val; break;
      case 'models': modelsJson = val; break;
      case 'providers': providersJson = val; break;
      case 'channels': channelsJson = val; break;
      case 'skills': skillsJson = val; break;
      case 'scheduler': schedulerJson = val; break;
      case 'trust-policy': trustPolicyJson = val; break;
      case 'capabilities': capabilitiesJson = val; break;
      case 'charge-policy': chargePolicyJson = val; break;
      case 'backup': backupJson = val; break;
    }
  }

  function setSettingsJson(value: string): void {
    settingsJson = value;
  }

  function currentRawJsonByKey(): Record<RawEditorKey, string> {
    return buildRawEditorJsonMap((key) => getRawJson(key));
  }

  function dirtyRawEditorKeys(): RawEditorKey[] {
    const current = currentRawJsonByKey();
    return listDirtyRawEditorKeys(current, initialRawJsonByKey);
  }

  function rawEditorLabel(key: RawEditorKey): string {
    return rawEditorOwnerFile(key);
  }

  let rawEditorViews = $derived.by(() => RAW_EDITORS.map((editor) => ({
    key: editor.key,
    ownerFile: rawEditorLabel(editor.key),
  })));

  function resetDirtyTracking(): void {
    initialSnapshot = computeSnapshot();
    initialAdvancedSnapshot = computeAdvancedSnapshot();
    initialRawJsonByKey = currentRawJsonByKey();
  }

  function markRawEditorsCommitted(keys: RawEditorKey[]): void {
    const current = currentRawJsonByKey();
    const next = { ...initialRawJsonByKey };
    for (const key of keys) {
      next[key] = current[key];
    }
    initialRawJsonByKey = next;
  }

  function ensureNoDirtyRawEditorsForGeneralSave(): boolean {
    const dirtyKeys = dirtyRawEditorKeys();
    if (dirtyKeys.length === 0) return true;
    flash(
      false,
      `Unsaved raw editor changes in ${dirtyKeys.map(rawEditorLabel).join(', ')}; save or discard them before using the general settings save.`,
    );
    return false;
  }

  function collectSimplePayload(): Record<string, unknown> {
    return collectSimpleSettingsPayload(currentSimpleFormState(), getCompositionalPolicy());
  }

  function collectCanonicalPayload(): Record<string, unknown> {
    return {
      ...((data?.config as Record<string, unknown> | undefined) ?? {}),
      ...collectSimplePayload(),
    };
  }

  function buildSchedulerPayload(): Record<string, unknown> {
    return {
      ...getSchedulerEditorConfig(),
      salienceDecayIntervalMs: maintenanceIntervalMs,
    };
  }

  function populateBackupFields(json: string): void {
    applySimpleFormState(parseBackupSettings(json));
  }

  function buildBackupPayload(): Record<string, unknown> {
    return buildBackupSettingsPayload(currentSimpleFormState());
  }

  function buildCapabilitiesPayload(): Record<string, unknown> {
    return buildCapabilitiesSettingsPayload(getCapabilitiesEditorConfig(), currentSimpleFormState());
  }

  function setProviderRegistryState(nextRegistry: CanonicalProviderRegistry): void {
    providerRegistry = cloneProviderRegistry(nextRegistry);
    providerRegistryInitialJson = serializeProviderRegistry(providerRegistry);
    providerValidationErrors = [];
  }

  function providerRegistryDirty(): boolean {
    return providerRegistryIsDirty(providerRegistry, providerRegistryInitialJson);
  }

  function updateProviderEntry(index: number, updater: (entry: ProviderRegistryEntry) => ProviderRegistryEntry): void {
    providerRegistry = updateProviderRegistryEntry(providerRegistry, index, updater);
    providerValidationErrors = [];
  }

  function addProviderEntry(): void {
    providerRegistry = appendProviderEntry(providerRegistry);
    providerValidationErrors = [];
  }

  function removeProviderEntry(index: number): void {
    providerRegistry = removeProviderRegistryEntry(providerRegistry, index);
    providerValidationErrors = [];
  }

  function setProviderType(index: number, value: string): void {
    providerRegistry = setProviderRegistryType(providerRegistry, index, value);
    providerValidationErrors = [];
  }

  function setProviderField(index: number, field: ProviderEditableField, value: string): void {
    providerRegistry = setProviderRegistryField(providerRegistry, index, field, value);
    providerValidationErrors = [];
  }

  async function saveProviderRegistry(): Promise<void> {
    saving = true;
    try {
      const errors = validateProviderRegistry(providerRegistry);
      providerValidationErrors = errors;
      if (errors.length > 0) {
        flash(false, errors[0] ?? 'Provider registry validation failed');
        return;
      }
      await saveSubConfig('providers', JSON.stringify(providerRegistry, null, 2));
      await reloadSettingsState();
      flash(true, 'providers.json saved');
    } catch (error) {
      flash(false, error instanceof Error ? error.message : 'Failed to save providers.json');
    } finally {
      saving = false;
    }
  }

  function discardProviderRegistryChanges(): void {
    const current = normalizeProvidersRuntimeConfig(data?.editors.providers).registry;
    setProviderRegistryState(current);
  }

  async function reloadSettingsState(options: {
    settingsData?: AdminSettingsData;
    schemaData?: SettingsContractData;
  } = {}): Promise<void> {
    const nextSettingsData = options.settingsData ?? await getSettings();
    const nextSchemaData = options.schemaData ?? await getSettingsSchema();
    data = nextSettingsData;
    settingsSchema = nextSchemaData;
    populateSimpleFields(nextSettingsData);
    setProviderRegistryState(normalizeProvidersRuntimeConfig(nextSettingsData.editors.providers).registry);
    settingsJson = JSON.stringify(nextSettingsData.config as Record<string, unknown>, null, 2);

    const [provConf, chanConf, skConf, schConf, tpConf, capConf, chargeConf, bakConf] = await Promise.all([
      getSubConfig('providers').catch(() => '{}'),
      getSubConfig('channels').catch(() => '{}'),
      getSubConfig('skills').catch(() => '{}'),
      getSubConfig('scheduler').catch(() => '{}'),
      getSubConfig('trust-policy').catch(() => '{}'),
      getSubConfig('capabilities').catch(() => '{}'),
      getSubConfig('charge-policy').catch(() => '{}'),
      getSubConfig('backup').catch(() => '{}'),
    ]);
    providersJson = tryPrettyPrint(provConf);
    channelsJson = tryPrettyPrint(chanConf);
    skillsJson = tryPrettyPrint(skConf);
    schedulerJson = tryPrettyPrint(schConf);
    trustPolicyJson = tryPrettyPrint(tpConf);
    capabilitiesJson = tryPrettyPrint(capConf);
    chargePolicyJson = tryPrettyPrint(chargeConf);
    backupJson = tryPrettyPrint(bakConf);
    populateBackupFields(bakConf);
    resetDirtyTracking();
  }

  async function saveSettingsContract(
    runtimePayload: Record<string, unknown>,
  ): Promise<{ ok: boolean; invalidFieldCount: number; message: string }> {
    const hasRuntimePayload = Object.keys(runtimePayload).length > 0;
    let invalidFieldCount = 0;
    const ownerConfigSaves = [
      {
        key: 'providers' as const,
        nextJson: JSON.stringify(providerRegistry, null, 2),
        currentJson: providerRegistryInitialJson,
      },
      {
        key: 'scheduler' as const,
        nextJson: JSON.stringify(buildSchedulerPayload(), null, 2),
        currentJson: tryPrettyPrint(schedulerJson),
      },
      {
        key: 'capabilities' as const,
        nextJson: JSON.stringify(buildCapabilitiesPayload(), null, 2),
        currentJson: tryPrettyPrint(capabilitiesJson),
      },
      {
        key: 'backup' as const,
        nextJson: JSON.stringify(buildBackupPayload(), null, 2),
        currentJson: tryPrettyPrint(backupJson),
      },
    ].filter(entry => entry.nextJson !== entry.currentJson);

    if (hasRuntimePayload) {
      const runtimeResult = await updateSettings(runtimePayload);
      invalidFieldCount = applyValidationErrors(runtimeResult);
      if (!runtimeResult.ok) {
        return {
          ok: false,
          invalidFieldCount,
          message: runtimeResult.message || 'Failed to save runtime settings',
        };
      }
    } else {
      applyValidationErrors({ ok: true, message: '' });
    }

    try {
      for (const entry of ownerConfigSaves) {
        await saveSubConfig(entry.key, entry.nextJson);
      }
    } catch (error) {
      return {
        ok: false,
        invalidFieldCount,
        message: error instanceof Error
          ? `Runtime settings saved, but canonical config save failed: ${error.message}`
          : 'Runtime settings saved, but canonical config save failed',
      };
    }

    await reloadSettingsState();
    return {
      ok: true,
      invalidFieldCount,
      message: 'Settings updated',
    };
  }

  async function saveSimple() {
    saving = true;
    try {
      if (!ensureNoDirtyRawEditorsForGeneralSave()) return;
      const result = await saveSettingsContract(
        advancedDirty ? collectCanonicalPayload() : collectSimplePayload(),
      );
      flash(result.ok, result.message);
      if (!result.ok && result.invalidFieldCount > 0) {
        jumpToSimpleSection('advanced-fields');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to save');
    } finally {
      saving = false;
    }
  }

  async function saveAdvanced() {
    if (!data) return;
    saving = true;
    try {
      if (!ensureNoDirtyRawEditorsForGeneralSave()) return;
      const result = await saveSettingsContract(collectCanonicalPayload());
      flash(result.ok, result.message);
      if (!result.ok && result.invalidFieldCount > 0) {
        jumpToSimpleSection('advanced-fields');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to save');
    } finally {
      saving = false;
    }
  }

  async function saveRawSettings() {
    saving = true;
    try {
      const parsed = JSON.parse(settingsJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        applyValidationErrors({
          ok: false,
          message: 'settings.json must be a JSON object',
          validationErrors: [{ field: '$root', message: 'settings.json must be a JSON object', code: 'invalid_payload' }],
        });
        flashRaw('settings', false, 'settings.json must be a JSON object');
        return;
      }

      const result = await updateSettings(parsed as Record<string, unknown>);
      applyValidationErrors(result);
      if (!result.ok) {
        flashRaw('settings', false, result.message || 'Failed to save settings.json');
        return;
      }

      flashRaw('settings', true, result.message || 'settings.json saved');
      await reloadSettingsState();
    } catch (e) {
      flashRaw('settings', false, e instanceof Error ? e.message : 'Failed to save settings.json');
    } finally {
      saving = false;
    }
  }

  async function saveRawConfig(key: string, label: string) {
    saving = true;
    try {
      const json = getRawJson(key);
      JSON.parse(json);
      await saveSubConfig(key, json);
      applyValidationErrors({ ok: true, message: '' });
      if (key === 'scheduler' || key === 'capabilities' || key === 'providers') {
        await reloadSettingsState();
      } else {
        markRawEditorsCommitted([key as RawEditorKey]);
      }
      flashRaw(key, true, `${label} saved`);
    } catch (e) {
      flashRaw(key, false, e instanceof Error ? e.message : `Failed to save ${label}`);
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    if (!visibleSimpleSectionIds.has(activeSimpleSectionId)) {
      const fallback = simpleQuickJumpSections[0];
      if (fallback) {
        activeSimpleSectionId = fallback;
      }
    }
    syncActiveSimpleSection();
  });

  // ── Init ──
  onMount(async () => {
    window.addEventListener('beforeunload', handleBeforeUnload);
    simpleViewportChangeHandler = () => syncActiveSimpleSection();
    simpleHashChangeHandler = () => jumpToHashSection('auto');
    window.addEventListener('scroll', simpleViewportChangeHandler, { passive: true });
    window.addEventListener('resize', simpleViewportChangeHandler);
    window.addEventListener('hashchange', simpleHashChangeHandler);
    try {
      const [settingsData, schemaData] = await Promise.all([
        getSettings(),
        getSettingsSchema(),
      ]);
      data = settingsData;
      settingsSchema = schemaData;
      populateSimpleFields(data);
      setProviderRegistryState(normalizeProvidersRuntimeConfig(settingsData.editors.providers).registry);
      settingsJson = JSON.stringify(data.config as Record<string, unknown>, null, 2);

      const [provConf, chanConf, skConf, schConf, tpConf, capConf, chargeConf, bakConf] = await Promise.all([
        getSubConfig('providers').catch(() => '{}'),
        getSubConfig('channels').catch(() => '{}'),
        getSubConfig('skills').catch(() => '{}'),
        getSubConfig('scheduler').catch(() => '{}'),
        getSubConfig('trust-policy').catch(() => '{}'),
        getSubConfig('capabilities').catch(() => '{}'),
        getSubConfig('charge-policy').catch(() => '{}'),
        getSubConfig('backup').catch(() => '{}'),
      ]);
      providersJson = tryPrettyPrint(provConf);
      channelsJson = tryPrettyPrint(chanConf);
      skillsJson = tryPrettyPrint(skConf);
      schedulerJson = tryPrettyPrint(schConf);
      trustPolicyJson = tryPrettyPrint(tpConf);
      capabilitiesJson = tryPrettyPrint(capConf);
      chargePolicyJson = tryPrettyPrint(chargeConf);
      backupJson = tryPrettyPrint(bakConf);
      resetDirtyTracking();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
      window.requestAnimationFrame(() => {
        syncActiveSimpleSection();
        jumpToHashSection('auto');
      });
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (simpleViewportChangeHandler) {
        window.removeEventListener('scroll', simpleViewportChangeHandler);
        window.removeEventListener('resize', simpleViewportChangeHandler);
      }
      if (simpleHashChangeHandler) {
        window.removeEventListener('hashchange', simpleHashChangeHandler);
      }
    }
  });

  // ── Style constants ──
  const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 transition-colors';
  const LABEL_CLS = 'block text-sm font-medium text-shadow-700 mb-1.5';
  const SLIDER_CLS = 'flex-1 h-2 rounded-full appearance-none bg-bark-300 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gold-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-gold-500 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer';
  const COMPACT_INPUT_CLS = 'w-20 px-2 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold-300';
  const TOGGLE_CLS = 'w-4 h-4 rounded border-bark-400 text-gold-600 focus:ring-gold-300';
  const PROVIDER_CARD_CLS = 'rounded-2xl border border-bark-300 bg-white/90 p-4 space-y-4';
</script>

<datalist id="tts-provider-list">
  {#each ttsProviderOptions as providerId}
    <option value={providerId}></option>
  {/each}
</datalist>

<datalist id="stt-provider-list">
  {#each sttProviderOptions as providerId}
    <option value={providerId}></option>
  {/each}
</datalist>

<div class="space-y-5">
  <SettingsPageChrome
    {dirty}
    {saveMessage}
    {saveOk}
  />

  <!-- Loading -->
  {#if loading}
    <div class="card-garden p-8">
      <div class="animate-pulse space-y-4">
        {#each Array(5) as _}
          <div class="h-10 bg-bark-300 rounded-lg"></div>
        {/each}
      </div>
    </div>

  {:else if error}
    <div class="card-garden p-8 text-center">
      <p class="text-wilt-600 text-sm">{error}</p>
    </div>

  {:else}
    <div class="space-y-5">
      <div class="card-garden p-3 lg:hidden">
        <label class="block text-sm font-medium text-shadow-700 mb-1.5" for="settings-jump-select">
          Quick jump
        </label>
        <select
          id="settings-jump-select"
          class={INPUT_CLS}
          value={activeSimpleSectionId}
          onchange={handleSimpleQuickJump}
        >
          {#each simpleSectionGroups as group}
            <optgroup label={group.label}>
              {#each group.sections as section}
                <option value={section.id}>{section.title}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </div>

      <div class="card-garden p-4 space-y-3">
        <div>
          <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Delegated Workspaces</p>
          <p class="text-sm text-shadow-700 mt-1">
            Settings keeps runtime owner-file controls here; related operator surfaces stay in their dedicated workspaces.
          </p>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {#each DELEGATED_WORKSPACES as workspace}
            <a
              href={`${base}${workspace.href}`}
              class="rounded-xl border border-bark-200 bg-white px-3 py-2 text-sm transition-colors hover:border-gold-300 hover:bg-gold-50"
            >
              <span class="block font-medium text-shadow-800">{workspace.label}</span>
              <span class="block text-xs text-shadow-600 mt-0.5">{workspace.description}</span>
            </a>
          {/each}
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-5 items-start">
        <aside class="hidden lg:block lg:sticky lg:top-4">
          <SettingsSidebarNav
            groups={simpleSectionGroups}
            activeSectionId={activeSimpleSectionId}
            onNavigate={jumpToSimpleSection}
          />
        </aside>

        <div class="space-y-5 min-w-0">
          <SettingsSimplePanels
            {data} {simpleSectionAnchor} {providerRegistry} {providerValidationErrors} {providerRegistryDirty}
            {saving} {dirty} {generalSettingsSaveDirty} {openSections} {budgetPreview}
            inputClass={INPUT_CLS} labelClass={LABEL_CLS} sliderClass={SLIDER_CLS}
            compactInputClass={COMPACT_INPUT_CLS} toggleClass={TOGGLE_CLS} providerCardClass={PROVIDER_CARD_CLS}
            {capabilityTierOptions} {importRouteModeOptions} {sessionRestartBehaviorOptions}
            {getBudgetContextWindowAuthority} {getSource} {getSettingAuthority} {rawEditorLabel} {toggleSection}
            {addProviderEntry} {removeProviderEntry} {updateProviderEntry} {setProviderType} {setProviderField}
            {saveProviderRegistry} {discardProviderRegistryChanges} {saveSimple}
            bind:sessionHistoryBudgetPct bind:memoryRetrievalBudgetPct bind:extractionThresholdPct bind:extractionInterval
            bind:compactionEmotionalSalienceThresholdPct bind:compactionThresholdPct bind:maintenanceIntervalMs bind:sessionRestartBehavior
            bind:memoryExtractionMinImportance bind:memoryExtractionMinConfidence bind:memoryExtractionMinNovelty bind:memoryExtractionMaxWrites
            bind:memoryExtractionTelemetryEnabled bind:memoryRetrievalTelemetryEnabled bind:profileSynthesisEnabled bind:profileSynthesisRefreshIntervalMs
            bind:profileSynthesisCooldownMs bind:profileSynthesisMinWrites bind:profileSynthesisMinImportance bind:profileSynthesisMinConfidence
            bind:profileSynthesisMinNovelty bind:profileSynthesisSourceMemoryLimit bind:profileSynthesisMinSourceMemories
            bind:analysisWorkbenchMaxTokens bind:analysisWorkbenchMaxWallTimeMs bind:analysisWorkbenchMaxSubQueries
            bind:capabilityTier bind:capabilityCustomTokens bind:backupIntervalHours bind:backupMaxRotating bind:backupMaxWeekly
            bind:backupMaxMonthly bind:backupMirrorDir bind:backupVerifyRestore bind:retryMaxAttempts bind:retryBaseDelayMs
            bind:importRouteMode bind:importStrictPolicy bind:openRouterProviderOrder bind:importLocalEndpointUrl bind:importLocalModel
            bind:webFetchAllowInternalNetwork bind:webFetchAllowHttp bind:webFetchDomainAllowlist bind:webFetchTlsCaCertPaths
            bind:ttsProvider bind:sttProvider bind:voiceId bind:deepgramModel bind:echoTtsUrl bind:echoTtsVoice bind:echoTtsPreset
            bind:obsidianVaultName bind:obsidianCliPath bind:obsidianAutoPublish bind:obsidianTimeoutMs
            bind:discordTriggerWords bind:discordTriggerReactions bind:discordTriggerListenWindowSeconds bind:telegramEnabled bind:telegramAuthorizedUsers
          />

          <SettingsAdvancedOwnerPanels
            {data} {simpleSectionAnchor} {SECTIONS} {advancedSectionSummaries} {openSections} {MODEL_OWNED_FIELDS}
            {saving} {capabilityTierOptions} {COMPOSITIONAL_CHANNEL_TYPE_OPTIONS} {COMPOSITIONAL_PURPOSE_OPTIONS}
            {toggleSection} {configValue} {setConfigValue} {fieldEditorType} {fieldEnumValues} {fieldContract}
            {fieldMinimum} {fieldMaximum} {isDeprecatedField} {getSource} {hasFieldErrors} {fieldErrors}
            {formatSettingOptionLabel} {humanizeSettingValue} {getCompositionalPolicy} {setCompositionalPolicyEnabled}
            {toggleCompositionalPolicyValue} {hasCompositionalPolicyValue} {saveAdvanced} {settingsJson}
            {rawEditorViews} {rawSaveStatus} {validationErrorsByField} {setSettingsJson} {getRawJson} {setRawJson}
            {saveRawSettings} {saveRawConfig}
          />
        </div>
      </div>
    </div>
  {/if}

  <SettingsEnvironmentSummary env={data?.env as unknown as Record<string, unknown> | undefined} />
</div>
