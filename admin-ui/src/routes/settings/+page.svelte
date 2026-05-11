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
  import {
    SETTINGS_GARDEN_SECTION_FIELDS,
    SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY,
    SETTINGS_GARDEN_RAW_EDITOR_KEYS,
    SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
    type GardenSettingsRawEditorKey,
  } from '$lib/settings-garden-contract';
  import {
    resolveBudgetContextWindowAuthority,
    resolveSettingAuthority,
  } from '$lib/settings/authority';
  import AdvancedSettingsMode from '$lib/components/settings/AdvancedSettingsMode.svelte';
  import ProviderRegistrySection from '$lib/components/settings/ProviderRegistrySection.svelte';
  import RawSettingsMode from '$lib/components/settings/RawSettingsMode.svelte';
  import SettingFieldLabel from '$lib/components/settings/SettingFieldLabel.svelte';
  import SettingAuthorityHint from '$lib/components/settings/SettingAuthorityHint.svelte';
  import SettingsEnvironmentSummary from '$lib/components/settings/SettingsEnvironmentSummary.svelte';
  import SettingsPageChrome from '$lib/components/settings/SettingsPageChrome.svelte';
  import SettingsSidebarNav from '$lib/components/settings/SettingsSidebarNav.svelte';
  import {
    buildSettingsSimpleSectionGroups,
    isSettingsSimpleSectionId,
    parseSettingsSimpleSectionHash,
    resolveActiveSettingsSimpleSection,
    settingsSimpleSectionAnchorId,
    type SettingsSimpleSectionId,
  } from '$lib/components/settings/navigation';
  import { resolveVoiceProviderSelection } from './voice-provider-selection';
  import type { ContextBudgetConfigLike } from '../../../../src/shared/context-budget.js';
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

  const DISABLED_PROVIDER_ID = 'disabled';
  const COMPOSITIONAL_TIER_OPTIONS = ['nursery', 'apprentice', 'autonomous', 'custom'] as const;
  const COMPOSITIONAL_CHANNEL_TYPE_OPTIONS = ['discord', 'terminal', 'api', 'telegram'] as const;
  const COMPOSITIONAL_PURPOSE_OPTIONS = [
    'extraction',
    'retrieval',
    'appraisal',
    'analysis_workbench',
    'shard_context',
  ] as const;
  const DELEGATED_WORKSPACES = [
    {
      label: 'Models',
      href: '/models',
      description: 'Purpose slots, rosters, context windows',
    },
    {
      label: 'Prompts',
      href: '/prompts',
      description: 'Prompt layers and authoring',
    },
    {
      label: 'Scheduler',
      href: '/scheduler',
      description: 'Heartbeat, timers, maintenance work',
    },
    {
      label: 'Theme',
      href: '/theme',
      description: 'Garden appearance controls',
    },
    {
      label: 'Tools',
      href: '/tools',
      description: 'Tool registry, health, failures',
    },
    {
      label: 'Prompt Monitor',
      href: '/prompt-monitor',
      description: 'Prompt assembly and turn observability',
    },
  ] as const;

  type CompositionalListKey = 'allowedTiers' | 'allowedChannelTypes' | 'allowedPurposes';

  interface CompositionalPolicyFormValue {
    enabled: boolean;
    allowedTiers: string[];
    allowedChannelTypes: string[];
    allowedPurposes: string[];
  }

  const ENUM_LABELS_BY_FIELD: Record<string, Record<string, string>> = {
    importProcessingRouteMode: {
      background: 'Background Routing (default)',
      openrouter_zdr: 'OpenRouter ZDR-only',
      local_endpoint: 'Local Endpoint Only',
    },
    sessionRestartBehavior: {
      reuse_latest_session: 'Reuse latest session',
      new_session: 'Always start a new session',
    },
  };

  const SYSTEM_PROMPT_ESTIMATE_TOKENS = 2_500;

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
  type RawEditorKey = GardenSettingsRawEditorKey;

  function buildRawEditorJsonMap(
    resolveValue: (key: RawEditorKey) => string,
  ): Record<RawEditorKey, string> {
    return Object.fromEntries(
      SETTINGS_GARDEN_RAW_EDITOR_KEYS.map((key) => [key, resolveValue(key)]),
    ) as Record<RawEditorKey, string>;
  }

  let initialRawJsonByKey = $state<Record<RawEditorKey, string>>(
    buildRawEditorJsonMap(() => ''),
  );

  function computeSnapshot(): string {
    return JSON.stringify({
      sessionRestartBehavior,
      compositionalPolicy: configValue('compositionalPolicy') ?? null,
      sessionHistoryBudgetPct, memoryRetrievalBudgetPct,
      extractionThresholdPct, compactionThresholdPct,
      maxResponseTokens, retryMaxAttempts, retryBaseDelayMs,
      importRouteMode, importStrictPolicy,
      importLocalEndpointUrl, importLocalModel,
      openRouterProviderOrder, webFetchAllowHttp,
      webFetchDomainAllowlist, webFetchAllowInternalNetwork,
      webFetchTlsCaCertPaths,
      capabilityTier,
      capabilityCustomTokens,
      // Memory & Extraction
      extractionInterval, compactionEmotionalSalienceThresholdPct,
      maintenanceIntervalMs,
      // Memory Extraction Tuning
      memoryExtractionMinImportance, memoryExtractionMinConfidence,
      memoryExtractionMinNovelty, memoryExtractionMaxWrites,
      memoryExtractionTelemetryEnabled, memoryRetrievalTelemetryEnabled,
      // Profile Synthesis
      profileSynthesisEnabled, profileSynthesisRefreshIntervalMs,
      profileSynthesisCooldownMs, profileSynthesisMinWrites,
      profileSynthesisMinImportance, profileSynthesisMinConfidence,
      profileSynthesisMinNovelty, profileSynthesisSourceMemoryLimit,
      profileSynthesisMinSourceMemories,
      // Analysis Workbench
      analysisWorkbenchMaxTokens, analysisWorkbenchMaxWallTimeMs, analysisWorkbenchMaxSubQueries,
      // Voice / TTS
      ttsProvider, voiceId, echoTtsUrl, echoTtsVoice, echoTtsPreset,
      sttProvider, deepgramModel,
      // Obsidian Vault
      obsidianVaultName, obsidianCliPath, obsidianAutoPublish, obsidianTimeoutMs,
      // Channels
      discordTriggerWords, discordTriggerReactions,
      discordTriggerListenWindowSeconds,
      telegramEnabled, telegramAuthorizedUsers,
      // Backup
      backupIntervalHours, backupMaxRotating, backupMaxWeekly,
      backupMaxMonthly, backupMirrorDir, backupVerifyRestore,
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

  // ── Obsidian Vault ──
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
  let backupMirrorDir = $state('/mnt/ai/psfn-bak');
  let backupVerifyRestore = $state(true);
  let rawSaveStatus = $state<Record<string, { ok: boolean; msg: string }>>({});
  let validationErrorsByField = $state<Record<string, string[]>>({});

  // ── Section IA navigation ──
  const SIMPLE_SECTION_ORDER: readonly SettingsSimpleSectionId[] = [
    'models',
    'providers',
    'prompting',
    'memory-budget',
    'memory-extraction',
    'memory-tuning',
    'memory-profile',
    'memory-sessions',
    'tools-analysis-workbench',
    'runtime-llm',
    'runtime-import',
    'runtime-fetch',
    'advanced-fields',
    'integrations-voice',
    'integrations-obsidian',
    'channels',
    'advanced-trust',
    'advanced-secrets',
    'advanced-backup',
    'owner-files',
  ];
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

  // ── Section definitions for advanced canonical fields ──
  interface SectionDef {
    id: string;
    title: string;
    icon: string;
    keys: string[];
    summary: () => string;
  }

  const MODEL_OWNED_FIELDS = new Set<string>(SETTINGS_GARDEN_SECTION_FIELDS.models);

  const SECTIONS: SectionDef[] = [
    {
      id: 'budget', title: 'Context Budget', icon: 'B',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.budget,
      summary: () => `Session ${sessionHistoryBudgetPct}%, Memory ${memoryRetrievalBudgetPct}%`,
    },
    {
      id: 'memory', title: 'Memory & Extraction', icon: 'E',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.memory,
      summary: () => `Extract at ${extractionThresholdPct}% every ${extractionInterval} turn${extractionInterval === 1 ? '' : 's'}`,
    },
    {
      id: 'sessions', title: 'Sessions & Compaction', icon: 'S',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.sessions,
      summary: () => (
        `Compaction at ${compactionThresholdPct}%, ` +
        `Maintenance ${Math.round(maintenanceIntervalMs / 1000)}s, ` +
        `Restart ${sessionRestartBehavior === 'new_session' ? 'new session' : 'reuse latest'}`
      ),
    },
    {
      id: 'extraction-tuning', title: 'Memory Extraction Tuning', icon: 'X',
      keys: SETTINGS_GARDEN_SECTION_FIELDS['extraction-tuning'],
      summary: () => `Min importance: ${memoryExtractionMinImportance}, Max writes: ${memoryExtractionMaxWrites}`,
    },
    {
      id: 'profile', title: 'Profile Synthesis', icon: 'P',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.profile,
      summary: () => profileSynthesisEnabled ? `Enabled, refresh ${Math.round(profileSynthesisRefreshIntervalMs / 60000)}min` : 'Disabled',
    },
    {
      id: 'analysis-workbench', title: 'Analysis Workbench', icon: 'R',
      keys: SETTINGS_GARDEN_SECTION_FIELDS['analysis-workbench'],
      summary: () => `Max tokens: ${analysisWorkbenchMaxTokens.toLocaleString()}, Wall time: ${Math.round(analysisWorkbenchMaxWallTimeMs / 1000)}s`,
    },
    {
      id: 'compositional', title: 'Compositional Cognition', icon: 'K',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.compositional,
      summary: () => summarizeCompositionalPolicy(configValue('compositionalPolicy')),
    },
    {
      id: 'trust', title: 'Trust & Capabilities', icon: 'T',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.trust,
      summary: () => `Tier: ${capabilityTier}`,
    },
    {
      id: 'llm', title: 'LLM Retries & Behavior', icon: 'L',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.llm,
      summary: () => `Max retries: ${retryMaxAttempts}, Base delay: ${retryBaseDelayMs}ms`,
    },
    {
      id: 'import', title: 'Import Processing', icon: 'I',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.import,
      summary: () => `Route: ${importRouteMode}${importStrictPolicy ? ' (strict)' : ''}`,
    },
    {
      id: 'fetch', title: 'Web Fetch Policy', icon: 'W',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.fetch,
      summary: () => {
        const parts: string[] = [];
        parts.push(webFetchAllowHttp ? 'HTTP allowed' : 'HTTPS only');
        if (webFetchAllowInternalNetwork) parts.push('internal LAN');
        return parts.join(', ');
      },
    },
    {
      id: 'voice', title: 'Voice & Speech', icon: 'V',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.voice,
      summary: () => `TTS: ${ttsProvider}, STT: ${sttProvider}`,
    },
    {
      id: 'obsidian', title: 'Obsidian Vault', icon: 'O',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.obsidian,
      summary: () => obsidianVaultName ? `Vault: ${obsidianVaultName}${obsidianAutoPublish ? ', auto-publish' : ''}` : 'Disabled',
    },
    {
      id: 'channels', title: 'Channels', icon: 'C',
      keys: SETTINGS_GARDEN_SECTION_FIELDS.channels,
      summary: () => {
        const wordsCount = splitCsv(discordTriggerWords).length;
        const reactionsCount = splitCsv(discordTriggerReactions).length;
        const windowSeconds = normalizeDiscordListenWindowSeconds(discordTriggerListenWindowSeconds);
        return [
          telegramEnabled ? 'Telegram on' : 'Telegram off',
          `${wordsCount} word trigger${wordsCount === 1 ? '' : 's'}`,
          `${reactionsCount} reaction trigger${reactionsCount === 1 ? '' : 's'}`,
          `${windowSeconds}s listen window`,
        ].join(', ');
      },
    },
  ];

  let advancedSectionSummaries = $derived.by(() => Object.fromEntries(
    SECTIONS.map((section) => [section.id, section.summary()]),
  ));

  const RAW_EDITORS = SETTINGS_GARDEN_RAW_EDITOR_KEYS
    .filter(
      (key): key is Exclude<RawEditorKey, 'settings' | 'models'> => (
        key !== 'settings' && key !== 'models'
      ),
    )
    .map((key) => ({ key }));

  type SchedulerEditorConfig = {
    tickIntervalMs?: number;
    heartbeatIntervalMs?: number;
    salienceDecayIntervalMs?: number;
  };

  type ModelsEditorConfig = Pick<ContextBudgetConfigLike, 'modelCatalog' | 'modelRoleAssignments' | 'modelRoster'>;

  type CapabilitiesEditorConfig = {
    tier?: string;
    customTokens?: string[];
  };

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

  function humanizeSettingValue(value: string): string {
    return value
      .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replaceAll('_', ' ')
      .replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatSettingOptionLabel(field: string, value: string): string {
    return ENUM_LABELS_BY_FIELD[field]?.[value] ?? humanizeSettingValue(value);
  }

  function settingControlId(key: string, suffix = 'input'): string {
    return `settings-${key.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase()}-${suffix}`;
  }

  function settingLabelId(key: string): string {
    return settingControlId(key, 'label');
  }

  function rawEditorOwnerFile(key: RawEditorKey): string {
    const subsystemId = SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY[key];
    return subsystemOwnerFile(subsystemId) ?? SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY[key];
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

  function summarizeCompositionalPolicy(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return 'Disabled';
    }

    const policy = value as {
      enabled?: unknown;
      allowedTiers?: unknown;
      allowedChannelTypes?: unknown;
      allowedPurposes?: unknown;
    };
    if (policy.enabled !== true) {
      return 'Disabled';
    }

    const tierCount = Array.isArray(policy.allowedTiers) ? policy.allowedTiers.length : 0;
    const channelCount = Array.isArray(policy.allowedChannelTypes) ? policy.allowedChannelTypes.length : 0;
    const purposeCount = Array.isArray(policy.allowedPurposes) ? policy.allowedPurposes.length : 0;

    return `Enabled, ${tierCount} tier${tierCount === 1 ? '' : 's'}, `
      + `${channelCount} channel${channelCount === 1 ? '' : 's'}, `
      + `${purposeCount} purpose${purposeCount === 1 ? '' : 's'}`;
  }

  function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(
      value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
    )];
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

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  function buildBudgetPreviewConfig(): ContextBudgetConfigLike | null {
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
  function populateSimpleFields(settingsData: AdminSettingsData) {
    const config = settingsData.config as Record<string, unknown>;
    const scheduler = settingsData.editors?.scheduler as SchedulerEditorConfig | undefined;
    const capabilities = settingsData.editors?.capabilities as CapabilitiesEditorConfig | undefined;
    const maxOutputTokensFromConfig = Number(config.primaryMaxTokens ?? config.extractionMaxTokens ?? 4096);
    sessionRestartBehavior = config.sessionRestartBehavior === 'new_session' ? 'new_session' : 'reuse_latest_session';
    sessionHistoryBudgetPct = Number(config.sessionHistoryBudgetPct ?? 6);
    memoryRetrievalBudgetPct = Number(config.memoryRetrievalBudgetPct ?? 2);
    extractionThresholdPct = Number(config.extractionThresholdPct ?? 30);
    compactionThresholdPct = Number(config.compactionThresholdPct ?? 70);
    maxResponseTokens = Number.isFinite(maxOutputTokensFromConfig) && maxOutputTokensFromConfig > 0
      ? maxOutputTokensFromConfig
      : 4096;
    retryMaxAttempts = Number(config.retryMaxAttempts ?? 3);
    retryBaseDelayMs = Number(config.retryBaseDelayMs ?? 2000);
    importRouteMode = String(config.importProcessingRouteMode ?? 'background');
    importStrictPolicy = Boolean(config.importProcessingStrictPolicy);
    importLocalEndpointUrl = String(config.importProcessingLocalEndpointUrl ?? '');
    importLocalModel = String(config.importProcessingLocalModel ?? '');
    openRouterProviderOrder = Array.isArray(config.openRouterProviderOrder) ? config.openRouterProviderOrder.join(', ') : '';
    webFetchAllowHttp = Boolean(config.webFetchAllowHttp);
    webFetchDomainAllowlist = Array.isArray(config.webFetchDomainAllowlist) ? config.webFetchDomainAllowlist.join(', ') : '';
    webFetchAllowInternalNetwork = Boolean(config.webFetchAllowInternalNetwork);
    webFetchTlsCaCertPaths = Array.isArray(config.webFetchTlsCaCertPaths) ? config.webFetchTlsCaCertPaths.join(', ') : '';
    capabilityTier = String(capabilities?.tier ?? 'apprentice');
    capabilityCustomTokens = Array.isArray(capabilities?.customTokens)
      ? capabilities.customTokens.join(', ')
      : '';

    // Memory & Extraction
    extractionInterval = Number(config.extractionInterval ?? 5);
    compactionEmotionalSalienceThresholdPct = Number(config.compactionEmotionalSalienceThresholdPct ?? 75);
    maintenanceIntervalMs = Number(scheduler?.salienceDecayIntervalMs ?? 300000);

    // Memory Extraction Tuning
    memoryExtractionMinImportance = Number(config.memoryExtractionMinImportance ?? 0.3);
    memoryExtractionMinConfidence = Number(config.memoryExtractionMinConfidence ?? 0.4);
    memoryExtractionMinNovelty = Number(config.memoryExtractionMinNovelty ?? 0.1);
    memoryExtractionMaxWrites = Number(config.memoryExtractionMaxWrites ?? 20);
    memoryExtractionTelemetryEnabled = config.memoryExtractionTelemetryEnabled !== false;
    memoryRetrievalTelemetryEnabled = config.memoryRetrievalTelemetryEnabled !== false;

    // Profile Synthesis
    profileSynthesisEnabled = config.profileSynthesisEnabled !== false;
    profileSynthesisRefreshIntervalMs = Number(config.profileSynthesisRefreshIntervalMs ?? 3600000);
    profileSynthesisCooldownMs = Number(config.profileSynthesisCooldownMs ?? 300000);
    profileSynthesisMinWrites = Number(config.profileSynthesisMinWrites ?? 1);
    profileSynthesisMinImportance = Number(config.profileSynthesisMinImportance ?? 0.65);
    profileSynthesisMinConfidence = Number(config.profileSynthesisMinConfidence ?? 0.7);
    profileSynthesisMinNovelty = Number(config.profileSynthesisMinNovelty ?? 0.12);
    profileSynthesisSourceMemoryLimit = Number(config.profileSynthesisSourceMemoryLimit ?? 16);
    profileSynthesisMinSourceMemories = Number(config.profileSynthesisMinSourceMemories ?? 2);

    // Analysis Workbench
    analysisWorkbenchMaxTokens = Number(config.analysisWorkbenchMaxTokens ?? 76000);
    analysisWorkbenchMaxWallTimeMs = Number(config.analysisWorkbenchMaxWallTimeMs ?? 300000);
    analysisWorkbenchMaxSubQueries = Number(config.analysisWorkbenchMaxSubQueries ?? 12);

    // Voice / TTS
    const providerSelection = resolveVoiceProviderSelection(config);
    ttsProvider = providerSelection.ttsProvider;
    voiceId = String(config.voiceId ?? config.elevenLabsVoiceId ?? '');
    echoTtsUrl = String(config.echoTtsUrl ?? '');
    echoTtsVoice = String(config.echoTtsVoice ?? '');
    echoTtsPreset = String(config.echoTtsPreset ?? '');
    sttProvider = providerSelection.sttProvider;
    deepgramModel = String(config.deepgramModel ?? '');

    // Obsidian Vault
    obsidianVaultName = String(config.obsidianVaultName ?? '');
    obsidianCliPath = String(config.obsidianCliPath ?? 'obsidian');
    obsidianAutoPublish = Boolean(config.obsidianAutoPublish);
    obsidianTimeoutMs = Number(config.obsidianTimeoutMs ?? 10000);

    // Channels
    discordTriggerWords = String(config.discordTriggerWords ?? '');
    discordTriggerReactions = String(config.discordTriggerReactions ?? '👆');
    discordTriggerListenWindowSeconds = normalizeDiscordListenWindowSeconds(
      Number(config.discordTriggerListenWindowMs ?? 120000) / 1000,
    );
    telegramEnabled = Boolean(config.telegramEnabled);
    telegramAuthorizedUsers = String(config.telegramAuthorizedUsers ?? '');
  }

  function tryPrettyPrint(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
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

  function stringFromConfigValue(value: unknown): string {
    if (Array.isArray(value)) {
      return value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .join(', ');
    }
    return typeof value === 'string' ? value : String(value ?? '');
  }

  function numberFromConfigValue(value: unknown, fallback: number): number {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  }

  // Advanced editors write data.config directly; keep overlapping curated controls from saving stale values.
  function syncCuratedFieldFromConfig(key: string, value: unknown): void {
    switch (key) {
      case 'sessionRestartBehavior':
        sessionRestartBehavior = value === 'new_session' ? 'new_session' : 'reuse_latest_session';
        break;
      case 'sessionHistoryBudgetPct':
        sessionHistoryBudgetPct = numberFromConfigValue(value, sessionHistoryBudgetPct);
        break;
      case 'memoryRetrievalBudgetPct':
        memoryRetrievalBudgetPct = numberFromConfigValue(value, memoryRetrievalBudgetPct);
        break;
      case 'extractionThresholdPct':
        extractionThresholdPct = numberFromConfigValue(value, extractionThresholdPct);
        break;
      case 'compactionThresholdPct':
        compactionThresholdPct = numberFromConfigValue(value, compactionThresholdPct);
        break;
      case 'primaryMaxTokens':
      case 'extractionMaxTokens':
        maxResponseTokens = numberFromConfigValue(value, maxResponseTokens);
        break;
      case 'retryMaxAttempts':
        retryMaxAttempts = numberFromConfigValue(value, retryMaxAttempts);
        break;
      case 'retryBaseDelayMs':
        retryBaseDelayMs = numberFromConfigValue(value, retryBaseDelayMs);
        break;
      case 'importProcessingRouteMode':
        importRouteMode = stringFromConfigValue(value);
        break;
      case 'importProcessingStrictPolicy':
        importStrictPolicy = value === true;
        break;
      case 'importProcessingLocalEndpointUrl':
        importLocalEndpointUrl = stringFromConfigValue(value);
        break;
      case 'importProcessingLocalModel':
        importLocalModel = stringFromConfigValue(value);
        break;
      case 'openRouterProviderOrder':
        openRouterProviderOrder = stringFromConfigValue(value);
        break;
      case 'webFetchAllowHttp':
        webFetchAllowHttp = value === true;
        break;
      case 'webFetchDomainAllowlist':
        webFetchDomainAllowlist = stringFromConfigValue(value);
        break;
      case 'webFetchAllowInternalNetwork':
        webFetchAllowInternalNetwork = value === true;
        break;
      case 'webFetchTlsCaCertPaths':
        webFetchTlsCaCertPaths = stringFromConfigValue(value);
        break;
      case 'capabilityTier':
        capabilityTier = stringFromConfigValue(value);
        break;
      case 'customTokens':
        capabilityCustomTokens = stringFromConfigValue(value);
        break;
      case 'extractionInterval':
        extractionInterval = numberFromConfigValue(value, extractionInterval);
        break;
      case 'compactionEmotionalSalienceThresholdPct':
        compactionEmotionalSalienceThresholdPct = numberFromConfigValue(value, compactionEmotionalSalienceThresholdPct);
        break;
      case 'maintenanceIntervalMs':
        maintenanceIntervalMs = numberFromConfigValue(value, maintenanceIntervalMs);
        break;
      case 'memoryExtractionMinImportance':
        memoryExtractionMinImportance = numberFromConfigValue(value, memoryExtractionMinImportance);
        break;
      case 'memoryExtractionMinConfidence':
        memoryExtractionMinConfidence = numberFromConfigValue(value, memoryExtractionMinConfidence);
        break;
      case 'memoryExtractionMinNovelty':
        memoryExtractionMinNovelty = numberFromConfigValue(value, memoryExtractionMinNovelty);
        break;
      case 'memoryExtractionMaxWrites':
        memoryExtractionMaxWrites = numberFromConfigValue(value, memoryExtractionMaxWrites);
        break;
      case 'memoryExtractionTelemetryEnabled':
        memoryExtractionTelemetryEnabled = value === true;
        break;
      case 'memoryRetrievalTelemetryEnabled':
        memoryRetrievalTelemetryEnabled = value === true;
        break;
      case 'profileSynthesisEnabled':
        profileSynthesisEnabled = value === true;
        break;
      case 'profileSynthesisRefreshIntervalMs':
        profileSynthesisRefreshIntervalMs = numberFromConfigValue(value, profileSynthesisRefreshIntervalMs);
        break;
      case 'profileSynthesisCooldownMs':
        profileSynthesisCooldownMs = numberFromConfigValue(value, profileSynthesisCooldownMs);
        break;
      case 'profileSynthesisMinWrites':
        profileSynthesisMinWrites = numberFromConfigValue(value, profileSynthesisMinWrites);
        break;
      case 'profileSynthesisMinImportance':
        profileSynthesisMinImportance = numberFromConfigValue(value, profileSynthesisMinImportance);
        break;
      case 'profileSynthesisMinConfidence':
        profileSynthesisMinConfidence = numberFromConfigValue(value, profileSynthesisMinConfidence);
        break;
      case 'profileSynthesisMinNovelty':
        profileSynthesisMinNovelty = numberFromConfigValue(value, profileSynthesisMinNovelty);
        break;
      case 'profileSynthesisSourceMemoryLimit':
        profileSynthesisSourceMemoryLimit = numberFromConfigValue(value, profileSynthesisSourceMemoryLimit);
        break;
      case 'profileSynthesisMinSourceMemories':
        profileSynthesisMinSourceMemories = numberFromConfigValue(value, profileSynthesisMinSourceMemories);
        break;
      case 'analysisWorkbenchMaxTokens':
        analysisWorkbenchMaxTokens = numberFromConfigValue(value, analysisWorkbenchMaxTokens);
        break;
      case 'analysisWorkbenchMaxWallTimeMs':
        analysisWorkbenchMaxWallTimeMs = numberFromConfigValue(value, analysisWorkbenchMaxWallTimeMs);
        break;
      case 'analysisWorkbenchMaxSubQueries':
        analysisWorkbenchMaxSubQueries = numberFromConfigValue(value, analysisWorkbenchMaxSubQueries);
        break;
      case 'ttsProvider':
        ttsProvider = stringFromConfigValue(value);
        break;
      case 'voiceId':
        voiceId = stringFromConfigValue(value);
        break;
      case 'echoTtsUrl':
        echoTtsUrl = stringFromConfigValue(value);
        break;
      case 'echoTtsVoice':
        echoTtsVoice = stringFromConfigValue(value);
        break;
      case 'echoTtsPreset':
        echoTtsPreset = stringFromConfigValue(value);
        break;
      case 'sttProvider':
        sttProvider = stringFromConfigValue(value);
        break;
      case 'deepgramModel':
        deepgramModel = stringFromConfigValue(value);
        break;
      case 'obsidianVaultName':
        obsidianVaultName = stringFromConfigValue(value);
        break;
      case 'obsidianCliPath':
        obsidianCliPath = stringFromConfigValue(value);
        break;
      case 'obsidianAutoPublish':
        obsidianAutoPublish = value === true;
        break;
      case 'obsidianTimeoutMs':
        obsidianTimeoutMs = numberFromConfigValue(value, obsidianTimeoutMs);
        break;
      case 'discordTriggerWords':
        discordTriggerWords = stringFromConfigValue(value);
        break;
      case 'discordTriggerReactions':
        discordTriggerReactions = stringFromConfigValue(value);
        break;
      case 'discordTriggerListenWindowMs':
        discordTriggerListenWindowSeconds = normalizeDiscordListenWindowSeconds(
          numberFromConfigValue(value, discordTriggerListenWindowSeconds * 1000) / 1000,
        );
        break;
      case 'telegramEnabled':
        telegramEnabled = value === true;
        break;
      case 'telegramAuthorizedUsers':
        telegramAuthorizedUsers = stringFromConfigValue(value);
        break;
    }
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
    return SETTINGS_GARDEN_RAW_EDITOR_KEYS.filter(
      key => current[key] !== initialRawJsonByKey[key],
    );
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

  function fmtTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
    return String(n);
  }

  function fmtMs(ms: number): string {
    if (ms >= 60000) return `${(ms / 60000).toFixed(1)}min`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function splitCsv(str: string): string[] {
    return str.split(',').map(s => s.trim()).filter(Boolean);
  }

  function normalizeDiscordListenWindowSeconds(value: number): number {
    if (!Number.isFinite(value)) return 120;
    return clamp(Math.round(value), 10, 600);
  }

  function collectSimplePayload(): Record<string, unknown> {
    const discordTriggerListenWindowMs = normalizeDiscordListenWindowSeconds(
      discordTriggerListenWindowSeconds,
    ) * 1000;

    return {
      sessionRestartBehavior,
      sessionHistoryBudgetPct,
      memoryRetrievalBudgetPct,
      extractionThresholdPct,
      compactionThresholdPct,
      retryMaxAttempts,
      retryBaseDelayMs,
      importProcessingRouteMode: importRouteMode,
      importProcessingStrictPolicy: importStrictPolicy,
      importProcessingLocalEndpointUrl: importLocalEndpointUrl,
      importProcessingLocalModel: importLocalModel,
      openRouterProviderOrder: splitCsv(openRouterProviderOrder),
      compositionalPolicy: getCompositionalPolicy(),
      webFetchAllowHttp,
      webFetchDomainAllowlist: splitCsv(webFetchDomainAllowlist),
      webFetchAllowInternalNetwork,
      webFetchTlsCaCertPaths: splitCsv(webFetchTlsCaCertPaths),
      // Memory & Extraction
      extractionInterval,
      compactionEmotionalSalienceThresholdPct,
      // Memory Extraction Tuning
      memoryExtractionMinImportance,
      memoryExtractionMinConfidence,
      memoryExtractionMinNovelty,
      memoryExtractionMaxWrites,
      memoryExtractionTelemetryEnabled,
      memoryRetrievalTelemetryEnabled,
      // Profile Synthesis
      profileSynthesisEnabled,
      profileSynthesisRefreshIntervalMs,
      profileSynthesisCooldownMs,
      profileSynthesisMinWrites,
      profileSynthesisMinImportance,
      profileSynthesisMinConfidence,
      profileSynthesisMinNovelty,
      profileSynthesisSourceMemoryLimit,
      profileSynthesisMinSourceMemories,
      // Analysis Workbench
      analysisWorkbenchMaxTokens,
      analysisWorkbenchMaxWallTimeMs,
      analysisWorkbenchMaxSubQueries,
      // Voice / TTS
      ttsProvider,
      voiceId,
      echoTtsUrl,
      echoTtsVoice,
      echoTtsPreset,
      sttProvider,
      deepgramModel,
      // Obsidian Vault
      obsidianVaultName: obsidianVaultName || undefined,
      obsidianCliPath: obsidianCliPath || 'obsidian',
      obsidianAutoPublish,
      obsidianTimeoutMs,
      // Channels
      discordTriggerWords,
      discordTriggerReactions,
      discordTriggerListenWindowMs,
      telegramEnabled,
      telegramAuthorizedUsers,
    };
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

  function populateBackupFields(json: string) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      backupIntervalHours = Number(parsed.intervalHours ?? 12);
      backupMaxRotating = Number(parsed.maxRotatingBackups ?? 9);
      backupMaxWeekly = Number(parsed.maxWeeklyBackups ?? 2);
      backupMaxMonthly = Number(parsed.maxMonthlyBackups ?? 1);
      backupMirrorDir = String(parsed.mirrorDir ?? '/mnt/ai/psfn-bak');
      backupVerifyRestore = parsed.verifyRestore !== false;
    } catch {
      // leave defaults
    }
  }

  function buildBackupPayload(): Record<string, unknown> {
    return {
      intervalHours: backupIntervalHours,
      maxRotatingBackups: backupMaxRotating,
      maxWeeklyBackups: backupMaxWeekly,
      maxMonthlyBackups: backupMaxMonthly,
      mirrorDir: backupMirrorDir,
      verifyRestore: backupVerifyRestore,
    };
  }

  function buildCapabilitiesPayload(): Record<string, unknown> {
    const current = getCapabilitiesEditorConfig();
    const customTokens = capabilityTier === 'custom'
      ? splitCsv(capabilityCustomTokens)
      : (Array.isArray(current.customTokens) ? current.customTokens : []);
    return {
      ...current,
      tier: capabilityTier,
      customTokens,
    };
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
          <section
            id={settingsSimpleSectionAnchorId('models')}
            use:simpleSectionAnchor={'models'}
            class="card-garden p-5 space-y-3"
            data-settings-section="models"
          >
            <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Models</p>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Model Registry and Purpose Routing</h2>
            <p class="text-sm text-shadow-600">
              Purpose-tagged primary/fallback models, model rosters, and context windows are managed in the dedicated Models workspace.
            </p>
            <a
              href={`${base}/models`}
              class="inline-flex items-center rounded-lg border border-gold-400 bg-gold-50 px-3 py-1.5 text-sm font-medium text-shadow-800 hover:bg-gold-100 transition-colors"
            >
              Open Models
            </a>
          </section>

          <section
            id={settingsSimpleSectionAnchorId('prompting')}
            use:simpleSectionAnchor={'prompting'}
            class="card-garden p-5 space-y-3"
            data-settings-section="prompting"
          >
            <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Prompting</p>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Prompt Stack and Authoring</h2>
            <p class="text-sm text-shadow-600">
              Prompt layers and authoring controls live in Prompts. Prompt assembly debugging lives in Prompt Monitor.
            </p>
            <div class="flex flex-wrap gap-2">
              <a
                href={`${base}/prompts`}
                class="inline-flex items-center rounded-lg border border-gold-400 bg-gold-50 px-3 py-1.5 text-sm font-medium text-shadow-800 hover:bg-gold-100 transition-colors"
              >
                Open Prompts
              </a>
              <a
                href={`${base}/prompt-monitor`}
                class="inline-flex items-center rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100 transition-colors"
              >
                Open Prompt Monitor
              </a>
            </div>
          </section>

          <section
            id={settingsSimpleSectionAnchorId('providers')}
            use:simpleSectionAnchor={'providers'}
            class="card-garden p-5 space-y-4"
            data-settings-section="providers"
          >
            <ProviderRegistrySection
              modelsHref={`${base}/models`}
              {providerRegistry}
              {providerValidationErrors}
              {saving}
              isDirty={providerRegistryDirty()}
              inputClass={INPUT_CLS}
              labelClass={LABEL_CLS}
              toggleClass={TOGGLE_CLS}
              providerCardClass={PROVIDER_CARD_CLS}
              {addProviderEntry}
              {removeProviderEntry}
              {updateProviderEntry}
              {setProviderType}
              {setProviderField}
              {saveProviderRegistry}
              {discardProviderRegistryChanges}
            />
          </section>

          <section
            id={settingsSimpleSectionAnchorId('memory-budget')}
            use:simpleSectionAnchor={'memory-budget'}
            class="space-y-5"
            data-settings-section="memory-budget"
          >
      <!-- Budget Preview with bar chart -->
      {#if budgetPreview}
        <div class="card-garden p-6 space-y-4">
          <h2 class="text-sm font-serif font-semibold text-shadow-800">Context Window Allocation</h2>
          <hr class="divider-filigree" />
          <SettingAuthorityHint info={getBudgetContextWindowAuthority()} />

          <!-- Visual bar chart -->
          <div class="space-y-2">
            <div class="flex rounded-lg overflow-hidden h-8 border border-bark-300">
              {#if budgetPreview.sysPct > 0}
                <div class="bg-bark-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
                  style="width: {budgetPreview.sysPct}%"
                  title="System prompt: ~{fmtTokens(budgetPreview.systemPromptTokens)} tokens">
                  {#if budgetPreview.sysPct > 4}<span class="truncate px-1">Sys</span>{/if}
                </div>
              {/if}
              {#if budgetPreview.sessPct > 0}
                <div class="bg-moss-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
                  style="width: {budgetPreview.sessPct}%"
                  title="Session history: ~{fmtTokens(budgetPreview.sessEstimatedTokens)} tokens (~{budgetPreview.sessEstimatedCount} whole messages)">
                  {#if budgetPreview.sessPct > 4}<span class="truncate px-1">Session</span>{/if}
                </div>
              {/if}
              {#if budgetPreview.memPct > 0}
                <div class="bg-gold-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
                  style="width: {budgetPreview.memPct}%"
                  title="Memory retrieval: ~{fmtTokens(budgetPreview.memEstimatedTokens)} tokens (~{budgetPreview.memEstimatedCount} whole memories)">
                  {#if budgetPreview.memPct > 4}<span class="truncate px-1">Memory</span>{/if}
                </div>
              {/if}
              {#if budgetPreview.respPct > 0}
                <div class="bg-petal-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
                  style="width: {budgetPreview.respPct}%"
                  title="Max response: ~{fmtTokens(budgetPreview.maxResponseTokens)} tokens">
                  {#if budgetPreview.respPct > 6}<span class="truncate px-1">Response</span>{/if}
                </div>
              {/if}
              {#if budgetPreview.remainPct > 0}
                <div class="bg-bark-200 flex items-center justify-center text-shadow-600 text-sm font-medium min-w-0 overflow-hidden flex-1"
                  title="Remaining: ~{fmtTokens(budgetPreview.remaining)} tokens">
                  {#if budgetPreview.remainPct > 8}<span class="truncate px-1">Free</span>{/if}
                </div>
              {/if}
            </div>

            <!-- Legend -->
            <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              <span class="flex items-center gap-1.5">
                <span class="w-3 h-3 rounded-sm bg-bark-400 inline-block"></span>
                <span class="text-shadow-700">System: ~{fmtTokens(budgetPreview.systemPromptTokens)}</span>
              </span>
              <span class="flex items-center gap-1.5">
                <span class="w-3 h-3 rounded-sm bg-moss-400 inline-block"></span>
                <span class="text-shadow-700">Session: ~{budgetPreview.sessEstimatedCount} msgs (~{fmtTokens(budgetPreview.sessEstimatedTokens)})</span>
              </span>
              <span class="flex items-center gap-1.5">
                <span class="w-3 h-3 rounded-sm bg-gold-400 inline-block"></span>
                <span class="text-shadow-700">Memory: ~{budgetPreview.memEstimatedCount} items (~{fmtTokens(budgetPreview.memEstimatedTokens)})</span>
              </span>
              <span class="flex items-center gap-1.5">
                <span class="w-3 h-3 rounded-sm bg-petal-400 inline-block"></span>
                <span class="text-shadow-700">Response: {fmtTokens(budgetPreview.maxResponseTokens)}</span>
              </span>
              <span class="flex items-center gap-1.5">
                <span class="w-3 h-3 rounded-sm bg-bark-200 border border-bark-300 inline-block"></span>
                <span class="text-shadow-700">Free: {fmtTokens(budgetPreview.remaining)}</span>
              </span>
            </div>
          </div>

          <!-- Detail cards -->
          <div class="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
            <div class="bg-bark-100 rounded-lg p-3 border border-bark-200">
              <span class="text-shadow-600 block mb-1">Context Window</span>
              <span class="text-shadow-900 font-mono font-semibold">{budgetPreview.contextWindow.toLocaleString()}</span>
              <span class="text-shadow-600"> tokens</span>
              {#if budgetPreview.resolvedChatProvider || budgetPreview.resolvedChatModel}
                <span class="text-shadow-500 block text-sm mt-1">
                  {budgetPreview.resolvedChatProvider ?? 'unknown'} / {budgetPreview.resolvedChatModel ?? 'unknown'}
                </span>
              {/if}
            </div>
            <div class="bg-moss-50 rounded-lg p-3 border border-moss-200">
              <span class="text-shadow-600 block mb-1">Session History</span>
              <span class="text-shadow-900 font-semibold">~{budgetPreview.sessEstimatedCount} messages</span>
              <span class="text-shadow-500 block text-sm">
                ~{fmtTokens(budgetPreview.sessTokenBudget)} token budget, trimmed on whole messages
                {#if budgetPreview.sessionHistoryMinTokens}
                  · floor {fmtTokens(budgetPreview.sessionHistoryMinTokens)}
                {/if}
              </span>
            </div>
            <div class="bg-gold-50 rounded-lg p-3 border border-gold-200">
              <span class="text-shadow-600 block mb-1">Memory Retrieval</span>
              <span class="text-shadow-900 font-semibold">~{budgetPreview.memEstimatedCount} memories</span>
              <span class="text-shadow-500 block text-sm">
                ~{fmtTokens(budgetPreview.memTokenBudget)} token budget, trimmed on whole memories
                {#if budgetPreview.memoryRetrievalMinTokens}
                  · floor {fmtTokens(budgetPreview.memoryRetrievalMinTokens)}
                {/if}
              </span>
            </div>
            <div class="rounded-lg p-3 border {budgetPreview.remaining < 0 ? 'bg-wilt-50 border-wilt-400' : 'bg-bark-100 border-bark-200'}">
              <span class="text-shadow-600 block mb-1">Remaining</span>
              <span class="{budgetPreview.remaining < 0 ? 'text-wilt-600' : 'text-shadow-900'} font-mono font-semibold">{fmtTokens(budgetPreview.remaining)}</span>
              <span class="text-shadow-600"> tokens</span>
              {#if budgetPreview.remaining < 0}
                <span class="text-wilt-600 block text-sm font-medium">Over budget!</span>
              {/if}
            </div>
          </div>

          <div class="rounded-lg border border-bark-200 bg-bark-50 p-4 space-y-3">
            <div>
              <h3 class="text-sm font-medium text-shadow-800">Adaptive Turn Profiles</h3>
              <p class="text-sm text-shadow-600">
                Garden now previews the effective chat slot context window and the same adaptive budget table the runtime uses. Heartbeat and reflection stay on the default companion budget unless their content classifies differently.
              </p>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 text-sm">
              {#each budgetPreview.variants as variant}
                <div class="rounded-lg border border-bark-200 bg-white p-3">
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-medium text-shadow-800">{variant.label}</span>
                    <span class="text-xs uppercase tracking-[0.12em] text-shadow-500">{variant.source}</span>
                  </div>
                  <div class="mt-2 space-y-1 text-shadow-600">
                    <div>Session {variant.sessionBudget.budgetPct}% · ~{variant.sessionBudget.estimatedCount} msgs</div>
                    <div>Memory {variant.memoryBudget.budgetPct}% · ~{variant.memoryBudget.estimatedCount} items</div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/if}

      <!-- Context Budget controls -->
      <div class="card-garden p-6 space-y-6">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Context Budget</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <SettingFieldLabel
              label="Session History Budget %"
              keys="sessionHistoryBudgetPct"
              source={getSource('sessionHistoryBudgetPct')}
              labelId={settingLabelId('sessionHistoryBudgetPct')}
              class={LABEL_CLS}
            />
            <div class="flex items-center gap-3">
              <input id={settingControlId('sessionHistoryBudgetPct', 'range')} aria-labelledby={settingLabelId('sessionHistoryBudgetPct')} type="range" min="1" max="80" step="1" bind:value={sessionHistoryBudgetPct} class={SLIDER_CLS} />
              <input id={settingControlId('sessionHistoryBudgetPct', 'number')} aria-labelledby={settingLabelId('sessionHistoryBudgetPct')} type="number" min="1" max="80" bind:value={sessionHistoryBudgetPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">% of context window for session history (default: 6%). Runtime keeps whole messages within this token budget.</p>
          </div>
          <div>
            <SettingFieldLabel
              label="Memory Retrieval Budget %"
              keys="memoryRetrievalBudgetPct"
              source={getSource('memoryRetrievalBudgetPct')}
              labelId={settingLabelId('memoryRetrievalBudgetPct')}
              class={LABEL_CLS}
            />
            <div class="flex items-center gap-3">
              <input id={settingControlId('memoryRetrievalBudgetPct', 'range')} aria-labelledby={settingLabelId('memoryRetrievalBudgetPct')} type="range" min="1" max="50" step="1" bind:value={memoryRetrievalBudgetPct} class={SLIDER_CLS} />
              <input id={settingControlId('memoryRetrievalBudgetPct', 'number')} aria-labelledby={settingLabelId('memoryRetrievalBudgetPct')} type="number" min="1" max="50" bind:value={memoryRetrievalBudgetPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">% of context window for memory retrieval (default: 2%). Runtime keeps whole memories within this token budget.</p>
          </div>
        </div>
      </div>
      </section>

      <!-- Memory & Extraction -->
      <section
        id={settingsSimpleSectionAnchorId('memory-extraction')}
        use:simpleSectionAnchor={'memory-extraction'}
        data-settings-section="memory-extraction"
      >
      <div class="card-garden p-6 space-y-6">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Memory & Extraction</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <SettingFieldLabel
              label="Extraction Threshold %"
              keys="extractionThresholdPct"
              source={getSource('extractionThresholdPct')}
              labelId={settingLabelId('extractionThresholdPct')}
              class={LABEL_CLS}
            />
            <div class="flex items-center gap-3">
              <input id={settingControlId('extractionThresholdPct', 'range')} aria-labelledby={settingLabelId('extractionThresholdPct')} type="range" min="10" max="80" step="1" bind:value={extractionThresholdPct} class={SLIDER_CLS} />
              <input id={settingControlId('extractionThresholdPct', 'number')} aria-labelledby={settingLabelId('extractionThresholdPct')} type="number" min="10" max="80" bind:value={extractionThresholdPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">Triggers extraction when session exceeds this % of context</p>
          </div>
          <div>
            <SettingFieldLabel label="Extraction Interval (messages)" keys="extractionInterval" forId={settingControlId('extractionInterval')} class={LABEL_CLS} />
            <input id={settingControlId('extractionInterval')} type="number" min="1" max="50" bind:value={extractionInterval} class={INPUT_CLS} />
            <p class="text-sm text-shadow-500 mt-1">Run extraction every N messages (1-50)</p>
          </div>
          <div>
            <SettingFieldLabel
              label="Emotional Salience Threshold %"
              keys="compactionEmotionalSalienceThresholdPct"
              labelId={settingLabelId('compactionEmotionalSalienceThresholdPct')}
              class={LABEL_CLS}
            />
            <div class="flex items-center gap-3">
              <input id={settingControlId('compactionEmotionalSalienceThresholdPct', 'range')} aria-labelledby={settingLabelId('compactionEmotionalSalienceThresholdPct')} type="range" min="0" max="100" step="1" bind:value={compactionEmotionalSalienceThresholdPct} class={SLIDER_CLS} />
              <input id={settingControlId('compactionEmotionalSalienceThresholdPct', 'number')} aria-labelledby={settingLabelId('compactionEmotionalSalienceThresholdPct')} type="number" min="0" max="100" bind:value={compactionEmotionalSalienceThresholdPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">Preserve messages above this emotional salience during compaction (0-100)</p>
          </div>
        </div>
      </div>
      </section>

      <!-- Sessions & Compaction -->
      <section
        id={settingsSimpleSectionAnchorId('memory-sessions')}
        use:simpleSectionAnchor={'memory-sessions'}
        data-settings-section="memory-sessions"
      >
      <div class="card-garden p-6 space-y-6">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Sessions & Compaction</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <SettingFieldLabel
              label="Compaction Threshold %"
              keys="compactionThresholdPct"
              source={getSource('compactionThresholdPct')}
              labelId={settingLabelId('compactionThresholdPct')}
              class={LABEL_CLS}
            />
            <div class="flex items-center gap-3">
              <input id={settingControlId('compactionThresholdPct', 'range')} aria-labelledby={settingLabelId('compactionThresholdPct')} type="range" min="30" max="90" step="1" bind:value={compactionThresholdPct} class={SLIDER_CLS} />
              <input id={settingControlId('compactionThresholdPct', 'number')} aria-labelledby={settingLabelId('compactionThresholdPct')} type="number" min="30" max="90" bind:value={compactionThresholdPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">Auto-compacts oldest 50% when context exceeds this %</p>
          </div>
          <div>
            <SettingFieldLabel
              label="Maintenance Interval (ms)"
              keys="maintenanceIntervalMs"
              source={getSource('maintenanceIntervalMs')}
              forId={settingControlId('maintenanceIntervalMs')}
              class={LABEL_CLS}
            />
            <input id={settingControlId('maintenanceIntervalMs')} type="number" min="10000" step="1000" bind:value={maintenanceIntervalMs} class={INPUT_CLS} />
            <p class="text-sm text-shadow-500 mt-1">Scheduler tick interval in milliseconds (default: 300,000 = 5min)</p>
            <SettingAuthorityHint info={getSettingAuthority('maintenanceIntervalMs')} />
          </div>
          <div>
            <SettingFieldLabel
              label="Restart Behavior"
              keys="sessionRestartBehavior"
              source={getSource('sessionRestartBehavior')}
              forId={settingControlId('sessionRestartBehavior')}
              class={LABEL_CLS}
            />
            <select id={settingControlId('sessionRestartBehavior')} bind:value={sessionRestartBehavior} class={INPUT_CLS}>
              {#each sessionRestartBehaviorOptions as option}
                <option value={option}>{formatSettingOptionLabel('sessionRestartBehavior', option)}</option>
              {/each}
            </select>
            <p class="text-sm text-shadow-500 mt-1">Choose whether startup resumes the latest session or seeds a fresh one.</p>
          </div>
        </div>
        <div class="rounded-xl border border-bark-200 bg-bark-50 p-3 text-sm text-shadow-700">
          Heartbeat schedules, one-shot timers, and maintenance queue state are delegated to Scheduler.
          <a href={`${base}/scheduler`} class="ml-1 font-medium text-gold-700 hover:text-gold-800">Open Scheduler</a>
        </div>
      </div>
      </section>

      <!-- Memory Extraction Tuning (collapsible) -->
      <section
        id={settingsSimpleSectionAnchorId('memory-tuning')}
        use:simpleSectionAnchor={'memory-tuning'}
        data-settings-section="memory-tuning"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('extraction-tuning')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">X</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Memory Extraction Tuning</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('extraction-tuning')}
              <span class="text-sm text-shadow-500">Min importance: {memoryExtractionMinImportance}, Max writes: {memoryExtractionMaxWrites}</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('extraction-tuning') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('extraction-tuning')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SettingFieldLabel label="Min Importance" keys="memoryExtractionMinImportance" forId={settingControlId('memoryExtractionMinImportance')} class={LABEL_CLS} />
                <input id={settingControlId('memoryExtractionMinImportance')} type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinImportance} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum importance score to write a memory (0-1)</p>
              </div>
              <div>
                <SettingFieldLabel label="Min Confidence" keys="memoryExtractionMinConfidence" forId={settingControlId('memoryExtractionMinConfidence')} class={LABEL_CLS} />
                <input id={settingControlId('memoryExtractionMinConfidence')} type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinConfidence} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum confidence score to write a memory (0-1)</p>
              </div>
              <div>
                <SettingFieldLabel label="Min Novelty" keys="memoryExtractionMinNovelty" forId={settingControlId('memoryExtractionMinNovelty')} class={LABEL_CLS} />
                <input id={settingControlId('memoryExtractionMinNovelty')} type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinNovelty} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum novelty score to write a memory (0-1)</p>
              </div>
              <div>
                <SettingFieldLabel label="Max Writes per Extraction" keys="memoryExtractionMaxWrites" forId={settingControlId('memoryExtractionMaxWrites')} class={LABEL_CLS} />
                <input id={settingControlId('memoryExtractionMaxWrites')} type="number" min="1" max="100" step="1" bind:value={memoryExtractionMaxWrites} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Maximum memories written per extraction cycle</p>
              </div>
              <div>
                <SettingFieldLabel label="Extraction Telemetry" keys="memoryExtractionTelemetryEnabled" labelId={settingLabelId('memoryExtractionTelemetryEnabled')} class={LABEL_CLS} />
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input id={settingControlId('memoryExtractionTelemetryEnabled')} aria-labelledby={settingLabelId('memoryExtractionTelemetryEnabled')} type="checkbox" bind:checked={memoryExtractionTelemetryEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Log extraction telemetry data</span>
                </label>
              </div>
              <div>
                <SettingFieldLabel label="Retrieval Telemetry" keys="memoryRetrievalTelemetryEnabled" labelId={settingLabelId('memoryRetrievalTelemetryEnabled')} class={LABEL_CLS} />
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input id={settingControlId('memoryRetrievalTelemetryEnabled')} aria-labelledby={settingLabelId('memoryRetrievalTelemetryEnabled')} type="checkbox" bind:checked={memoryRetrievalTelemetryEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Log retrieval telemetry data</span>
                </label>
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Profile Synthesis (collapsible) -->
      <section
        id={settingsSimpleSectionAnchorId('memory-profile')}
        use:simpleSectionAnchor={'memory-profile'}
        data-settings-section="memory-profile"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('profile')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">P</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Profile Synthesis</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('profile')}
              <span class="text-sm text-shadow-500">{profileSynthesisEnabled ? 'Enabled' : 'Disabled'}</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('profile') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('profile')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SettingFieldLabel label="Enabled" keys="profileSynthesisEnabled" labelId={settingLabelId('profileSynthesisEnabled')} class={LABEL_CLS} />
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input id={settingControlId('profileSynthesisEnabled')} aria-labelledby={settingLabelId('profileSynthesisEnabled')} type="checkbox" bind:checked={profileSynthesisEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Enable automatic profile synthesis</span>
                </label>
              </div>
              <div>
                <SettingFieldLabel label="Refresh Interval (ms)" keys="profileSynthesisRefreshIntervalMs" forId={settingControlId('profileSynthesisRefreshIntervalMs')} class={LABEL_CLS} />
                <input id={settingControlId('profileSynthesisRefreshIntervalMs')} type="number" min="60000" step="60000" bind:value={profileSynthesisRefreshIntervalMs} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">How often to refresh profiles ({fmtMs(profileSynthesisRefreshIntervalMs)})</p>
              </div>
              <div>
                <SettingFieldLabel label="Cooldown (ms)" keys="profileSynthesisCooldownMs" forId={settingControlId('profileSynthesisCooldownMs')} class={LABEL_CLS} />
                <input id={settingControlId('profileSynthesisCooldownMs')} type="number" min="10000" step="10000" bind:value={profileSynthesisCooldownMs} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum wait between profile updates ({fmtMs(profileSynthesisCooldownMs)})</p>
              </div>
              <div>
                <SettingFieldLabel label="Min Writes" keys="profileSynthesisMinWrites" forId={settingControlId('profileSynthesisMinWrites')} class={LABEL_CLS} />
                <input id={settingControlId('profileSynthesisMinWrites')} type="number" min="1" max="100" step="1" bind:value={profileSynthesisMinWrites} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum memory writes before triggering synthesis</p>
              </div>
              <div>
                <SettingFieldLabel label="Min Importance" keys="profileSynthesisMinImportance" forId={settingControlId('profileSynthesisMinImportance')} class={LABEL_CLS} />
                <input id={settingControlId('profileSynthesisMinImportance')} type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinImportance} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum importance for source memories (0-1)</p>
              </div>
              <div>
                <SettingFieldLabel label="Min Confidence" keys="profileSynthesisMinConfidence" forId={settingControlId('profileSynthesisMinConfidence')} class={LABEL_CLS} />
                <input id={settingControlId('profileSynthesisMinConfidence')} type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinConfidence} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum confidence for source memories (0-1)</p>
              </div>
              <div>
                <SettingFieldLabel label="Min Novelty" keys="profileSynthesisMinNovelty" forId={settingControlId('profileSynthesisMinNovelty')} class={LABEL_CLS} />
                <input id={settingControlId('profileSynthesisMinNovelty')} type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinNovelty} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum novelty for source memories (0-1)</p>
              </div>
              <div>
                <SettingFieldLabel label="Source Memory Limit" keys="profileSynthesisSourceMemoryLimit" forId={settingControlId('profileSynthesisSourceMemoryLimit')} class={LABEL_CLS} />
                <input id={settingControlId('profileSynthesisSourceMemoryLimit')} type="number" min="1" max="200" step="1" bind:value={profileSynthesisSourceMemoryLimit} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Max source memories to consider per synthesis</p>
              </div>
              <div>
                <SettingFieldLabel label="Min Source Memories" keys="profileSynthesisMinSourceMemories" forId={settingControlId('profileSynthesisMinSourceMemories')} class={LABEL_CLS} />
                <input id={settingControlId('profileSynthesisMinSourceMemories')} type="number" min="1" max="50" step="1" bind:value={profileSynthesisMinSourceMemories} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum source memories required to run synthesis</p>
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Analysis Workbench (collapsible) -->
      <section
        id={settingsSimpleSectionAnchorId('tools-analysis-workbench')}
        use:simpleSectionAnchor={'tools-analysis-workbench'}
        data-settings-section="tools-analysis-workbench"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('analysis-workbench')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">R</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Analysis Workbench (RLM Sandbox)</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('analysis-workbench')}
              <span class="text-sm text-shadow-500">Max: {fmtTokens(analysisWorkbenchMaxTokens)} tokens, {fmtMs(analysisWorkbenchMaxWallTimeMs)}, {analysisWorkbenchMaxSubQueries} queries</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('analysis-workbench') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('analysis-workbench')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div>
                <SettingFieldLabel label="Max Tokens" keys="analysisWorkbenchMaxTokens" forId={settingControlId('analysisWorkbenchMaxTokens')} class={LABEL_CLS} />
                <input id={settingControlId('analysisWorkbenchMaxTokens')} type="number" min="1000" max="1000000" step="1000" bind:value={analysisWorkbenchMaxTokens} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Max tokens for RLM sandbox (1K-1M)</p>
              </div>
              <div>
                <SettingFieldLabel label="Max Wall Time (ms)" keys="analysisWorkbenchMaxWallTimeMs" forId={settingControlId('analysisWorkbenchMaxWallTimeMs')} class={LABEL_CLS} />
                <input id={settingControlId('analysisWorkbenchMaxWallTimeMs')} type="number" min="5000" max="600000" step="1000" bind:value={analysisWorkbenchMaxWallTimeMs} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Max wall-clock time ({fmtMs(analysisWorkbenchMaxWallTimeMs)})</p>
              </div>
              <div>
                <SettingFieldLabel label="Max Sub-Queries" keys="analysisWorkbenchMaxSubQueries" forId={settingControlId('analysisWorkbenchMaxSubQueries')} class={LABEL_CLS} />
                <input id={settingControlId('analysisWorkbenchMaxSubQueries')} type="number" min="1" max="100" step="1" bind:value={analysisWorkbenchMaxSubQueries} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Max LLM sub-queries per analysis workbench run (1-100)</p>
              </div>
            </div>
            <div class="mt-4 rounded-xl border border-bark-200 bg-bark-50 p-3 text-sm text-shadow-700">
              Tool availability, health, and recent failures are delegated to Tools.
              <a href={`${base}/tools`} class="ml-1 font-medium text-gold-700 hover:text-gold-800">Open Tools</a>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Trust & Capability (collapsible) -->
      <section
        id={settingsSimpleSectionAnchorId('advanced-trust')}
        use:simpleSectionAnchor={'advanced-trust'}
        data-settings-section="advanced-trust"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('trust')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">T</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Trust & Capabilities</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('trust')}
              <span class="text-sm text-shadow-500">Tier: {capabilityTier}</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('trust') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('trust')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SettingFieldLabel
                  label="Capability Tier"
                  keys="capabilityTier"
                  source={getSource('capabilityTier')}
                  forId={settingControlId('capabilityTier')}
                  class={LABEL_CLS}
                />
                <select id={settingControlId('capabilityTier')} bind:value={capabilityTier} class={INPUT_CLS}>
                  {#each capabilityTierOptions as tier}
                    <option value={tier}>{formatSettingOptionLabel('capabilityTier', tier)}</option>
                  {/each}
                </select>
                <p class="text-sm text-shadow-500 mt-1">Controls agent autonomy level</p>
                <SettingAuthorityHint info={getSettingAuthority('capabilityTier')} />
              </div>
              <div class="md:col-span-2">
                <SettingFieldLabel
                  label="Custom Capability Tokens"
                  keys="customTokens"
                  source={getSource('customTokens')}
                  forId={settingControlId('customTokens')}
                  class={LABEL_CLS}
                />
                <input
                  id={settingControlId('customTokens')}
                  type="text"
                  bind:value={capabilityCustomTokens}
                  class={INPUT_CLS}
                  placeholder="identity.read, git.read"
                  disabled={capabilityTier !== 'custom'}
                />
                <p class="text-sm text-shadow-500 mt-1">
                  Comma-separated capability tokens for the <span class="font-mono">custom</span> tier. Saved to {rawEditorLabel('capabilities')}.
                </p>
                <SettingAuthorityHint info={getSettingAuthority('customTokens')} />
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Memory Backup -->
      <section
        id={settingsSimpleSectionAnchorId('advanced-backup')}
        use:simpleSectionAnchor={'advanced-backup'}
        data-settings-section="advanced-backup"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('backup')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">B</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Backups</h2>
          </div>
          <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('backup') ? 'rotate-180' : ''}">&#9660;</span>
        </button>
        {#if openSections.has('backup')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SettingFieldLabel label="Interval (hours)" keys="intervalHours" forId={settingControlId('intervalHours')} class={LABEL_CLS} />
                <input id={settingControlId('intervalHours')} type="number" min="1" max="168" bind:value={backupIntervalHours} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">How often to run a backup cycle</p>
              </div>
              <div>
                <SettingFieldLabel label="Rotating backups" keys="maxRotatingBackups" forId={settingControlId('maxRotatingBackups')} class={LABEL_CLS} />
                <input id={settingControlId('maxRotatingBackups')} type="number" min="1" max="99" bind:value={backupMaxRotating} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Most-recent backups to keep</p>
              </div>
              <div>
                <SettingFieldLabel label="Weekly backups" keys="maxWeeklyBackups" forId={settingControlId('maxWeeklyBackups')} class={LABEL_CLS} />
                <input id={settingControlId('maxWeeklyBackups')} type="number" min="0" max="52" bind:value={backupMaxWeekly} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Weekly slots (derived from rotating cycle)</p>
              </div>
              <div>
                <SettingFieldLabel label="Monthly backups" keys="maxMonthlyBackups" forId={settingControlId('maxMonthlyBackups')} class={LABEL_CLS} />
                <input id={settingControlId('maxMonthlyBackups')} type="number" min="0" max="24" bind:value={backupMaxMonthly} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Monthly slots (derived from rotating cycle)</p>
              </div>
              <div class="md:col-span-2">
                <SettingFieldLabel label="Mirror directory" keys="mirrorDir" forId={settingControlId('mirrorDir')} class={LABEL_CLS} />
                <input id={settingControlId('mirrorDir')} type="text" bind:value={backupMirrorDir} class={INPUT_CLS} placeholder="/mnt/ai/psfn-bak" />
                <p class="text-sm text-shadow-500 mt-1">Secondary backup mirror path (leave blank to disable)</p>
              </div>
              <div class="md:col-span-2 flex items-center gap-3">
                <input type="checkbox" id="backup-verify-restore" bind:checked={backupVerifyRestore} class={TOGGLE_CLS} />
                <label for="backup-verify-restore" class="text-sm text-shadow-700">
                  Verify restore integrity after each backup
                  <code class="ml-1.5 rounded-md border border-bark-200 bg-bark-100 px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold text-shadow-600">verifyRestore</code>
                </label>
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- LLM Retries (collapsible) -->
      <section
        id={settingsSimpleSectionAnchorId('runtime-llm')}
        use:simpleSectionAnchor={'runtime-llm'}
        data-settings-section="runtime-llm"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('llm')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">L</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">LLM Retries & Behavior</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('llm')}
              <span class="text-sm text-shadow-500">Retries: {retryMaxAttempts}, Delay: {retryBaseDelayMs}ms</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('llm') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('llm')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SettingFieldLabel label="LLM Max Retries" keys="retryMaxAttempts" forId={settingControlId('retryMaxAttempts')} class={LABEL_CLS} />
                <input id={settingControlId('retryMaxAttempts')} type="number" min="0" max="10" bind:value={retryMaxAttempts} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Maximum retry attempts (0-10)</p>
              </div>
              <div>
                <SettingFieldLabel label="Retry Base Delay (ms)" keys="retryBaseDelayMs" forId={settingControlId('retryBaseDelayMs')} class={LABEL_CLS} />
                <input id={settingControlId('retryBaseDelayMs')} type="number" min="500" max="30000" step="100" bind:value={retryBaseDelayMs} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Base delay between retries (500-30,000ms)</p>
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Import Processing (collapsible) -->
      <section
        id={settingsSimpleSectionAnchorId('runtime-import')}
        use:simpleSectionAnchor={'runtime-import'}
        data-settings-section="runtime-import"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('import')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">I</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Import Processing</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('import')}
              <span class="text-sm text-shadow-500">Route: {importRouteMode}{importStrictPolicy ? ' (strict)' : ''}</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('import') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('import')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SettingFieldLabel
                  label="Route Mode"
                  keys="importProcessingRouteMode"
                  source={getSource('importProcessingRouteMode')}
                  forId={settingControlId('importProcessingRouteMode')}
                  class={LABEL_CLS}
                />
                <select id={settingControlId('importProcessingRouteMode')} bind:value={importRouteMode} class={INPUT_CLS}>
                  {#each importRouteModeOptions as option}
                    <option value={option}>{formatSettingOptionLabel('importProcessingRouteMode', option)}</option>
                  {/each}
                </select>
              </div>
              <div>
                <SettingFieldLabel label="Strict Policy" keys="importProcessingStrictPolicy" labelId={settingLabelId('importProcessingStrictPolicy')} class={LABEL_CLS} />
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input id={settingControlId('importProcessingStrictPolicy')} aria-labelledby={settingLabelId('importProcessingStrictPolicy')} type="checkbox" bind:checked={importStrictPolicy} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Enforce strict ZDR compliance</span>
                </label>
              </div>
              <div>
                <SettingFieldLabel label="OpenRouter Provider Order" keys="openRouterProviderOrder" forId={settingControlId('openRouterProviderOrder')} class={LABEL_CLS} />
                <input id={settingControlId('openRouterProviderOrder')} type="text" bind:value={openRouterProviderOrder} class={INPUT_CLS} placeholder="comma-separated providers" />
                <p class="text-sm text-shadow-500 mt-1">Global/import fallback order for provider routing.</p>
              </div>
              <div>
                <SettingFieldLabel label="Local Endpoint URL" keys="importProcessingLocalEndpointUrl" forId={settingControlId('importProcessingLocalEndpointUrl')} class={LABEL_CLS} />
                <input id={settingControlId('importProcessingLocalEndpointUrl')} type="text" bind:value={importLocalEndpointUrl} class={INPUT_CLS} placeholder="http://localhost:8080" />
              </div>
              <div>
                <SettingFieldLabel label="Local Model" keys="importProcessingLocalModel" forId={settingControlId('importProcessingLocalModel')} class={LABEL_CLS} />
                <input id={settingControlId('importProcessingLocalModel')} type="text" bind:value={importLocalModel} class={INPUT_CLS} placeholder="model name" />
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Gateway Web Fetch (collapsible) -->
      <section
        id={settingsSimpleSectionAnchorId('runtime-fetch')}
        use:simpleSectionAnchor={'runtime-fetch'}
        data-settings-section="runtime-fetch"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('fetch')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">W</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Web Fetch Policy</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('fetch')}
              <span class="text-sm text-shadow-500">{webFetchAllowHttp ? 'HTTP allowed' : 'HTTPS only'}{webFetchAllowInternalNetwork ? ', internal LAN' : ''}</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('fetch') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('fetch')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SettingFieldLabel label="Allow Internal Network Access" keys="webFetchAllowInternalNetwork" labelId={settingLabelId('webFetchAllowInternalNetwork')} class={LABEL_CLS} />
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input id={settingControlId('webFetchAllowInternalNetwork')} aria-labelledby={settingLabelId('webFetchAllowInternalNetwork')} type="checkbox" bind:checked={webFetchAllowInternalNetwork} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Allow fetching from RFC1918 / LAN hosts (cloud metadata still blocked)</span>
                </label>
              </div>
              <div>
                <SettingFieldLabel label="Allow Non-HTTPS" keys="webFetchAllowHttp" labelId={settingLabelId('webFetchAllowHttp')} class={LABEL_CLS} />
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input id={settingControlId('webFetchAllowHttp')} aria-labelledby={settingLabelId('webFetchAllowHttp')} type="checkbox" bind:checked={webFetchAllowHttp} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Allow HTTP (non-encrypted) web fetch requests</span>
                </label>
              </div>
              <div>
                <SettingFieldLabel label="Domain Allowlist" keys="webFetchDomainAllowlist" forId={settingControlId('webFetchDomainAllowlist')} class={LABEL_CLS} />
                <input id={settingControlId('webFetchDomainAllowlist')} type="text" bind:value={webFetchDomainAllowlist} class={INPUT_CLS} placeholder="comma-separated domains (e.g. example.local, internal.corp)" />
              </div>
              <div>
                <SettingFieldLabel label="TLS CA Cert Paths" keys="webFetchTlsCaCertPaths" forId={settingControlId('webFetchTlsCaCertPaths')} class={LABEL_CLS} />
                <input id={settingControlId('webFetchTlsCaCertPaths')} type="text" bind:value={webFetchTlsCaCertPaths} class={INPUT_CLS} placeholder="comma-separated file paths" />
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Voice & TTS -->
      <section
        id={settingsSimpleSectionAnchorId('integrations-voice')}
        use:simpleSectionAnchor={'integrations-voice'}
        data-settings-section="integrations-voice"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('voice')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-bark-200 text-shadow-600 text-sm font-bold border border-bark-400">V</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Voice & TTS</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('voice')}
              <span class="text-sm text-shadow-500">TTS: {ttsProvider}, STT: {sttProvider}</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('voice') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('voice')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SettingFieldLabel label="TTS Provider" keys="ttsProvider" forId={settingControlId('ttsProvider')} class={LABEL_CLS} />
                <input id={settingControlId('ttsProvider')} type="text" bind:value={ttsProvider} list="tts-provider-list" class={INPUT_CLS} placeholder="disabled or provider id" />
                <p class="text-sm text-shadow-500 mt-1">Registered provider ids from the backend registry are suggested, and any current provider id is preserved and sent back unchanged.</p>
              </div>
              <div>
                <SettingFieldLabel label="STT Provider" keys="sttProvider" forId={settingControlId('sttProvider')} class={LABEL_CLS} />
                <input id={settingControlId('sttProvider')} type="text" bind:value={sttProvider} list="stt-provider-list" class={INPUT_CLS} placeholder="disabled or provider id" />
                <p class="text-sm text-shadow-500 mt-1">Registered provider ids from the backend registry are suggested, and plugin ids are preserved instead of being coerced to disabled.</p>
              </div>
              <div>
                <SettingFieldLabel label="ElevenLabs Voice ID" keys="voiceId" forId={settingControlId('voiceId')} class={LABEL_CLS} />
                <input id={settingControlId('voiceId')} type="text" bind:value={voiceId} class={INPUT_CLS} placeholder="your-voice-id" />
                <p class="text-sm text-shadow-500 mt-1">Leave blank to clear persisted voice override.</p>
              </div>
              <div>
                <SettingFieldLabel label="Deepgram Model" keys="deepgramModel" forId={settingControlId('deepgramModel')} class={LABEL_CLS} />
                <input id={settingControlId('deepgramModel')} type="text" bind:value={deepgramModel} class={INPUT_CLS} placeholder="Deepgram model id" />
                <p class="text-sm text-shadow-500 mt-1">Leave blank to clear persisted model override.</p>
              </div>
              <div>
                <SettingFieldLabel label="Echo TTS URL" keys="echoTtsUrl" forId={settingControlId('echoTtsUrl')} class={LABEL_CLS} />
                <input id={settingControlId('echoTtsUrl')} type="text" bind:value={echoTtsUrl} class={INPUT_CLS} placeholder="http://127.0.0.1:8001/v1/audio/speech" />
              </div>
              <div>
                <SettingFieldLabel label="Echo TTS Voice" keys="echoTtsVoice" forId={settingControlId('echoTtsVoice')} class={LABEL_CLS} />
                <input id={settingControlId('echoTtsVoice')} type="text" bind:value={echoTtsVoice} class={INPUT_CLS} placeholder="11labs-Allison" />
              </div>
              <div class="md:col-span-2">
                <SettingFieldLabel label="Echo TTS Preset" keys="echoTtsPreset" forId={settingControlId('echoTtsPreset')} class={LABEL_CLS} />
                <input id={settingControlId('echoTtsPreset')} type="text" bind:value={echoTtsPreset} class={INPUT_CLS} placeholder="Independent-High-Speaker-CFG" />
              </div>
            </div>
            <div class="mt-4 bg-bark-100 rounded-lg p-4 border border-bark-200">
              <p class="text-sm text-shadow-700">
                Secrets and API credentials stay server-side in environment variables. Provider changes are applied at runtime wiring points and may require restart for active voice sessions.
              </p>
              <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div class="text-sm">
                  <span class="font-medium text-shadow-800">ElevenLabs credentials:</span>
                  <span class="text-shadow-600 ml-1 font-mono">ELEVENLABS_API_KEY</span>
                </div>
                <div class="text-sm">
                  <span class="font-medium text-shadow-800">Deepgram credentials:</span>
                  <span class="text-shadow-600 ml-1 font-mono">DEEPGRAM_API_KEY</span>
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Obsidian Vault -->
      <section
        id={settingsSimpleSectionAnchorId('integrations-obsidian')}
        use:simpleSectionAnchor={'integrations-obsidian'}
        data-settings-section="integrations-obsidian"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('obsidian')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-bark-200 text-shadow-600 text-sm font-bold border border-bark-400">O</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Obsidian Vault</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('obsidian')}
              <span class="text-xs text-shadow-600">{obsidianVaultName ? `Vault: ${obsidianVaultName}` : 'Disabled'}</span>
            {/if}
            <span class="text-shadow-500">{openSections.has('obsidian') ? '−' : '+'}</span>
          </div>
        </button>
        {#if openSections.has('obsidian')}
          <div class="px-5 py-4 space-y-4 border-t border-bark-200">
            <div>
              <SettingFieldLabel
                label="Vault Name"
                keys="obsidianVaultName"
                forId="obsidianVaultName"
                class="block text-xs font-semibold text-shadow-700 mb-1"
              />
              <input type="text" id="obsidianVaultName" class="input-garden w-full" bind:value={obsidianVaultName} placeholder="e.g. companion" />
              <p class="text-xs text-shadow-500 mt-0.5">Leave empty to disable vault tools. Must match the name in Obsidian.</p>
            </div>
            <div>
              <SettingFieldLabel
                label="CLI Path"
                keys="obsidianCliPath"
                forId="obsidianCliPath"
                class="block text-xs font-semibold text-shadow-700 mb-1"
              />
              <input type="text" id="obsidianCliPath" class="input-garden w-full" bind:value={obsidianCliPath} placeholder="obsidian" />
              <p class="text-xs text-shadow-500 mt-0.5">Path to the Obsidian CLI binary. Default: obsidian</p>
            </div>
            <div class="flex items-center gap-3">
              <input type="checkbox" id="obsidianAutoPublish" class="rounded border-bark-400" bind:checked={obsidianAutoPublish} />
              <label class="text-xs font-semibold text-shadow-700" for="obsidianAutoPublish">
                Auto-publish reflections to vault
                <code class="ml-1.5 rounded-md border border-bark-200 bg-bark-100 px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold text-shadow-600">obsidianAutoPublish</code>
              </label>
            </div>
            <div>
              <SettingFieldLabel
                label="CLI Timeout (ms)"
                keys="obsidianTimeoutMs"
                forId="obsidianTimeoutMs"
                class="block text-xs font-semibold text-shadow-700 mb-1"
              />
              <input type="number" id="obsidianTimeoutMs" class="input-garden w-28" bind:value={obsidianTimeoutMs} min={1000} max={30000} step={1000} />
              <p class="text-xs text-shadow-500 mt-0.5">Timeout for CLI commands (1000-30000ms)</p>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Channels -->
      <section
        id={settingsSimpleSectionAnchorId('channels')}
        use:simpleSectionAnchor={'channels'}
        data-settings-section="channels"
      >
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('channels')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-bark-200 text-shadow-600 text-sm font-bold border border-bark-400">C</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Channels</h2>
          </div>
            <div class="flex items-center gap-3">
              {#if !openSections.has('channels')}
                <span class="text-sm text-shadow-500">
                {discordTriggerListenWindowSeconds}s listen window, {telegramEnabled ? 'Telegram on' : 'Telegram off'}
                </span>
              {/if}
              <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('channels') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('channels')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4 space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div class="md:col-span-2">
                <SettingFieldLabel label="Discord Trigger Words" keys="discordTriggerWords" forId={settingControlId('discordTriggerWords')} class={LABEL_CLS} />
                <input id={settingControlId('discordTriggerWords')} type="text" bind:value={discordTriggerWords} class={INPUT_CLS} placeholder="pixie, hey companion" />
                <p class="text-sm text-shadow-500 mt-1">
                  Comma-separated words or phrases that trigger replies in guild channels.
                </p>
              </div>
              <div class="md:col-span-2">
                <SettingFieldLabel label="Discord Trigger Reactions" keys="discordTriggerReactions" forId={settingControlId('discordTriggerReactions')} class={LABEL_CLS} />
                <input id={settingControlId('discordTriggerReactions')} type="text" bind:value={discordTriggerReactions} class={INPUT_CLS} placeholder="👆, 🔥, 👀" />
                <p class="text-sm text-shadow-500 mt-1">
                  Comma-separated emoji reactions that open a Discord follow-up window.
                </p>
              </div>
              <div>
                <SettingFieldLabel label="Discord Listen Window (seconds)" keys="discordTriggerListenWindowMs" forId={settingControlId('discordTriggerListenWindowMs')} class={LABEL_CLS} />
                <input
                  id={settingControlId('discordTriggerListenWindowMs')}
                  type="number"
                  min="10"
                  max="600"
                  step="1"
                  value={discordTriggerListenWindowSeconds}
                  onchange={(e) => {
                    discordTriggerListenWindowSeconds = normalizeDiscordListenWindowSeconds(
                      Number((e.target as HTMLInputElement).value),
                    );
                  }}
                  class={INPUT_CLS}
                />
                <p class="text-sm text-shadow-500 mt-1">
                  After a trigger, accept follow-up Discord messages for this long (10-600s). Saved as milliseconds.
                </p>
              </div>
              <div>
                <SettingFieldLabel label="Telegram Enabled" keys="telegramEnabled" labelId={settingLabelId('telegramEnabled')} class={LABEL_CLS} />
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input id={settingControlId('telegramEnabled')} aria-labelledby={settingLabelId('telegramEnabled')} type="checkbox" bind:checked={telegramEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Enable Telegram channel bridge</span>
                </label>
              </div>
              <div class="md:col-span-2">
                <SettingFieldLabel label="Telegram Authorized Users" keys="telegramAuthorizedUsers" forId={settingControlId('telegramAuthorizedUsers')} class={LABEL_CLS} />
                <input id={settingControlId('telegramAuthorizedUsers')} type="text" bind:value={telegramAuthorizedUsers} class={INPUT_CLS} placeholder="12345678, 87654321" />
                <p class="text-sm text-shadow-500 mt-1">Comma-separated Telegram user IDs allowed to interact.</p>
              </div>
            </div>
            <div class="bg-bark-100 rounded-lg p-4 border border-bark-200">
              <p class="text-sm text-shadow-700">
                Channel bindings (ports, tokens, host addresses) are security-sensitive settings configured at the server level.
                Trigger behavior is saved here, while host/token bindings are set at startup and may require restart to change.
              </p>
              <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div class="text-sm">
                  <span class="font-medium text-shadow-800">Discord:</span>
                  <span class="text-shadow-600 ml-1 font-mono">DISCORD_TOKEN, DISCORD_BOT_ID, channels.json:discord.heartbeatChannelId</span>
                </div>
                <div class="text-sm">
                  <span class="font-medium text-shadow-800">OpenAI API:</span>
                  <span class="text-shadow-600 ml-1 font-mono">API_PORT, API_HOST, API_KEY</span>
                </div>
                <div class="text-sm">
                  <span class="font-medium text-shadow-800">Admin GUI:</span>
                  <span class="text-shadow-600 ml-1 font-mono">ADMIN_PORT, ADMIN_HOST, ADMIN_TOKEN</span>
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>
      </section>

      <!-- Secrets display -->
      {#if data?.env}
        {@const env = data.env as unknown as Record<string, unknown>}
        <section
          id={settingsSimpleSectionAnchorId('advanced-secrets')}
          use:simpleSectionAnchor={'advanced-secrets'}
          data-settings-section="advanced-secrets"
        >
        <div class="card-garden overflow-hidden">
          <button
            onclick={() => toggleSection('secrets')}
            class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
          >
            <div class="flex items-center gap-3">
              <span class="flex items-center justify-center w-7 h-7 rounded-full bg-bark-200 text-shadow-600 text-sm font-bold border border-bark-400">K</span>
              <h2 class="text-sm font-serif font-semibold text-shadow-800">Secrets (Read-Only)</h2>
            </div>
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('secrets') ? 'rotate-180' : ''}">&#9660;</span>
          </button>
          {#if openSections.has('secrets')}
            <div class="px-5 pb-5 border-t border-bark-300 pt-4">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-bark-300">
                      <th class="text-left py-2 text-shadow-700 font-medium">Key</th>
                      <th class="text-left py-2 text-shadow-700 font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each [
                      ['DISCORD_TOKEN', env.discordToken],
                      ['API_KEY', env.apiKey],
                      ['ADMIN_TOKEN', env.adminToken],
                      ['OPENROUTER_API_KEY', env.openrouterApiKey],
                      ['LITELLM_BASE_URL', env.litellmBaseUrl],
                      ['LITELLM_API_KEY', env.litellmApiKey],
                    ] as pair}
                      <tr class="border-b border-bark-200">
                        <td class="py-2 font-mono text-shadow-700">{pair[0]}</td>
                        <td class="py-2 font-mono text-shadow-600">{String(pair[1] ?? '(not set)')}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {/if}
        </div>
        </section>
      {/if}

      <!-- Save -->
      <div class="flex items-center gap-3 pt-2">
        <button onclick={saveSimple} disabled={saving || !generalSettingsSaveDirty}
          class="px-5 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm
            {generalSettingsSaveDirty
              ? 'bg-gold-600 text-white hover:bg-gold-700'
              : 'bg-bark-300 text-shadow-500 cursor-not-allowed'}"
        >
          {saving ? 'Saving...' : 'Save Curated Settings'}
        </button>
        {#if dirty}
          <span class="text-sm text-shadow-500">You have unsaved changes</span>
        {/if}
      </div>

          <section
            id={settingsSimpleSectionAnchorId('advanced-fields')}
            use:simpleSectionAnchor={'advanced-fields'}
            class="space-y-4"
            data-settings-section="advanced-fields"
          >
            <div class="card-garden p-5 space-y-2">
              <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Runtime</p>
              <h2 class="text-sm font-serif font-semibold text-shadow-800">All Canonical Fields</h2>
              <p class="text-sm text-shadow-600">
                Full contract-backed runtime fields stay in this workspace for operator access.
                Validation errors open the owning canonical group instead of switching modes.
              </p>
            </div>
            <AdvancedSettingsMode
              {data}
              sections={SECTIONS}
              sectionSummaries={advancedSectionSummaries}
              {openSections}
              modelOwnedFields={MODEL_OWNED_FIELDS}
              {saving}
              {capabilityTierOptions}
              compositionalChannelTypeOptions={COMPOSITIONAL_CHANNEL_TYPE_OPTIONS}
              compositionalPurposeOptions={COMPOSITIONAL_PURPOSE_OPTIONS}
              {toggleSection}
              {configValue}
              {setConfigValue}
              {fieldEditorType}
              {fieldEnumValues}
              {fieldContract}
              {fieldMinimum}
              {fieldMaximum}
              {isDeprecatedField}
              {getSource}
              {hasFieldErrors}
              {fieldErrors}
              {formatSettingOptionLabel}
              {humanizeSettingValue}
              {getCompositionalPolicy}
              {setCompositionalPolicyEnabled}
              {toggleCompositionalPolicyValue}
              {hasCompositionalPolicyValue}
              {saveAdvanced}
            />
          </section>

          <section
            id={settingsSimpleSectionAnchorId('owner-files')}
            use:simpleSectionAnchor={'owner-files'}
            class="space-y-4"
            data-settings-section="owner-files"
          >
            <div class="card-garden p-5 space-y-2">
              <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Owner Files</p>
              <h2 class="text-sm font-serif font-semibold text-shadow-800">Raw Owner-File Editors</h2>
              <p class="text-sm text-shadow-600">
                JSON owner files remain editable in place. Raw edits are dirty-guarded so general settings saves
                do not overwrite staged file changes.
              </p>
            </div>
            <RawSettingsMode
              {settingsJson}
              rawEditors={rawEditorViews}
              {rawSaveStatus}
              {saving}
              {validationErrorsByField}
              {setSettingsJson}
              {getRawJson}
              {setRawJson}
              {saveRawSettings}
              {saveRawConfig}
            />
          </section>
        </div>
      </div>
    </div>
  {/if}

  <SettingsEnvironmentSummary env={data?.env as unknown as Record<string, unknown> | undefined} />
</div>
