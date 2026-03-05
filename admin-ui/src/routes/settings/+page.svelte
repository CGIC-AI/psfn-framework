<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    getSettings,
    updateSettings,
    getSubConfig,
    saveSubConfig,
    listModels,
    refreshModels,
  } from '$lib/api/endpoints/settings';
  import type { AdminSettingsData, ConfigUpdateResult, DiscoveredModel } from '$lib/types';

  type ViewMode = 'simple' | 'advanced' | 'raw';

  // ── Model catalog types ──
  interface CatalogSlot {
    slotKey: string;
    model: string;
    provider: string;
    routeProviderOrder: string;
    defaultMaxTokens: number | null;
    defaultContextWindow: number | null;
    overrideMaxTokens: number | null;
    overrideContextWindow: number | null;
  }

  interface PurposeMapping {
    purpose: string;
    slotKey: string;
  }

  const DEFAULT_PURPOSES = [
    'chat', 'background', 'extraction', 'summary', 'reasoning', 'longContext', 'import_processing',
  ];

  const CAPABILITY_TIERS = ['nursery', 'apprentice', 'autonomous', 'custom'] as const;
  const IMPORT_ROUTE_MODES = [
    { value: 'background', label: 'Background Routing (default)' },
    { value: 'openrouter_zdr', label: 'OpenRouter ZDR-only' },
    { value: 'local_endpoint', label: 'Local Endpoint Only' },
  ] as const;
  const SESSION_RESTART_BEHAVIORS = [
    { value: 'reuse_latest_session', label: 'Reuse latest session' },
    { value: 'new_session', label: 'Always start a new session' },
  ] as const;
  const DISABLED_PROVIDER_ID = 'disabled';

  // ── Budget constants (from context-budget.ts) ──
  const SESSION_HISTORY_TOKENS_PER_MSG = 256;
  const MEMORY_RETRIEVAL_TOKENS_PER_ITEM = 170;
  const SESSION_HISTORY_MIN_MESSAGES = 5;
  const SESSION_HISTORY_MAX_MESSAGES = 400;
  const MEMORY_RETRIEVAL_MIN_ITEMS = 1;
  const MEMORY_RETRIEVAL_MAX_ITEMS = 200;
  const SESSION_HISTORY_MIN_TOKENS_FLOOR = 4_000;
  const MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR = 1_000;
  const SYSTEM_PROMPT_ESTIMATE_TOKENS = 2_500;

  // ── Core state ──
  let data = $state<AdminSettingsData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let mode = $state<ViewMode>('simple');
  let saving = $state(false);
  let saveMessage = $state('');
  let saveOk = $state(true);
  let discoveredModels = $state<DiscoveredModel[]>([]);
  let refreshingModels = $state(false);

  // ── Dirty tracking ──
  let initialSnapshot = $state('');
  let dirty = $state(false);

  function computeSnapshot(): string {
    return JSON.stringify({
      primaryModel, extractionModel, memoryBudgetPct,
      memoryRetrievalLimit, sessionMessageLimit,
      sessionRestartBehavior,
      sessionHistoryBudgetPct, memoryRetrievalBudgetPct,
      extractionThresholdPct, compactionThresholdPct,
      maxResponseTokens, retryMaxAttempts, retryBaseDelayMs,
      importRouteMode, importStrictPolicy,
      importLocalEndpointUrl, importLocalModel,
      openRouterProviderOrder, webFetchAllowHttp,
      webFetchDomainAllowlist, webFetchAllowInternalNetwork,
      webFetchTlsCaCertPaths,
      capabilityTier, catalogSlots, purposeMappings,
      // Memory & Extraction
      extractionInterval, compactionEmotionalSalienceThresholdPct,
      defaultContextWindow, maintenanceIntervalMs,
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
      // Think Tool
      thinkMaxTokens, thinkMaxWallTimeMs, thinkMaxSubQueries,
      // Voice / TTS
      ttsProvider, voiceId, echoTtsUrl, echoTtsVoice, echoTtsPreset,
      sttProvider, deepgramModel,
      // Obsidian Vault
      obsidianVaultName, obsidianCliPath, obsidianAutoPublish, obsidianTimeoutMs,
      // Channels
      discordEnabled, discordHeartbeatChannel,
      discordTriggerWords, discordTriggerReactions,
      discordTriggerListenWindowSeconds,
      telegramEnabled, telegramAuthorizedUsers,
    });
  }

  $effect(() => {
    if (initialSnapshot) {
      dirty = computeSnapshot() !== initialSnapshot;
    }
  });

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (dirty) {
      e.preventDefault();
    }
  }

  // ── Simple mode fields ──
  let primaryModel = $state('');
  let extractionModel = $state('');
  let memoryBudgetPct = $state(20);
  let memoryRetrievalLimit = $state<number | null>(null);
  let sessionMessageLimit = $state<number | null>(null);
  let sessionRestartBehavior = $state<'reuse_latest_session' | 'new_session'>('reuse_latest_session');
  let sessionHistoryBudgetPct = $state(6);
  let memoryRetrievalBudgetPct = $state(2);
  let extractionThresholdPct = $state(30);
  let compactionThresholdPct = $state(70);
  let maxResponseTokens = $state(4096);
  let retryMaxAttempts = $state(3);

  // ── Model catalog ──
  let catalogSlots = $state<CatalogSlot[]>([]);
  let purposeMappings = $state<PurposeMapping[]>([]);

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
  let deepgramModel = $state('nova-3');

  // ── Obsidian Vault ──
  let obsidianVaultName = $state('');
  let obsidianCliPath = $state('obsidian');
  let obsidianAutoPublish = $state(false);
  let obsidianTimeoutMs = $state(10000);

  // ── Channels ──
  let discordEnabled = $state(false);
  let discordHeartbeatChannel = $state('');
  let discordTriggerWords = $state('');
  let discordTriggerReactions = $state('👆');
  let discordTriggerListenWindowSeconds = $state(120);
  let telegramEnabled = $state(false);
  let telegramAuthorizedUsers = $state('');

  // ── Capability tier ──
  let capabilityTier = $state('apprentice');

  // ── LLM retries ──
  let retryBaseDelayMs = $state(2000);

  // ── Memory & Extraction ──
  let extractionInterval = $state(5);
  let compactionEmotionalSalienceThresholdPct = $state(75);
  let defaultContextWindow = $state(128000);
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

  // ── Think Tool ──
  let thinkMaxTokens = $state(50000);
  let thinkMaxWallTimeMs = $state(120000);
  let thinkMaxSubQueries = $state(10);

  // ── Raw editor states ──
  let modelsJson = $state('');
  let skillsJson = $state('');
  let schedulerJson = $state('');
  let trustPolicyJson = $state('');
  let capabilitiesJson = $state('');
  let settingsJson = $state('');
  let rawSaveStatus = $state<Record<string, { ok: boolean; msg: string }>>({});
  let validationErrorsByField = $state<Record<string, string[]>>({});

  // ── Collapsible sections ──
  let openSections = $state(new Set<string>(['models']));

  // ── Section definitions for advanced mode ──
  interface SectionDef {
    id: string;
    title: string;
    icon: string;
    keys: string[];
    summary: () => string;
  }

  const SECTIONS: SectionDef[] = [
    {
      id: 'models', title: 'Models & Routing', icon: 'M',
      keys: [
        'primaryModel', 'primaryProvider', 'primaryMaxTokens',
        'extractionModel', 'extractionProvider', 'extractionMaxTokens',
        'defaultContextWindow',
      ],
      summary: () => {
        const slots = catalogSlots.filter(s => s.slotKey && s.model);
        if (slots.length === 0) return 'No models configured';
        return slots.map(s => `${s.slotKey}: ${s.model.split('/').pop()}`).join(', ');
      },
    },
    {
      id: 'budget', title: 'Context Budget', icon: 'B',
      keys: [
        'sessionHistoryBudgetPct', 'memoryRetrievalBudgetPct',
        'sessionMessageLimit', 'memoryRetrievalLimit',
      ],
      summary: () => `Session ${sessionHistoryBudgetPct}%, Memory ${memoryRetrievalBudgetPct}%`,
    },
    {
      id: 'memory', title: 'Memory & Extraction', icon: 'E',
      keys: [
        'memoryBudgetPct', 'extractionThresholdPct',
        'extractionInterval', 'compactionEmotionalSalienceThresholdPct',
      ],
      summary: () => `Budget ${memoryBudgetPct}%, Extract at ${extractionThresholdPct}%`,
    },
    {
      id: 'sessions', title: 'Sessions & Compaction', icon: 'S',
      keys: ['compactionThresholdPct', 'maintenanceIntervalMs', 'sessionRestartBehavior'],
      summary: () => (
        `Compaction at ${compactionThresholdPct}%, ` +
        `Maintenance ${Math.round(maintenanceIntervalMs / 1000)}s, ` +
        `Restart ${sessionRestartBehavior === 'new_session' ? 'new session' : 'reuse latest'}`
      ),
    },
    {
      id: 'extraction-tuning', title: 'Memory Extraction Tuning', icon: 'X',
      keys: [
        'memoryExtractionMinImportance', 'memoryExtractionMinConfidence',
        'memoryExtractionMinNovelty', 'memoryExtractionMaxWrites',
        'memoryExtractionTelemetryEnabled', 'memoryRetrievalTelemetryEnabled',
      ],
      summary: () => `Min importance: ${memoryExtractionMinImportance}, Max writes: ${memoryExtractionMaxWrites}`,
    },
    {
      id: 'profile', title: 'Profile Synthesis', icon: 'P',
      keys: [
        'profileSynthesisEnabled', 'profileSynthesisRefreshIntervalMs',
        'profileSynthesisCooldownMs', 'profileSynthesisMinWrites',
        'profileSynthesisMinImportance', 'profileSynthesisMinConfidence',
        'profileSynthesisMinNovelty', 'profileSynthesisSourceMemoryLimit',
        'profileSynthesisMinSourceMemories',
      ],
      summary: () => profileSynthesisEnabled ? `Enabled, refresh ${Math.round(profileSynthesisRefreshIntervalMs / 60000)}min` : 'Disabled',
    },
    {
      id: 'think', title: 'Think Tool', icon: 'R',
      keys: ['thinkMaxTokens', 'thinkMaxWallTimeMs', 'thinkMaxSubQueries'],
      summary: () => `Max tokens: ${thinkMaxTokens.toLocaleString()}, Wall time: ${Math.round(thinkMaxWallTimeMs / 1000)}s`,
    },
    {
      id: 'trust', title: 'Trust & Capabilities', icon: 'T',
      keys: ['capabilityTier'],
      summary: () => `Tier: ${capabilityTier}`,
    },
    {
      id: 'llm', title: 'LLM Retries & Behavior', icon: 'L',
      keys: ['retryMaxAttempts', 'retryBaseDelayMs'],
      summary: () => `Max retries: ${retryMaxAttempts}, Base delay: ${retryBaseDelayMs}ms`,
    },
    {
      id: 'import', title: 'Import Processing', icon: 'I',
      keys: [
        'importProcessingRouteMode', 'importProcessingStrictPolicy',
        'importProcessingLocalEndpointUrl', 'importProcessingLocalModel',
        'openRouterProviderOrder',
      ],
      summary: () => `Route: ${importRouteMode}${importStrictPolicy ? ' (strict)' : ''}`,
    },
    {
      id: 'fetch', title: 'Web Fetch Policy', icon: 'W',
      keys: [
        'webFetchAllowHttp', 'webFetchDomainAllowlist',
        'webFetchAllowInternalNetwork', 'webFetchTlsCaCertPaths',
      ],
      summary: () => {
        const parts: string[] = [];
        parts.push(webFetchAllowHttp ? 'HTTP allowed' : 'HTTPS only');
        if (webFetchAllowInternalNetwork) parts.push('internal LAN');
        return parts.join(', ');
      },
    },
    {
      id: 'voice', title: 'Voice & Speech', icon: 'V',
      keys: [
        'ttsProvider', 'voiceId', 'echoTtsUrl', 'echoTtsVoice', 'echoTtsPreset',
        'sttProvider', 'deepgramModel',
      ],
      summary: () => `TTS: ${ttsProvider}, STT: ${sttProvider}`,
    },
    {
      id: 'obsidian', title: 'Obsidian Vault', icon: 'O',
      keys: ['obsidianVaultName', 'obsidianCliPath', 'obsidianAutoPublish', 'obsidianTimeoutMs'],
      summary: () => obsidianVaultName ? `Vault: ${obsidianVaultName}${obsidianAutoPublish ? ', auto-publish' : ''}` : 'Disabled',
    },
    {
      id: 'channels', title: 'Channels', icon: 'C',
      keys: [
        'discordEnabled', 'discordHeartbeatChannel',
        'discordTriggerWords', 'discordTriggerReactions',
        'discordTriggerListenWindowMs',
        'telegramEnabled', 'telegramAuthorizedUsers',
      ],
      summary: () => {
        const wordsCount = splitCsv(discordTriggerWords).length;
        const reactionsCount = splitCsv(discordTriggerReactions).length;
        const windowSeconds = normalizeDiscordListenWindowSeconds(discordTriggerListenWindowSeconds);
        return [
          discordEnabled ? 'Discord on' : 'Discord off',
          telegramEnabled ? 'Telegram on' : 'Telegram off',
          `${wordsCount} word trigger${wordsCount === 1 ? '' : 's'}`,
          `${reactionsCount} reaction trigger${reactionsCount === 1 ? '' : 's'}`,
          `${windowSeconds}s listen window`,
        ].join(', ');
      },
    },
  ];

  const RAW_EDITORS = [
    { key: 'models', label: 'models.json' },
    { key: 'skills', label: 'skills.json' },
    { key: 'scheduler', label: 'scheduler.json' },
    { key: 'trust-policy', label: 'trust-policy.json' },
    { key: 'capabilities', label: 'capabilities.json' },
  ] as const;

  function fieldErrors(field: string): string[] {
    return validationErrorsByField[field] ?? [];
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
      const nextOpenSections = new Set(openSections);
      for (const section of SECTIONS) {
        if (section.keys.some((key) => invalidFields.has(key))) {
          nextOpenSections.add(section.id);
        }
      }
      const categorizedKeys = new Set(SECTIONS.flatMap((section) => section.keys));
      if (Array.from(invalidFields).some((field) => !categorizedKeys.has(field))) {
        nextOpenSections.add('other');
      }
      openSections = nextOpenSections;
    }

    return invalidFields.size;
  }

  // ── Source attribution ──
  type SettingSource = 'default' | 'settings.json' | 'env var';

  function getSource(key: string): SettingSource {
    if (!data) return 'default';
    const env = data.env as Record<string, unknown> | undefined;
    const envMap: Record<string, string> = {
      'primaryModel': 'primaryModel',
      'extractionModel': 'extractionModel',
      'webFetchAllowHttp': 'webFetchAllowHttp',
    };
    if (env && envMap[key] && env[envMap[key]] !== undefined) return 'env var';
    const config = data.config as Record<string, unknown>;
    if (config[key] !== undefined) return 'settings.json';
    return 'default';
  }

  // ── Derived ──
  let slotKeys = $derived(catalogSlots.map(s => s.slotKey).filter(Boolean));
  let availableTtsProviderIds = $derived(
    data?.voiceProviders?.tts?.map(provider => provider.id) ?? [],
  );
  let availableSttProviderIds = $derived(
    data?.voiceProviders?.stt?.map(provider => provider.id) ?? [],
  );
  let ttsProviderOptions = $derived(
    [...new Set([DISABLED_PROVIDER_ID, ...availableTtsProviderIds, ttsProvider].filter(Boolean))],
  );
  let sttProviderOptions = $derived(
    [...new Set([DISABLED_PROVIDER_ID, ...availableSttProviderIds, sttProvider].filter(Boolean))],
  );

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  let budgetPreview = $derived.by(() => {
    if (!data) return null;
    const ctxWindow = defaultContextWindow;

    const sessTokenBudget = Math.max(SESSION_HISTORY_MIN_TOKENS_FLOOR, Math.floor(ctxWindow * (sessionHistoryBudgetPct / 100)));
    const sessBudgetMsgs = clamp(
      Math.floor(sessTokenBudget / SESSION_HISTORY_TOKENS_PER_MSG),
      SESSION_HISTORY_MIN_MESSAGES,
      SESSION_HISTORY_MAX_MESSAGES,
    );
    const sessEffective = sessionMessageLimit != null
      ? Math.min(sessBudgetMsgs, sessionMessageLimit)
      : sessBudgetMsgs;
    const sessEffectiveTokens = sessEffective * SESSION_HISTORY_TOKENS_PER_MSG;

    const memTokenBudget = Math.max(MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR, Math.floor(ctxWindow * (memoryRetrievalBudgetPct / 100)));
    const memBudgetItems = clamp(
      Math.floor(memTokenBudget / MEMORY_RETRIEVAL_TOKENS_PER_ITEM),
      MEMORY_RETRIEVAL_MIN_ITEMS,
      MEMORY_RETRIEVAL_MAX_ITEMS,
    );
    const memEffective = memoryRetrievalLimit != null
      ? Math.min(memBudgetItems, memoryRetrievalLimit)
      : memBudgetItems;
    const memEffectiveTokens = memEffective * MEMORY_RETRIEVAL_TOKENS_PER_ITEM;

    const systemPromptTokens = SYSTEM_PROMPT_ESTIMATE_TOKENS;
    const allocated = systemPromptTokens + sessEffectiveTokens + memEffectiveTokens + maxResponseTokens;
    const remaining = Math.max(0, ctxWindow - allocated);

    const sysPct = (systemPromptTokens / ctxWindow) * 100;
    const sessPct = (sessEffectiveTokens / ctxWindow) * 100;
    const memPct = (memEffectiveTokens / ctxWindow) * 100;
    const respPct = (maxResponseTokens / ctxWindow) * 100;
    const remainPct = (remaining / ctxWindow) * 100;

    return {
      contextWindow: ctxWindow,
      systemPromptTokens,
      sessEffective,
      sessBudgetMsgs,
      sessEffectiveTokens,
      sessTokenBudget,
      sessMode: sessionMessageLimit != null ? 'hard_limit' as const : 'budget' as const,
      memEffective,
      memBudgetItems,
      memEffectiveTokens,
      memTokenBudget,
      memMode: memoryRetrievalLimit != null ? 'hard_limit' as const : 'budget' as const,
      maxResponseTokens,
      allocated,
      remaining,
      sysPct,
      sessPct,
      memPct,
      respPct,
      remainPct,
    };
  });

  // ── Helpers ──
  function populateSimpleFields(config: Record<string, unknown>) {
    primaryModel = String(config.primaryModel ?? '');
    extractionModel = String(config.extractionModel ?? '');
    memoryBudgetPct = Number(config.memoryBudgetPct ?? 20);
    memoryRetrievalLimit = config.memoryRetrievalLimit != null ? Number(config.memoryRetrievalLimit) : null;
    sessionMessageLimit = config.sessionMessageLimit != null ? Number(config.sessionMessageLimit) : null;
    sessionRestartBehavior = config.sessionRestartBehavior === 'new_session' ? 'new_session' : 'reuse_latest_session';
    sessionHistoryBudgetPct = Number(config.sessionHistoryBudgetPct ?? 6);
    memoryRetrievalBudgetPct = Number(config.memoryRetrievalBudgetPct ?? 2);
    extractionThresholdPct = Number(config.extractionThresholdPct ?? 30);
    compactionThresholdPct = Number(config.compactionThresholdPct ?? 70);
    maxResponseTokens = Number(config.primaryMaxTokens ?? 4096);
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
    capabilityTier = String(config.capabilityTier ?? 'apprentice');

    // Memory & Extraction
    extractionInterval = Number(config.extractionInterval ?? 5);
    compactionEmotionalSalienceThresholdPct = Number(config.compactionEmotionalSalienceThresholdPct ?? 75);
    defaultContextWindow = Number(config.defaultContextWindow ?? 128000);
    maintenanceIntervalMs = Number(config.maintenanceIntervalMs ?? 300000);

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

    // Think Tool
    thinkMaxTokens = Number(config.thinkMaxTokens ?? 50000);
    thinkMaxWallTimeMs = Number(config.thinkMaxWallTimeMs ?? 120000);
    thinkMaxSubQueries = Number(config.thinkMaxSubQueries ?? 10);

    // Voice / TTS
    const rawTts = String(config.ttsProvider ?? 'disabled').trim();
    ttsProvider = rawTts || 'disabled';
    voiceId = String(config.voiceId ?? config.elevenLabsVoiceId ?? '');
    echoTtsUrl = String(config.echoTtsUrl ?? '');
    echoTtsVoice = String(config.echoTtsVoice ?? '');
    echoTtsPreset = String(config.echoTtsPreset ?? '');
    const rawStt = String(config.sttProvider ?? (config.deepgramApiKey ? 'deepgram' : 'disabled')).trim();
    sttProvider = rawStt || 'disabled';
    deepgramModel = String(config.deepgramModel ?? 'nova-3');

    // Obsidian Vault
    obsidianVaultName = String(config.obsidianVaultName ?? '');
    obsidianCliPath = String(config.obsidianCliPath ?? 'obsidian');
    obsidianAutoPublish = Boolean(config.obsidianAutoPublish);
    obsidianTimeoutMs = Number(config.obsidianTimeoutMs ?? 10000);

    // Channels
    discordEnabled = Boolean(config.discordEnabled);
    discordHeartbeatChannel = String(config.discordHeartbeatChannel ?? '');
    discordTriggerWords = String(config.discordTriggerWords ?? '');
    discordTriggerReactions = String(config.discordTriggerReactions ?? '👆');
    discordTriggerListenWindowSeconds = normalizeDiscordListenWindowSeconds(
      Number(config.discordTriggerListenWindowMs ?? 120000) / 1000,
    );
    telegramEnabled = Boolean(config.telegramEnabled);
    telegramAuthorizedUsers = String(config.telegramAuthorizedUsers ?? '');

    // Populate catalog slots
    const catalog = config.modelCatalog as Record<string, Record<string, unknown>> | undefined;
    if (catalog && Object.keys(catalog).length > 0) {
      catalogSlots = Object.entries(catalog).map(([key, entry]) => ({
        slotKey: key,
        model: String(entry.model ?? ''),
        provider: String(entry.provider ?? ''),
        routeProviderOrder: entry.routing && typeof entry.routing === 'object'
          && Array.isArray((entry.routing as Record<string, unknown>).providerOrder)
          ? ((entry.routing as Record<string, unknown>).providerOrder as string[]).join(', ')
          : '',
        defaultMaxTokens: entry.defaults && typeof entry.defaults === 'object' ? Number((entry.defaults as Record<string, unknown>).maxTokens ?? 0) || null : null,
        defaultContextWindow: entry.defaults && typeof entry.defaults === 'object' ? Number((entry.defaults as Record<string, unknown>).contextWindow ?? 0) || null : null,
        overrideMaxTokens: entry.overrides && typeof entry.overrides === 'object' ? Number((entry.overrides as Record<string, unknown>).maxTokens ?? 0) || null : null,
        overrideContextWindow: entry.overrides && typeof entry.overrides === 'object' ? Number((entry.overrides as Record<string, unknown>).contextWindow ?? 0) || null : null,
      }));
    } else {
      catalogSlots = [
        { slotKey: 'primary', model: String(config.primaryModel ?? ''), provider: String(config.primaryProvider ?? ''), routeProviderOrder: '', defaultMaxTokens: Number(config.primaryMaxTokens ?? 4096), defaultContextWindow: Number(config.defaultContextWindow ?? 128000), overrideMaxTokens: null, overrideContextWindow: null },
        { slotKey: 'extraction', model: String(config.extractionModel ?? ''), provider: String(config.extractionProvider ?? ''), routeProviderOrder: '', defaultMaxTokens: Number(config.extractionMaxTokens ?? 4096), defaultContextWindow: null, overrideMaxTokens: null, overrideContextWindow: null },
      ];
    }

    // Populate purpose mappings
    const assignments = config.modelRoleAssignments as Record<string, string> | undefined;
    if (assignments && Object.keys(assignments).length > 0) {
      purposeMappings = Object.entries(assignments).map(([purpose, slotKey]) => ({ purpose, slotKey }));
    } else {
      purposeMappings = DEFAULT_PURPOSES.map(p => ({
        purpose: p,
        slotKey: p === 'chat' || p === 'summary' || p === 'reasoning' || p === 'longContext' ? 'primary' : 'extraction',
      }));
    }

    // Set initial snapshot for dirty tracking
    initialSnapshot = computeSnapshot();
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

  function setConfigValue(key: string, value: unknown) {
    if (!data) return;
    (data.config as Record<string, unknown>)[key] = value;
  }

  function fieldType(value: unknown): 'text' | 'number' | 'checkbox' | 'array' | 'object' {
    if (typeof value === 'boolean') return 'checkbox';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'array';
    if (value !== null && typeof value === 'object') return 'object';
    return 'text';
  }

  function toggleSection(id: string) {
    const next = new Set(openSections);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openSections = next;
  }

  function getRawJson(key: string): string {
    switch (key) {
      case 'models': return modelsJson;
      case 'skills': return skillsJson;
      case 'scheduler': return schedulerJson;
      case 'trust-policy': return trustPolicyJson;
      case 'capabilities': return capabilitiesJson;
      default: return '';
    }
  }

  function setRawJson(key: string, val: string) {
    switch (key) {
      case 'models': modelsJson = val; break;
      case 'skills': skillsJson = val; break;
      case 'scheduler': schedulerJson = val; break;
      case 'trust-policy': trustPolicyJson = val; break;
      case 'capabilities': capabilitiesJson = val; break;
    }
  }

  function fmtTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
    return String(n);
  }

  function fmtMs(ms: number): string {
    if (ms >= 60000) return `${(ms / 60000).toFixed(1)}min`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  // ── Catalog actions ──
  function addCatalogSlot() {
    catalogSlots = [...catalogSlots, {
      slotKey: '', model: '', provider: '', routeProviderOrder: '',
      defaultMaxTokens: null, defaultContextWindow: null,
      overrideMaxTokens: null, overrideContextWindow: null,
    }];
  }

  function removeCatalogSlot(idx: number) {
    catalogSlots = catalogSlots.filter((_, i) => i !== idx);
  }

  function addPurposeMapping() {
    purposeMappings = [...purposeMappings, { purpose: '', slotKey: catalogSlots[0]?.slotKey ?? '' }];
  }

  function removePurposeMapping(idx: number) {
    purposeMappings = purposeMappings.filter((_, i) => i !== idx);
  }

  // ── Save actions ──
  function buildCatalogPayload(): Record<string, unknown> {
    const catalog: Record<string, unknown> = {};
    for (const slot of catalogSlots) {
      if (!slot.slotKey) continue;
      catalog[slot.slotKey] = {
        model: slot.model,
        provider: slot.provider,
        routing: { providerOrder: splitCsv(slot.routeProviderOrder) },
        defaults: {
          ...(slot.defaultMaxTokens ? { maxTokens: slot.defaultMaxTokens } : {}),
          ...(slot.defaultContextWindow ? { contextWindow: slot.defaultContextWindow } : {}),
        },
        overrides: {
          ...(slot.overrideMaxTokens ? { maxTokens: slot.overrideMaxTokens } : {}),
          ...(slot.overrideContextWindow ? { contextWindow: slot.overrideContextWindow } : {}),
        },
      };
    }
    const assignments: Record<string, string> = {};
    for (const m of purposeMappings) {
      if (m.purpose && m.slotKey) assignments[m.purpose] = m.slotKey;
    }
    return { modelCatalog: catalog, modelRoleAssignments: assignments };
  }

  function splitCsv(str: string): string[] {
    return str.split(',').map(s => s.trim()).filter(Boolean);
  }

  function normalizeDiscordListenWindowSeconds(value: number): number {
    if (!Number.isFinite(value)) return 120;
    return clamp(Math.round(value), 10, 600);
  }

  function collectSimplePayload(catalogPayload: Record<string, unknown>): Record<string, unknown> {
    const discordTriggerListenWindowMs = normalizeDiscordListenWindowSeconds(
      discordTriggerListenWindowSeconds,
    ) * 1000;

    return {
      primaryModel,
      extractionModel,
      memoryBudgetPct,
      ...(memoryRetrievalLimit != null ? { memoryRetrievalLimit } : {}),
      ...(sessionMessageLimit != null ? { sessionMessageLimit } : {}),
      sessionRestartBehavior,
      sessionHistoryBudgetPct,
      memoryRetrievalBudgetPct,
      extractionThresholdPct,
      compactionThresholdPct,
      primaryMaxTokens: maxResponseTokens,
      retryMaxAttempts,
      retryBaseDelayMs,
      importProcessingRouteMode: importRouteMode,
      importProcessingStrictPolicy: importStrictPolicy,
      importProcessingLocalEndpointUrl: importLocalEndpointUrl,
      importProcessingLocalModel: importLocalModel,
      openRouterProviderOrder: splitCsv(openRouterProviderOrder),
      webFetchAllowHttp,
      webFetchDomainAllowlist: splitCsv(webFetchDomainAllowlist),
      webFetchAllowInternalNetwork,
      webFetchTlsCaCertPaths: splitCsv(webFetchTlsCaCertPaths),
      capabilityTier,
      // Memory & Extraction
      extractionInterval,
      compactionEmotionalSalienceThresholdPct,
      defaultContextWindow,
      maintenanceIntervalMs,
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
      // Think Tool
      thinkMaxTokens,
      thinkMaxWallTimeMs,
      thinkMaxSubQueries,
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
      discordEnabled,
      discordHeartbeatChannel,
      discordTriggerWords,
      discordTriggerReactions,
      discordTriggerListenWindowMs,
      telegramEnabled,
      telegramAuthorizedUsers,
      ...catalogPayload,
    };
  }

  async function saveSimple() {
    saving = true;
    try {
      const catalogPayload = buildCatalogPayload();
      const result = await updateSettings(collectSimplePayload(catalogPayload));
      const invalidFieldCount = applyValidationErrors(result);
      flash(result.ok, result.message || 'Settings saved');
      if (result.ok) {
        data = await getSettings();
        populateSimpleFields(data.config as Record<string, unknown>);
        settingsJson = JSON.stringify(data.config as Record<string, unknown>, null, 2);
      } else if (invalidFieldCount > 0) {
        mode = 'advanced';
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
      const result = await updateSettings(data.config as Record<string, unknown>);
      const invalidFieldCount = applyValidationErrors(result);
      flash(result.ok, result.message || 'Settings saved');
      if (result.ok) {
        data = await getSettings();
        populateSimpleFields(data.config as Record<string, unknown>);
        settingsJson = JSON.stringify(data.config as Record<string, unknown>, null, 2);
      } else if (invalidFieldCount > 0) {
        mode = 'advanced';
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
      data = await getSettings();
      populateSimpleFields(data.config as Record<string, unknown>);
      settingsJson = JSON.stringify(data.config as Record<string, unknown>, null, 2);
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
      flashRaw(key, true, `${label} saved`);
    } catch (e) {
      flashRaw(key, false, e instanceof Error ? e.message : `Failed to save ${label}`);
    } finally {
      saving = false;
    }
  }

  async function doRefreshModels() {
    refreshingModels = true;
    try {
      await refreshModels();
      discoveredModels = await listModels();
      flash(true, `Discovered ${discoveredModels.length} models`);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Model refresh failed');
    } finally {
      refreshingModels = false;
    }
  }

  // ── Init ──
  onMount(async () => {
    window.addEventListener('beforeunload', handleBeforeUnload);
    try {
      const [settingsData, models] = await Promise.all([
        getSettings(),
        listModels().catch(() => [] as DiscoveredModel[]),
      ]);
      data = settingsData;
      discoveredModels = models;
      populateSimpleFields(data.config as Record<string, unknown>);
      settingsJson = JSON.stringify(data.config as Record<string, unknown>, null, 2);

      const [mConf, skConf, schConf, tpConf, capConf] = await Promise.all([
        getSubConfig('models').catch(() => '{}'),
        getSubConfig('skills').catch(() => '{}'),
        getSubConfig('scheduler').catch(() => '{}'),
        getSubConfig('trust-policy').catch(() => '{}'),
        getSubConfig('capabilities').catch(() => '{}'),
      ]);
      modelsJson = tryPrettyPrint(mConf);
      skillsJson = tryPrettyPrint(skConf);
      schedulerJson = tryPrettyPrint(schConf);
      trustPolicyJson = tryPrettyPrint(tpConf);
      capabilitiesJson = tryPrettyPrint(capConf);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    }
  });

  // ── Style constants ──
  const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 transition-colors';
  const LABEL_CLS = 'block text-sm font-medium text-shadow-700 mb-1.5';
  const SLIDER_CLS = 'flex-1 h-2 rounded-full appearance-none bg-bark-300 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gold-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-gold-500 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer';
  const COMPACT_INPUT_CLS = 'w-20 px-2 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold-300';
  const TOGGLE_CLS = 'w-4 h-4 rounded border-bark-400 text-gold-600 focus:ring-gold-300';
</script>

<!-- Model datalist for autocomplete -->
<datalist id="model-list">
  {#each discoveredModels as m}
    <option value={m.id}>{m.description ?? m.id}</option>
  {/each}
</datalist>

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
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
    <div class="flex items-center gap-3">
      <div>
        <h1 class="text-2xl font-serif font-bold text-shadow-900">The Climate</h1>
        <p class="text-sm text-shadow-600 mt-1">Runtime configuration and tuning</p>
      </div>
      {#if dirty}
        <span class="px-2.5 py-1 rounded-full text-sm font-medium bg-gold-100 text-gold-700 border border-gold-300">
          Unsaved changes
        </span>
      {/if}
    </div>

    <div class="flex items-center gap-3">
      <button onclick={doRefreshModels} disabled={refreshingModels}
        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-bark-300
               text-shadow-700 hover:bg-bark-200
               disabled:opacity-50 transition-colors">
        {refreshingModels ? 'Refreshing...' : 'Refresh Models'}
      </button>
      <div class="flex rounded-lg border border-bark-300 overflow-hidden">
        {#each (['simple', 'advanced', 'raw'] as const) as m}
          <button
            onclick={() => mode = m}
            class="px-3 py-1.5 text-sm font-medium capitalize transition-colors
              {mode === m ? 'bg-gold-600 text-white' : 'bg-white text-shadow-700 hover:bg-bark-200'}"
          >
            {m}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Flash message -->
  {#if saveMessage}
    <div class="px-4 py-2.5 rounded-lg text-sm font-medium
      {saveOk
        ? 'bg-moss-50 text-moss-700 border border-moss-300'
        : 'bg-wilt-50 text-wilt-600 border border-wilt-400'}">
      {saveMessage}
    </div>
  {/if}

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

  <!-- SIMPLE MODE -->
  {:else if mode === 'simple'}
    <div class="space-y-5">
      <!-- Primary models (quick-access) -->
      <div class="card-garden p-6 space-y-4">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Quick Model Selection</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>
              Primary Model
              <span class="text-shadow-400 font-normal ml-1">({getSource('primaryModel')})</span>
            </label>
            <input type="text" list="model-list" bind:value={primaryModel} placeholder="provider/model"
              class={INPUT_CLS} />
          </div>
          <div>
            <label class={LABEL_CLS}>
              Extraction Model
              <span class="text-shadow-400 font-normal ml-1">({getSource('extractionModel')})</span>
            </label>
            <input type="text" list="model-list" bind:value={extractionModel} placeholder="provider/model"
              class={INPUT_CLS} />
          </div>
          <div>
            <label class={LABEL_CLS}>Default Context Window</label>
            <input type="number" min="4096" step="1024" bind:value={defaultContextWindow} class={INPUT_CLS} />
            <p class="text-sm text-shadow-500 mt-1">Context window size in tokens (default: 128,000)</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Max Response Tokens</label>
            <input type="number" min="256" max="1000000" step="256" bind:value={maxResponseTokens} class={INPUT_CLS} />
            <p class="text-sm text-shadow-500 mt-1">Maximum tokens in LLM response (256-1,000,000)</p>
          </div>
        </div>
      </div>

      <!-- Budget Preview with bar chart -->
      {#if budgetPreview}
        <div class="card-garden p-6 space-y-4">
          <h2 class="text-sm font-serif font-semibold text-shadow-800">Context Window Allocation</h2>
          <hr class="divider-filigree" />

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
                  title="Session history: ~{fmtTokens(budgetPreview.sessEffectiveTokens)} tokens ({budgetPreview.sessEffective} messages)">
                  {#if budgetPreview.sessPct > 4}<span class="truncate px-1">Session</span>{/if}
                </div>
              {/if}
              {#if budgetPreview.memPct > 0}
                <div class="bg-gold-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
                  style="width: {budgetPreview.memPct}%"
                  title="Memory retrieval: ~{fmtTokens(budgetPreview.memEffectiveTokens)} tokens ({budgetPreview.memEffective} memories)">
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
                <span class="text-shadow-700">Session: {budgetPreview.sessEffective} msgs (~{fmtTokens(budgetPreview.sessEffectiveTokens)})</span>
              </span>
              <span class="flex items-center gap-1.5">
                <span class="w-3 h-3 rounded-sm bg-gold-400 inline-block"></span>
                <span class="text-shadow-700">Memory: {budgetPreview.memEffective} items (~{fmtTokens(budgetPreview.memEffectiveTokens)})</span>
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
            </div>
            <div class="bg-moss-50 rounded-lg p-3 border border-moss-200">
              <span class="text-shadow-600 block mb-1">Session History</span>
              <span class="text-shadow-900 font-semibold">{budgetPreview.sessEffective} messages</span>
              {#if budgetPreview.sessMode === 'hard_limit'}
                <span class="text-shadow-500 block text-sm">hard limit: {sessionMessageLimit}, budget: ~{budgetPreview.sessBudgetMsgs}</span>
              {:else}
                <span class="text-shadow-500 block text-sm">~{fmtTokens(budgetPreview.sessTokenBudget)} token budget</span>
              {/if}
            </div>
            <div class="bg-gold-50 rounded-lg p-3 border border-gold-200">
              <span class="text-shadow-600 block mb-1">Memory Retrieval</span>
              <span class="text-shadow-900 font-semibold">{budgetPreview.memEffective} memories</span>
              {#if budgetPreview.memMode === 'hard_limit'}
                <span class="text-shadow-500 block text-sm">hard limit: {memoryRetrievalLimit}, budget: ~{budgetPreview.memBudgetItems}</span>
              {:else}
                <span class="text-shadow-500 block text-sm">~{fmtTokens(budgetPreview.memTokenBudget)} token budget</span>
              {/if}
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
        </div>
      {/if}

      <!-- Context Budget controls -->
      <div class="card-garden p-6 space-y-6">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Context Budget</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>
              Session History Budget %
              <span class="text-shadow-400 font-normal ml-1">({getSource('sessionHistoryBudgetPct')})</span>
            </label>
            <div class="flex items-center gap-3">
              <input type="range" min="1" max="80" step="1" bind:value={sessionHistoryBudgetPct} class={SLIDER_CLS} />
              <input type="number" min="1" max="80" bind:value={sessionHistoryBudgetPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">% of context window for session history (default: 6%)</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Session Message Limit (hard override)</label>
            <input type="number" min="1" max="500"
              value={sessionMessageLimit ?? ''}
              onchange={(e) => { const v = Number((e.target as HTMLInputElement).value); sessionMessageLimit = v > 0 ? v : null; }}
              placeholder="auto (budget-based)"
              class={INPUT_CLS} />
            <p class="text-sm text-shadow-500 mt-1">Caps messages regardless of budget. Leave blank for auto.</p>
          </div>
          <div>
            <label class={LABEL_CLS}>
              Memory Retrieval Budget %
              <span class="text-shadow-400 font-normal ml-1">({getSource('memoryRetrievalBudgetPct')})</span>
            </label>
            <div class="flex items-center gap-3">
              <input type="range" min="1" max="50" step="1" bind:value={memoryRetrievalBudgetPct} class={SLIDER_CLS} />
              <input type="number" min="1" max="50" bind:value={memoryRetrievalBudgetPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">% of context window for memory retrieval (default: 2%)</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Memory Retrieval Limit (hard override)</label>
            <input type="number" min="1" max="500"
              value={memoryRetrievalLimit ?? ''}
              onchange={(e) => { const v = Number((e.target as HTMLInputElement).value); memoryRetrievalLimit = v > 0 ? v : null; }}
              placeholder="auto (budget-based)"
              class={INPUT_CLS} />
            <p class="text-sm text-shadow-500 mt-1">Caps memories regardless of budget. Leave blank for auto.</p>
          </div>
        </div>
      </div>

      <!-- Memory & Extraction -->
      <div class="card-garden p-6 space-y-6">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Memory & Extraction</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>
              Memory Budget %
              <span class="text-shadow-400 font-normal ml-1">({getSource('memoryBudgetPct')})</span>
            </label>
            <div class="flex items-center gap-3">
              <input type="range" min="5" max="50" step="1" bind:value={memoryBudgetPct} class={SLIDER_CLS} />
              <input type="number" min="5" max="50" bind:value={memoryBudgetPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">Legacy % of context window reserved for memory (see budget % above)</p>
          </div>
          <div>
            <label class={LABEL_CLS}>
              Extraction Threshold %
              <span class="text-shadow-400 font-normal ml-1">({getSource('extractionThresholdPct')})</span>
            </label>
            <div class="flex items-center gap-3">
              <input type="range" min="10" max="80" step="1" bind:value={extractionThresholdPct} class={SLIDER_CLS} />
              <input type="number" min="10" max="80" bind:value={extractionThresholdPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">Triggers extraction when session exceeds this % of context</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Extraction Interval (messages)</label>
            <input type="number" min="1" max="50" bind:value={extractionInterval} class={INPUT_CLS} />
            <p class="text-sm text-shadow-500 mt-1">Run extraction every N messages (1-50)</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Emotional Salience Threshold %</label>
            <div class="flex items-center gap-3">
              <input type="range" min="0" max="100" step="1" bind:value={compactionEmotionalSalienceThresholdPct} class={SLIDER_CLS} />
              <input type="number" min="0" max="100" bind:value={compactionEmotionalSalienceThresholdPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">Preserve messages above this emotional salience during compaction (0-100)</p>
          </div>
        </div>
      </div>

      <!-- Sessions & Compaction -->
      <div class="card-garden p-6 space-y-6">
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Sessions & Compaction</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>
              Compaction Threshold %
              <span class="text-shadow-400 font-normal ml-1">({getSource('compactionThresholdPct')})</span>
            </label>
            <div class="flex items-center gap-3">
              <input type="range" min="30" max="90" step="1" bind:value={compactionThresholdPct} class={SLIDER_CLS} />
              <input type="number" min="30" max="90" bind:value={compactionThresholdPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-500 mt-1">Auto-compacts oldest 50% when context exceeds this %</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Maintenance Interval (ms)</label>
            <input type="number" min="10000" step="1000" bind:value={maintenanceIntervalMs} class={INPUT_CLS} />
            <p class="text-sm text-shadow-500 mt-1">Scheduler tick interval in milliseconds (default: 300,000 = 5min)</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Restart Behavior</label>
            <select bind:value={sessionRestartBehavior} class={INPUT_CLS}>
              {#each SESSION_RESTART_BEHAVIORS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            <p class="text-sm text-shadow-500 mt-1">Choose whether startup resumes the latest session or seeds a fresh one.</p>
          </div>
        </div>
      </div>

      <!-- Memory Extraction Tuning (collapsible) -->
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
                <label class={LABEL_CLS}>Min Importance</label>
                <input type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinImportance} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum importance score to write a memory (0-1)</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Min Confidence</label>
                <input type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinConfidence} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum confidence score to write a memory (0-1)</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Min Novelty</label>
                <input type="number" min="0" max="1" step="0.05" bind:value={memoryExtractionMinNovelty} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum novelty score to write a memory (0-1)</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Max Writes per Extraction</label>
                <input type="number" min="1" max="100" step="1" bind:value={memoryExtractionMaxWrites} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Maximum memories written per extraction cycle</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Extraction Telemetry</label>
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" bind:checked={memoryExtractionTelemetryEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Log extraction telemetry data</span>
                </label>
              </div>
              <div>
                <label class={LABEL_CLS}>Retrieval Telemetry</label>
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" bind:checked={memoryRetrievalTelemetryEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Log retrieval telemetry data</span>
                </label>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Profile Synthesis (collapsible) -->
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
                <label class={LABEL_CLS}>Enabled</label>
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" bind:checked={profileSynthesisEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Enable automatic profile synthesis</span>
                </label>
              </div>
              <div>
                <label class={LABEL_CLS}>Refresh Interval (ms)</label>
                <input type="number" min="60000" step="60000" bind:value={profileSynthesisRefreshIntervalMs} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">How often to refresh profiles ({fmtMs(profileSynthesisRefreshIntervalMs)})</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Cooldown (ms)</label>
                <input type="number" min="10000" step="10000" bind:value={profileSynthesisCooldownMs} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum wait between profile updates ({fmtMs(profileSynthesisCooldownMs)})</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Min Writes</label>
                <input type="number" min="1" max="100" step="1" bind:value={profileSynthesisMinWrites} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum memory writes before triggering synthesis</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Min Importance</label>
                <input type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinImportance} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum importance for source memories (0-1)</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Min Confidence</label>
                <input type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinConfidence} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum confidence for source memories (0-1)</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Min Novelty</label>
                <input type="number" min="0" max="1" step="0.05" bind:value={profileSynthesisMinNovelty} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum novelty for source memories (0-1)</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Source Memory Limit</label>
                <input type="number" min="1" max="200" step="1" bind:value={profileSynthesisSourceMemoryLimit} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Max source memories to consider per synthesis</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Min Source Memories</label>
                <input type="number" min="1" max="50" step="1" bind:value={profileSynthesisMinSourceMemories} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Minimum source memories required to run synthesis</p>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Think Tool (collapsible) -->
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('think')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">R</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Think Tool (RLM Sandbox)</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('think')}
              <span class="text-sm text-shadow-500">Max: {fmtTokens(thinkMaxTokens)} tokens, {fmtMs(thinkMaxWallTimeMs)}, {thinkMaxSubQueries} queries</span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('think') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('think')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div>
                <label class={LABEL_CLS}>Max Tokens</label>
                <input type="number" min="1000" max="1000000" step="1000" bind:value={thinkMaxTokens} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Max tokens for RLM sandbox (1K-1M)</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Max Wall Time (ms)</label>
                <input type="number" min="5000" max="600000" step="1000" bind:value={thinkMaxWallTimeMs} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Max wall-clock time ({fmtMs(thinkMaxWallTimeMs)})</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Max Sub-Queries</label>
                <input type="number" min="1" max="100" step="1" bind:value={thinkMaxSubQueries} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Max LLM sub-queries per think (1-100)</p>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Model Catalog (collapsible) -->
      <div class="card-garden overflow-hidden">
        <button
          onclick={() => toggleSection('models')}
          class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">M</span>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Model Catalog</h2>
            <span class="text-sm text-shadow-500">{catalogSlots.filter(s => s.slotKey).length} slots</span>
          </div>
          <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('models') ? 'rotate-180' : ''}">&#9660;</span>
        </button>
        {#if !openSections.has('models')}
          <div class="px-5 pb-3 text-sm text-shadow-500">
            {catalogSlots.filter(s => s.slotKey && s.model).map(s => `${s.slotKey}: ${s.model.split('/').pop()}`).join(', ') || 'No models configured'}
          </div>
        {/if}
        {#if openSections.has('models')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4 space-y-4">
            <div class="flex items-center justify-between">
              <p class="text-sm text-shadow-600">Define reusable model slots, then map purposes to slots below.</p>
              <button onclick={addCatalogSlot}
                class="px-3 py-1 text-sm font-medium rounded border border-gold-400 text-gold-700 hover:bg-gold-50 transition-colors">
                + Add Slot
              </button>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm min-w-[800px]">
                <thead>
                  <tr class="border-b border-bark-300">
                    <th class="text-left py-2 px-2 text-shadow-700 font-medium">Slot Key</th>
                    <th class="text-left py-2 px-2 text-shadow-700 font-medium">Model</th>
                    <th class="text-left py-2 px-2 text-shadow-700 font-medium">Provider</th>
                    <th class="text-left py-2 px-2 text-shadow-700 font-medium">Route Provider Order</th>
                    <th class="text-right py-2 px-2 text-shadow-700 font-medium">Def. Max Tokens</th>
                    <th class="text-right py-2 px-2 text-shadow-700 font-medium">Def. Context</th>
                    <th class="text-right py-2 px-2 text-shadow-700 font-medium">Ovr. Max Tokens</th>
                    <th class="text-right py-2 px-2 text-shadow-700 font-medium">Ovr. Context</th>
                    <th class="py-2 px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {#each catalogSlots as slot, i}
                    <tr class="border-b border-bark-200">
                      <td class="py-1.5 px-2">
                        <input type="text" bind:value={slot.slotKey} placeholder="primary"
                          class="w-24 px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-800 focus:ring-1 focus:ring-gold-300" />
                      </td>
                      <td class="py-1.5 px-2">
                        <input type="text" list="model-list" bind:value={slot.model} placeholder="provider/model"
                          class="w-48 px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-800 focus:ring-1 focus:ring-gold-300" />
                      </td>
                      <td class="py-1.5 px-2">
                        <input type="text" bind:value={slot.provider} placeholder="openrouter"
                          class="w-28 px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-800 focus:ring-1 focus:ring-gold-300" />
                      </td>
                      <td class="py-1.5 px-2">
                        <input type="text" bind:value={slot.routeProviderOrder} placeholder="parasail, openai"
                          class="w-36 px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-800 focus:ring-1 focus:ring-gold-300" />
                      </td>
                      <td class="py-1.5 px-2 text-right">
                        <input type="number" min="1"
                          value={slot.defaultMaxTokens ?? ''}
                          onchange={(e) => { slot.defaultMaxTokens = Number((e.target as HTMLInputElement).value) || null; }}
                          placeholder="auto"
                          class="w-24 px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-800 text-right focus:ring-1 focus:ring-gold-300" />
                      </td>
                      <td class="py-1.5 px-2 text-right">
                        <input type="number" min="1"
                          value={slot.defaultContextWindow ?? ''}
                          onchange={(e) => { slot.defaultContextWindow = Number((e.target as HTMLInputElement).value) || null; }}
                          placeholder="auto"
                          class="w-24 px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-800 text-right focus:ring-1 focus:ring-gold-300" />
                      </td>
                      <td class="py-1.5 px-2 text-right">
                        <input type="number" min="1"
                          value={slot.overrideMaxTokens ?? ''}
                          onchange={(e) => { slot.overrideMaxTokens = Number((e.target as HTMLInputElement).value) || null; }}
                          placeholder="optional"
                          class="w-24 px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-800 text-right focus:ring-1 focus:ring-gold-300" />
                      </td>
                      <td class="py-1.5 px-2 text-right">
                        <input type="number" min="1"
                          value={slot.overrideContextWindow ?? ''}
                          onchange={(e) => { slot.overrideContextWindow = Number((e.target as HTMLInputElement).value) || null; }}
                          placeholder="optional"
                          class="w-24 px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-800 text-right focus:ring-1 focus:ring-gold-300" />
                      </td>
                      <td class="py-1.5 px-2">
                        <button onclick={() => removeCatalogSlot(i)}
                          class="text-sm text-wilt-600 hover:text-wilt-400 font-medium">Remove</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <!-- Purpose Mappings -->
            <div class="pt-2 space-y-3">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-medium text-shadow-700">Purpose Mappings</h3>
                <button onclick={addPurposeMapping}
                  class="px-3 py-1 text-sm font-medium rounded border border-gold-400 text-gold-700 hover:bg-gold-50 transition-colors">
                  + Add Mapping
                </button>
              </div>
              <div class="space-y-2">
                {#each purposeMappings as mapping, i}
                  <div class="flex items-center gap-3">
                    <input type="text" bind:value={mapping.purpose} placeholder="chat"
                      class="w-40 px-3 py-1.5 text-sm rounded border border-bark-300 bg-white text-shadow-800 font-mono focus:ring-1 focus:ring-gold-300" />
                    <svg class="w-4 h-4 text-shadow-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14m-4-4l4 4-4 4"/></svg>
                    <select bind:value={mapping.slotKey}
                      class="flex-1 px-3 py-1.5 text-sm rounded border border-bark-300 bg-white text-shadow-800 focus:ring-1 focus:ring-gold-300">
                      {#each slotKeys as key}
                        <option value={key}>{key}</option>
                      {/each}
                      {#if !slotKeys.includes(mapping.slotKey) && mapping.slotKey}
                        <option value={mapping.slotKey}>{mapping.slotKey} (missing)</option>
                      {/if}
                    </select>
                    <button onclick={() => removePurposeMapping(i)}
                      class="text-sm text-wilt-600 hover:text-wilt-400 font-medium shrink-0">Remove</button>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Trust & Capability (collapsible) -->
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
                <label class={LABEL_CLS}>Capability Tier</label>
                <select bind:value={capabilityTier} class={INPUT_CLS}>
                  {#each CAPABILITY_TIERS as tier}
                    <option value={tier}>{tier}</option>
                  {/each}
                </select>
                <p class="text-sm text-shadow-500 mt-1">Controls agent autonomy level</p>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- LLM Retries (collapsible) -->
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
                <label class={LABEL_CLS}>LLM Max Retries</label>
                <input type="number" min="0" max="10" bind:value={retryMaxAttempts} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Maximum retry attempts (0-10)</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Retry Base Delay (ms)</label>
                <input type="number" min="500" max="30000" step="100" bind:value={retryBaseDelayMs} class={INPUT_CLS} />
                <p class="text-sm text-shadow-500 mt-1">Base delay between retries (500-30,000ms)</p>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Import Processing (collapsible) -->
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
                <label class={LABEL_CLS}>Route Mode</label>
                <select bind:value={importRouteMode} class={INPUT_CLS}>
                  {#each IMPORT_ROUTE_MODES as opt}
                    <option value={opt.value}>{opt.label}</option>
                  {/each}
                </select>
              </div>
              <div>
                <label class={LABEL_CLS}>Strict Policy</label>
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" bind:checked={importStrictPolicy} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Enforce strict ZDR compliance</span>
                </label>
              </div>
              <div>
                <label class={LABEL_CLS}>OpenRouter Provider Order</label>
                <input type="text" bind:value={openRouterProviderOrder} class={INPUT_CLS} placeholder="comma-separated providers" />
                <p class="text-sm text-shadow-500 mt-1">Global/import fallback order. Per-slot route order is configured in the model catalog table above.</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Local Endpoint URL</label>
                <input type="text" bind:value={importLocalEndpointUrl} class={INPUT_CLS} placeholder="http://localhost:8080" />
              </div>
              <div>
                <label class={LABEL_CLS}>Local Model</label>
                <input type="text" bind:value={importLocalModel} class={INPUT_CLS} placeholder="model name" />
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Gateway Web Fetch (collapsible) -->
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
                <label class={LABEL_CLS}>Allow Internal Network Access</label>
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" bind:checked={webFetchAllowInternalNetwork} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Allow fetching from RFC1918 / LAN hosts (cloud metadata still blocked)</span>
                </label>
              </div>
              <div>
                <label class={LABEL_CLS}>Allow Non-HTTPS</label>
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" bind:checked={webFetchAllowHttp} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Allow HTTP (non-encrypted) web fetch requests</span>
                </label>
              </div>
              <div>
                <label class={LABEL_CLS}>Domain Allowlist</label>
                <input type="text" bind:value={webFetchDomainAllowlist} class={INPUT_CLS} placeholder="comma-separated domains (e.g. example.local, internal.corp)" />
              </div>
              <div>
                <label class={LABEL_CLS}>TLS CA Cert Paths</label>
                <input type="text" bind:value={webFetchTlsCaCertPaths} class={INPUT_CLS} placeholder="comma-separated file paths" />
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Voice & TTS -->
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
                <label class={LABEL_CLS}>TTS Provider</label>
                <input type="text" bind:value={ttsProvider} list="tts-provider-list" class={INPUT_CLS} placeholder="disabled or provider id" />
                <p class="text-sm text-shadow-500 mt-1">Registered provider ids from the backend registry are suggested, and any current provider id is preserved and sent back unchanged.</p>
              </div>
              <div>
                <label class={LABEL_CLS}>STT Provider</label>
                <input type="text" bind:value={sttProvider} list="stt-provider-list" class={INPUT_CLS} placeholder="disabled or provider id" />
                <p class="text-sm text-shadow-500 mt-1">Registered provider ids from the backend registry are suggested, and plugin ids are preserved instead of being coerced to disabled.</p>
              </div>
              <div>
                <label class={LABEL_CLS}>ElevenLabs Voice ID</label>
                <input type="text" bind:value={voiceId} class={INPUT_CLS} placeholder="your-voice-id" />
                <p class="text-sm text-shadow-500 mt-1">Leave blank to clear persisted voice override.</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Deepgram Model</label>
                <input type="text" bind:value={deepgramModel} class={INPUT_CLS} placeholder="nova-3" />
                <p class="text-sm text-shadow-500 mt-1">Leave blank to clear persisted model override.</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Echo TTS URL</label>
                <input type="text" bind:value={echoTtsUrl} class={INPUT_CLS} placeholder="http://127.0.0.1:8001/v1/audio/speech" />
              </div>
              <div>
                <label class={LABEL_CLS}>Echo TTS Voice</label>
                <input type="text" bind:value={echoTtsVoice} class={INPUT_CLS} placeholder="11labs-Allison" />
              </div>
              <div class="md:col-span-2">
                <label class={LABEL_CLS}>Echo TTS Preset</label>
                <input type="text" bind:value={echoTtsPreset} class={INPUT_CLS} placeholder="Independent-High-Speaker-CFG" />
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

      <!-- Obsidian Vault -->
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
              <label class="block text-xs font-semibold text-shadow-700 mb-1" for="obsidianVaultName">Vault Name</label>
              <input type="text" id="obsidianVaultName" class="input-garden w-full" bind:value={obsidianVaultName} placeholder="e.g. companion" />
              <p class="text-xs text-shadow-500 mt-0.5">Leave empty to disable vault tools. Must match the name in Obsidian.</p>
            </div>
            <div>
              <label class="block text-xs font-semibold text-shadow-700 mb-1" for="obsidianCliPath">CLI Path</label>
              <input type="text" id="obsidianCliPath" class="input-garden w-full" bind:value={obsidianCliPath} placeholder="obsidian" />
              <p class="text-xs text-shadow-500 mt-0.5">Path to the Obsidian CLI binary. Default: obsidian</p>
            </div>
            <div class="flex items-center gap-3">
              <input type="checkbox" id="obsidianAutoPublish" class="rounded border-bark-400" bind:checked={obsidianAutoPublish} />
              <label class="text-xs font-semibold text-shadow-700" for="obsidianAutoPublish">Auto-publish reflections to vault</label>
            </div>
            <div>
              <label class="block text-xs font-semibold text-shadow-700 mb-1" for="obsidianTimeoutMs">CLI Timeout (ms)</label>
              <input type="number" id="obsidianTimeoutMs" class="input-garden w-28" bind:value={obsidianTimeoutMs} min={1000} max={30000} step={1000} />
              <p class="text-xs text-shadow-500 mt-0.5">Timeout for CLI commands (1000-30000ms)</p>
            </div>
          </div>
        {/if}
      </div>

      <!-- Channels -->
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
                {discordEnabled ? 'Discord on' : 'Discord off'}, {discordTriggerListenWindowSeconds}s listen window
              </span>
            {/if}
            <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('channels') ? 'rotate-180' : ''}">&#9660;</span>
          </div>
        </button>
        {#if openSections.has('channels')}
          <div class="px-5 pb-5 border-t border-bark-300 pt-4 space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label class={LABEL_CLS}>Discord Enabled</label>
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" bind:checked={discordEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Enable Discord channel bridge</span>
                </label>
                <p class="text-sm text-shadow-500 mt-1">Requires a valid <span class="font-mono">DISCORD_TOKEN</span> at runtime.</p>
              </div>
              <div>
                <label class={LABEL_CLS}>Discord Heartbeat Channel</label>
                <input type="text" bind:value={discordHeartbeatChannel} class={INPUT_CLS} placeholder="channel-id" />
                <p class="text-sm text-shadow-500 mt-1">Optional channel ID used for heartbeat/status pings.</p>
              </div>
              <div class="md:col-span-2">
                <label class={LABEL_CLS}>Discord Trigger Words</label>
                <input type="text" bind:value={discordTriggerWords} class={INPUT_CLS} placeholder="pixie, hey companion" />
                <p class="text-sm text-shadow-500 mt-1">
                  Comma-separated words or phrases that trigger replies in guild channels.
                </p>
              </div>
              <div class="md:col-span-2">
                <label class={LABEL_CLS}>Discord Trigger Reactions</label>
                <input type="text" bind:value={discordTriggerReactions} class={INPUT_CLS} placeholder="👆, 🔥, 👀" />
                <p class="text-sm text-shadow-500 mt-1">
                  Comma-separated emoji reactions that open a Discord follow-up window.
                </p>
              </div>
              <div>
                <label class={LABEL_CLS}>Discord Listen Window (seconds)</label>
                <input
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
                <label class={LABEL_CLS}>Telegram Enabled</label>
                <label class="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" bind:checked={telegramEnabled} class={TOGGLE_CLS} />
                  <span class="text-sm text-shadow-700">Enable Telegram channel bridge</span>
                </label>
              </div>
              <div class="md:col-span-2">
                <label class={LABEL_CLS}>Telegram Authorized Users</label>
                <input type="text" bind:value={telegramAuthorizedUsers} class={INPUT_CLS} placeholder="12345678, 87654321" />
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
                  <span class="text-shadow-600 ml-1 font-mono">DISCORD_TOKEN, DISCORD_HEARTBEAT_CHANNEL, DISCORD_TRIGGER_* (optional)</span>
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

      <!-- Secrets display -->
      {#if data?.env}
        {@const env = data.env as Record<string, unknown>}
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
                      ['OLLAMA_URL', env.ollamaUrl],
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
      {/if}

      <!-- Save -->
      <div class="flex items-center gap-3 pt-2">
        <button onclick={saveSimple} disabled={saving || !dirty}
          class="px-5 py-2.5 rounded-lg text-sm font-medium transition-colors shadow-sm
            {dirty
              ? 'bg-gold-600 text-white hover:bg-gold-700'
              : 'bg-bark-300 text-shadow-500 cursor-not-allowed'}"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {#if dirty}
          <span class="text-sm text-shadow-500">You have unsaved changes</span>
        {/if}
      </div>
    </div>

  <!-- ADVANCED MODE -->
  {:else if mode === 'advanced'}
    <div class="space-y-3">
      {#each SECTIONS as section}
        {@const sectionKeys = section.keys.filter((k) => data && k in (data.config as Record<string, unknown>))}
        {#if sectionKeys.length > 0}
          <div class="card-garden overflow-hidden">
            <button
              onclick={() => toggleSection(section.id)}
              class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
            >
              <div class="flex items-center gap-3">
                <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">
                  {section.icon}
                </span>
                <h2 class="text-sm font-serif font-semibold text-shadow-800">{section.title}</h2>
                <span class="text-sm text-shadow-500">({sectionKeys.length} fields)</span>
              </div>
              <div class="flex items-center gap-3">
                {#if !openSections.has(section.id)}
                  <span class="text-sm text-shadow-500 hidden md:inline">{section.summary()}</span>
                {/if}
                <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has(section.id) ? 'rotate-180' : ''}">
                  &#9660;
                </span>
              </div>
            </button>
            {#if openSections.has(section.id)}
              <div class="px-5 pb-5 space-y-3 border-t border-bark-300 pt-4">
                {#each sectionKeys as key}
                  {@const value = configValue(key)}
                  {@const ft = fieldType(value)}
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <div class="sm:w-60 shrink-0 flex items-center gap-2">
                      <label class="text-sm font-mono text-shadow-700">{key}</label>
                      <span class="text-shadow-400 text-sm">({getSource(key)})</span>
                    </div>
                    {#if ft === 'checkbox'}
                      <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox"
                          checked={Boolean(value)}
                          onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).checked)}
                          class="sr-only peer" />
                        <div class="w-9 h-5 bg-bark-400 rounded-full peer
                                    peer-checked:bg-gold-500 peer-focus:ring-2 peer-focus:ring-gold-300
                                    after:content-[''] after:absolute after:top-0.5 after:start-[2px]
                                    after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all
                                    peer-checked:after:translate-x-full"></div>
                      </label>
                    {:else if ft === 'number'}
                      <input type="number"
                        value={Number(value)}
                        onchange={(e) => setConfigValue(key, Number((e.target as HTMLInputElement).value))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {:else if ft === 'array'}
                      <input type="text"
                        value={Array.isArray(value) ? value.join(', ') : ''}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300"
                        placeholder="comma-separated values" />
                    {:else if ft === 'object'}
                      <textarea
                        value={JSON.stringify(value, null, 2)}
                        onchange={(e) => { try { setConfigValue(key, JSON.parse((e.target as HTMLTextAreaElement).value)); } catch { /* ignore */ } }}
                        rows="3"
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300 resize-y"
                        spellcheck="false"
                      ></textarea>
                    {:else}
                      <input type="text"
                        value={String(value ?? '')}
                        list={key.toLowerCase().includes('model') ? 'model-list' : undefined}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value)}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {/if}
                  </div>
                  {#if hasFieldErrors(key)}
                    <div class="sm:pl-60 space-y-1">
                      {#each fieldErrors(key) as fieldError}
                        <p class="text-sm text-wilt-600">{fieldError}</p>
                      {/each}
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/each}

      <!-- Other (uncategorized) keys -->
      {#if data}
        {@const allCategorized = new Set(SECTIONS.flatMap(s => s.keys))}
        {@const otherKeys = Object.keys(data.config as Record<string, unknown>).filter(k => !allCategorized.has(k))}
        {#if otherKeys.length > 0}
          <div class="card-garden overflow-hidden">
            <button
              onclick={() => toggleSection('other')}
              class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
            >
              <div class="flex items-center gap-3">
                <span class="flex items-center justify-center w-7 h-7 rounded-full bg-bark-200 text-shadow-600 text-sm font-bold border border-bark-400">
                  ?
                </span>
                <h2 class="text-sm font-serif font-semibold text-shadow-800">Other Settings</h2>
                <span class="text-sm text-shadow-500">({otherKeys.length} fields)</span>
              </div>
              <span class="text-shadow-500 text-sm transition-transform duration-200 {openSections.has('other') ? 'rotate-180' : ''}">
                &#9660;
              </span>
            </button>
            {#if openSections.has('other')}
              <div class="px-5 pb-5 space-y-3 border-t border-bark-300 pt-4">
                {#each otherKeys as key}
                  {@const value = configValue(key)}
                  {@const ft = fieldType(value)}
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <div class="sm:w-60 shrink-0 flex items-center gap-2">
                      <label class="text-sm font-mono text-shadow-700">{key}</label>
                      <span class="text-shadow-400 text-sm">({getSource(key)})</span>
                    </div>
                    {#if ft === 'checkbox'}
                      <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox"
                          checked={Boolean(value)}
                          onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).checked)}
                          class="sr-only peer" />
                        <div class="w-9 h-5 bg-bark-400 rounded-full peer
                                    peer-checked:bg-gold-500 peer-focus:ring-2 peer-focus:ring-gold-300
                                    after:content-[''] after:absolute after:top-0.5 after:start-[2px]
                                    after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all
                                    peer-checked:after:translate-x-full"></div>
                      </label>
                    {:else if ft === 'number'}
                      <input type="number"
                        value={Number(value)}
                        onchange={(e) => setConfigValue(key, Number((e.target as HTMLInputElement).value))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {:else if ft === 'array'}
                      <input type="text"
                        value={Array.isArray(value) ? value.join(', ') : ''}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300"
                        placeholder="comma-separated values" />
                    {:else if ft === 'object'}
                      <textarea
                        value={JSON.stringify(value, null, 2)}
                        onchange={(e) => { try { setConfigValue(key, JSON.parse((e.target as HTMLTextAreaElement).value)); } catch { /* ignore */ } }}
                        rows="3"
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300 resize-y"
                        spellcheck="false"
                      ></textarea>
                    {:else}
                      <input type="text"
                        value={String(value ?? '')}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value)}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {/if}
                  </div>
                  {#if hasFieldErrors(key)}
                    <div class="sm:pl-60 space-y-1">
                      {#each fieldErrors(key) as fieldError}
                        <p class="text-sm text-wilt-600">{fieldError}</p>
                      {/each}
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/if}

      <div class="flex items-center gap-3 pt-2">
        <button onclick={saveAdvanced} disabled={saving}
          class="px-5 py-2.5 rounded-lg bg-gold-600 text-white text-sm font-medium
                 hover:bg-gold-700 disabled:opacity-50 transition-colors shadow-sm">
          {saving ? 'Saving...' : 'Save All Settings'}
        </button>
      </div>
    </div>

  <!-- RAW MODE -->
  {:else}
    <div class="space-y-4">
      {#if discoveredModels.length > 0}
        <div class="card-garden px-5 py-3 flex items-center justify-between">
          <span class="text-sm text-shadow-700">
            {discoveredModels.length} models discovered via proxy
          </span>
          <button onclick={doRefreshModels} disabled={refreshingModels}
            class="text-sm text-gold-700 hover:text-gold-600 font-medium disabled:opacity-50">
            {refreshingModels ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      {/if}

      <div class="card-garden overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-bark-300">
          <h3 class="text-sm font-serif font-semibold text-shadow-800">settings.json (full runtime object)</h3>
          <div class="flex items-center gap-3">
            {#if rawSaveStatus['settings']}
              <span class="text-sm font-medium {rawSaveStatus['settings'].ok ? 'text-moss-600' : 'text-wilt-600'}">
                {rawSaveStatus['settings'].msg}
              </span>
            {/if}
            <button
              onclick={saveRawSettings}
              disabled={saving}
              class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium
                     hover:bg-gold-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
        <textarea
          bind:value={settingsJson}
          rows="18"
          class="w-full font-mono text-sm text-shadow-800 bg-white p-4
                 focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-inset
                 resize-y border-0"
          spellcheck="false"
        ></textarea>
        {#if Object.keys(validationErrorsByField).length > 0}
          <div class="px-5 pb-4 border-t border-bark-300 space-y-1">
            {#each Object.entries(validationErrorsByField) as [field, messages]}
              {#each messages as message}
                <p class="text-sm text-wilt-600">
                  <span class="font-mono">{field}</span>: {message}
                </p>
              {/each}
            {/each}
          </div>
        {/if}
      </div>

      {#each RAW_EDITORS as editor}
        {@const status = rawSaveStatus[editor.key]}
        <div class="card-garden overflow-hidden">
          <div class="flex items-center justify-between px-5 py-3 border-b border-bark-300">
            <h3 class="text-sm font-serif font-semibold text-shadow-800">{editor.label}</h3>
            <div class="flex items-center gap-3">
              {#if status}
                <span class="text-sm font-medium {status.ok ? 'text-moss-600' : 'text-wilt-600'}">
                  {status.msg}
                </span>
              {/if}
              <button
                onclick={() => saveRawConfig(editor.key, editor.label)}
                disabled={saving}
                class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium
                       hover:bg-gold-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
          <textarea
            value={getRawJson(editor.key)}
            oninput={(e) => setRawJson(editor.key, (e.target as HTMLTextAreaElement).value)}
            rows="14"
            class="w-full font-mono text-sm text-shadow-800 bg-white p-4
                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-inset
                   resize-y border-0"
            spellcheck="false"
          ></textarea>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Environment info (always visible) -->
  {#if data?.env}
    {@const env = data.env as Record<string, unknown>}
    <div class="card-garden px-5 py-4">
      <h2 class="text-sm font-serif font-semibold text-shadow-700 mb-2 uppercase tracking-wider">Environment</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm text-shadow-700">
        {#if env.nodeVersion}
          <div>
            <span class="text-shadow-500">Node</span>
            <span class="font-mono ml-1 text-shadow-800">{env.nodeVersion}</span>
          </div>
        {/if}
        {#if env.platform}
          <div>
            <span class="text-shadow-500">Platform</span>
            <span class="font-mono ml-1 text-shadow-800">{env.platform}/{env.arch}</span>
          </div>
        {/if}
        {#if env.uptime !== undefined}
          <div>
            <span class="text-shadow-500">Uptime</span>
            <span class="ml-1 text-shadow-800">{Math.floor(Number(env.uptime) / 3600)}h {Math.floor((Number(env.uptime) % 3600) / 60)}m</span>
          </div>
        {/if}
        {#if env.memoryUsage && typeof env.memoryUsage === 'object'}
          {@const mem = env.memoryUsage as Record<string, number>}
          <div>
            <span class="text-shadow-500">Heap</span>
            <span class="ml-1 text-shadow-800">{(mem.heapUsed / 1_048_576).toFixed(0)}MB / {(mem.heapTotal / 1_048_576).toFixed(0)}MB</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
