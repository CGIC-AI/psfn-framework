<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getSettings,
    updateSettings,
    getModelsConfig,
    saveModelsConfig,
    getSkillsConfig,
    saveSkillsConfig,
    getSchedulerConfig,
    saveSchedulerConfig,
    getTrustPolicyConfig,
    saveTrustPolicyConfig,
    getCapabilitiesConfig,
    saveCapabilitiesConfig,
    listModels,
    refreshModels,
  } from '$lib/api/endpoints/settings';
  import type { AdminSettingsData, DiscoveredModel } from '$lib/types';

  type ViewMode = 'simple' | 'advanced' | 'raw';

  let data = $state<AdminSettingsData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let mode = $state<ViewMode>('simple');
  let saving = $state(false);
  let saveMessage = $state('');
  let saveOk = $state(true);
  let discoveredModels = $state<DiscoveredModel[]>([]);

  // Simple mode fields
  let primaryModel = $state('');
  let primaryProvider = $state('');
  let primaryMaxTokens = $state(4096);
  let extractionModel = $state('');
  let extractionProvider = $state('');
  let extractionMaxTokens = $state(4096);
  let memoryRetrievalBudgetPct = $state(20);
  let memoryRetrievalLimit = $state(15);
  let extractionInterval = $state(5);
  let sessionHistoryBudgetPct = $state(70);
  let sessionMessageLimit = $state(50);
  let retryMaxAttempts = $state(3);
  let retryBaseDelayMs = $state(1000);

  // Raw editor states
  let modelsJson = $state('');
  let skillsJson = $state('');
  let schedulerJson = $state('');
  let trustPolicyJson = $state('');
  let capabilitiesJson = $state('');

  // Advanced mode
  let openSections = $state(new Set<string>(['models']));

  const CONFIG_SECTIONS: Array<{ title: string; keys: string[] }> = [
    {
      title: 'Models & Roster',
      keys: [
        'primaryModel', 'primaryProvider', 'primaryMaxTokens',
        'extractionModel', 'extractionProvider', 'extractionMaxTokens',
        'reasoningModel', 'reasoningProvider', 'reasoningMaxTokens',
        'longContextModel', 'longContextProvider', 'longContextMaxTokens',
        'defaultContextWindow',
      ],
    },
    {
      title: 'Memory & Extraction',
      keys: [
        'memoryBudgetPct', 'memoryRetrievalLimit', 'extractionThresholdPct',
        'extractionInterval', 'salienceFloor',
      ],
    },
    {
      title: 'Sessions & Compaction',
      keys: [
        'compactionThresholdPct', 'sessionMessageLimit', 'maxSessionTokens',
      ],
    },
    {
      title: 'LLM Retries',
      keys: [
        'retryMaxAttempts', 'retryBaseDelayMs',
      ],
    },
    {
      title: 'Think Tool',
      keys: [
        'thinkMaxIterations', 'thinkMaxTokensPerIteration', 'thinkTimeout',
      ],
    },
    {
      title: 'Import Processing',
      keys: [
        'importProcessingModel', 'importProcessingProvider',
        'importProcessingMaxTokens', 'importProcessingLocalApiBase',
      ],
    },
    {
      title: 'Web Fetch Policy',
      keys: [
        'allowHttpFetch', 'fetchDomainAllowlist',
      ],
    },
  ];

  function populateFields(config: Record<string, unknown>) {
    primaryModel = String(config.primaryModel ?? '');
    primaryProvider = String(config.primaryProvider ?? '');
    primaryMaxTokens = Number(config.primaryMaxTokens ?? 4096);
    extractionModel = String(config.extractionModel ?? '');
    extractionProvider = String(config.extractionProvider ?? '');
    extractionMaxTokens = Number(config.extractionMaxTokens ?? 4096);
    memoryRetrievalBudgetPct = Number(config.memoryBudgetPct ?? 20);
    memoryRetrievalLimit = Number(config.memoryRetrievalLimit ?? 15);
    extractionInterval = Number(config.extractionInterval ?? 5);
    sessionHistoryBudgetPct = Number(config.compactionThresholdPct ?? 70);
    sessionMessageLimit = Number(config.sessionMessageLimit ?? 50);
    retryMaxAttempts = Number(config.retryMaxAttempts ?? 3);
    retryBaseDelayMs = Number(config.retryBaseDelayMs ?? 1000);
  }

  function flash(ok: boolean, msg: string) {
    saveOk = ok;
    saveMessage = msg;
    setTimeout(() => { saveMessage = ''; }, 4000);
  }

  async function saveSimple() {
    saving = true;
    try {
      const result = await updateSettings({
        primaryModel,
        primaryProvider,
        primaryMaxTokens,
        extractionModel,
        extractionProvider,
        extractionMaxTokens,
        memoryBudgetPct: memoryRetrievalBudgetPct,
        memoryRetrievalLimit,
        extractionInterval,
        compactionThresholdPct: sessionHistoryBudgetPct,
        sessionMessageLimit,
        retryMaxAttempts,
        retryBaseDelayMs,
      });
      flash(result.ok, result.message || 'Settings saved');
      if (result.ok) {
        data = await getSettings();
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
      const config = data.config as Record<string, unknown>;
      const result = await updateSettings(config);
      flash(result.ok, result.message || 'Settings saved');
      if (result.ok) {
        data = await getSettings();
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to save');
    } finally {
      saving = false;
    }
  }

  async function saveRawConfig(
    label: string,
    jsonStr: string,
    saveFn: (config: unknown) => Promise<void>,
  ) {
    saving = true;
    try {
      const parsed = JSON.parse(jsonStr);
      await saveFn(parsed);
      flash(true, `${label} saved`);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : `Failed to save ${label}`);
    } finally {
      saving = false;
    }
  }

  async function doRefreshModels() {
    try {
      discoveredModels = await refreshModels();
      flash(true, `Discovered ${discoveredModels.length} models`);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Model refresh failed');
    }
  }

  function configValue(key: string): unknown {
    if (!data) return undefined;
    return (data.config as Record<string, unknown>)[key];
  }

  function setConfigValue(key: string, value: unknown) {
    if (!data) return;
    (data.config as Record<string, unknown>)[key] = value;
  }

  function renderFieldType(value: unknown): 'text' | 'number' | 'checkbox' | 'array' | 'object' {
    if (typeof value === 'boolean') return 'checkbox';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'array';
    if (value !== null && typeof value === 'object') return 'object';
    return 'text';
  }

  function toggleSection(title: string) {
    const next = new Set(openSections);
    if (next.has(title)) {
      next.delete(title);
    } else {
      next.add(title);
    }
    openSections = next;
  }

  onMount(async () => {
    try {
      const [settingsData, models] = await Promise.all([
        getSettings(),
        listModels().catch(() => [] as DiscoveredModel[]),
      ]);
      data = settingsData;
      discoveredModels = models;
      populateFields(data.config as Record<string, unknown>);

      // Load raw editor JSON
      const [mConf, skConf, schConf, tpConf, capConf] = await Promise.all([
        getModelsConfig().catch(() => ({})),
        getSkillsConfig().catch(() => ({})),
        getSchedulerConfig().catch(() => ({})),
        getTrustPolicyConfig().catch(() => ({})),
        getCapabilitiesConfig().catch(() => ({})),
      ]);
      modelsJson = JSON.stringify(mConf, null, 2);
      skillsJson = JSON.stringify(skConf, null, 2);
      schedulerJson = JSON.stringify(schConf, null, 2);
      trustPolicyJson = JSON.stringify(tpConf, null, 2);
      capabilitiesJson = JSON.stringify(capConf, null, 2);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
    }
  });
</script>

<datalist id="model-list">
  {#each discoveredModels as m}
    <option value={m.id}>{m.description ?? m.id}</option>
  {/each}
</datalist>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Climate</h1>
      <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Runtime configuration</p>
    </div>

    <div class="flex items-center gap-3">
      <button onclick={doRefreshModels}
        class="px-3 py-1.5 text-xs font-medium rounded-lg border border-bark-300 dark:border-shadow-600 text-shadow-500 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-700 transition-colors">
        Refresh Models
      </button>

      <!-- Mode switcher -->
      <div class="flex rounded-lg border border-bark-300 dark:border-shadow-600 overflow-hidden">
        {#each (['simple', 'advanced', 'raw'] as const) as m}
          <button
            onclick={() => mode = m}
            class="px-3 py-1.5 text-xs font-medium capitalize transition-colors
              {mode === m
                ? 'bg-gold-600 text-white'
                : 'bg-bark-50 dark:bg-shadow-800 text-shadow-500 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-700'}"
          >
            {m}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Flash message -->
  {#if saveMessage}
    <div class="px-4 py-2 rounded-lg text-sm {saveOk ? 'bg-moss-50 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300' : 'bg-wilt-50 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300'}">
      {saveMessage}
    </div>
  {/if}

  {#if loading}
    <div class="card-garden p-6 animate-pulse space-y-4">
      {#each Array(4) as _}
        <div class="h-10 bg-bark-200 dark:bg-shadow-700 rounded"></div>
      {/each}
    </div>
  {:else if error}
    <div class="card-garden p-6 text-center text-wilt-600">{error}</div>

  {:else if mode === 'simple'}
    <!-- ── Simple Mode ── -->
    <div class="card-garden p-6 space-y-5">
      <h2 class="text-sm font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-2">Primary Model</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Model</label>
          <input type="text" list="model-list" bind:value={primaryModel}
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Provider</label>
          <input type="text" bind:value={primaryProvider}
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Max Tokens</label>
          <input type="number" bind:value={primaryMaxTokens} min="256" step="256"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
      </div>

      <h2 class="text-sm font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-2 pt-2">Extraction Model</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Model</label>
          <input type="text" list="model-list" bind:value={extractionModel}
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Provider</label>
          <input type="text" bind:value={extractionProvider}
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Max Tokens</label>
          <input type="number" bind:value={extractionMaxTokens} min="256" step="256"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
      </div>

      <h2 class="text-sm font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-2 pt-2">Memory & Retrieval</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Retrieval Budget %</label>
          <input type="number" bind:value={memoryRetrievalBudgetPct} min="1" max="100"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Retrieval Limit</label>
          <input type="number" bind:value={memoryRetrievalLimit} min="1" max="100"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Extraction Interval (min)</label>
          <input type="number" bind:value={extractionInterval} min="1"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
      </div>

      <h2 class="text-sm font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-2 pt-2">Sessions</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">History Budget %</label>
          <input type="number" bind:value={sessionHistoryBudgetPct} min="10" max="100"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Message Limit</label>
          <input type="number" bind:value={sessionMessageLimit} min="5" max="500"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
      </div>

      <h2 class="text-sm font-serif font-semibold text-shadow-700 dark:text-bark-300 mb-2 pt-2">LLM Retries</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Max Attempts</label>
          <input type="number" bind:value={retryMaxAttempts} min="0" max="10"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
        <div>
          <label class="block text-xs font-medium text-shadow-600 dark:text-bark-400 mb-1">Base Delay (ms)</label>
          <input type="number" bind:value={retryBaseDelayMs} min="100" step="100"
            class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300" />
        </div>
      </div>

      <div class="flex items-center gap-3 pt-3">
        <button onclick={saveSimple} disabled={saving}
          class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>

  {:else if mode === 'advanced'}
    <!-- ── Advanced Mode ── -->
    <div class="space-y-3">
      {#each CONFIG_SECTIONS as section}
        {@const sectionKeys = section.keys.filter((k) => data && k in (data.config as Record<string, unknown>))}
        {#if sectionKeys.length > 0}
          <div class="card-garden overflow-hidden">
            <button
              onclick={() => toggleSection(section.title)}
              class="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-bark-50 dark:hover:bg-shadow-800 transition-colors"
            >
              <h2 class="text-sm font-serif font-semibold text-shadow-700 dark:text-bark-300">{section.title}</h2>
              <span class="text-shadow-400 text-xs">{openSections.has(section.title) ? '−' : '+'}</span>
            </button>
            {#if openSections.has(section.title)}
              <div class="px-5 pb-4 space-y-3 border-t border-bark-100 dark:border-shadow-800 pt-3">
                {#each sectionKeys as key}
                  {@const value = configValue(key)}
                  {@const fieldType = renderFieldType(value)}
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <label class="text-xs font-mono text-shadow-600 dark:text-bark-400 sm:w-56 shrink-0">{key}</label>
                    {#if fieldType === 'checkbox'}
                      <input type="checkbox"
                        checked={Boolean(value)}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).checked)}
                        class="h-4 w-4 rounded border-bark-300 text-gold-600 focus:ring-gold-300" />
                    {:else if fieldType === 'number'}
                      <input type="number"
                        value={Number(value)}
                        onchange={(e) => setConfigValue(key, Number((e.target as HTMLInputElement).value))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {:else if fieldType === 'array'}
                      <input type="text"
                        value={Array.isArray(value) ? value.join(', ') : ''}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300"
                        placeholder="comma-separated values" />
                    {:else if fieldType === 'object'}
                      <textarea
                        value={JSON.stringify(value, null, 2)}
                        onchange={(e) => { try { setConfigValue(key, JSON.parse((e.target as HTMLTextAreaElement).value)); } catch { /* ignore */ } }}
                        rows="3"
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300 resize-y"
                        spellcheck="false"
                      ></textarea>
                    {:else}
                      <input type="text"
                        value={String(value ?? '')}
                        list={key.toLowerCase().includes('model') ? 'model-list' : undefined}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value)}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/each}

      <!-- Other Settings (uncategorized keys) -->
      {#if data}
        {@const allCategorized = new Set(CONFIG_SECTIONS.flatMap(s => s.keys))}
        {@const otherKeys = Object.keys(data.config as Record<string, unknown>).filter(k => !allCategorized.has(k))}
        {#if otherKeys.length > 0}
          <div class="card-garden overflow-hidden">
            <button
              onclick={() => toggleSection('Other Settings')}
              class="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-bark-50 dark:hover:bg-shadow-800 transition-colors"
            >
              <h2 class="text-sm font-serif font-semibold text-shadow-700 dark:text-bark-300">Other Settings</h2>
              <span class="text-shadow-400 text-xs">{openSections.has('Other Settings') ? '−' : '+'}</span>
            </button>
            {#if openSections.has('Other Settings')}
              <div class="px-5 pb-4 space-y-3 border-t border-bark-100 dark:border-shadow-800 pt-3">
                {#each otherKeys as key}
                  {@const value = configValue(key)}
                  {@const fieldType = renderFieldType(value)}
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <label class="text-xs font-mono text-shadow-600 dark:text-bark-400 sm:w-56 shrink-0">{key}</label>
                    {#if fieldType === 'checkbox'}
                      <input type="checkbox"
                        checked={Boolean(value)}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).checked)}
                        class="h-4 w-4 rounded border-bark-300 text-gold-600 focus:ring-gold-300" />
                    {:else if fieldType === 'number'}
                      <input type="number"
                        value={Number(value)}
                        onchange={(e) => setConfigValue(key, Number((e.target as HTMLInputElement).value))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {:else if fieldType === 'array'}
                      <input type="text"
                        value={Array.isArray(value) ? value.join(', ') : ''}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300"
                        placeholder="comma-separated values" />
                    {:else if fieldType === 'object'}
                      <textarea
                        value={JSON.stringify(value, null, 2)}
                        onchange={(e) => { try { setConfigValue(key, JSON.parse((e.target as HTMLTextAreaElement).value)); } catch { /* ignore */ } }}
                        rows="3"
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300 resize-y"
                        spellcheck="false"
                      ></textarea>
                    {:else}
                      <input type="text"
                        value={String(value ?? '')}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value)}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/if}

      <div class="flex items-center gap-3 pt-1">
        <button onclick={saveAdvanced} disabled={saving}
          class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : 'Save All Settings'}
        </button>
      </div>
    </div>

  {:else}
    <!-- ── Raw Mode ── -->
    <div class="space-y-4">
      {#each [
        { label: 'models.json', get: () => modelsJson, set: (v: string) => modelsJson = v, save: saveModelsConfig },
        { label: 'skills.json', get: () => skillsJson, set: (v: string) => skillsJson = v, save: saveSkillsConfig },
        { label: 'scheduler.json', get: () => schedulerJson, set: (v: string) => schedulerJson = v, save: saveSchedulerConfig },
        { label: 'trust-policy.json', get: () => trustPolicyJson, set: (v: string) => trustPolicyJson = v, save: saveTrustPolicyConfig },
        { label: 'capability-tier.json', get: () => capabilitiesJson, set: (v: string) => capabilitiesJson = v, save: saveCapabilitiesConfig },
      ] as editor}
        <div class="card-garden p-4">
          <h3 class="text-xs font-serif font-semibold text-shadow-600 dark:text-bark-400 mb-2">{editor.label}</h3>
          <textarea
            value={editor.get()}
            oninput={(e) => editor.set((e.target as HTMLTextAreaElement).value)}
            rows="12"
            class="w-full font-mono text-xs text-shadow-600 dark:text-bark-400 bg-bark-50 dark:bg-shadow-900 border border-bark-200 dark:border-shadow-700 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-gold-300 resize-y"
            spellcheck="false"
          ></textarea>
          <div class="flex items-center gap-3 mt-2">
            <button
              onclick={() => saveRawConfig(editor.label, editor.get(), editor.save)}
              disabled={saving}
              class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-xs font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : `Save ${editor.label}`}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Environment info -->
  {#if data?.env}
    <div class="card-garden p-5">
      <h2 class="text-sm font-serif font-semibold text-shadow-600 dark:text-bark-400 mb-2">Environment</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-shadow-500 dark:text-bark-400">
        {#if data.env.nodeVersion}
          <div>Node: <span class="font-mono">{data.env.nodeVersion}</span></div>
        {/if}
        {#if data.env.platform}
          <div>Platform: <span class="font-mono">{data.env.platform}/{data.env.arch}</span></div>
        {/if}
        {#if data.env.uptime !== undefined}
          <div>Uptime: {Math.floor(data.env.uptime / 3600)}h {Math.floor((data.env.uptime % 3600) / 60)}m</div>
        {/if}
        {#if data.env.memoryUsage}
          <div>Heap: {(data.env.memoryUsage.heapUsed / 1_048_576).toFixed(0)}MB / {(data.env.memoryUsage.heapTotal / 1_048_576).toFixed(0)}MB</div>
        {/if}
      </div>
    </div>
  {/if}
</div>
