<script lang="ts">
  import type { GardenEventEnvelope } from '$lib/events/envelope';
  import { getCompanionName } from '$lib/stores/companion.svelte';
  import {
    buildStaticPrefixHashTimeline,
    diffPromptPlanBlocks,
    resolvePromptMonitorPlan,
    resolvePromptMonitorPromptLoom,
    type PromptMonitorMetrics,
    type PromptMonitorTurn,
  } from '$lib/events/prompt-monitor';
  import type { AdminPromptPlanBlock, AdminPromptSectionCacheability } from '$lib/types';
  import PromptMonitorMemoryList from './PromptMonitorMemoryList.svelte';
  import PromptMonitorMessageList from './PromptMonitorMessageList.svelte';
  import PromptMonitorRawEventsPanel from './PromptMonitorRawEventsPanel.svelte';
  import PromptMonitorSectionTelemetryList from './PromptMonitorSectionTelemetryList.svelte';
  import PromptMonitorSessionEntryList from './PromptMonitorSessionEntryList.svelte';
  import PromptMonitorTextBlock from './PromptMonitorTextBlock.svelte';
  import PromptMonitorTimelinePanel from './PromptMonitorTimelinePanel.svelte';
  import PromptMonitorToolList from './PromptMonitorToolList.svelte';
  import {
    activeToolCount,
    diffStatusTone,
    formatBytesDelta,
    formatCapability,
    formatCount,
    formatDuration,
    formatJson,
    formatStageName,
    formatTimestamp,
    humanizeToken,
    joinLines,
    memoryCount,
    memoryMetadataJson,
    metricTone,
    regionTokens,
    selectedTurnTabs,
    sessionMetadataJson,
    skippedToolCount,
    toolInvocations,
    truncateValue,
    volatilityTone,
    type SelectedTurnTab,
  } from './PromptMonitorSelectedTurnTabs.helpers';

  interface Props {
    turn: PromptMonitorTurn;
    metrics?: PromptMonitorMetrics | null;
    selectedChannelEvents?: GardenEventEnvelope[];
    /** Recent turns for the same session: feeds the turn-diff baseline picker and the static-hash timeline. */
    turns?: PromptMonitorTurn[];
  }

  let {
    turn,
    metrics = null,
    selectedChannelEvents = [],
    turns = [],
  }: Props = $props();

  let activeTab = $state<SelectedTurnTab>('summary');
  let lastTurnId = $state<string | null>(null);
  let diffBaselineTurnId = $state<string | null>(null);
  const promptLoom = $derived(resolvePromptMonitorPromptLoom(turn));
  const plan = $derived(resolvePromptMonitorPlan(turn));
  const isLegacyTurn = $derived(plan === null);
  const companionName = $derived(getCompanionName());
  const LEGACY_TURN_LABEL = 'Legacy turn (pre-plan): this record predates the PromptPlan snapshot; views degrade to recorded strings.';

  $effect(() => {
    if (lastTurnId !== turn.turnId) {
      lastTurnId = turn.turnId;
      activeTab = 'summary';
      diffBaselineTurnId = null;
    }
  });

  // ── Turn-diff affordance (E2.3) ──
  const diffCandidates = $derived(turns.filter(candidate => candidate.turnId !== turn.turnId));
  // Default baseline: the previous (next-older) turn in the session ledger.
  const defaultDiffBaseline = $derived.by(() => {
    const index = turns.findIndex(candidate => candidate.turnId === turn.turnId);
    if (index >= 0 && index + 1 < turns.length) return turns[index + 1];
    return diffCandidates[0] ?? null;
  });
  const diffBaselineTurn = $derived(
    diffCandidates.find(candidate => candidate.turnId === diffBaselineTurnId) ?? defaultDiffBaseline,
  );
  const diffBaselinePlan = $derived(diffBaselineTurn ? resolvePromptMonitorPlan(diffBaselineTurn) : null);
  const blockDiff = $derived(diffPromptPlanBlocks(diffBaselinePlan, plan));

  // ── Cache projection (E2.3) ──
  const staticHashTimeline = $derived(buildStaticPrefixHashTimeline(turns));
  const cacheRegions = $derived.by(() => {
    if (!plan) return [];
    const { staticBoundary, sessionStableBoundary } = plan.cachePlan;
    return [
      { name: 'static', blocks: plan.blocks.slice(0, staticBoundary) },
      { name: 'session_stable', blocks: plan.blocks.slice(staticBoundary, sessionStableBoundary) },
      { name: 'turn', blocks: plan.blocks.slice(sessionStableBoundary) },
    ] as Array<{ name: 'static' | 'session_stable' | 'turn'; blocks: AdminPromptPlanBlock[] }>;
  });
  const providerCacheTelemetry = $derived(
    turn.snapshot?.promptContext?.providerObservability?.promptCaching ?? null,
  );

  function cacheabilityFor(
    section: AdminPromptSectionCacheability['section'],
  ): AdminPromptSectionCacheability | null {
    return turn.snapshot?.promptContext?.sectionCacheability?.find(candidate => candidate.section === section) ?? null;
  }
</script>

