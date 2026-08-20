<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
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
  import { resolveSettingAuthority } from '$lib/settings/authority';
  import SettingsAdvancedOwnerPanels from './SettingsAdvancedOwnerPanels.svelte';
  import SettingsDelegatedPanels from './SettingsDelegatedPanels.svelte';
  import SettingsEnvironmentSummary from '$lib/components/settings/SettingsEnvironmentSummary.svelte';
  import SettingsIntegrationsPanels from './SettingsIntegrationsPanels.svelte';
  import SettingsMemoryPanels from './SettingsMemoryPanels.svelte';
  import FloatingSettingsSave from '$lib/components/settings/FloatingSettingsSave.svelte';
  import SettingsPageChrome from '$lib/components/settings/SettingsPageChrome.svelte';
  import SettingsSearch from '$lib/components/settings/SettingsSearch.svelte';
  import SettingsRuntimePanels from './SettingsRuntimePanels.svelte';
  import SettingsTrustBackupPanels from './SettingsTrustBackupPanels.svelte';
  import {
    parseSettingsSimpleSectionHash,
    settingsSimpleSectionAnchorId,
    type SettingsSimpleSectionId,
  } from '$lib/components/settings/navigation';
  import { SETTINGS_SECTION_COLLAPSE_KEY } from '$lib/components/settings/settings-search';
  import {
    CURATED_SETTINGS_TAB_IDS,
    MODEL_OWNED_FIELDS,
    SETTINGS_TAB_DEFINITIONS,
    isSettingsTabId,
    settingsTabForSection,
    type SettingsTabId,
  } from './settings-section-definitions';
  import {
    normalizeProvidersRuntimeConfig,
  } from '$lib/providers/registry';
  import { getCompanionCacheScope } from '$lib/fleet/companion-scope';
  import {
    persistSettingsLastSavedAt,
    restoreSettingsLastSavedAt,
  } from '$lib/components/settings/floating-save';
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
    DISABLED_PROVIDER_ID,
    RAW_EDITORS,
    buildAdvancedSettingsSections,
    buildBackupSettingsPayload,
    buildCapabilitiesSettingsPayload,
    buildRawEditorJsonMap,
    buildSettingsSnapshot,
    buildUnifiedSaveSkipNote,
    buildValidationNavigationNotice,
    collectSimpleSettingsPayload,
    formatSettingOptionLabel,
    humanizeSettingValue,
    listDirtyRawEditorKeys,
    loadRawEditorConfig,
    loadRawEditorConfigs,
    planUnifiedOwnerConfigSaves,
    resolveUnifiedSaveSettingsJsonConflict,
    normalizeStringList,
    parseBackupSettings,
    populateSimpleSettingsForm,
    rebaselineRawJsonByKey,
    resolveRawEditorOwnerFile,
    resolveReloadedRawJsonByKey,
    resolveSaveFeedback,
    resolveValidationNavigation,
    syncCuratedSettingsField,
    summarizeCompositionalPolicy,
    tryPrettyPrint,
    RAW_SAVE_SUCCESS_AUTO_DISMISS_MS,
    type CapabilitiesEditorConfig,
    type CompositionalListKey,
    type CompositionalPolicyFormValue,
    type RawEditorKey,
    type RawEditorLoadResult,
    type RawSettingsEditorKey,
    type SaveFeedbackState,
    type SchedulerEditorConfig,
    type SettingsSimpleFormState,
    type UnifiedSaveOwnerFileKey,
  } from './settings-page-helpers';

  // ── Core state ──
  let data = $state<AdminSettingsData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let saving = $state(false);
  let lastSavedAt = $state<number | null>(null);
  // Persistent save feedback (qq67): a single banner in SettingsPageChrome,
  // but errors (and successes that skipped owner files) persist until the
  // operator dismisses them or starts the next save. Only plain successes
  // auto-dismiss. The timer handle is stored so it is cleared on every new
  // flash and on destroy — no leaked timers.
  let saveFeedback = $state<SaveFeedbackState | null>(null);
  let saveFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
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
  // The unified save commits every non-raw surface in one call: curated fields,
  // advanced canonical fields, and the provider registry all route through
  // saveSettingsContract to their owner files. Raw owner-file editors keep
  // their own scoped saves; dirty raw editors are preserved across this save
  // and their owner files are skipped rather than blocked.
  let settingsSaveDirty = $derived(
    curatedDirty || advancedDirty || providerRegistryDirty(),
  );

  function recordConfirmedSave(savedAt: number): void {
    lastSavedAt = savedAt;
    persistSettingsLastSavedAt(getCompanionCacheScope(), savedAt);
  }

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
  let backgroundMaintenanceIntervalMs = $state(3600000);

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
  let analysisWorkbenchMaxIterations = $state(60);
  let analysisWorkbenchMaxTokens = $state(256000);
  let analysisWorkbenchMaxWallTimeMs = $state(600000);
  let analysisWorkbenchMaxSubQueries = $state(60);

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
  let rawEditorLoadErrors = $state<Partial<Record<RawSettingsEditorKey, string>>>({});
  let retryingRawEditorKey = $state<RawSettingsEditorKey | null>(null);

  // ── Backup form fields ──
  let backupIntervalHours = $state(12);
  let backupMaxRotating = $state(9);
  let backupMaxWeekly = $state(2);
  let backupMaxMonthly = $state(1);
  let backupMirrorDir = $state('');
  let backupVerifyRestore = $state(true);
  let rawSaveStatus = $state<Record<string, { ok: boolean; msg: string }>>({});
  // Per-editor auto-dismiss timers for raw save confirmations. Errors persist
  // (no timer); only successes schedule a clear. Handles are stored so they can
  // be cleared on re-flash and on destroy (qq67).
  const rawSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
      backgroundMaintenanceIntervalMs,
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
      analysisWorkbenchMaxIterations,
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
    if (next.backgroundMaintenanceIntervalMs !== undefined) {
      backgroundMaintenanceIntervalMs = next.backgroundMaintenanceIntervalMs;
    }
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
    if (next.analysisWorkbenchMaxIterations !== undefined) analysisWorkbenchMaxIterations = next.analysisWorkbenchMaxIterations;
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

  // ── Tab navigation ──
  // One navigation scheme: every settings section lives on exactly one tab
  // (see SETTINGS_TAB_DEFINITIONS). Section hash deep links resolve to the
  // owning tab and scroll to the section anchor.
  let activeTabId = $state<SettingsTabId>(SETTINGS_TAB_DEFINITIONS[0].id);
  let hashChangeHandler: (() => void) | null = null;

  // Per-tab dirty badges: curated tabs share one dirty flag (the curated form
  // snapshot covers every curated panel), the providers tab surfaces the
  // provider-registry editor state, and the raw tab counts dirty owner-file
  // editors. Badges make cross-tab unsaved state visible instead of blocking
  // the unified save.
  function settingsTabDirtyCount(tabId: SettingsTabId): number | undefined {
    if (tabId === 'providers') return providerRegistryDirty() ? 1 : undefined;
    if (tabId === 'advanced') return advancedDirty ? 1 : undefined;
    if (tabId === 'raw') {
      const count = dirtyRawEditorKeys().length;
      return count > 0 ? count : undefined;
    }
    return curatedDirty ? 1 : undefined;
  }

  let settingsTabs = $derived(SETTINGS_TAB_DEFINITIONS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    count: settingsTabDirtyCount(tab.id),
  })));

  const SETTINGS_TAB_DESCRIPTIONS: Record<SettingsTabId, string> = {
    providers: 'Provider registry and model handoffs',
    memory: 'Retrieval, extraction, and synthesis',
    runtime: 'Retries, import routes, and web fetch',
    integrations: 'Voice, Obsidian, and channel adapters',
    trust: 'Capabilities, fleet auth, secrets, and backups',
    advanced: 'Every contract-backed runtime field',
    raw: 'Direct canonical owner-file editors',
  };

  // The unified save action is offered on every tab whose fields it commits
  // (curated panels, providers registry, and the advanced canonical editor).
  // The raw tab edits owner files directly and keeps its own scoped saves.
  let activeTabHasPrimarySave = $derived(
    CURATED_SETTINGS_TAB_IDS.includes(activeTabId) || activeTabId === 'advanced',
  );

  // settings.json is the one raw editor whose owner file IS the unified save's
  // runtime payload target, so a dirty settings.json raw editor BLOCKS the
  // unified save (it cannot be skipped like the other owner files). Surfaced as
  // a distinct hint under the save button so the blocking consequence is
  // visible from the tab where the user clicks save.
  let settingsRawEditorDirty = $derived(dirtyRawEditorKeys().includes('settings'));

  function selectTab(tabId: string): void {
    if (!isSettingsTabId(tabId)) return;
    activeTabId = tabId;
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${tabId}`);
    }
  }

  async function jumpToSection(
    sectionId: SettingsSimpleSectionId,
    behavior: ScrollBehavior = 'smooth',
  ): Promise<void> {
    activeTabId = settingsTabForSection(sectionId);
    await tick();
    if (typeof document === 'undefined') return;
    document
      .getElementById(settingsSimpleSectionAnchorId(sectionId))
      ?.scrollIntoView({ behavior, block: 'start' });
  }

  // Search result selection: expand the target section's collapsible (when it
  // has one) before jumping, so the setting is visible after the scroll lands.
  // For fields routed to the "All Fields (Advanced)" editor, also expand the
  // owning Garden section group (its collapse key is the Garden section id) so
  // the field is not hidden behind a collapsed advanced group.
  function handleSearchJump(
    sectionId: SettingsSimpleSectionId,
    advancedGroupId?: string,
  ): void {
    const keysToOpen: string[] = [];
    const collapseKey = SETTINGS_SECTION_COLLAPSE_KEY[sectionId];
    if (collapseKey) keysToOpen.push(collapseKey);
    if (advancedGroupId) keysToOpen.push(advancedGroupId);
    const pending = keysToOpen.filter((key) => !openSections.has(key));
    if (pending.length > 0) {
      const next = new Set(openSections);
      for (const key of pending) next.add(key);
      openSections = next;
    }
    void jumpToSection(sectionId);
  }

  function applyLocationHash(behavior: ScrollBehavior = 'auto'): void {
    if (typeof window === 'undefined') return;
    const rawHash = window.location.hash.trim().replace(/^#/, '');
    if (!rawHash) return;
    if (isSettingsTabId(rawHash)) {
      activeTabId = rawHash;
      return;
    }
    const sectionId = parseSettingsSimpleSectionHash(window.location.hash);
    if (sectionId) {
      void jumpToSection(sectionId, behavior);
    }
  }

  // ── Collapsible sections ──
  let openSections = $state(new Set<string>(['budget']));

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

  function getCapabilitiesEditorConfig(): CapabilitiesEditorConfig {
    return (data?.editors?.capabilities as CapabilitiesEditorConfig | undefined) ?? {};
  }

  function getBackupEditorConfig(): Record<string, unknown> {
    return (data?.editors?.backup as Record<string, unknown> | undefined) ?? {};
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

  // ── Helpers ──
  function populateSimpleFields(settingsData: AdminSettingsData): void {
    applySimpleFormState(populateSimpleSettingsForm(settingsData));
  }

  function clearSaveFeedbackTimer(): void {
    if (saveFeedbackTimer !== null) {
      clearTimeout(saveFeedbackTimer);
      saveFeedbackTimer = null;
    }
  }

  // Single entry point for save feedback: clears any pending auto-dismiss timer
  // (so a prior success timer can't wipe a fresh error), sets the new state, and
  // only schedules a new timer when the state opts into auto-dismiss.
  function setSaveFeedback(next: SaveFeedbackState | null): void {
    clearSaveFeedbackTimer();
    saveFeedback = next;
    if (next && next.autoDismissMs !== null) {
      saveFeedbackTimer = setTimeout(() => {
        saveFeedback = null;
        saveFeedbackTimer = null;
      }, next.autoDismissMs);
    }
  }

  function dismissSaveFeedback(): void {
    setSaveFeedback(null);
  }

  function flash(ok: boolean, msg: string) {
    setSaveFeedback(resolveSaveFeedback({ ok, message: msg }));
  }

  function clearRawSaveTimer(key: string): void {
    const timer = rawSaveTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      rawSaveTimers.delete(key);
    }
  }

  function flashRaw(key: string, ok: boolean, msg: string) {
    clearRawSaveTimer(key);
    rawSaveStatus = { ...rawSaveStatus, [key]: { ok, msg } };
    // Errors persist until the next save of this editor re-flashes; only
    // successes auto-dismiss.
    if (ok) {
      rawSaveTimers.set(key, setTimeout(() => {
        const next = { ...rawSaveStatus };
        delete next[key];
        rawSaveStatus = next;
        rawSaveTimers.delete(key);
      }, RAW_SAVE_SUCCESS_AUTO_DISMISS_MS));
    }
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

  function rawEditorLoadError(key: RawEditorKey): string | undefined {
    if (key === 'settings' || key === 'models') return undefined;
    return rawEditorLoadErrors[key];
  }

  function dirtyRawEditorKeys(): RawEditorKey[] {
    const current = currentRawJsonByKey();
    return listDirtyRawEditorKeys(current, initialRawJsonByKey);
  }

  function unavailableRawEditorKeys(): RawSettingsEditorKey[] {
    return RAW_EDITORS
      .filter(({ key }) => rawEditorLoadErrors[key] !== undefined)
      .map(({ key }) => key);
  }

  function rawEditorLabel(key: RawEditorKey): string {
    return rawEditorOwnerFile(key);
  }

  let rawEditorViews = $derived.by(() => RAW_EDITORS.map((editor) => ({
    key: editor.key,
    ownerFile: rawEditorLabel(editor.key),
    loadError: rawEditorLoadErrors[editor.key],
  })));

  function resetDirtyTracking(preserveRawKeys: readonly RawEditorKey[] = []): void {
    initialSnapshot = computeSnapshot();
    initialAdvancedSnapshot = computeAdvancedSnapshot();
    initialRawJsonByKey = rebaselineRawJsonByKey({
      currentJsonByKey: currentRawJsonByKey(),
      initialJsonByKey: initialRawJsonByKey,
      preservedKeys: preserveRawKeys,
    });
  }

  function markRawEditorsCommitted(keys: RawEditorKey[]): void {
    const current = currentRawJsonByKey();
    const next = { ...initialRawJsonByKey };
    for (const key of keys) {
      next[key] = current[key];
    }
    initialRawJsonByKey = next;
  }

  function formatRawEditorLoadError(key: RawSettingsEditorKey, result: RawEditorLoadResult): string {
    const detail = result.status === 'error' ? result.message : 'Unknown owner-file load error';
    return `Failed to load ${rawEditorLabel(key)}: ${detail}. Editing and saving are disabled until a reload succeeds.`;
  }

  function applyRawEditorLoadResults(input: {
    results: Record<RawSettingsEditorKey, RawEditorLoadResult>;
    settingsJson: string;
    stagedJsonByKey: Record<RawEditorKey, string>;
    preservedKeys: readonly RawEditorKey[];
  }): void {
    const serverJsonByKey = {
      ...input.stagedJsonByKey,
      settings: input.settingsJson,
    };
    const nextErrors: Partial<Record<RawSettingsEditorKey, string>> = {};
    for (const { key } of RAW_EDITORS) {
      const result = input.results[key];
      if (result.status === 'loaded') {
        serverJsonByKey[key] = tryPrettyPrint(result.json);
      } else {
        nextErrors[key] = formatRawEditorLoadError(key, result);
      }
    }
    const reloadedRawJsonByKey = resolveReloadedRawJsonByKey({
      serverJsonByKey,
      stagedJsonByKey: input.stagedJsonByKey,
      dirtyKeys: input.preservedKeys,
    });
    for (const key of Object.keys(reloadedRawJsonByKey) as RawEditorKey[]) {
      setRawJson(key, reloadedRawJsonByKey[key]);
    }
    rawEditorLoadErrors = nextErrors;

    const backupResult = input.results.backup;
    if (backupResult.status === 'loaded') {
      populateBackupFields(backupResult.json);
    }
  }

  async function retryRawConfig(key: RawSettingsEditorKey): Promise<void> {
    retryingRawEditorKey = key;
    try {
      const result = await loadRawEditorConfig(key, getSubConfig);
      if (result.status === 'error') {
        rawEditorLoadErrors = {
          ...rawEditorLoadErrors,
          [key]: formatRawEditorLoadError(key, result),
        };
        return;
      }

      const currentJsonByKey = currentRawJsonByKey();
      const hadStagedEdit = listDirtyRawEditorKeys(currentJsonByKey, initialRawJsonByKey).includes(key);
      const loadedJson = tryPrettyPrint(result.json);
      if (hadStagedEdit) {
        initialRawJsonByKey = { ...initialRawJsonByKey, [key]: loadedJson };
      } else {
        setRawJson(key, loadedJson);
        markRawEditorsCommitted([key]);
      }
      if (key === 'backup' && !hadStagedEdit) {
        populateBackupFields(result.json);
      }
      const nextErrors = { ...rawEditorLoadErrors };
      delete nextErrors[key];
      rawEditorLoadErrors = nextErrors;
    } finally {
      retryingRawEditorKey = null;
    }
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
    const scheduler = getSchedulerEditorConfig();
    return {
      ...scheduler,
      backgroundMaintenance: {
        ...(scheduler.backgroundMaintenance ?? {}),
        intervalMs: backgroundMaintenanceIntervalMs,
      },
    };
  }

  function populateBackupFields(json: string): void {
    applySimpleFormState(parseBackupSettings(json));
  }

  function buildBackupPayload(): Record<string, unknown> {
    return buildBackupSettingsPayload(getBackupEditorConfig(), currentSimpleFormState());
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
      recordConfirmedSave(Date.now());
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
    // Dirty raw editors hold staged hand edits the server does not know about.
    // Snapshot them before the reload so the refresh below cannot clobber them.
    const preservedRawKeys = dirtyRawEditorKeys();
    const stagedRawJsonByKey = currentRawJsonByKey();

    const nextSettingsData = options.settingsData ?? await getSettings();
    const nextSchemaData = options.schemaData ?? await getSettingsSchema();
    data = nextSettingsData;
    settingsSchema = nextSchemaData;
    populateSimpleFields(nextSettingsData);
    setProviderRegistryState(normalizeProvidersRuntimeConfig(nextSettingsData.editors.providers).registry);

    const results = await loadRawEditorConfigs(getSubConfig);
    applyRawEditorLoadResults({
      results,
      settingsJson: JSON.stringify(nextSettingsData.config as Record<string, unknown>, null, 2),
      stagedJsonByKey: stagedRawJsonByKey,
      preservedKeys: preservedRawKeys,
    });
    resetDirtyTracking(preservedRawKeys);
  }

  async function saveSettingsContract(
    runtimePayload: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    invalidFieldCount: number;
    message: string;
    skippedOwnerFiles: UnifiedSaveOwnerFileKey[];
  }> {
    const hasRuntimePayload = Object.keys(runtimePayload).length > 0;
    let invalidFieldCount = 0;
    const dirtyKeys = dirtyRawEditorKeys();

    // Fail closed, before ANY write: the unified save's runtime payload IS
    // settings.json, so a dirty settings.json raw editor cannot be "skipped" —
    // running updateSettings would clobber the operator's staged hand edits.
    // Refuse the whole save (no runtime write, no owner-file writes) until the
    // raw edits are saved or discarded on the Raw JSON tab.
    const settingsConflict = resolveUnifiedSaveSettingsJsonConflict(dirtyKeys);
    if (settingsConflict) {
      return {
        ok: false,
        invalidFieldCount: 0,
        message: settingsConflict,
        skippedOwnerFiles: [],
      };
    }

    // An owner file with a dirty raw editor is being hand-edited on the Raw
    // JSON tab; the unified save must not write form-derived JSON over it. The
    // plan skips those files (and flags any that ALSO had pending form changes)
    // and enforces that the write surface exactly equals the skip-set constant.
    const ownerConfigPlan = planUnifiedOwnerConfigSaves({
      entries: [
        {
          key: 'providers',
          nextJson: JSON.stringify(providerRegistry, null, 2),
          currentJson: providerRegistryInitialJson,
        },
        {
          key: 'scheduler',
          nextJson: JSON.stringify(buildSchedulerPayload(), null, 2),
          currentJson: tryPrettyPrint(schedulerJson),
        },
        {
          key: 'capabilities',
          nextJson: JSON.stringify(buildCapabilitiesPayload(), null, 2),
          currentJson: tryPrettyPrint(capabilitiesJson),
        },
        {
          key: 'backup',
          nextJson: JSON.stringify(buildBackupPayload(), null, 2),
          currentJson: tryPrettyPrint(backupJson),
        },
      ],
      dirtyRawEditorKeys: dirtyKeys,
      unavailableRawEditorKeys: unavailableRawEditorKeys(),
    });

    if (hasRuntimePayload) {
      const runtimeResult = await updateSettings(runtimePayload);
      invalidFieldCount = applyValidationErrors(runtimeResult);
      if (!runtimeResult.ok) {
        return {
          ok: false,
          invalidFieldCount,
          message: runtimeResult.message || 'Failed to save runtime settings',
          skippedOwnerFiles: ownerConfigPlan.skippedOwnerFiles,
        };
      }
    } else {
      applyValidationErrors({ ok: true, message: '' });
    }

    try {
      for (const entry of ownerConfigPlan.saves) {
        await saveSubConfig(entry.key, entry.nextJson);
      }
    } catch (error) {
      return {
        ok: false,
        invalidFieldCount,
        message: error instanceof Error
          ? `Runtime settings saved, but canonical config save failed: ${error.message}`
          : 'Runtime settings saved, but canonical config save failed',
        skippedOwnerFiles: ownerConfigPlan.skippedOwnerFiles,
      };
    }

    recordConfirmedSave(Date.now());
    await reloadSettingsState();
    const skippedNote = buildUnifiedSaveSkipNote({
      skippedOwnerFiles: ownerConfigPlan.skippedOwnerFiles,
      skippedWithPendingChanges: ownerConfigPlan.skippedWithPendingChanges,
      unavailableOwnerFiles: ownerConfigPlan.unavailableOwnerFiles,
      ownerFileLabel: rawEditorOwnerFile,
    });
    return {
      ok: true,
      invalidFieldCount,
      message: `Settings updated.${skippedNote}`,
      skippedOwnerFiles: ownerConfigPlan.skippedOwnerFiles,
    };
  }

  // One save action for the whole page: whatever is dirty — curated fields,
  // advanced canonical fields, and the provider registry — is routed through
  // saveSettingsContract to the owner file each field belongs to. When the
  // advanced canonical editor is dirty the full canonical payload is sent so
  // advanced keys reach settings.json; otherwise only the curated payload goes.
  // Raw owner-file editors save directly to their files via their own scoped
  // actions. A raw editor with staged (dirty) edits is preserved across this
  // save's reload, and its owner file is skipped by the structured owner-file
  // saves so form-derived JSON never stomps the staged hand edits.
  async function saveSettings() {
    // A new save attempt supersedes any lingering feedback.
    setSaveFeedback(null);
    saving = true;
    try {
      const result = await saveSettingsContract(
        advancedDirty ? collectCanonicalPayload() : collectSimplePayload(),
      );
      let message = result.message;
      // Validation failures render inline at the curated control for each
      // invalid field (see SettingFieldLabel). Only fall back to the All Fields
      // view for invalid fields that have no curated control anywhere, and say
      // so explicitly rather than teleporting the operator off their tab (ybm3).
      if (!result.ok && result.invalidFieldCount > 0) {
        const invalidFields = Object.keys(validationErrorsByField).filter((field) => field !== '$root');
        const navigation = resolveValidationNavigation({ invalidFields });
        if (navigation.navigate) {
          void jumpToSection('advanced-fields');
          const notice = buildValidationNavigationNotice(navigation.uncoveredFields);
          message = notice ? `${message} ${notice}`.trim() : message;
        }
      }
      setSaveFeedback(resolveSaveFeedback({
        ok: result.ok,
        message,
        hasSkippedOwnerFiles: result.skippedOwnerFiles.length > 0,
      }));
    } catch (e) {
      setSaveFeedback(resolveSaveFeedback({
        ok: false,
        message: e instanceof Error ? e.message : 'Failed to save',
      }));
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

      recordConfirmedSave(Date.now());
      flashRaw('settings', true, result.message || 'settings.json saved');
      // Rebasing the just-saved editor before the reload keeps it clean (see
      // saveRawConfig); the reload then refreshes it from server state.
      markRawEditorsCommitted(['settings']);
      await reloadSettingsState();
    } catch (e) {
      flashRaw('settings', false, e instanceof Error ? e.message : 'Failed to save settings.json');
    } finally {
      saving = false;
    }
  }

  async function saveRawConfig(key: string, label: string) {
    const loadError = rawEditorLoadError(key as RawEditorKey);
    if (loadError) {
      flashRaw(key, false, loadError);
      return;
    }
    saving = true;
    try {
      const json = getRawJson(key);
      JSON.parse(json);
      await saveSubConfig(key, json);
      recordConfirmedSave(Date.now());
      applyValidationErrors({ ok: true, message: '' });
      // Rebasing the just-saved editor before any reload keeps it clean: the
      // reload refreshes it from server state instead of preserving it as dirty.
      markRawEditorsCommitted([key as RawEditorKey]);
      // Every owner file whose unified-save builder spreads data.editors.*
      // must reload here, or the next unified save writes the stale spread
      // over the raw edit that was just saved to disk.
      if (key === 'scheduler' || key === 'capabilities' || key === 'providers' || key === 'backup') {
        await reloadSettingsState();
      }
      flashRaw(key, true, `${label} saved`);
    } catch (e) {
      flashRaw(key, false, e instanceof Error ? e.message : `Failed to save ${label}`);
    } finally {
      saving = false;
    }
  }

  // ── Init ──
  onMount(async () => {
    lastSavedAt = restoreSettingsLastSavedAt(getCompanionCacheScope());
    window.addEventListener('beforeunload', handleBeforeUnload);
    hashChangeHandler = () => applyLocationHash('auto');
    window.addEventListener('hashchange', hashChangeHandler);
    try {
      const [settingsData, schemaData] = await Promise.all([
        getSettings(),
        getSettingsSchema(),
      ]);
      data = settingsData;
      settingsSchema = schemaData;
      populateSimpleFields(data);
      setProviderRegistryState(normalizeProvidersRuntimeConfig(settingsData.editors.providers).registry);
      const results = await loadRawEditorConfigs(getSubConfig);
      applyRawEditorLoadResults({
        results,
        settingsJson: JSON.stringify(data.config as Record<string, unknown>, null, 2),
        stagedJsonByKey: currentRawJsonByKey(),
        preservedKeys: [],
      });
      resetDirtyTracking();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
      window.requestAnimationFrame(() => {
        applyLocationHash('auto');
      });
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (hashChangeHandler) {
        window.removeEventListener('hashchange', hashChangeHandler);
      }
    }
    // Clear pending auto-dismiss timers so they cannot fire after teardown.
    clearSaveFeedbackTimer();
    for (const timer of rawSaveTimers.values()) {
      clearTimeout(timer);
    }
    rawSaveTimers.clear();
  });

  // ── Style constants ──
  const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-gold-200 focus:border-gold-400 transition-colors';
  const LABEL_CLS = 'block text-sm font-medium text-shadow-700 mb-1.5';
  const SLIDER_CLS = 'flex-1 h-2 rounded-full appearance-none bg-bark-300 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gold-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-gold-500 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer';
  const COMPACT_INPUT_CLS = 'w-20 px-2 py-1.5 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold-300';
  const TOGGLE_CLS = 'w-4 h-4 rounded border-bark-400 text-gold-600 focus:ring-gold-300';
  const PROVIDER_CARD_CLS = 'rounded-xl border border-bark-300 bg-bark-50 p-4 space-y-4 shadow-sm';
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

<div class="garden-page space-y-5 pb-10">
  <FloatingSettingsSave
    {dirty}
    saveable={settingsSaveDirty}
    {saving}
    {lastSavedAt}
    onSave={saveSettings}
  />

  <SettingsPageChrome
    {dirty}
    feedback={saveFeedback}
    onDismiss={dismissSaveFeedback}
  />

  <!-- Loading -->
  {#if loading}
    <div class="garden-loading card-garden p-8">
      <div class="animate-pulse space-y-4">
        {#each Array(5) as _}
          <div class="h-10 bg-bark-300 rounded-lg"></div>
        {/each}
      </div>
    </div>

  {:else if error}
    <div class="garden-error card-garden p-8 text-center" role="alert">
      <p class="text-wilt-600 text-sm">{error}</p>
    </div>

  {:else}
    <div class="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside class="min-w-0 lg:sticky lg:top-28 lg:h-fit">
        <div class="card-garden overflow-hidden">
          <div class="border-b border-bark-300 bg-bark-50 p-3">
            <SettingsSearch onJump={handleSearchJump} />
          </div>
          <nav aria-label="Settings domains" class="flex gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible">
            {#each settingsTabs as tab (tab.id)}
              <button
                type="button"
                aria-current={activeTabId === tab.id ? 'page' : undefined}
                onclick={() => selectTab(tab.id)}
                class="group relative min-w-40 rounded-lg px-3 py-2 text-left transition-colors lg:min-w-0 {activeTabId === tab.id ? 'bg-gold-50 text-gold-700' : 'text-shadow-600 hover:bg-bark-100 hover:text-shadow-900'}"
              >
                {#if activeTabId === tab.id}
                  <span class="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-gold-500" aria-hidden="true"></span>
                {/if}
                <span class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-sm font-medium">{tab.label}</span>
                  {#if tab.count}
                    <span class="rounded-full border border-gold-300 bg-gold-100 px-1.5 py-0.5 text-[0.65rem] font-semibold tabular-nums text-gold-700" aria-label={`${tab.count} unsaved changes`}>{tab.count}</span>
                  {/if}
                </span>
                <span class="mt-0.5 hidden text-[0.68rem] leading-snug text-shadow-500 lg:block">{SETTINGS_TAB_DESCRIPTIONS[tab.id]}</span>
              </button>
            {/each}
          </nav>
        </div>
        <div class="mt-3 hidden rounded-xl border border-bark-300 bg-bark-100 p-3 text-xs leading-relaxed text-shadow-500 lg:block">
          Structured fields save through their canonical owner files. Raw JSON edits remain separately staged and never get overwritten by the unified save.
        </div>
      </aside>

      <div class="min-w-0 space-y-5">
        {#if activeTabId === 'providers'}
          <SettingsDelegatedPanels
            {providerRegistry} {providerValidationErrors} {providerRegistryDirty} {saving}
            inputClass={INPUT_CLS} labelClass={LABEL_CLS} toggleClass={TOGGLE_CLS} providerCardClass={PROVIDER_CARD_CLS}
            {addProviderEntry} {removeProviderEntry} {updateProviderEntry} {setProviderType} {setProviderField}
            {saveProviderRegistry} {discardProviderRegistryChanges}
          />
        {:else if activeTabId === 'memory'}
          <SettingsMemoryPanels
            {openSections} {sessionRestartBehaviorOptions}
            inputClass={INPUT_CLS} labelClass={LABEL_CLS} sliderClass={SLIDER_CLS}
            compactInputClass={COMPACT_INPUT_CLS} toggleClass={TOGGLE_CLS}
            {getSource} {getSettingAuthority} {fieldErrors} {toggleSection}
            bind:sessionRestartBehavior bind:sessionHistoryBudgetPct bind:memoryRetrievalBudgetPct
            bind:extractionThresholdPct bind:compactionThresholdPct bind:extractionInterval
            bind:compactionEmotionalSalienceThresholdPct bind:backgroundMaintenanceIntervalMs
            bind:memoryExtractionMinImportance bind:memoryExtractionMinConfidence bind:memoryExtractionMinNovelty
            bind:memoryExtractionMaxWrites bind:memoryExtractionTelemetryEnabled bind:memoryRetrievalTelemetryEnabled
            bind:profileSynthesisEnabled bind:profileSynthesisRefreshIntervalMs bind:profileSynthesisCooldownMs
            bind:profileSynthesisMinWrites bind:profileSynthesisMinImportance bind:profileSynthesisMinConfidence
            bind:profileSynthesisMinNovelty bind:profileSynthesisSourceMemoryLimit bind:profileSynthesisMinSourceMemories
            bind:analysisWorkbenchMaxIterations bind:analysisWorkbenchMaxTokens bind:analysisWorkbenchMaxWallTimeMs bind:analysisWorkbenchMaxSubQueries
          />
        {:else if activeTabId === 'runtime'}
          <SettingsRuntimePanels
            {openSections} {importRouteModeOptions}
            inputClass={INPUT_CLS} labelClass={LABEL_CLS} toggleClass={TOGGLE_CLS}
            {getSource} {fieldErrors} {toggleSection}
            bind:retryMaxAttempts bind:retryBaseDelayMs
            bind:importRouteMode bind:importStrictPolicy bind:importLocalEndpointUrl bind:importLocalModel
            bind:openRouterProviderOrder
            bind:webFetchAllowHttp bind:webFetchDomainAllowlist bind:webFetchAllowInternalNetwork bind:webFetchTlsCaCertPaths
          />
        {:else if activeTabId === 'integrations'}
          <SettingsIntegrationsPanels
            {openSections}
            inputClass={INPUT_CLS} labelClass={LABEL_CLS} toggleClass={TOGGLE_CLS}
            {fieldErrors} {toggleSection}
            bind:ttsProvider bind:sttProvider bind:voiceId bind:deepgramModel
            bind:echoTtsUrl bind:echoTtsVoice bind:echoTtsPreset
            bind:obsidianVaultName bind:obsidianCliPath bind:obsidianAutoPublish bind:obsidianTimeoutMs
            bind:discordTriggerWords bind:discordTriggerReactions bind:discordTriggerListenWindowSeconds
            bind:telegramEnabled bind:telegramAuthorizedUsers
          />
        {:else if activeTabId === 'trust'}
          <SettingsTrustBackupPanels
            {data} {openSections} {capabilityTierOptions}
            inputClass={INPUT_CLS} labelClass={LABEL_CLS} toggleClass={TOGGLE_CLS}
            {getSource} {getSettingAuthority} {rawEditorLabel} {fieldErrors} {toggleSection}
            bind:capabilityTier bind:capabilityCustomTokens
            bind:backupIntervalHours bind:backupMaxRotating bind:backupMaxWeekly bind:backupMaxMonthly
            bind:backupMirrorDir bind:backupVerifyRestore
          />
        {:else}
          <SettingsAdvancedOwnerPanels
            view={activeTabId === 'advanced' ? 'fields' : 'raw'}
            {data} {SECTIONS} {advancedSectionSummaries} {openSections} {MODEL_OWNED_FIELDS}
            {saving} {capabilityTierOptions} {COMPOSITIONAL_CHANNEL_TYPE_OPTIONS} {COMPOSITIONAL_PURPOSE_OPTIONS}
            {toggleSection} {configValue} {setConfigValue} {fieldEditorType} {fieldEnumValues} {fieldContract}
            {fieldMinimum} {fieldMaximum} {isDeprecatedField} {getSource} {hasFieldErrors} {fieldErrors}
            {formatSettingOptionLabel} {humanizeSettingValue} {getCompositionalPolicy} {setCompositionalPolicyEnabled}
            {toggleCompositionalPolicyValue} {hasCompositionalPolicyValue} {settingsJson}
            {rawEditorViews} {rawSaveStatus} {retryingRawEditorKey} {validationErrorsByField}
            {setSettingsJson} {getRawJson} {setRawJson} {saveRawSettings} {saveRawConfig} {retryRawConfig}
          />
        {/if}

        {#if activeTabHasPrimarySave}
          <div class="garden-toolbar card-garden flex flex-wrap items-center gap-3 p-4">
            <button onclick={saveSettings} disabled={saving || !settingsSaveDirty}
              class="garden-action garden-action--primary min-h-10 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors shadow-sm
                {settingsSaveDirty
                  ? 'bg-gold-600 text-white hover:bg-gold-700'
                  : 'bg-bark-300 text-shadow-500 cursor-not-allowed'}"
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
            {#if dirty}
              <span class="text-sm text-shadow-500">You have unsaved changes</span>
            {/if}
            {#if settingsRawEditorDirty}
              <span class="text-sm text-wilt-600">
                settings.json has staged raw edits on the Raw JSON tab — this save is blocked until you save or discard them there.
              </span>
            {:else if rawDirty}
              <span class="text-sm text-shadow-500">
                Staged raw edits are preserved; their owner files are skipped by this save until you save or discard them on the Raw JSON tab.
              </span>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <SettingsEnvironmentSummary env={data?.env as unknown as Record<string, unknown> | undefined} />
</div>
