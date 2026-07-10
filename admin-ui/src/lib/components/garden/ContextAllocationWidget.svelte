<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettings } from '$lib/api/endpoints/settings';
  import {
    buildContextBudgetPreview,
    type ContextBudgetPreviewData,
  } from '$lib/settings/context-budget-preview';
  import type { ContextBudgetConfigLike } from '../../../../../src/shared/context-budget.js';
  import type { AdminSettingsData } from '$lib/types';

  let {
    showVariants = true,
    class: className = '',
  } = $props<{
    /** Render the adaptive turn-profile variant cards below the allocation chart. */
    showVariants?: boolean;
    class?: string;
  }>();

  // Mirrors the settings-page estimate for the assembled system prompt.
  const SYSTEM_PROMPT_ESTIMATE_TOKENS = 2_500;

  interface ModelsEditorConfigLike {
    modelRoster?: ContextBudgetConfigLike['modelRoster'];
    modelCatalog?: ContextBudgetConfigLike['modelCatalog'];
    modelRoleAssignments?: ContextBudgetConfigLike['modelRoleAssignments'];
  }

  let preview = $state<ContextBudgetPreviewData | null>(null);
  let loading = $state(true);
  let error = $state('');

  function fmtTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
    return String(n);
  }

  function buildPreviewFromSettings(settingsData: AdminSettingsData): ContextBudgetPreviewData {
    const config = settingsData.config as Record<string, unknown>;
    const models = (settingsData.editors?.models as ModelsEditorConfigLike | undefined) ?? {};
    const maxOutputTokensFromConfig = Number(config.primaryMaxTokens ?? config.extractionMaxTokens ?? 4096);
    const maxResponseTokens = Number.isFinite(maxOutputTokensFromConfig) && maxOutputTokensFromConfig > 0
      ? maxOutputTokensFromConfig
      : 4096;
    const budgetConfig: ContextBudgetConfigLike = {
      defaultContextWindow: 128_000,
      modelRoster: models.modelRoster ?? {},
      ...(models.modelCatalog ? { modelCatalog: models.modelCatalog } : {}),
      ...(models.modelRoleAssignments ? { modelRoleAssignments: models.modelRoleAssignments } : {}),
      sessionHistoryBudgetPct: Number(config.sessionHistoryBudgetPct ?? 6),
      memoryRetrievalBudgetPct: Number(config.memoryRetrievalBudgetPct ?? 2),
      ...(config.adaptiveContextBudgetsEnabled !== undefined
        ? { adaptiveContextBudgetsEnabled: config.adaptiveContextBudgetsEnabled === true }
        : {}),
    };
    return buildContextBudgetPreview(budgetConfig, {
      systemPromptTokens: SYSTEM_PROMPT_ESTIMATE_TOKENS,
      maxResponseTokens,
    });
  }

  onMount(async () => {
    try {
      preview = buildPreviewFromSettings(await getSettings());
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load context allocation';
    } finally {
      loading = false;
    }
  });
</script>