<section class="card-garden overflow-hidden">
  <div class="border-b border-bark-300 bg-bark-100 px-5 py-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="font-serif text-lg text-shadow-900">Selected Turn</h2>
        <p class="mt-1 truncate font-mono text-sm text-shadow-600">
          {turn.turnId}
        </p>
      </div>
      <span class="shrink-0 rounded-full px-2.5 py-1 text-sm font-medium
        {metrics?.isComplete ? 'bg-bark-100 text-shadow-700' : 'bg-moss-50 text-moss-700'}">
        {metrics?.isComplete ? 'recorded' : 'live'}
      </span>
    </div>

    <div class="mt-4 overflow-x-auto">
      <div class="flex min-w-max gap-2" role="tablist" aria-label="Selected turn views">
        {#each selectedTurnTabs as tab (tab.id)}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            title={tab.description}
            onclick={() => activeTab = tab.id}
            class="rounded-t-xl border px-3 py-2 text-sm font-medium transition-colors
              {activeTab === tab.id
                ? 'border-gold-300 bg-white text-shadow-900 shadow-sm'
                : 'border-bark-300 bg-bark-50 text-shadow-600 hover:bg-white hover:text-shadow-900'}"
          >
            {tab.label}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <div class="space-y-5 p-5">
    {#if activeTab === 'summary'}
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div class="rounded-xl border border-bark-200 bg-white p-3">
          <p class="text-sm text-shadow-600">Provider Route</p>
          <p class="mt-1 text-shadow-900">
            {humanizeToken(turn.snapshot?.promptContext?.providerObservability?.routeKind)}
          </p>
        </div>
        <div class="rounded-xl border border-bark-200 bg-white p-3">
          <p class="text-sm text-shadow-600">Backend Model</p>
          <p class="mt-1 break-all text-shadow-900">
            {turn.snapshot?.promptContext?.providerObservability?.backendModel ?? '—'}
          </p>
        </div>
        <div class="rounded-xl border border-bark-200 bg-white p-3">
          <p class="text-sm text-shadow-600">Prompt Stack</p>
          <p class="mt-1 font-mono text-sm text-shadow-900">
            {truncateValue(metrics?.promptVersionPointer, 20)}
          </p>
        </div>
        <div class="rounded-xl border border-bark-200 bg-white p-3">
          <p class="text-sm text-shadow-600">Static Hash</p>
          <p class="mt-1 font-mono text-sm text-shadow-900">
            {truncateValue(metrics?.staticHash, 20)}
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Route & Prompt Identity</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">Requested Provider</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.requestedProvider ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Requested Model</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.requestedModel ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Backend Provider</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.backendProvider ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Backend API</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.backendApi ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Prompt Mode</p>
              <p class="mt-1 text-shadow-900">{metrics?.promptMode ?? 'default'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Trust Level</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.trustLevel ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Latest Stage</p>
              <p class="mt-1 text-shadow-900">{formatStageName(metrics?.latestStage)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Captured At</p>
              <p class="mt-1 text-shadow-900">{formatTimestamp(turn.snapshot?.capturedAt ?? null)}</p>
            </div>
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Timings & Tokens</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">TTFT</p>
              <p class="mt-1 font-serif text-2xl {metricTone(metrics?.ttftMs ?? null, 500)}">
                {formatDuration(metrics?.ttftMs ?? null)}
              </p>
            </div>
            <div>
              <p class="text-shadow-600">Prompt Stage</p>
              <p class="mt-1 font-serif text-2xl {metricTone(metrics?.promptDurationMs ?? null, 1_500)}">
                {formatDuration(metrics?.promptDurationMs ?? null)}
              </p>
            </div>
            <div>
              <p class="text-shadow-600">Total Elapsed</p>
              <p class="mt-1 text-shadow-900">{formatDuration(metrics?.totalElapsedMs ?? null)}</p>
            </div>
            <div>
              <p class="text-shadow-600">First Token Source</p>
              <p class="mt-1 text-shadow-900">{metrics?.firstTokenSource ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">System Prompt Tokens</p>
              <p class="mt-1 text-shadow-900">{formatCount(metrics?.systemPromptTokens)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Assembled Prompt Tokens</p>
              <p class="mt-1 text-shadow-900">{formatCount(metrics?.assembledPromptTokens)}</p>
            </div>
            <div>
              <p class="text-shadow-600">System Prompt Chars</p>
              <p class="mt-1 text-shadow-900">{formatCount(metrics?.systemPromptChars)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Assembled Prompt Chars</p>
              <p class="mt-1 text-shadow-900">{formatCount(metrics?.assembledPromptChars)}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Context Load</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">Context Messages</p>
              <p class="mt-1 text-shadow-900">{formatCount(metrics?.contextMessages)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Memory Chars</p>
              <p class="mt-1 text-shadow-900">{formatCount(metrics?.memoryChars)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Memory Candidates</p>
              <p class="mt-1 text-shadow-900">{memoryCount(turn)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Withheld Memories</p>
              <p class="mt-1 text-shadow-900">{formatCount(turn.snapshot?.memory?.withheldSummary?.totalCount)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Active Tools</p>
              <p class="mt-1 text-shadow-900">{activeToolCount(turn)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Skipped Tools</p>
              <p class="mt-1 text-shadow-900">{skippedToolCount(turn)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Compaction Summaries</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.sessionContext?.compactionSummaryTexts?.length ?? 0}</p>
            </div>
            <div>
              <p class="text-shadow-600">Focus Knowledge Blocks</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.sessionContext?.focusKnowledgeTexts?.length ?? 0}</p>
            </div>
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Provider Result</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">Response Model</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.response?.model ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Stop Reason</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.promptContext?.response?.stopReason ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Tool Calls Requested</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.promptContext?.response?.toolCallCount ?? 0}</p>
            </div>
            <div>
              <p class="text-shadow-600">Provider Error</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.promptContext?.response?.errorMessage ?? '—'}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="rounded-xl border border-bark-200 bg-white p-4">
        <h3 class="font-medium text-shadow-900">Turn Exchange</h3>
        <div class="mt-3 space-y-3 text-sm">
          <PromptMonitorTextBlock
            title="Current-Turn Input"
            value={turn.snapshot?.promptContext?.currentTurnInput}
            emptyText="No current-turn input snapshot recorded."
            maxHeightClass="max-h-[20rem]"
          />
          <PromptMonitorTextBlock
            title={`${companionName} Response`}
            value={turn.snapshot?.promptContext?.response?.content ?? turn.record?.assistantMessage?.content}
            emptyText={`No ${companionName} response snapshot recorded.`}
            maxHeightClass="max-h-[20rem]"
          />
          <PromptMonitorTextBlock
            title="Provider Reasoning"
            value={turn.snapshot?.promptContext?.response?.reasoning}
            emptyText="No provider reasoning snapshot recorded."
            maxHeightClass="max-h-[20rem]"
          />
        </div>
      </div>
    {:else if activeTab === 'blocks'}
      {#if !plan}
        <div class="rounded-xl border border-gold-300 bg-gold-50 p-4 text-sm text-shadow-800">
          <p class="font-medium text-shadow-900">Legacy turn (pre-plan)</p>
          <p class="mt-1">{LEGACY_TURN_LABEL}</p>
          <p class="mt-1">
            Recorded prompt strings for this turn are available in the
            <span class="font-medium">Prompt Assembly</span> and <span class="font-medium">Exact Payload</span> tabs.
          </p>
        </div>
      {:else}
        <div class="rounded-xl border border-bark-200 bg-white p-3 text-xs text-shadow-700">
          <span class="font-medium text-shadow-900">PromptPlan v{plan.schemaVersion}:</span>
          {plan.blocks.length} ordered blocks · {regionTokens(plan.blocks)} tokens (est.) ·
          cache boundaries static&lt;{plan.cachePlan.staticBoundary} · session_stable&lt;{plan.cachePlan.sessionStableBoundary}.
          These are the exact ordered blocks the provider system prompt was serialized from.
        </div>
        <div class="space-y-3">
          {#each plan.blocks as block, index (block.id)}
            <div class="rounded-xl border border-bark-200 bg-white p-4">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-xs text-shadow-700">#{index + 1}</span>
                <span class="font-mono text-sm font-medium text-shadow-900">{block.id}</span>
                <span class={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${volatilityTone(block.volatility)}`}>
                  {block.volatility.replace('_', ' ')}
                </span>
                <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-xs text-shadow-700">{block.layer}</span>
                <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-xs text-shadow-700">
                  {block.tokensEst} tokens (est.)
                </span>
              </div>
              <p class="mt-2 text-xs text-shadow-600">
                producer <span class="font-mono">{block.producer}</span>
                · scope <span class="font-mono">{block.scopeKey ?? '—'}</span>
              </p>
              <div class="mt-2 text-sm">
                <PromptMonitorTextBlock
                  title="Rendered Text"
                  value={block.renderedText}
                  emptyText="Block rendered empty text."
                  maxHeightClass="max-h-72"
                />
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if activeTab === 'prompt'}
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-medium text-shadow-900">Template Snapshot</h3>
            <span class="rounded-full border border-gold-300 bg-gold-50 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-shadow-900">
              Historical Snapshot
            </span>
          </div>
          <p class="mt-1 text-xs text-shadow-600">{promptLoom.historicalSnapshot.label}</p>
          {#if promptLoom.historicalSnapshot.removedPromptLayerIds.length > 0}
            <p class="mt-2 text-sm text-wilt-700">
              Removed historical prompt layer data detected:
              {promptLoom.historicalSnapshot.removedPromptLayerIds.join(', ')}
            </p>
          {/if}
          <div class="mt-3 space-y-3 text-sm">
            <PromptMonitorTextBlock
              title="Static Prefix Template"
              value={turn.snapshot?.prompt?.staticPrefixTemplate}
              emptyText="No static prompt snapshot recorded."
              cacheability={cacheabilityFor('staticPrefixTemplate')}
            />
            <PromptMonitorTextBlock
              title="Dynamic Suffix Template"
              value={turn.snapshot?.prompt?.dynamicSuffixTemplate}
              emptyText="No dynamic prompt snapshot recorded."
              cacheability={cacheabilityFor('dynamicSuffixTemplate')}
            />
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Resolved Prompt Context</h3>
          <div class="mt-3 space-y-3 text-sm">
            <PromptMonitorTextBlock
              title="Rendered Static Prefix"
              value={promptLoom.generatedPrompt.renderedStaticPrefix}
              emptyText="No rendered static prefix recorded."
              cacheability={cacheabilityFor('renderedStaticPrefix')}
            />
            <PromptMonitorTextBlock
              title="Rendered Dynamic Suffix"
              value={promptLoom.generatedPrompt.renderedDynamicSuffix}
              emptyText="No rendered dynamic suffix recorded."
              cacheability={cacheabilityFor('renderedDynamicSuffix')}
            />
            <PromptMonitorTextBlock
              title="Runtime Context Block"
              value={promptLoom.generatedPrompt.runtimeContext}
              emptyText="No runtime context block recorded."
              maxHeightClass="max-h-64"
              cacheability={cacheabilityFor('runtimeContext')}
            />
            <PromptMonitorTextBlock
              title="Memory Context Block"
              value={promptLoom.generatedPrompt.memoryContextBlock}
              emptyText="No memory context block recorded."
              maxHeightClass="max-h-64"
              cacheability={cacheabilityFor('memoryContextBlock')}
            />
            <PromptMonitorTextBlock
              title="Scratchpad Context"
              value={promptLoom.generatedPrompt.scratchpadContext}
              emptyText="No scratchpad context recorded."
              cacheability={cacheabilityFor('scratchpadContext')}
            />
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Assembled Prompt</h3>
          <div class="mt-3 space-y-3">
            <PromptMonitorTextBlock
              title="Pre-Session Prompt"
              value={promptLoom.generatedPrompt.assembledPrompt}
              emptyText="No assembled prompt recorded."
              maxHeightClass="max-h-[28rem]"
              cacheability={cacheabilityFor('assembledPrompt')}
            />
            <PromptMonitorTextBlock
              title="Final System Prompt"
              value={promptLoom.providerPayload.finalSystemPrompt}
              emptyText="No final system prompt recorded."
              maxHeightClass="max-h-[28rem]"
              cacheability={cacheabilityFor('finalSystemPrompt')}
            />
          </div>
        </div>

        <PromptMonitorMessageList
          title="Model Context Messages"
          messages={promptLoom.generatedPrompt.contextMessages}
          cacheability={cacheabilityFor('messages')}
        />
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PromptMonitorSectionTelemetryList
          title="Input Sections"
          sections={turn.snapshot?.promptContext?.inputSections ?? []}
          emptyText="No input section telemetry recorded."
        />
        <PromptMonitorSectionTelemetryList
          title="Runtime Context Sections"
          sections={turn.snapshot?.promptContext?.runtimeContextSections ?? []}
          emptyText="No runtime context section telemetry recorded."
        />
        <PromptMonitorSectionTelemetryList
          title="Memory Context Sections"
          sections={turn.snapshot?.promptContext?.memoryContextSections ?? []}
          emptyText="No memory context section telemetry recorded."
        />
        <PromptMonitorSectionTelemetryList
          title="Final System Sections"
          sections={turn.snapshot?.promptContext?.finalSystemSections ?? []}
          emptyText="No final system section telemetry recorded."
        />
      </div>
      <p class="text-xs text-shadow-600">
        Each prompt block header shows its producer module and resolved scope key
        (<span class="font-mono">dm:&lt;contactId&gt;</span> / <span class="font-mono">room:&lt;channelId&gt;</span> / <span class="font-mono">global</span>).
      </p>

      <div class="rounded-xl border border-bark-200 bg-white p-4">
        <h3 class="font-medium text-shadow-900">Prompt Review Notes</h3>
        <div class="mt-3 space-y-3 text-sm text-shadow-700">
          <p>
            <span class="font-medium text-shadow-900">Assembled Prompt</span> shows the prompt before session-managed context folding.
          </p>
          <p>
            <span class="font-medium text-shadow-900">Final System Prompt</span> shows the system block after session assembly.
          </p>
          <p>
            <span class="font-medium text-shadow-900">Model Context Messages</span> shows the canonical message list before provider transport decisions.
          </p>
          <p>
            <span class="font-medium text-shadow-900">Section Telemetry</span> breaks wrapped prompt blocks into char and token counted sections.
          </p>
        </div>
      </div>
    {:else if activeTab === 'context'}
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PromptMonitorSessionEntryList
          title="Recent Session Entries"
          entries={turn.snapshot?.sessionContext?.recentEntries ?? []}
          emptyText="No recent session entries recorded."
        />
        <PromptMonitorSessionEntryList
          title="Continuity Entries"
          entries={turn.snapshot?.sessionContext?.continuityEntries ?? []}
          emptyText="No continuity entries recorded."
        />
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Session Prompt Inputs</h3>
          <div class="mt-3 space-y-3">
            <PromptMonitorTextBlock
              title="Compaction Summaries"
              value={joinLines(turn.snapshot?.sessionContext?.compactionSummaryTexts)}
              emptyText="No compaction summaries recorded."
              maxHeightClass="max-h-64"
            />
            <PromptMonitorTextBlock
              title="Focus Knowledge"
              value={joinLines(turn.snapshot?.sessionContext?.focusKnowledgeTexts)}
              emptyText="No focus knowledge recorded."
              maxHeightClass="max-h-64"
            />
            <PromptMonitorTextBlock
              title="Compaction Prompt Snapshot"
              value={turn.snapshot?.sessionContext?.compactionPromptText}
              emptyText="No compaction prompt snapshot recorded."
            />
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Context Metadata</h3>
          <div class="mt-3 space-y-3">
            <PromptMonitorTextBlock
              title="Session Metadata"
              value={sessionMetadataJson(turn)}
              emptyText="No session context metadata recorded."
              maxHeightClass="max-h-64"
            />
            <PromptMonitorTextBlock
              title="Memory Metadata"
              value={memoryMetadataJson(turn)}
              emptyText="No memory metadata recorded."
              maxHeightClass="max-h-64"
            />
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Memory Withholds</h3>
          <div class="mt-3 space-y-3">
            <PromptMonitorTextBlock
              title="Withheld Summary"
              value={formatJson(turn.snapshot?.memory?.withheldSummary)}
              emptyText="No withheld memories recorded."
            />
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Context Counts</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">Recent Entries</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.sessionContext?.recentEntries?.length ?? 0}</p>
            </div>
            <div>
              <p class="text-shadow-600">Continuity Entries</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.sessionContext?.continuityEntries?.length ?? 0}</p>
            </div>
            <div>
              <p class="text-shadow-600">Compaction Summaries</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.sessionContext?.compactionSummaryTexts?.length ?? 0}</p>
            </div>
            <div>
              <p class="text-shadow-600">Focus Knowledge</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.sessionContext?.focusKnowledgeTexts?.length ?? 0}</p>
            </div>
            <div>
              <p class="text-shadow-600">Memory Candidates</p>
              <p class="mt-1 text-shadow-900">{memoryCount(turn)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Withheld Memories</p>
              <p class="mt-1 text-shadow-900">{formatCount(turn.snapshot?.memory?.withheldSummary?.totalCount)}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PromptMonitorMemoryList
          title="Contact Emotional Memories"
          memories={turn.snapshot?.memory?.contactEmotionalMemories ?? []}
          emptyText="No contact emotional memories recorded."
        />
        <PromptMonitorMemoryList
          title="Semantic Candidates"
          memories={turn.snapshot?.memory?.semanticCandidates ?? []}
          emptyText="No semantic candidates recorded."
        />
        <PromptMonitorMemoryList
          title="Lexical Candidates"
          memories={turn.snapshot?.memory?.lexicalCandidates ?? []}
          emptyText="No lexical candidates recorded."
        />
        <PromptMonitorMemoryList
          title="Proactive Candidates"
          memories={turn.snapshot?.memory?.proactiveCandidates ?? []}
          emptyText="No proactive candidates recorded."
        />
      </div>
    {:else if activeTab === 'tools'}
      <div class="rounded-xl border border-bark-200 bg-white p-3 text-xs text-shadow-700">
        <span class="font-medium text-shadow-900">Tool surface:</span>
        The schemas below are <span class="font-medium">direct</span> tools serialized to the provider
        exactly as shown (name, description, input schema). REPL-only helpers (e.g.
        <span class="font-mono">grep</span>, <span class="font-mono">memory_search</span>) run only inside the
        <span class="font-mono">analysis_workbench</span> sandbox and are not part of this provider-visible catalog.
        {#if plan}
          This view is <span class="font-medium">plan-backed</span>: the definitions come from
          <span class="font-mono">plan.toolDefinitions</span>, the exact set serialized to the provider.
        {:else}
          <span class="font-medium">Legacy turn (pre-plan):</span> definitions come from the recorded
          tool-context snapshot.
        {/if}
      </div>
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PromptMonitorToolList
          title={plan && plan.toolDefinitions.length > 0
            ? 'Shipped Tool Definitions (plan-backed, provider-visible)'
            : 'Active Tool Schemas (recorded snapshot, provider-visible)'}
          tools={plan && plan.toolDefinitions.length > 0
            ? plan.toolDefinitions
            : turn.snapshot?.toolContext?.activeTools ?? []}
        />

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Adaptive Tool State</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">Task Kind</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.toolContext?.adaptiveSnapshot?.taskKind ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Intent</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.toolContext?.adaptiveSnapshot?.intent ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Active Tools</p>
              <p class="mt-1 text-shadow-900">{activeToolCount(turn)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Skipped Tools</p>
              <p class="mt-1 text-shadow-900">{skippedToolCount(turn)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Core</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.toolContext?.adaptiveSnapshot?.counts?.core ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Promoted</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.toolContext?.adaptiveSnapshot?.counts?.promoted ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Extended Loaded</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.toolContext?.adaptiveSnapshot?.counts?.extendedLoaded ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Autoload / Deferred</p>
              <p class="mt-1 text-shadow-900">
                {turn.snapshot?.toolContext?.adaptiveSnapshot?.counts?.autoload ?? '—'} /
                {turn.snapshot?.toolContext?.adaptiveSnapshot?.counts?.deferred ?? '—'}
              </p>
            </div>
          </div>
          <div class="mt-4 space-y-3">
            <PromptMonitorTextBlock
              title="Adaptive Active Tool Sources"
              value={formatJson(turn.snapshot?.toolContext?.adaptiveSnapshot?.tools)}
              emptyText="No adaptive tool activation snapshot recorded."
              maxHeightClass="max-h-56"
            />
          </div>
        </div>
      </div>

      <div class="rounded-xl border border-bark-200 bg-white p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-medium text-shadow-900">Skipped / Withheld Tools</h3>
          <span class="text-sm text-shadow-600">{skippedToolCount(turn)} skipped</span>
        </div>
        {#if (turn.snapshot?.toolContext?.adaptiveSnapshot?.skipped?.length ?? 0) === 0}
          <p class="mt-3 text-sm text-shadow-600">No tools were skipped or withheld this turn.</p>
        {:else}
          <div class="mt-3 space-y-2">
            {#each turn.snapshot?.toolContext?.adaptiveSnapshot?.skipped ?? [] as skip (skip.toolName)}
              <div class="rounded-lg border border-wilt-200 bg-wilt-50 p-3">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-sm font-medium text-shadow-900">{skip.toolName}</span>
                  <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-xs text-shadow-700">{skip.source}</span>
                  <span class="rounded-full border border-wilt-300 bg-white px-2 py-0.5 text-xs font-medium text-wilt-700" title="Reason code">{skip.reason}</span>
                </div>
                {#if skip.missingTokens && skip.missingTokens.length > 0}
                  <p class="mt-1 text-xs text-shadow-600">Missing capability tokens: <span class="font-mono">{skip.missingTokens.join(', ')}</span></p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="rounded-xl border border-bark-200 bg-white p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-medium text-shadow-900">Tool Call Sequence</h3>
          <span class="text-sm text-shadow-600">{toolInvocations(turn).length} call{toolInvocations(turn).length === 1 ? '' : 's'}</span>
        </div>
        <p class="mt-1 text-xs text-shadow-600">Tool calls the model issued this turn, in order, with inputs and results/errors.</p>
        {#if toolInvocations(turn).length === 0}
          <p class="mt-3 text-sm text-shadow-600">No tool calls were issued this turn.</p>
        {:else}
          <div class="mt-3 space-y-3">
            {#each toolInvocations(turn) as call (call.sequence)}
              <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-xs text-shadow-700">#{call.sequence}</span>
                  <span class="font-mono text-sm font-medium text-shadow-900">{call.toolName}</span>
                  <span
                    class={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                      call.resultStatus === 'error'
                        ? 'border-wilt-300 bg-wilt-50 text-wilt-700'
                        : call.resultStatus === 'ok'
                          ? 'border-moss-300 bg-moss-50 text-moss-700'
                          : 'border-bark-300 bg-bark-100 text-shadow-600'
                    }`}
                  >
                    {call.resultStatus}
                  </span>
                  {#if call.toolCallId}
                    <span class="font-mono text-xs text-shadow-500">{truncateValue(call.toolCallId, 24)}</span>
                  {/if}
                </div>
                {#if call.rationale}
                  <p class="mt-2 text-sm text-shadow-700">{call.rationale}</p>
                {/if}
                <PromptMonitorTextBlock
                  title="Input Arguments"
                  value={call.argumentsJson}
                  emptyText="No input arguments recorded."
                  maxHeightClass="max-h-48"
                />
                <PromptMonitorTextBlock
                  title={call.resultStatus === 'error' ? 'Tool Error' : 'Tool Result'}
                  value={call.resultText}
                  emptyText={call.resultStatus === 'pending' ? 'No result observed for this call.' : 'No result text recorded.'}
                  maxHeightClass="max-h-48"
                />
                {#if call.provenanceRefs && call.provenanceRefs.length > 0}
                  <p class="mt-2 text-xs text-shadow-600">Provenance: <span class="font-mono">{call.provenanceRefs.join(', ')}</span></p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if activeTab === 'exact'}
      <div class="rounded-xl border border-bark-200 bg-white p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="font-medium text-shadow-900">Historical Snapshot Boundary</h3>
            <p class="mt-1 text-sm text-shadow-600">{promptLoom.historicalSnapshot.label}</p>
          </div>
          <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-shadow-700">
            {promptLoom.source.replace('_', ' ')}
          </span>
        </div>
        {#if promptLoom.historicalSnapshot.removedPromptLayerIds.length > 0}
          <div class="mt-3 rounded-lg border border-wilt-200 bg-wilt-50 p-3 text-sm text-wilt-800">
            <p class="font-medium">Historical removed prompt layers</p>
            <p class="mt-1">{promptLoom.historicalSnapshot.removedPromptLayerIds.join(', ')}</p>
            <PromptMonitorTextBlock
              title="Historical Snapshot Hits"
              value={formatJson(promptLoom.historicalSnapshot.hits)}
              emptyText="No removed historical prompt layer hits recorded."
              maxHeightClass="max-h-48"
            />
          </div>
        {/if}
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Generated Prompt Sections</h3>
          <div class="mt-3 space-y-3 text-sm">
            <PromptMonitorTextBlock
              title="Rendered Static Prefix"
              value={promptLoom.generatedPrompt.renderedStaticPrefix}
              emptyText="No rendered static prefix recorded."
              maxHeightClass="max-h-56"
            />
            <PromptMonitorTextBlock
              title="Rendered Dynamic Suffix"
              value={promptLoom.generatedPrompt.renderedDynamicSuffix}
              emptyText="No rendered dynamic suffix recorded."
              maxHeightClass="max-h-56"
            />
            <PromptMonitorTextBlock
              title="Section Telemetry"
              value={formatJson({
                inputSections: promptLoom.generatedPrompt.inputSections,
                runtimeContextSections: promptLoom.generatedPrompt.runtimeContextSections,
                finalSystemSections: promptLoom.generatedPrompt.finalSystemSections,
              })}
              emptyText="No generated prompt section telemetry recorded."
              maxHeightClass="max-h-[28rem]"
            />
            <PromptMonitorTextBlock
              title="Canonical Context Messages"
              value={formatJson(promptLoom.generatedPrompt.contextMessages)}
              emptyText="No canonical context messages recorded."
              maxHeightClass="max-h-[28rem]"
            />
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Final Provider Payload</h3>
          <div class="mt-3 space-y-3 text-sm">
            <PromptMonitorTextBlock
              title="Final System Prompt"
              value={promptLoom.providerPayload.finalSystemPrompt}
              emptyText="No final provider system prompt recorded."
              maxHeightClass="max-h-[28rem]"
            />
            <PromptMonitorTextBlock
              title="Provider Message Array"
              value={formatJson(promptLoom.providerPayload.providerMessages)}
              emptyText="No provider message array recorded."
              maxHeightClass="max-h-[28rem]"
            />
            <PromptMonitorTextBlock
              title="Active Provider Tools"
              value={formatJson(promptLoom.providerPayload.activeTools)}
              emptyText="No active provider tool payload recorded."
              maxHeightClass="max-h-[28rem]"
            />
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Provider Response & Rendered Chat</h3>
          <div class="mt-3 space-y-3 text-sm">
            <PromptMonitorTextBlock
              title="Provider Response"
              value={formatJson(promptLoom.providerResult.response)}
              emptyText="No provider response snapshot recorded."
              maxHeightClass="max-h-[24rem]"
            />
            <PromptMonitorTextBlock
              title="Rendered Chat Output"
              value={promptLoom.providerResult.renderedChatOutput}
              emptyText="No rendered chat output recorded."
              maxHeightClass="max-h-[20rem]"
            />
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Memory Capture Input & Output</h3>
          <div class="mt-3 space-y-3 text-sm">
            <PromptMonitorTextBlock
              title="Memory Capture Input"
              value={formatJson(promptLoom.memoryCapture.input)}
              emptyText="No memory capture input recorded."
              maxHeightClass="max-h-[24rem]"
            />
            <PromptMonitorTextBlock
              title="Memory Capture Output"
              value={formatJson(promptLoom.memoryCapture.output)}
              emptyText="No memory capture output recorded."
              maxHeightClass="max-h-[16rem]"
            />
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Tool Calls</h3>
          <div class="mt-3 text-sm">
            <PromptMonitorTextBlock
              title="Model-Emitted Tool Calls"
              value={formatJson(promptLoom.toolActivity.toolCalls)}
              emptyText="No model-emitted tool calls recorded."
              maxHeightClass="max-h-[28rem]"
            />
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Tool Results</h3>
          <div class="mt-3 text-sm">
            <PromptMonitorTextBlock
              title="Tool Result Payloads"
              value={formatJson(promptLoom.toolActivity.toolResults)}
              emptyText="No tool results recorded."
              maxHeightClass="max-h-[28rem]"
            />
          </div>
        </div>
      </div>
    {:else if activeTab === 'provider'}
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Provider Snapshot</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">Route Kind</p>
              <p class="mt-1 text-shadow-900">{humanizeToken(turn.snapshot?.promptContext?.providerObservability?.routeKind)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Requested Provider</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.requestedProvider ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Requested Model</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.requestedModel ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Backend Provider</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.backendProvider ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Backend Model</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.backendModel ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Backend API</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.backendApi ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Base URL</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.backendBaseUrl ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Provider Wire Messages</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.promptContext?.providerObservability?.providerWireMessages?.length ?? 0}</p>
            </div>
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">System Role Transport</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">System Transport</p>
              <p class="mt-1 text-shadow-900">{humanizeToken(turn.snapshot?.promptContext?.providerObservability?.systemRole?.transport)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Supports System Role</p>
              <p class="mt-1 text-shadow-900">{formatCapability(turn.snapshot?.promptContext?.providerObservability?.systemRole?.supportsSystemRole)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Supports Developer Role</p>
              <p class="mt-1 text-shadow-900">{formatCapability(turn.snapshot?.promptContext?.providerObservability?.systemRole?.supportsDeveloperRole)}</p>
            </div>
            <div>
              <p class="text-shadow-600">Out-of-Band System Prompt</p>
              <p class="mt-1 text-shadow-900">{formatCapability(turn.snapshot?.promptContext?.providerObservability?.systemRole?.usesOutOfBandSystemPrompt)}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="rounded-xl border border-bark-200 bg-white p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-medium text-shadow-900">Serialized Provider Payload</h3>
          <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-shadow-700">
            {promptLoom.providerWire.source === 'prompt_plan' ? 'from PromptPlan' : 'recorded snapshot'}
          </span>
          {#if promptLoom.providerWire.legacy}
            <span class="rounded-full border border-gold-300 bg-gold-50 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-shadow-900">
              legacy turn (pre-plan)
            </span>
          {/if}
          {#if promptLoom.providerWire.systemRoleTransport}
            <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-xs text-shadow-700">
              transport: {promptLoom.providerWire.systemRoleTransport}
            </span>
          {/if}
        </div>
        <p class="mt-1 text-xs text-shadow-600">
          {#if promptLoom.providerWire.source === 'prompt_plan'}
            System prompt, message array, and tool definitions serialized from the persisted PromptPlan —
            byte-equal to what shipped to the provider (single assembly path).
          {:else}
            {LEGACY_TURN_LABEL} The payload below is the recorded provider-wire capture.
          {/if}
        </p>
        <div class="mt-3 space-y-3 text-sm">
          <PromptMonitorTextBlock
            title="System Prompt (as shipped)"
            value={promptLoom.providerWire.systemPrompt}
            emptyText="No serialized system prompt recorded."
            maxHeightClass="max-h-[28rem]"
          />
          <PromptMonitorTextBlock
            title={`Tool Definitions (${promptLoom.providerWire.toolDefinitions.length}, as shipped)`}
            value={formatJson(promptLoom.providerWire.toolDefinitions)}
            emptyText="No tool definitions shipped this turn."
            maxHeightClass="max-h-[24rem]"
          />
        </div>
      </div>

      <p class="text-xs text-shadow-600">
        Provider wire messages carry the full, untruncated content sent to the provider. If the
        message set looks shorter than the raw session history, that reflects the real
        session-budgeted context (compaction / history span), not a snapshot or UI cap.
      </p>
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PromptMonitorMessageList
          title={`Provider Wire Messages (${promptLoom.providerWire.messages.length})`}
          messages={promptLoom.providerWire.messages.map(message => ({
            role: `${humanizeToken(message.role)} · ${humanizeToken(message.source)}`,
            content: message.content,
          }))}
          emptyText="No provider-wire message snapshot recorded."
        />

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Provider Response</h3>
          <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-shadow-600">Response Model</p>
              <p class="mt-1 break-all text-shadow-900">{turn.snapshot?.promptContext?.response?.model ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Stop Reason</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.promptContext?.response?.stopReason ?? '—'}</p>
            </div>
            <div>
              <p class="text-shadow-600">Tool Calls Requested</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.promptContext?.response?.toolCallCount ?? 0}</p>
            </div>
            <div>
              <p class="text-shadow-600">Provider Error</p>
              <p class="mt-1 text-shadow-900">{turn.snapshot?.promptContext?.response?.errorMessage ?? '—'}</p>
            </div>
          </div>
          <div class="mt-4 space-y-3 text-sm">
            <PromptMonitorTextBlock
              title="Response Content"
              value={turn.snapshot?.promptContext?.response?.content ?? turn.record?.assistantMessage?.content}
              emptyText="No response content recorded."
              maxHeightClass="max-h-[20rem]"
            />
            <PromptMonitorTextBlock
              title="Provider Reasoning"
              value={turn.snapshot?.promptContext?.response?.reasoning}
              emptyText="No provider reasoning snapshot recorded."
              maxHeightClass="max-h-[20rem]"
            />
          </div>
        </div>
      </div>
    {:else if activeTab === 'cache'}
      {#if !plan}
        <div class="rounded-xl border border-gold-300 bg-gold-50 p-4 text-sm text-shadow-800">
          <p class="font-medium text-shadow-900">Legacy turn (pre-plan)</p>
          <p class="mt-1">{LEGACY_TURN_LABEL} No cache plan is recorded for this turn.</p>
        </div>
      {:else}
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Volatility Regions</h3>
          <p class="mt-1 text-xs text-shadow-600">
            Ordered cache regions from the plan's cachePlan: blocks[0..{plan.cachePlan.staticBoundary}) are
            static, blocks[{plan.cachePlan.staticBoundary}..{plan.cachePlan.sessionStableBoundary}) are
            session-stable, the rest re-render every turn.
          </p>
          <div class="mt-3 space-y-3">
            {#each cacheRegions as region (region.name)}
              <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
                <div class="flex flex-wrap items-center gap-2">
                  <span class={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${volatilityTone(region.name)}`}>
                    {region.name.replace('_', ' ')}
                  </span>
                  <span class="text-sm text-shadow-700">
                    {region.blocks.length} block{region.blocks.length === 1 ? '' : 's'} · {regionTokens(region.blocks)} tokens (est.)
                  </span>
                </div>
                {#if region.blocks.length === 0}
                  <p class="mt-2 text-sm text-shadow-600">No blocks in this region.</p>
                {:else}
                  <div class="mt-2 flex flex-wrap gap-2">
                    {#each region.blocks as block (block.id)}
                      <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 font-mono text-xs text-shadow-800" title={`producer ${block.producer} · scope ${block.scopeKey ?? '—'} · ${block.tokensEst} tokens (est.)`}>
                        {block.id}
                      </span>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Static-Prefix Hash Timeline</h3>
          <p class="mt-1 text-xs text-shadow-600">
            Static hash across the loaded recent turns (oldest first). A stable hash means the frozen
            static prefix stayed byte-identical turn over turn.
          </p>
          {#if staticHashTimeline.length === 0}
            <p class="mt-3 text-sm text-shadow-600">No turns loaded for this session.</p>
          {:else}
            <div class="mt-3 space-y-2">
              {#each staticHashTimeline as entry (entry.turnId)}
                <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2
                  {entry.turnId === turn.turnId ? 'border-gold-400 bg-gold-50' : 'border-bark-200 bg-white'}">
                  <div class="min-w-0">
                    <p class="truncate font-mono text-sm text-shadow-900">{truncateValue(entry.turnId, 24)}</p>
                    <p class="mt-0.5 font-mono text-xs text-shadow-600">{truncateValue(entry.staticHash, 24)}</p>
                  </div>
                  <span class={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
                    entry.changedFromPrevious === null
                      ? 'border-bark-300 bg-bark-100 text-shadow-600'
                      : entry.changedFromPrevious
                        ? 'border-wilt-300 bg-wilt-50 text-wilt-700'
                        : 'border-moss-300 bg-moss-50 text-moss-700'
                  }`}>
                    {entry.changedFromPrevious === null
                      ? 'no prior hash'
                      : entry.changedFromPrevious
                        ? 'hash changed'
                        : 'hash stable'}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Provider Cache Telemetry</h3>
          <p class="mt-1 text-xs text-shadow-600">
            Provider cache hit/miss telemetry lands in E2.4. Whatever cache fields the runtime already
            records for this turn are rendered below, absent-tolerant.
          </p>
          <div class="mt-3 text-sm">
            <PromptMonitorTextBlock
              title="promptCaching (recorded)"
              value={formatJson(providerCacheTelemetry)}
              emptyText="No provider cache telemetry recorded for this turn (placeholder until E2.4)."
              maxHeightClass="max-h-64"
            />
          </div>
        </div>
      </div>
    {:else if activeTab === 'diff'}
      <div class="rounded-xl border border-bark-200 bg-white p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="font-medium text-shadow-900">Turn Diff (block-level)</h3>
            <p class="mt-1 text-xs text-shadow-600">
              Compares the selected turn's PromptPlan blocks against a baseline turn: which blocks
              appeared, disappeared, or changed (id-level, with a changed-bytes indicator per block).
            </p>
          </div>
          <label class="flex items-center gap-2 text-sm text-shadow-700">
            <span>Baseline</span>
            <select
              class="rounded-lg border border-bark-300 bg-white px-2 py-1.5 font-mono text-sm text-shadow-900"
              value={diffBaselineTurn?.turnId ?? ''}
              onchange={(event) => diffBaselineTurnId = (event.currentTarget as HTMLSelectElement).value || null}
              disabled={diffCandidates.length === 0}
            >
              {#if diffCandidates.length === 0}
                <option value="">no other turns loaded</option>
              {/if}
              {#each diffCandidates as candidate (candidate.turnId)}
                <option value={candidate.turnId}>
                  {candidate.turnId}{candidate.turnId === defaultDiffBaseline?.turnId ? ' (previous)' : ''}
                </option>
              {/each}
            </select>
          </label>
        </div>

        {#if !plan}
          <div class="mt-3 rounded-lg border border-gold-300 bg-gold-50 p-3 text-sm text-shadow-800">
            <p class="font-medium text-shadow-900">Legacy turn (pre-plan)</p>
            <p class="mt-1">{LEGACY_TURN_LABEL} Block-level diffing needs a PromptPlan on both turns.</p>
          </div>
        {:else if !diffBaselineTurn}
          <p class="mt-3 text-sm text-shadow-600">
            No other turns are loaded for this session, so there is nothing to diff against.
          </p>
        {:else if !diffBaselinePlan}
          <div class="mt-3 rounded-lg border border-gold-300 bg-gold-50 p-3 text-sm text-shadow-800">
            <p class="font-medium text-shadow-900">Baseline is a legacy turn (pre-plan)</p>
            <p class="mt-1">
              Turn <span class="font-mono">{truncateValue(diffBaselineTurn.turnId, 24)}</span> predates the
              PromptPlan snapshot; pick a plan-backed baseline to diff.
            </p>
          </div>
        {:else}
          <div class="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <div class="rounded-lg border border-bark-200 bg-white p-3">
              <p class="text-shadow-600">Added</p>
              <p class="mt-1 font-serif text-2xl {blockDiff.addedCount > 0 ? 'text-moss-700' : 'text-shadow-900'}">{blockDiff.addedCount}</p>
            </div>
            <div class="rounded-lg border border-bark-200 bg-white p-3">
              <p class="text-shadow-600">Removed</p>
              <p class="mt-1 font-serif text-2xl {blockDiff.removedCount > 0 ? 'text-wilt-600' : 'text-shadow-900'}">{blockDiff.removedCount}</p>
            </div>
            <div class="rounded-lg border border-bark-200 bg-white p-3">
              <p class="text-shadow-600">Changed</p>
              <p class="mt-1 font-serif text-2xl {blockDiff.changedCount > 0 ? 'text-shadow-900' : 'text-shadow-900'}">{blockDiff.changedCount}</p>
            </div>
            <div class="rounded-lg border border-bark-200 bg-white p-3">
              <p class="text-shadow-600">Unchanged</p>
              <p class="mt-1 font-serif text-2xl text-shadow-900">{blockDiff.unchangedCount}</p>
            </div>
            <div class="rounded-lg border p-3 {blockDiff.staticRegionChangedCount === 0 ? 'border-moss-300 bg-moss-50' : 'border-wilt-300 bg-wilt-50'}">
              <p class="text-shadow-600">Static Region Changed</p>
              <p class="mt-1 font-serif text-2xl {blockDiff.staticRegionChangedCount === 0 ? 'text-moss-700' : 'text-wilt-600'}">
                {blockDiff.staticRegionChangedCount}
              </p>
            </div>
          </div>
          <p class="mt-2 text-xs text-shadow-600">
            {#if blockDiff.staticRegionChangedCount === 0}
              Static region is byte-stable against the baseline: zero changed static blocks.
            {:else}
              Static region changed against the baseline — the frozen prefix cache line was broken.
            {/if}
          </p>

          <div class="mt-4 space-y-2">
            {#each blockDiff.entries as entry (entry.id)}
              <div class="rounded-lg border border-bark-200 bg-white px-3 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${diffStatusTone(entry.status)}`}>
                    {entry.status}
                  </span>
                  <span class="font-mono text-sm font-medium text-shadow-900">{entry.id}</span>
                  {#if entry.volatility}
                    <span class={`rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${volatilityTone(entry.volatility)}`}>
                      {entry.volatility.replace('_', ' ')}
                    </span>
                  {/if}
                  {#if entry.layer}
                    <span class="rounded-full border border-bark-300 bg-bark-50 px-2 py-0.5 text-xs text-shadow-700">{entry.layer}</span>
                  {/if}
                  <span class="ml-auto font-mono text-xs text-shadow-600">{formatBytesDelta(entry)}</span>
                </div>
                <p class="mt-1 text-xs text-shadow-600">
                  producer <span class="font-mono">{entry.producer ?? '—'}</span>
                  · scope <span class="font-mono">{entry.scopeKey ?? '—'}</span>
                </p>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if activeTab === 'timeline'}
      <PromptMonitorTimelinePanel {turn} />
    {:else if activeTab === 'raw'}
      <PromptMonitorRawEventsPanel {turn} {selectedChannelEvents} />
    {/if}
  </div>
</section>
