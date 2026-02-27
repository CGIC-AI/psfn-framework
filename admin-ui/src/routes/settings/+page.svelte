<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getSettings,
    updateSettings,
    getSubConfig,
    saveSubConfig,
    listModels,
    refreshModels,
  } from '$lib/api/endpoints/settings';
  import type { AdminSettingsData, DiscoveredModel } from '$lib/types';

  type ViewMode = 'simple' | 'advanced' | 'raw';

  // ── Model catalog types ──
  interface CatalogSlot {
    slotKey: string;
    model: string;
    provider: string;
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

  // ── Simple mode fields ──
  let primaryModel = $state('');
  let extractionModel = $state('');
  let memoryBudgetPct = $state(20);
  let memoryRetrievalLimit = $state(15);
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
  let allowHttpFetch = $state(false);
  let webFetchDomainAllowlist = $state('');
  let webFetchLocalCrawlerHostAllowlist = $state('');
  let webFetchLocalCrawlerDomainAllowlist = $state('');
  let webFetchTlsCaCertPaths = $state('');

  // ── Capability tier ──
  let capabilityTier = $state('apprentice');

  // ── LLM retries ──
  let retryBaseDelayMs = $state(2000);

  // ── Raw editor states ──
  let modelsJson = $state('');
  let skillsJson = $state('');
  let schedulerJson = $state('');
  let trustPolicyJson = $state('');
  let capabilitiesJson = $state('');
  let rawSaveStatus = $state<Record<string, { ok: boolean; msg: string }>>({});

  // ── Advanced mode ──
  let openSections = $state(new Set<string>(['models']));

  const ADVANCED_SECTIONS: Array<{ id: string; title: string; icon: string; keys: string[] }> = [
    {
      id: 'models', title: 'Models & Roster', icon: 'M',
      keys: [
        'primaryModel', 'primaryProvider', 'primaryMaxTokens',
        'extractionModel', 'extractionProvider', 'extractionMaxTokens',
        'reasoningModel', 'reasoningProvider', 'reasoningMaxTokens',
        'longContextModel', 'longContextProvider', 'longContextMaxTokens',
        'backgroundModel', 'backgroundProvider', 'backgroundMaxTokens',
        'defaultContextWindow',
      ],
    },
    {
      id: 'memory', title: 'Memory & Extraction', icon: 'E',
      keys: [
        'memoryBudgetPct', 'memoryRetrievalLimit', 'extractionThresholdPct',
        'extractionInterval', 'salienceFloor',
      ],
    },
    {
      id: 'sessions', title: 'Sessions & Compaction', icon: 'S',
      keys: ['compactionThresholdPct', 'sessionMessageLimit', 'maxSessionTokens'],
    },
    {
      id: 'llm', title: 'LLM Retries & Behavior', icon: 'L',
      keys: ['retryMaxAttempts', 'retryBaseDelayMs'],
    },
    {
      id: 'think', title: 'Think Tool', icon: 'T',
      keys: ['thinkMaxIterations', 'thinkMaxTokensPerIteration', 'thinkTimeout'],
    },
    {
      id: 'import', title: 'Import Processing', icon: 'I',
      keys: [
        'importProcessingRouteMode', 'importProcessingStrictPolicy',
        'importProcessingLocalEndpointUrl', 'importProcessingLocalModel',
        'openRouterProviderOrder',
      ],
    },
    {
      id: 'fetch', title: 'Web Fetch Policy', icon: 'W',
      keys: [
        'allowHttpFetch', 'webFetchDomainAllowlist',
        'webFetchLocalCrawlerHostAllowlist', 'webFetchLocalCrawlerDomainAllowlist',
        'webFetchTlsCaCertPaths',
      ],
    },
  ];

  const RAW_EDITORS = [
    { key: 'models', label: 'models.json' },
    { key: 'skills', label: 'skills.json' },
    { key: 'scheduler', label: 'scheduler.json' },
    { key: 'trust-policy', label: 'trust-policy.json' },
    { key: 'capabilities', label: 'capabilities.json' },
  ] as const;

  // ── Derived ──
  let slotKeys = $derived(catalogSlots.map(s => s.slotKey).filter(Boolean));

  let budgetPreview = $derived.by(() => {
    if (!data) return { session: '', memory: '', contextWindow: '128,000' };
    const config = data.config as Record<string, unknown>;
    const ctxWindow = Number(config.defaultContextWindow ?? 128000);
    const memPct = memoryBudgetPct / 100;
    const memTokenBudget = Math.floor(ctxWindow * memPct);
    const memItems = Math.min(Math.max(Math.floor(memTokenBudget / 200), 3), 100);
    const sessPct = (100 - memoryBudgetPct - 10) / 100; // rough: leave 10% for system
    const sessTokenBudget = Math.floor(ctxWindow * sessPct);
    const sessMsgs = Math.min(Math.max(Math.floor(sessTokenBudget / 400), 5), 500);
    return {
      session: `~${sessMsgs} messages (~${(sessTokenBudget / 1000).toFixed(0)}K tokens)`,
      memory: `~${memItems} memories (~${(memTokenBudget / 1000).toFixed(0)}K tokens)`,
      contextWindow: ctxWindow.toLocaleString(),
    };
  });

  // ── Helpers ──
  function populateSimpleFields(config: Record<string, unknown>) {
    primaryModel = String(config.primaryModel ?? '');
    extractionModel = String(config.extractionModel ?? '');
    memoryBudgetPct = Number(config.memoryBudgetPct ?? 20);
    memoryRetrievalLimit = Number(config.memoryRetrievalLimit ?? 15);
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
    allowHttpFetch = Boolean(config.allowHttpFetch);
    webFetchDomainAllowlist = Array.isArray(config.webFetchDomainAllowlist) ? config.webFetchDomainAllowlist.join(', ') : '';
    webFetchLocalCrawlerHostAllowlist = Array.isArray(config.webFetchLocalCrawlerHostAllowlist) ? config.webFetchLocalCrawlerHostAllowlist.join(', ') : '';
    webFetchLocalCrawlerDomainAllowlist = Array.isArray(config.webFetchLocalCrawlerDomainAllowlist) ? config.webFetchLocalCrawlerDomainAllowlist.join(', ') : '';
    webFetchTlsCaCertPaths = Array.isArray(config.webFetchTlsCaCertPaths) ? config.webFetchTlsCaCertPaths.join(', ') : '';
    capabilityTier = String(config.capabilityTier ?? 'apprentice');

    // Populate catalog slots
    const catalog = config.modelCatalog as Record<string, Record<string, unknown>> | undefined;
    if (catalog && Object.keys(catalog).length > 0) {
      catalogSlots = Object.entries(catalog).map(([key, entry]) => ({
        slotKey: key,
        model: String(entry.model ?? ''),
        provider: String(entry.provider ?? ''),
        defaultMaxTokens: entry.defaults && typeof entry.defaults === 'object' ? Number((entry.defaults as Record<string, unknown>).maxTokens ?? 0) || null : null,
        defaultContextWindow: entry.defaults && typeof entry.defaults === 'object' ? Number((entry.defaults as Record<string, unknown>).contextWindow ?? 0) || null : null,
        overrideMaxTokens: entry.overrides && typeof entry.overrides === 'object' ? Number((entry.overrides as Record<string, unknown>).maxTokens ?? 0) || null : null,
        overrideContextWindow: entry.overrides && typeof entry.overrides === 'object' ? Number((entry.overrides as Record<string, unknown>).contextWindow ?? 0) || null : null,
      }));
    } else {
      catalogSlots = [
        { slotKey: 'primary', model: String(config.primaryModel ?? ''), provider: String(config.primaryProvider ?? ''), defaultMaxTokens: Number(config.primaryMaxTokens ?? 4096), defaultContextWindow: Number(config.defaultContextWindow ?? 128000), overrideMaxTokens: null, overrideContextWindow: null },
        { slotKey: 'extraction', model: String(config.extractionModel ?? ''), provider: String(config.extractionProvider ?? ''), defaultMaxTokens: Number(config.extractionMaxTokens ?? 4096), defaultContextWindow: null, overrideMaxTokens: null, overrideContextWindow: null },
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

  // ── Catalog actions ──
  function addCatalogSlot() {
    catalogSlots = [...catalogSlots, {
      slotKey: '', model: '', provider: '',
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

  async function saveSimple() {
    saving = true;
    try {
      const catalogPayload = buildCatalogPayload();
      const result = await updateSettings({
        primaryModel,
        extractionModel,
        memoryBudgetPct,
        memoryRetrievalLimit,
        extractionThresholdPct,
        compactionThresholdPct,
        primaryMaxTokens: maxResponseTokens,
        retryMaxAttempts,
        retryBaseDelayMs,
        importProcessingRouteMode: importRouteMode,
        importProcessingStrictPolicy: importStrictPolicy,
        importProcessingLocalEndpointUrl: importLocalEndpointUrl,
        importProcessingLocalModel: importLocalModel,
        openRouterProviderOrder: openRouterProviderOrder.split(',').map(s => s.trim()).filter(Boolean),
        allowHttpFetch: allowHttpFetch,
        webFetchDomainAllowlist: webFetchDomainAllowlist.split(',').map(s => s.trim()).filter(Boolean),
        capabilityTier,
        ...catalogPayload,
      });
      flash(result.ok, result.message || 'Settings saved');
      if (result.ok) { data = await getSettings(); }
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
      flash(result.ok, result.message || 'Settings saved');
      if (result.ok) { data = await getSettings(); }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to save');
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
    try {
      const [settingsData, models] = await Promise.all([
        getSettings(),
        listModels().catch(() => [] as DiscoveredModel[]),
      ]);
      data = settingsData;
      discoveredModels = models;
      populateSimpleFields(data.config as Record<string, unknown>);

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

  const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 transition-colors';
  const LABEL_CLS = 'block text-sm font-medium text-shadow-700 mb-1.5';
  const SECTION_HEADING_CLS = 'text-sm font-serif font-semibold text-shadow-800';
  const SLIDER_CLS = 'flex-1 h-2 rounded-full appearance-none bg-bark-300 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gold-500 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-gold-500 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer';
  const COMPACT_INPUT_CLS = 'w-20 px-2 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold-300';
</script>

<!-- Model datalist for autocomplete -->
<datalist id="model-list">
  {#each discoveredModels as m}
    <option value={m.id}>{m.description ?? m.id}</option>
  {/each}
</datalist>

<div class="space-y-5">
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Climate</h1>
      <p class="text-sm text-shadow-600 mt-1">Runtime configuration and tuning</p>
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

  <!-- ════════════ SIMPLE MODE ════════════ -->
  {:else if mode === 'simple'}
    <div class="space-y-5">
      <!-- Model Catalog -->
      <div class="card-garden p-6 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class={SECTION_HEADING_CLS}>Model Catalog</h2>
          <button onclick={addCatalogSlot}
            class="px-3 py-1 text-sm font-medium rounded border border-gold-400 text-gold-700 hover:bg-gold-50 transition-colors">
            + Add Slot
          </button>
        </div>
        <p class="text-sm text-shadow-600">Define reusable model slots, then map purposes to slots below. Discovery metadata auto-fills defaults.</p>
        <hr class="divider-filigree" />

        <div class="overflow-x-auto">
          <table class="w-full text-sm min-w-[800px]">
            <thead>
              <tr class="border-b border-bark-300">
                <th class="text-left py-2 px-2 text-shadow-700 font-medium">Slot Key</th>
                <th class="text-left py-2 px-2 text-shadow-700 font-medium">Model</th>
                <th class="text-left py-2 px-2 text-shadow-700 font-medium">Provider</th>
                <th class="text-right py-2 px-2 text-shadow-700 font-medium">Default Max Tokens</th>
                <th class="text-right py-2 px-2 text-shadow-700 font-medium">Default Context</th>
                <th class="text-right py-2 px-2 text-shadow-700 font-medium">Override Max Tokens</th>
                <th class="text-right py-2 px-2 text-shadow-700 font-medium">Override Context</th>
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
      </div>

      <!-- Purpose Mappings -->
      <div class="card-garden p-6 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class={SECTION_HEADING_CLS}>Purpose Mappings</h2>
          <button onclick={addPurposeMapping}
            class="px-3 py-1 text-sm font-medium rounded border border-gold-400 text-gold-700 hover:bg-gold-50 transition-colors">
            + Add Mapping
          </button>
        </div>
        <p class="text-sm text-shadow-600">Map each purpose to a model slot from the catalog above.</p>
        <hr class="divider-filigree" />

        <div class="space-y-2">
          {#each purposeMappings as mapping, i}
            <div class="flex items-center gap-3">
              <input type="text" bind:value={mapping.purpose} placeholder="chat"
                class="w-40 px-3 py-1.5 text-sm rounded border border-bark-300 bg-white text-shadow-800 font-mono focus:ring-1 focus:ring-gold-300" />
              <svg class="w-4 h-4 text-shadow-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14m-4-4l4 4-4 4"/></svg>
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

      <!-- Live Budget Preview -->
      <div class="card-garden p-5">
        <h2 class={SECTION_HEADING_CLS}>Live Budget Preview</h2>
        <hr class="divider-filigree my-3" />
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div class="bg-bark-100 rounded-lg p-3">
            <span class="text-shadow-600 block mb-1">Context Window</span>
            <span class="text-shadow-900 font-mono font-medium">{budgetPreview.contextWindow} tokens</span>
          </div>
          <div class="bg-moss-50 rounded-lg p-3">
            <span class="text-shadow-600 block mb-1">Session History</span>
            <span class="text-shadow-900 font-medium">{budgetPreview.session}</span>
          </div>
          <div class="bg-gold-50 rounded-lg p-3">
            <span class="text-shadow-600 block mb-1">Memory Retrieval</span>
            <span class="text-shadow-900 font-medium">{budgetPreview.memory}</span>
          </div>
        </div>
      </div>

      <!-- Memory & Extraction -->
      <div class="card-garden p-6 space-y-6">
        <h2 class={SECTION_HEADING_CLS}>Memory & Extraction</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>Memory Budget %</label>
            <div class="flex items-center gap-3">
              <input type="range" min="5" max="50" step="1" bind:value={memoryBudgetPct} class={SLIDER_CLS} />
              <input type="number" min="5" max="50" bind:value={memoryBudgetPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-600 mt-1">% of context window reserved for memory retrieval</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Memory Retrieval Limit</label>
            <input type="number" min="1" max="500" bind:value={memoryRetrievalLimit} class={INPUT_CLS} />
            <p class="text-sm text-shadow-600 mt-1">Max memories returned per retrieval</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Extraction Threshold %</label>
            <div class="flex items-center gap-3">
              <input type="range" min="10" max="80" step="1" bind:value={extractionThresholdPct} class={SLIDER_CLS} />
              <input type="number" min="10" max="80" bind:value={extractionThresholdPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-600 mt-1">Triggers extraction when session exceeds this % of context</p>
          </div>
          <div>
            <label class={LABEL_CLS}>Compaction Threshold %</label>
            <div class="flex items-center gap-3">
              <input type="range" min="30" max="90" step="1" bind:value={compactionThresholdPct} class={SLIDER_CLS} />
              <input type="number" min="30" max="90" bind:value={compactionThresholdPct} class={COMPACT_INPUT_CLS} />
            </div>
            <p class="text-sm text-shadow-600 mt-1">Auto-compacts oldest 50% when context exceeds this %</p>
          </div>
        </div>
      </div>

      <!-- Response, Retries, Capability -->
      <div class="card-garden p-6 space-y-6">
        <h2 class={SECTION_HEADING_CLS}>Response, Retries & Capability</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>Max Response Tokens</label>
            <input type="number" min="256" step="256" bind:value={maxResponseTokens} class={INPUT_CLS} />
          </div>
          <div>
            <label class={LABEL_CLS}>LLM Max Retries</label>
            <input type="number" min="0" max="10" bind:value={retryMaxAttempts} class={INPUT_CLS} />
          </div>
          <div>
            <label class={LABEL_CLS}>Retry Base Delay (ms)</label>
            <input type="number" min="100" step="100" bind:value={retryBaseDelayMs} class={INPUT_CLS} />
          </div>
          <div>
            <label class={LABEL_CLS}>Capability Tier</label>
            <select bind:value={capabilityTier} class={INPUT_CLS}>
              {#each CAPABILITY_TIERS as tier}
                <option value={tier}>{tier}</option>
              {/each}
            </select>
            <p class="text-sm text-shadow-600 mt-1">Controls agent autonomy level</p>
          </div>
        </div>
      </div>

      <!-- Import Processing -->
      <div class="card-garden p-6 space-y-6">
        <h2 class={SECTION_HEADING_CLS}>Import Processing</h2>
        <hr class="divider-filigree" />
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
              <input type="checkbox" bind:checked={importStrictPolicy}
                class="w-4 h-4 rounded border-bark-400 text-gold-600 focus:ring-gold-300" />
              <span class="text-sm text-shadow-700">Enforce strict ZDR compliance</span>
            </label>
          </div>
          <div>
            <label class={LABEL_CLS}>OpenRouter Provider Order</label>
            <input type="text" bind:value={openRouterProviderOrder} class={INPUT_CLS} placeholder="comma-separated providers" />
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

      <!-- Gateway Web Fetch -->
      <div class="card-garden p-6 space-y-6">
        <h2 class={SECTION_HEADING_CLS}>Gateway Web Fetch</h2>
        <hr class="divider-filigree" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>Allow HTTP Fetch</label>
            <label class="flex items-center gap-2 mt-2 cursor-pointer">
              <input type="checkbox" bind:checked={allowHttpFetch}
                class="w-4 h-4 rounded border-bark-400 text-gold-600 focus:ring-gold-300" />
              <span class="text-sm text-shadow-700">Enable web fetch in gateway</span>
            </label>
          </div>
          <div>
            <label class={LABEL_CLS}>Domain Allowlist</label>
            <input type="text" bind:value={webFetchDomainAllowlist} class={INPUT_CLS} placeholder="comma-separated domains" />
          </div>
          <div>
            <label class={LABEL_CLS}>Local Crawler Host Allowlist</label>
            <input type="text" bind:value={webFetchLocalCrawlerHostAllowlist} class={INPUT_CLS} placeholder="comma-separated hosts" />
          </div>
          <div>
            <label class={LABEL_CLS}>TLS CA Cert Paths</label>
            <input type="text" bind:value={webFetchTlsCaCertPaths} class={INPUT_CLS} placeholder="comma-separated file paths" />
          </div>
        </div>
      </div>

      <!-- Secrets display -->
      {#if data?.env}
        {@const env = data.env as Record<string, unknown>}
        <div class="card-garden p-6 space-y-4">
          <h2 class={SECTION_HEADING_CLS}>Secrets (Read-Only)</h2>
          <hr class="divider-filigree" />
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

      <!-- Save -->
      <div class="flex items-center gap-3 pt-2">
        <button onclick={saveSimple} disabled={saving}
          class="px-5 py-2.5 rounded-lg bg-gold-600 text-white text-sm font-medium
                 hover:bg-gold-700 disabled:opacity-50 transition-colors shadow-sm">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>

  <!-- ════════════ ADVANCED MODE ════════════ -->
  {:else if mode === 'advanced'}
    <div class="space-y-3">
      {#each ADVANCED_SECTIONS as section}
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
                <h2 class={SECTION_HEADING_CLS}>{section.title}</h2>
                <span class="text-sm text-shadow-600">({sectionKeys.length} fields)</span>
              </div>
              <span class="text-shadow-600 text-sm transition-transform {openSections.has(section.id) ? 'rotate-180' : ''}">
                &#9660;
              </span>
            </button>
            {#if openSections.has(section.id)}
              <div class="px-5 pb-5 space-y-3 border-t border-bark-300 pt-4">
                {#each sectionKeys as key}
                  {@const value = configValue(key)}
                  {@const ft = fieldType(value)}
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <label class="text-sm font-mono text-shadow-700 sm:w-60 shrink-0">{key}</label>
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
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/each}

      <!-- Other (uncategorized) keys -->
      {#if data}
        {@const allCategorized = new Set(ADVANCED_SECTIONS.flatMap(s => s.keys))}
        {@const otherKeys = Object.keys(data.config as Record<string, unknown>).filter(k => !allCategorized.has(k))}
        {#if otherKeys.length > 0}
          <div class="card-garden overflow-hidden">
            <button
              onclick={() => toggleSection('other')}
              class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
            >
              <div class="flex items-center gap-3">
                <span class="flex items-center justify-center w-7 h-7 rounded-full bg-bark-200 text-shadow-700 text-sm font-bold border border-bark-400">
                  ?
                </span>
                <h2 class={SECTION_HEADING_CLS}>Other Settings</h2>
                <span class="text-sm text-shadow-600">({otherKeys.length} fields)</span>
              </div>
              <span class="text-shadow-600 text-sm transition-transform {openSections.has('other') ? 'rotate-180' : ''}">
                &#9660;
              </span>
            </button>
            {#if openSections.has('other')}
              <div class="px-5 pb-5 space-y-3 border-t border-bark-300 pt-4">
                {#each otherKeys as key}
                  {@const value = configValue(key)}
                  {@const ft = fieldType(value)}
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <label class="text-sm font-mono text-shadow-700 sm:w-60 shrink-0">{key}</label>
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

  <!-- ════════════ RAW MODE ════════════ -->
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
            class="w-full font-mono text-sm text-shadow-800 bg-bark-100 p-4
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
            <span class="text-shadow-600">Node</span>
            <span class="font-mono ml-1 text-shadow-800">{env.nodeVersion}</span>
          </div>
        {/if}
        {#if env.platform}
          <div>
            <span class="text-shadow-600">Platform</span>
            <span class="font-mono ml-1 text-shadow-800">{env.platform}/{env.arch}</span>
          </div>
        {/if}
        {#if env.uptime !== undefined}
          <div>
            <span class="text-shadow-600">Uptime</span>
            <span class="ml-1 text-shadow-800">{Math.floor(Number(env.uptime) / 3600)}h {Math.floor((Number(env.uptime) % 3600) / 60)}m</span>
          </div>
        {/if}
        {#if env.memoryUsage && typeof env.memoryUsage === 'object'}
          {@const mem = env.memoryUsage as Record<string, number>}
          <div>
            <span class="text-shadow-600">Heap</span>
            <span class="ml-1 text-shadow-800">{(mem.heapUsed / 1_048_576).toFixed(0)}MB / {(mem.heapTotal / 1_048_576).toFixed(0)}MB</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