<div class={`space-y-4 ${className}`.trim()}>
  {#if loading}
    <div class="animate-pulse space-y-3">
      <div class="h-8 rounded-lg bg-bark-300"></div>
      <div class="h-4 w-2/3 rounded bg-bark-300"></div>
    </div>
  {:else if error}
    <p class="text-sm text-wilt-600">{error}</p>
  {:else if preview}
    <!-- Visual bar chart -->
    <div class="space-y-2">
      <div class="flex rounded-lg overflow-hidden h-8 border border-bark-300">
        {#if preview.sysPct > 0}
          <div class="bg-bark-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
            style="width: {preview.sysPct}%"
            title="System prompt: ~{fmtTokens(preview.systemPromptTokens)} tokens">
            {#if preview.sysPct > 4}<span class="truncate px-1">Sys</span>{/if}
          </div>
        {/if}
        {#if preview.sessPct > 0}
          <div class="bg-moss-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
            style="width: {preview.sessPct}%"
            title="Session history: ~{fmtTokens(preview.sessEstimatedTokens)} tokens (~{preview.sessEstimatedCount} whole messages)">
            {#if preview.sessPct > 4}<span class="truncate px-1">Session</span>{/if}
          </div>
        {/if}
        {#if preview.memPct > 0}
          <div class="bg-gold-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
            style="width: {preview.memPct}%"
            title="Memory retrieval: ~{fmtTokens(preview.memEstimatedTokens)} tokens (~{preview.memEstimatedCount} whole memories)">
            {#if preview.memPct > 4}<span class="truncate px-1">Memory</span>{/if}
          </div>
        {/if}
        {#if preview.respPct > 0}
          <div class="bg-petal-400 flex items-center justify-center text-white text-sm font-medium min-w-0 overflow-hidden"
            style="width: {preview.respPct}%"
            title="Max response: ~{fmtTokens(preview.maxResponseTokens)} tokens">
            {#if preview.respPct > 6}<span class="truncate px-1">Response</span>{/if}
          </div>
        {/if}
        {#if preview.remainPct > 0}
          <div class="bg-bark-200 flex items-center justify-center text-shadow-600 text-sm font-medium min-w-0 overflow-hidden flex-1"
            title="Remaining: ~{fmtTokens(preview.remaining)} tokens">
            {#if preview.remainPct > 8}<span class="truncate px-1">Free</span>{/if}
          </div>
        {/if}
      </div>

      <!-- Legend -->
      <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span class="flex items-center gap-1.5">
          <span class="w-3 h-3 rounded-sm bg-bark-400 inline-block"></span>
          <span class="text-shadow-700">System: ~{fmtTokens(preview.systemPromptTokens)}</span>
        </span>
        <span class="flex items-center gap-1.5">
          <span class="w-3 h-3 rounded-sm bg-moss-400 inline-block"></span>
          <span class="text-shadow-700">Session: ~{preview.sessEstimatedCount} msgs (~{fmtTokens(preview.sessEstimatedTokens)})</span>
        </span>
        <span class="flex items-center gap-1.5">
          <span class="w-3 h-3 rounded-sm bg-gold-400 inline-block"></span>
          <span class="text-shadow-700">Memory: ~{preview.memEstimatedCount} items (~{fmtTokens(preview.memEstimatedTokens)})</span>
        </span>
        <span class="flex items-center gap-1.5">
          <span class="w-3 h-3 rounded-sm bg-petal-400 inline-block"></span>
          <span class="text-shadow-700">Response: {fmtTokens(preview.maxResponseTokens)}</span>
        </span>
        <span class="flex items-center gap-1.5">
          <span class="w-3 h-3 rounded-sm bg-bark-200 border border-bark-300 inline-block"></span>
          <span class="text-shadow-700">Free: {fmtTokens(preview.remaining)}</span>
        </span>
      </div>
    </div>

    <!-- Detail cards -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
      <div class="bg-bark-100 rounded-lg p-3 border border-bark-200">
        <span class="text-shadow-600 block mb-1">Context Window</span>
        <span class="text-shadow-900 font-mono font-semibold">{preview.contextWindow.toLocaleString()}</span>
        <span class="text-shadow-600"> tokens</span>
        {#if preview.resolvedChatProvider || preview.resolvedChatModel}
          <span class="text-shadow-500 block text-sm mt-1">
            {preview.resolvedChatProvider ?? 'unknown'} / {preview.resolvedChatModel ?? 'unknown'}
          </span>
        {/if}
      </div>
      <div class="bg-moss-50 rounded-lg p-3 border border-moss-200">
        <span class="text-shadow-600 block mb-1">Session History</span>
        <span class="text-shadow-900 font-semibold">~{preview.sessEstimatedCount} messages</span>
        <span class="text-shadow-500 block text-sm">
          ~{fmtTokens(preview.sessTokenBudget)} token budget, trimmed on whole messages
          {#if preview.sessionHistoryMinTokens}
            · floor {fmtTokens(preview.sessionHistoryMinTokens)}
          {/if}
        </span>
      </div>
      <div class="bg-gold-50 rounded-lg p-3 border border-gold-200">
        <span class="text-shadow-600 block mb-1">Memory Retrieval</span>
        <span class="text-shadow-900 font-semibold">~{preview.memEstimatedCount} memories</span>
        <span class="text-shadow-500 block text-sm">
          ~{fmtTokens(preview.memTokenBudget)} token budget, trimmed on whole memories
          {#if preview.memoryRetrievalMinTokens}
            · floor {fmtTokens(preview.memoryRetrievalMinTokens)}
          {/if}
        </span>
      </div>
      <div class="rounded-lg p-3 border {preview.remaining < 0 ? 'bg-wilt-50 border-wilt-400' : 'bg-bark-100 border-bark-200'}">
        <span class="text-shadow-600 block mb-1">Remaining</span>
        <span class="{preview.remaining < 0 ? 'text-wilt-600' : 'text-shadow-900'} font-mono font-semibold">{fmtTokens(preview.remaining)}</span>
        <span class="text-shadow-600"> tokens</span>
        {#if preview.remaining < 0}
          <span class="text-wilt-600 block text-sm font-medium">Over budget!</span>
        {/if}
      </div>
    </div>

    {#if showVariants}
      <div class="rounded-lg border border-bark-200 bg-bark-50 p-4 space-y-3">
        <div>
          <h3 class="text-sm font-medium text-shadow-800">Adaptive Turn Profiles</h3>
          <p class="text-sm text-shadow-600">
            Preview of the effective chat slot context window and the same adaptive budget table the runtime uses. Heartbeat and reflection stay on the default companion budget unless their content classifies differently.
          </p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 text-sm">
          {#each preview.variants as variant (variant.key)}
            <div class="rounded-lg border border-bark-200 bg-bark-100 p-3">
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
    {/if}
  {/if}
</div>
