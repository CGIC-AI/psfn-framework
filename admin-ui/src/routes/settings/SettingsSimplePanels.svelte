<script lang="ts">
  import type { Action } from 'svelte/action';
  import { base } from '$app/paths';
  import type {
    AdminSettingsData,
    CanonicalProviderRegistry,
    ProviderRegistryEntry,
  } from '$lib/types';
  import type { SettingAuthorityInfo } from '$lib/settings/authority';
  import type { ContextBudgetPreviewData } from '$lib/settings/context-budget-preview';
  import type { ProviderEditableField } from '$lib/providers/editor';
  import ProviderRegistrySection from '$lib/components/settings/ProviderRegistrySection.svelte';
  import SettingAuthorityHint from '$lib/components/settings/SettingAuthorityHint.svelte';
  import SettingFieldLabel from '$lib/components/settings/SettingFieldLabel.svelte';
  import {
    settingsSimpleSectionAnchorId,
    type SettingsSimpleSectionId,
  } from '$lib/components/settings/navigation';
  import {
    DELEGATED_WORKSPACES,
    formatSettingOptionLabel,
    fmtMs,
    fmtTokens,
    normalizeDiscordListenWindowSeconds,
    settingControlId,
    settingLabelId,
    type RawEditorKey,
  } from './settings-page-helpers';

  interface Props {
    data: AdminSettingsData | null;
    simpleSectionAnchor: Action<HTMLElement, SettingsSimpleSectionId>;
    providerRegistry: CanonicalProviderRegistry;
    providerValidationErrors: string[];
    providerRegistryDirty: () => boolean;
    saving: boolean;
    dirty: boolean;
    generalSettingsSaveDirty: boolean;
    openSections: Set<string>;
    budgetPreview: ContextBudgetPreviewData | null;
    inputClass: string;
    labelClass: string;
    sliderClass: string;
    compactInputClass: string;
    toggleClass: string;
    providerCardClass: string;
    capabilityTierOptions: string[];
    importRouteModeOptions: string[];
    sessionRestartBehaviorOptions: string[];
    getBudgetContextWindowAuthority: () => SettingAuthorityInfo | null | undefined;
    getSource: (key: string) => string;
    getSettingAuthority: (key: string) => SettingAuthorityInfo | null | undefined;
    rawEditorLabel: (key: RawEditorKey) => string;
    toggleSection: (id: string) => void;
    addProviderEntry: () => void;
    removeProviderEntry: (index: number) => void;
    updateProviderEntry: (index: number, updater: (entry: ProviderRegistryEntry) => ProviderRegistryEntry) => void;
    setProviderType: (index: number, value: string) => void;
    setProviderField: (index: number, field: ProviderEditableField, value: string) => void;
    saveProviderRegistry: () => void | Promise<void>;
    discardProviderRegistryChanges: () => void;
    saveSimple: () => void | Promise<void>;
    sessionHistoryBudgetPct: number;
    memoryRetrievalBudgetPct: number;
    extractionThresholdPct: number;
    extractionInterval: number;
    compactionEmotionalSalienceThresholdPct: number;
    compactionThresholdPct: number;
    maintenanceIntervalMs: number;
    sessionRestartBehavior: 'reuse_latest_session' | 'new_session';
    memoryExtractionMinImportance: number;
    memoryExtractionMinConfidence: number;
    memoryExtractionMinNovelty: number;
    memoryExtractionMaxWrites: number;
    memoryExtractionTelemetryEnabled: boolean;
    memoryRetrievalTelemetryEnabled: boolean;
    profileSynthesisEnabled: boolean;
    profileSynthesisRefreshIntervalMs: number;
    profileSynthesisCooldownMs: number;
    profileSynthesisMinWrites: number;
    profileSynthesisMinImportance: number;
    profileSynthesisMinConfidence: number;
    profileSynthesisMinNovelty: number;
    profileSynthesisSourceMemoryLimit: number;
    profileSynthesisMinSourceMemories: number;
    analysisWorkbenchMaxTokens: number;
    analysisWorkbenchMaxWallTimeMs: number;
    analysisWorkbenchMaxSubQueries: number;
    capabilityTier: string;
    capabilityCustomTokens: string;
    backupIntervalHours: number;
    backupMaxRotating: number;
    backupMaxWeekly: number;
    backupMaxMonthly: number;
    backupMirrorDir: string;
    backupVerifyRestore: boolean;
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
    importRouteMode: string;
    importStrictPolicy: boolean;
    openRouterProviderOrder: string;
    importLocalEndpointUrl: string;
    importLocalModel: string;
    webFetchAllowInternalNetwork: boolean;
    webFetchAllowHttp: boolean;
    webFetchDomainAllowlist: string;
    webFetchTlsCaCertPaths: string;
    ttsProvider: string;
    sttProvider: string;
    voiceId: string;
    deepgramModel: string;
    echoTtsUrl: string;
    echoTtsVoice: string;
    echoTtsPreset: string;
    obsidianVaultName: string;
    obsidianCliPath: string;
    obsidianAutoPublish: boolean;
    obsidianTimeoutMs: number;
    discordTriggerWords: string;
    discordTriggerReactions: string;
    discordTriggerListenWindowSeconds: number;
    telegramEnabled: boolean;
    telegramAuthorizedUsers: string;
  }

  let {
    data,
    simpleSectionAnchor,
    providerRegistry,
    providerValidationErrors,
    providerRegistryDirty,
    saving,
    dirty,
    generalSettingsSaveDirty,
    openSections,
    budgetPreview,
    inputClass: INPUT_CLS,
    labelClass: LABEL_CLS,
    sliderClass: SLIDER_CLS,
    compactInputClass: COMPACT_INPUT_CLS,
    toggleClass: TOGGLE_CLS,
    providerCardClass: PROVIDER_CARD_CLS,
    capabilityTierOptions,
    importRouteModeOptions,
    sessionRestartBehaviorOptions,
    getBudgetContextWindowAuthority,
    getSource,
    getSettingAuthority,
    rawEditorLabel,
    toggleSection,
    addProviderEntry,
    removeProviderEntry,
    updateProviderEntry,
    setProviderType,
    setProviderField,
    saveProviderRegistry,
    discardProviderRegistryChanges,
    saveSimple,
    sessionHistoryBudgetPct = $bindable(),
    memoryRetrievalBudgetPct = $bindable(),
    extractionThresholdPct = $bindable(),
    extractionInterval = $bindable(),
    compactionEmotionalSalienceThresholdPct = $bindable(),
    compactionThresholdPct = $bindable(),
    maintenanceIntervalMs = $bindable(),
    sessionRestartBehavior = $bindable(),
    memoryExtractionMinImportance = $bindable(),
    memoryExtractionMinConfidence = $bindable(),
    memoryExtractionMinNovelty = $bindable(),
    memoryExtractionMaxWrites = $bindable(),
    memoryExtractionTelemetryEnabled = $bindable(),
    memoryRetrievalTelemetryEnabled = $bindable(),
    profileSynthesisEnabled = $bindable(),
    profileSynthesisRefreshIntervalMs = $bindable(),
    profileSynthesisCooldownMs = $bindable(),
    profileSynthesisMinWrites = $bindable(),
    profileSynthesisMinImportance = $bindable(),
    profileSynthesisMinConfidence = $bindable(),
    profileSynthesisMinNovelty = $bindable(),
    profileSynthesisSourceMemoryLimit = $bindable(),
    profileSynthesisMinSourceMemories = $bindable(),
    analysisWorkbenchMaxTokens = $bindable(),
    analysisWorkbenchMaxWallTimeMs = $bindable(),
    analysisWorkbenchMaxSubQueries = $bindable(),
    capabilityTier = $bindable(),
    capabilityCustomTokens = $bindable(),
    backupIntervalHours = $bindable(),
    backupMaxRotating = $bindable(),
    backupMaxWeekly = $bindable(),
    backupMaxMonthly = $bindable(),
    backupMirrorDir = $bindable(),
    backupVerifyRestore = $bindable(),
    retryMaxAttempts = $bindable(),
    retryBaseDelayMs = $bindable(),
    importRouteMode = $bindable(),
    importStrictPolicy = $bindable(),
    openRouterProviderOrder = $bindable(),
    importLocalEndpointUrl = $bindable(),
    importLocalModel = $bindable(),
    webFetchAllowInternalNetwork = $bindable(),
    webFetchAllowHttp = $bindable(),
    webFetchDomainAllowlist = $bindable(),
    webFetchTlsCaCertPaths = $bindable(),
    ttsProvider = $bindable(),
    sttProvider = $bindable(),
    voiceId = $bindable(),
    deepgramModel = $bindable(),
    echoTtsUrl = $bindable(),
    echoTtsVoice = $bindable(),
    echoTtsPreset = $bindable(),
    obsidianVaultName = $bindable(),
    obsidianCliPath = $bindable(),
    obsidianAutoPublish = $bindable(),
    obsidianTimeoutMs = $bindable(),
    discordTriggerWords = $bindable(),
    discordTriggerReactions = $bindable(),
    discordTriggerListenWindowSeconds = $bindable(),
    telegramEnabled = $bindable(),
    telegramAuthorizedUsers = $bindable(),
  }: Props = $props();
