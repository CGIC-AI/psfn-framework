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
      id: 'models',
      title: 'Models & Roster',
      icon: 'M',
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
      id: 'memory',
      title: 'Memory & Extraction',
      icon: 'E',
      keys: [
        'memoryBudgetPct', 'memoryRetrievalLimit', 'extractionThresholdPct',
        'extractionInterval', 'salienceFloor',
      ],
    },
    {
      id: 'sessions',
      title: 'Sessions & Compaction',
      icon: 'S',
      keys: [
        'compactionThresholdPct', 'sessionMessageLimit', 'maxSessionTokens',
      ],
    },
    {
      id: 'llm',
      title: 'LLM Retries & Behavior',
      icon: 'L',
      keys: [
        'retryMaxAttempts', 'retryBaseDelayMs',
      ],
    },
    {
      id: 'think',
      title: 'Think Tool',
      icon: 'T',
      keys: [
        'thinkMaxIterations', 'thinkMaxTokensPerIteration', 'thinkTimeout',
      ],
    },
    {
      id: 'import',
      title: 'Import Processing',
      icon: 'I',
      keys: [
        'importProcessingModel', 'importProcessingProvider',
        'importProcessingMaxTokens', 'importProcessingLocalApiBase',
      ],
    },
    {
      id: 'fetch',
      title: 'Web Fetch Policy',
      icon: 'W',
      keys: [
        'allowHttpFetch', 'fetchDomainAllowlist',
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

  function getRawSaveFn(key: string): (json: string) => Promise<string> {
    return (json: string) => saveSubConfig(key, json);
  }

  // ── Actions ──

  async function saveSimple() {
    saving = true;
    try {
      const result = await updateSettings({
        primaryModel,
        extractionModel,
        memoryBudgetPct,
        memoryRetrievalLimit,
        extractionThresholdPct,
        compactionThresholdPct,
        primaryMaxTokens: maxResponseTokens,
        retryMaxAttempts,
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
      const result = await updateSettings(data.config as Record<string, unknown>);
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

  async function saveRawConfig(key: string, label: string) {
    saving = true;
    try {
      // Validate JSON before sending
      const json = getRawJson(key);
      JSON.parse(json); // throws if invalid
      await getRawSaveFn(key)(json);
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
      // getSubConfig returns raw JSON strings; pretty-print for editor
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

  // Input class constants
  const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 transition-colors';
  const LABEL_CLS = 'block text-xs font-medium text-shadow-500 dark:text-bark-400 mb-1.5';
  const SECTION_HEADING_CLS = 'text-sm font-serif font-semibold text-shadow-800 dark:text-bark-300';
</script>

<!-- Model datalist for autocomplete -->
<datalist id="model-list">
  {#each discoveredModels as m}
    <option value={m.id}>{m.description ?? m.id}</option>
  {/each}
</datalist>

<div class="space-y-5">
  <!-- ── Header ── -->
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900 dark:text-bark-200">The Climate</h1>
      <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Runtime configuration and tuning</p>
    </div>

    <div class="flex items-center gap-3">
      <!-- Refresh Models -->
      <button onclick={doRefreshModels} disabled={refreshingModels}
        class="px-3 py-1.5 text-xs font-medium rounded-lg border border-bark-300 dark:border-shadow-600
               text-shadow-500 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-700
               disabled:opacity-50 transition-colors">
        {refreshingModels ? 'Refreshing...' : 'Refresh Models'}
      </button>

      <!-- Mode switcher -->
      <div class="flex rounded-lg border border-bark-300 dark:border-shadow-600 overflow-hidden">
        {#each (['simple', 'advanced', 'raw'] as const) as m}
          <button
            onclick={() => mode = m}
            class="px-3 py-1.5 text-xs font-medium capitalize transition-colors
              {mode === m
                ? 'bg-gold-600 text-white'
                : 'bg-white dark:bg-shadow-800 text-shadow-500 dark:text-bark-400 hover:bg-bark-100 dark:hover:bg-shadow-700'}"
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
        ? 'bg-moss-50 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300 border border-moss-200 dark:border-moss-800'
        : 'bg-wilt-50 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300 border border-wilt-200 dark:border-wilt-800'}">
      {saveMessage}
    </div>
  {/if}

  <!-- ── Loading ── -->
  {#if loading}
    <div class="card-garden p-8">
      <div class="animate-pulse space-y-4">
        {#each Array(5) as _}
          <div class="h-10 bg-bark-200 dark:bg-shadow-700 rounded-lg"></div>
        {/each}
      </div>
    </div>

  <!-- ── Error ── -->
  {:else if error}
    <div class="card-garden p-8 text-center">
      <p class="text-wilt-600 dark:text-wilt-400 text-sm">{error}</p>
    </div>

  <!-- ════════════════════════════════════════════════ -->
  <!--                SIMPLE MODE                       -->
  <!-- ════════════════════════════════════════════════ -->
  {:else if mode === 'simple'}
    <div class="card-garden p-6 space-y-6">
      <!-- Models -->
      <div>
        <h2 class={SECTION_HEADING_CLS}>Models</h2>
        <hr class="divider-filigree my-3" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>Primary Model</label>
            <input type="text" list="model-list" bind:value={primaryModel} class={INPUT_CLS}
              placeholder="e.g. deepseek/deepseek-v3.2" />
          </div>
          <div>
            <label class={LABEL_CLS}>Extraction Model</label>
            <input type="text" list="model-list" bind:value={extractionModel} class={INPUT_CLS}
              placeholder="e.g. deepseek/deepseek-v3.2" />
          </div>
        </div>
      </div>

      <!-- Memory Budget % -->
      <div>
        <h2 class={SECTION_HEADING_CLS}>Memory & Extraction</h2>
        <hr class="divider-filigree my-3" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <!-- Memory Budget % -->
          <div>
            <label class={LABEL_CLS}>Memory Budget %</label>
            <div class="flex items-center gap-3">
              <input type="range" min="5" max="50" step="1" bind:value={memoryBudgetPct}
                class="flex-1 h-2 rounded-full appearance-none bg-bark-200 dark:bg-shadow-700
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gold-500 [&::-webkit-slider-thumb]:shadow-sm
                  [&::-webkit-slider-thumb]:cursor-pointer
                  [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full
                  [&::-moz-range-thumb]:bg-gold-500 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer" />
              <input type="number" min="5" max="50" bind:value={memoryBudgetPct}
                class="w-20 px-2 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-white dark:bg-shadow-800
                  text-shadow-900 dark:text-bark-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold-300" />
            </div>
            <p class="text-[11px] text-shadow-400 dark:text-bark-500 mt-1">% of context window reserved for memory retrieval</p>
          </div>

          <!-- Memory Retrieval Limit -->
          <div>
            <label class={LABEL_CLS}>Memory Retrieval Limit</label>
            <input type="number" min="1" max="500" bind:value={memoryRetrievalLimit} class={INPUT_CLS} />
            <p class="text-[11px] text-shadow-400 dark:text-bark-500 mt-1">Max memories returned per retrieval</p>
          </div>

          <!-- Extraction Threshold % -->
          <div>
            <label class={LABEL_CLS}>Extraction Threshold %</label>
            <div class="flex items-center gap-3">
              <input type="range" min="10" max="80" step="1" bind:value={extractionThresholdPct}
                class="flex-1 h-2 rounded-full appearance-none bg-bark-200 dark:bg-shadow-700
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gold-500 [&::-webkit-slider-thumb]:shadow-sm
                  [&::-webkit-slider-thumb]:cursor-pointer
                  [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full
                  [&::-moz-range-thumb]:bg-gold-500 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer" />
              <input type="number" min="10" max="80" bind:value={extractionThresholdPct}
                class="w-20 px-2 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-white dark:bg-shadow-800
                  text-shadow-900 dark:text-bark-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold-300" />
            </div>
            <p class="text-[11px] text-shadow-400 dark:text-bark-500 mt-1">Triggers extraction when session exceeds this % of context</p>
          </div>

          <!-- Compaction Threshold % -->
          <div>
            <label class={LABEL_CLS}>Compaction Threshold %</label>
            <div class="flex items-center gap-3">
              <input type="range" min="30" max="90" step="1" bind:value={compactionThresholdPct}
                class="flex-1 h-2 rounded-full appearance-none bg-bark-200 dark:bg-shadow-700
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gold-500 [&::-webkit-slider-thumb]:shadow-sm
                  [&::-webkit-slider-thumb]:cursor-pointer
                  [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full
                  [&::-moz-range-thumb]:bg-gold-500 [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer" />
              <input type="number" min="30" max="90" bind:value={compactionThresholdPct}
                class="w-20 px-2 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600 bg-white dark:bg-shadow-800
                  text-shadow-900 dark:text-bark-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-gold-300" />
            </div>
            <p class="text-[11px] text-shadow-400 dark:text-bark-500 mt-1">Auto-compacts oldest 50% when context exceeds this %</p>
          </div>
        </div>
      </div>

      <!-- Response & Retries -->
      <div>
        <h2 class={SECTION_HEADING_CLS}>Response & Retries</h2>
        <hr class="divider-filigree my-3" />
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class={LABEL_CLS}>Max Response Tokens</label>
            <input type="number" min="256" step="256" bind:value={maxResponseTokens} class={INPUT_CLS} />
          </div>
          <div>
            <label class={LABEL_CLS}>LLM Max Retries</label>
            <input type="number" min="0" max="10" bind:value={retryMaxAttempts} class={INPUT_CLS} />
          </div>
        </div>
      </div>

      <!-- Save -->
      <div class="flex items-center gap-3 pt-2">
        <button onclick={saveSimple} disabled={saving}
          class="px-5 py-2.5 rounded-lg bg-gold-600 text-white text-sm font-medium
                 hover:bg-gold-700 disabled:opacity-50 transition-colors shadow-sm">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>

  <!-- ════════════════════════════════════════════════ -->
  <!--              ADVANCED MODE                       -->
  <!-- ════════════════════════════════════════════════ -->
  {:else if mode === 'advanced'}
    <div class="space-y-3">
      {#each ADVANCED_SECTIONS as section}
        {@const sectionKeys = section.keys.filter((k) => data && k in (data.config as Record<string, unknown>))}
        {#if sectionKeys.length > 0}
          <div class="card-garden overflow-hidden">
            <button
              onclick={() => toggleSection(section.id)}
              class="w-full flex items-center justify-between px-5 py-3.5 text-left
                     hover:bg-bark-50 dark:hover:bg-shadow-800 transition-colors"
            >
              <div class="flex items-center gap-3">
                <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-50 dark:bg-gold-900/20
                             text-gold-600 dark:text-gold-400 text-xs font-bold border border-gold-200 dark:border-gold-800">
                  {section.icon}
                </span>
                <h2 class={SECTION_HEADING_CLS}>{section.title}</h2>
                <span class="text-[10px] text-shadow-400 dark:text-bark-500">({sectionKeys.length} fields)</span>
              </div>
              <span class="text-shadow-400 dark:text-bark-500 text-sm transition-transform {openSections.has(section.id) ? 'rotate-180' : ''}">
                &#9660;
              </span>
            </button>
            {#if openSections.has(section.id)}
              <div class="px-5 pb-5 space-y-3 border-t border-bark-100 dark:border-shadow-800 pt-4">
                {#each sectionKeys as key}
                  {@const value = configValue(key)}
                  {@const ft = fieldType(value)}
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <label class="text-xs font-mono text-shadow-500 dark:text-bark-400 sm:w-60 shrink-0">{key}</label>
                    {#if ft === 'checkbox'}
                      <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox"
                          checked={Boolean(value)}
                          onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).checked)}
                          class="sr-only peer" />
                        <div class="w-9 h-5 bg-bark-300 rounded-full peer
                                    peer-checked:bg-gold-500 peer-focus:ring-2 peer-focus:ring-gold-300
                                    dark:bg-shadow-600 dark:peer-checked:bg-gold-600
                                    after:content-[''] after:absolute after:top-0.5 after:start-[2px]
                                    after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all
                                    peer-checked:after:translate-x-full"></div>
                      </label>
                    {:else if ft === 'number'}
                      <input type="number"
                        value={Number(value)}
                        onchange={(e) => setConfigValue(key, Number((e.target as HTMLInputElement).value))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600
                               bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200
                               text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {:else if ft === 'array'}
                      <input type="text"
                        value={Array.isArray(value) ? value.join(', ') : ''}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600
                               bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200
                               text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300"
                        placeholder="comma-separated values" />
                    {:else if ft === 'object'}
                      <textarea
                        value={JSON.stringify(value, null, 2)}
                        onchange={(e) => { try { setConfigValue(key, JSON.parse((e.target as HTMLTextAreaElement).value)); } catch { /* ignore */ } }}
                        rows="3"
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600
                               bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200
                               text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300 resize-y"
                        spellcheck="false"
                      ></textarea>
                    {:else}
                      <input type="text"
                        value={String(value ?? '')}
                        list={key.toLowerCase().includes('model') ? 'model-list' : undefined}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value)}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600
                               bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200
                               text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
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
              class="w-full flex items-center justify-between px-5 py-3.5 text-left
                     hover:bg-bark-50 dark:hover:bg-shadow-800 transition-colors"
            >
              <div class="flex items-center gap-3">
                <span class="flex items-center justify-center w-7 h-7 rounded-full bg-bark-100 dark:bg-shadow-800
                             text-shadow-500 dark:text-bark-400 text-xs font-bold border border-bark-300 dark:border-shadow-600">
                  ?
                </span>
                <h2 class={SECTION_HEADING_CLS}>Other Settings</h2>
                <span class="text-[10px] text-shadow-400 dark:text-bark-500">({otherKeys.length} fields)</span>
              </div>
              <span class="text-shadow-400 dark:text-bark-500 text-sm transition-transform {openSections.has('other') ? 'rotate-180' : ''}">
                &#9660;
              </span>
            </button>
            {#if openSections.has('other')}
              <div class="px-5 pb-5 space-y-3 border-t border-bark-100 dark:border-shadow-800 pt-4">
                {#each otherKeys as key}
                  {@const value = configValue(key)}
                  {@const ft = fieldType(value)}
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <label class="text-xs font-mono text-shadow-500 dark:text-bark-400 sm:w-60 shrink-0">{key}</label>
                    {#if ft === 'checkbox'}
                      <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox"
                          checked={Boolean(value)}
                          onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).checked)}
                          class="sr-only peer" />
                        <div class="w-9 h-5 bg-bark-300 rounded-full peer
                                    peer-checked:bg-gold-500 peer-focus:ring-2 peer-focus:ring-gold-300
                                    dark:bg-shadow-600 dark:peer-checked:bg-gold-600
                                    after:content-[''] after:absolute after:top-0.5 after:start-[2px]
                                    after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all
                                    peer-checked:after:translate-x-full"></div>
                      </label>
                    {:else if ft === 'number'}
                      <input type="number"
                        value={Number(value)}
                        onchange={(e) => setConfigValue(key, Number((e.target as HTMLInputElement).value))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600
                               bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200
                               text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {:else if ft === 'array'}
                      <input type="text"
                        value={Array.isArray(value) ? value.join(', ') : ''}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean))}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600
                               bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200
                               text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300"
                        placeholder="comma-separated values" />
                    {:else if ft === 'object'}
                      <textarea
                        value={JSON.stringify(value, null, 2)}
                        onchange={(e) => { try { setConfigValue(key, JSON.parse((e.target as HTMLTextAreaElement).value)); } catch { /* ignore */ } }}
                        rows="3"
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600
                               bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200
                               text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300 resize-y"
                        spellcheck="false"
                      ></textarea>
                    {:else}
                      <input type="text"
                        value={String(value ?? '')}
                        onchange={(e) => setConfigValue(key, (e.target as HTMLInputElement).value)}
                        class="flex-1 px-3 py-1.5 rounded-lg border border-bark-300 dark:border-shadow-600
                               bg-white dark:bg-shadow-800 text-shadow-900 dark:text-bark-200
                               text-xs font-mono focus:outline-none focus:ring-2 focus:ring-gold-300" />
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/if}

      <!-- Global Save -->
      <div class="flex items-center gap-3 pt-2">
        <button onclick={saveAdvanced} disabled={saving}
          class="px-5 py-2.5 rounded-lg bg-gold-600 text-white text-sm font-medium
                 hover:bg-gold-700 disabled:opacity-50 transition-colors shadow-sm">
          {saving ? 'Saving...' : 'Save All Settings'}
        </button>
      </div>
    </div>

  <!-- ════════════════════════════════════════════════ -->
  <!--                 RAW MODE                         -->
  <!-- ════════════════════════════════════════════════ -->
  {:else}
    <div class="space-y-4">
      <!-- Model count info -->
      {#if discoveredModels.length > 0}
        <div class="card-garden px-5 py-3 flex items-center justify-between">
          <span class="text-xs text-shadow-500 dark:text-bark-400">
            {discoveredModels.length} models discovered via proxy
          </span>
          <button onclick={doRefreshModels} disabled={refreshingModels}
            class="text-xs text-gold-600 hover:text-gold-700 dark:text-gold-400 font-medium disabled:opacity-50">
            {refreshingModels ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      {/if}

      {#each RAW_EDITORS as editor}
        {@const status = rawSaveStatus[editor.key]}
        <div class="card-garden overflow-hidden">
          <div class="flex items-center justify-between px-5 py-3 border-b border-bark-100 dark:border-shadow-800">
            <h3 class="text-sm font-serif font-semibold text-shadow-800 dark:text-bark-300">{editor.label}</h3>
            <div class="flex items-center gap-3">
              {#if status}
                <span class="text-xs font-medium {status.ok ? 'text-moss-600 dark:text-moss-400' : 'text-wilt-600 dark:text-wilt-400'}">
                  {status.msg}
                </span>
              {/if}
              <button
                onclick={() => saveRawConfig(editor.key, editor.label)}
                disabled={saving}
                class="px-3 py-1.5 rounded-lg bg-gold-600 text-white text-xs font-medium
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
            class="w-full font-mono text-xs text-shadow-800 dark:text-bark-300
                   bg-bark-50 dark:bg-shadow-900 p-4
                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-inset
                   resize-y border-0"
            spellcheck="false"
          ></textarea>
        </div>
      {/each}
    </div>
  {/if}

  <!-- ── Environment info (always visible) ── -->
  {#if data?.env}
    <div class="card-garden px-5 py-4">
      <h2 class="text-xs font-serif font-semibold text-shadow-500 dark:text-bark-400 mb-2 uppercase tracking-wider">Environment</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-shadow-500 dark:text-bark-400">
        {#if data.env.nodeVersion}
          <div>
            <span class="text-shadow-400 dark:text-bark-500">Node</span>
            <span class="font-mono ml-1 text-shadow-800 dark:text-bark-300">{data.env.nodeVersion}</span>
          </div>
        {/if}
        {#if data.env.platform}
          <div>
            <span class="text-shadow-400 dark:text-bark-500">Platform</span>
            <span class="font-mono ml-1 text-shadow-800 dark:text-bark-300">{data.env.platform}/{data.env.arch}</span>
          </div>
        {/if}
        {#if data.env.uptime !== undefined}
          <div>
            <span class="text-shadow-400 dark:text-bark-500">Uptime</span>
            <span class="ml-1 text-shadow-800 dark:text-bark-300">{Math.floor(data.env.uptime / 3600)}h {Math.floor((data.env.uptime % 3600) / 60)}m</span>
          </div>
        {/if}
        {#if data.env.memoryUsage}
          <div>
            <span class="text-shadow-400 dark:text-bark-500">Heap</span>
            <span class="ml-1 text-shadow-800 dark:text-bark-300">{(data.env.memoryUsage.heapUsed / 1_048_576).toFixed(0)}MB / {(data.env.memoryUsage.heapTotal / 1_048_576).toFixed(0)}MB</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