</script>

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
                <input id={settingControlId('mirrorDir')} type="text" bind:value={backupMirrorDir} class={INPUT_CLS} placeholder="/path/to/backup-mirror" />
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

      <!-- External Obsidian Bridge -->
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
            <h2 class="text-sm font-serif font-semibold text-shadow-800">External Obsidian Bridge</h2>
          </div>
          <div class="flex items-center gap-3">
            {#if !openSections.has('obsidian')}
              <span class="text-xs text-shadow-600">{obsidianVaultName ? `External vault: ${obsidianVaultName}` : 'Disabled'}</span>
            {/if}
            <span class="text-shadow-500">{openSections.has('obsidian') ? '−' : '+'}</span>
          </div>
        </button>
        {#if openSections.has('obsidian')}
          <div class="px-5 py-4 space-y-4 border-t border-bark-200">
            <div>
              <SettingFieldLabel
                label="External Vault Name"
                keys="obsidianVaultName"
                forId="obsidianVaultName"
                class="block text-xs font-semibold text-shadow-700 mb-1"
              />
              <input type="text" id="obsidianVaultName" class="input-garden w-full" bind:value={obsidianVaultName} placeholder="e.g. companion" />
              <p class="text-xs text-shadow-500 mt-0.5">Leave empty to disable the external bridge. Canonical durable notes belong in Wiki.</p>
            </div>
            <div>
              <SettingFieldLabel
                label="CLI Path"
                keys="obsidianCliPath"
                forId="obsidianCliPath"
                class="block text-xs font-semibold text-shadow-700 mb-1"
              />
              <input type="text" id="obsidianCliPath" class="input-garden w-full" bind:value={obsidianCliPath} placeholder="obsidian" />
              <p class="text-xs text-shadow-500 mt-0.5">Path to the Obsidian CLI binary for the external bridge. Default: obsidian</p>
            </div>
            <div class="flex items-center gap-3">
              <input type="checkbox" id="obsidianAutoPublish" class="rounded border-bark-400" bind:checked={obsidianAutoPublish} />
              <label class="text-xs font-semibold text-shadow-700" for="obsidianAutoPublish">
                Auto-publish reflections to external vault
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
                <SettingFieldLabel label="Telegram Authorized Accounts" keys="telegramAuthorizedUsers" forId={settingControlId('telegramAuthorizedUsers')} class={LABEL_CLS} />
                <input id={settingControlId('telegramAuthorizedUsers')} type="text" bind:value={telegramAuthorizedUsers} class={INPUT_CLS} placeholder="12345678, 87654321" />
                <p class="text-sm text-shadow-500 mt-1">Comma-separated Telegram account IDs allowed to interact.</p>
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
