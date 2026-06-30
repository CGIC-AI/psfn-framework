<script lang="ts">
  import type { GardenEventEnvelope } from '$lib/events/envelope';
  import {
    formatPromptMonitorStageLabel,
    PROMPT_MONITOR_STAGE_ORDER,
    resolvePromptMonitorPromptLoom,
    type PromptMonitorMetrics,
    type PromptMonitorTurn,
  } from '$lib/events/prompt-monitor';
  import type { AdminPromptSectionCacheability } from '$lib/types';
  import PromptMonitorMemoryList from './PromptMonitorMemoryList.svelte';
  import PromptMonitorMessageList from './PromptMonitorMessageList.svelte';
  import PromptMonitorSectionTelemetryList from './PromptMonitorSectionTelemetryList.svelte';
  import PromptMonitorSessionEntryList from './PromptMonitorSessionEntryList.svelte';
  import PromptMonitorTextBlock from './PromptMonitorTextBlock.svelte';
  import PromptMonitorToolList from './PromptMonitorToolList.svelte';

  type SelectedTurnTab =
    | 'summary'
    | 'prompt'
    | 'context'
    | 'tools'
    | 'exact'
    | 'provider'
    | 'timeline'
    | 'raw';

  interface Props {
    turn: PromptMonitorTurn;
    metrics?: PromptMonitorMetrics | null;
    selectedChannelEvents?: GardenEventEnvelope[];
  }

  let {
    turn,
    metrics = null,
    selectedChannelEvents = [],
  }: Props = $props();

  const selectedTurnTabs = [
    { id: 'summary', label: 'Summary', description: 'Route, prompt, timing, and outcome triage' },
    { id: 'prompt', label: 'Prompt Assembly', description: 'Templates, rendered blocks, assembled prompt, and model context' },
    { id: 'context', label: 'Context & Memory', description: 'Session inputs, memory retrievals, withholds, and metadata' },
    { id: 'tools', label: 'Tools', description: 'Active schemas and adaptive activation state' },
    { id: 'exact', label: 'Exact Payload', description: 'Exact provider input, tools, response, memory capture, and tool activity' },
    { id: 'provider', label: 'Provider Wire', description: 'Provider routing, system-role transport, payload, and response' },
    { id: 'timeline', label: 'Timeline', description: 'Stage order, elapsed time, and stage payloads' },
    { id: 'raw', label: 'Raw Events', description: 'Record, snapshot, stage telemetry, and live bus envelopes' },
  ] satisfies Array<{ id: SelectedTurnTab; label: string; description: string }>;

  let activeTab = $state<SelectedTurnTab>('summary');
  let lastTurnId = $state<string | null>(null);
  const promptLoom = $derived(resolvePromptMonitorPromptLoom(turn));

  $effect(() => {
    if (lastTurnId !== turn.turnId) {
      lastTurnId = turn.turnId;
      activeTab = 'summary';
    }
  });

  function toTimestamp(value: number | string | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function formatDuration(value: number | null): string {
    if (value == null) return '—';
    if (value < 1_000) return `${Math.round(value)}ms`;
    if (value < 60_000) return `${(value / 1_000).toFixed(2)}s`;
    return `${(value / 60_000).toFixed(2)}m`;
  }

  function formatCount(value: number | null | undefined): string {
    if (value == null) return '—';
    return value.toLocaleString();
  }

  function formatTimestamp(value: number | null): string {
    if (value == null) return '—';
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function truncateValue(value: string | null | undefined, limit: number = 18): string {
    if (!value) return '—';
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}…`;
  }

  function metricTone(value: number | null, warningThreshold: number): string {
    if (value == null) return 'text-shadow-700';
    return value >= warningThreshold ? 'text-wilt-600' : 'text-moss-700';
  }

  function joinLines(values: readonly string[] | null | undefined): string | null {
    if (!values || values.length === 0) return null;
    return values.join('\n\n');
  }

  function formatJson(value: unknown): string | null {
    if (value == null) return null;
    return JSON.stringify(value, null, 2);
  }

  function humanizeToken(value: string | null | undefined): string {
    if (!value) return '—';
    return value
      .split('_')
      .filter(part => part.length > 0)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function formatCapability(value: boolean | null | undefined): string {
    if (value == null) return '—';
    return value ? 'Yes' : 'No';
  }

  function formatStageName(value: string | null | undefined): string {
    return value ? formatPromptMonitorStageLabel(value) : '—';
  }

  function providerWireMessages(currentTurn: PromptMonitorTurn): Array<{ role: string; content: string }> {
    return currentTurn.snapshot?.promptContext?.providerObservability?.providerWireMessages.map(message => ({
      role: `${humanizeToken(message.role)} · ${humanizeToken(message.source)}`,
      content: message.content,
    })) ?? [];
  }

  function cacheabilityFor(
    section: AdminPromptSectionCacheability['section'],
  ): AdminPromptSectionCacheability | null {
    return turn.snapshot?.promptContext?.sectionCacheability?.find(candidate => candidate.section === section) ?? null;
  }

  function memoryCount(currentTurn: PromptMonitorTurn): number {
    const memory = currentTurn.snapshot?.memory;
    if (!memory) return 0;
    return memory.contactEmotionalMemories.length
      + memory.semanticCandidates.length
      + memory.lexicalCandidates.length
      + memory.proactiveCandidates.length;
  }

  function activeToolCount(currentTurn: PromptMonitorTurn): number {
    return currentTurn.snapshot?.toolContext?.adaptiveSnapshot?.counts?.total
      ?? currentTurn.snapshot?.toolContext?.activeTools?.length
      ?? 0;
  }

  function skippedToolCount(currentTurn: PromptMonitorTurn): number {
    return currentTurn.snapshot?.toolContext?.adaptiveSnapshot?.skipped?.length ?? 0;
  }

  function stageFieldCount(stage: PromptMonitorTurn['stages'][number]): number {
    return Object.entries(stage.data).length;
  }

  function sessionMetadataJson(currentTurn: PromptMonitorTurn): string | null {
    const sessionContext = currentTurn.snapshot?.sessionContext;
    if (!sessionContext) return null;
    return formatJson({
      channelId: sessionContext.channelId,
      versionPointer: sessionContext.versionPointer,
      recentEntryCount: sessionContext.recentEntries.length,
      continuityEntryCount: sessionContext.continuityEntries.length,
      compactionSummaryCount: sessionContext.compactionSummaryTexts.length,
      focusKnowledgeCount: sessionContext.focusKnowledgeTexts.length,
    });
  }

  function memoryMetadataJson(currentTurn: PromptMonitorTurn): string | null {
    const memory = currentTurn.snapshot?.memory;
    if (!memory) return null;
    return formatJson({
      channelId: memory.channelId,
      versionPointer: memory.versionPointer,
      profile: memory.profile,
      emotionalSnapshot: memory.emotionalSnapshot,
      withheldSummary: memory.withheldSummary,
    });
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
            title="Assistant Response"
            value={turn.snapshot?.promptContext?.response?.content ?? turn.record?.assistantMessage?.content}
            emptyText="No assistant response snapshot recorded."
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
              value={turn.snapshot?.promptContext?.renderedStaticPrefix}
              emptyText="No rendered static prefix recorded."
              cacheability={cacheabilityFor('renderedStaticPrefix')}
            />
            <PromptMonitorTextBlock
              title="Rendered Dynamic Suffix"
              value={turn.snapshot?.promptContext?.renderedDynamicSuffix}
              emptyText="No rendered dynamic suffix recorded."
              cacheability={cacheabilityFor('renderedDynamicSuffix')}
            />
            <PromptMonitorTextBlock
              title="Runtime Context Block"
              value={turn.snapshot?.promptContext?.runtimeContext}
              emptyText="No runtime context block recorded."
              maxHeightClass="max-h-64"
              cacheability={cacheabilityFor('runtimeContext')}
            />
            <PromptMonitorTextBlock
              title="Memory Context Block"
              value={turn.snapshot?.promptContext?.memoryContextBlock}
              emptyText="No memory context block recorded."
              maxHeightClass="max-h-64"
              cacheability={cacheabilityFor('memoryContextBlock')}
            />
            <PromptMonitorTextBlock
              title="Scratchpad Context"
              value={turn.snapshot?.promptContext?.scratchpadContext}
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
              value={turn.snapshot?.promptContext?.assembledPrompt}
              emptyText="No assembled prompt recorded."
              maxHeightClass="max-h-[28rem]"
              cacheability={cacheabilityFor('assembledPrompt')}
            />
            <PromptMonitorTextBlock
              title="Final System Prompt"
              value={turn.snapshot?.promptContext?.finalSystemPrompt}
              emptyText="No final system prompt recorded."
              maxHeightClass="max-h-[28rem]"
              cacheability={cacheabilityFor('finalSystemPrompt')}
            />
          </div>
        </div>

        <PromptMonitorMessageList
          title="Model Context Messages"
          messages={turn.snapshot?.promptContext?.messages ?? []}
          cacheability={cacheabilityFor('messages')}
        />
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
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
          title="Final System Sections"
          sections={turn.snapshot?.promptContext?.finalSystemSections ?? []}
          emptyText="No final system section telemetry recorded."
        />
      </div>

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
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PromptMonitorToolList
          title="Active Tool Schemas"
          tools={turn.snapshot?.toolContext?.activeTools ?? []}
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
            <PromptMonitorTextBlock
              title="Adaptive Skips"
              value={formatJson(turn.snapshot?.toolContext?.adaptiveSnapshot?.skipped)}
              emptyText="No adaptive tool skips recorded."
              maxHeightClass="max-h-56"
            />
          </div>
        </div>
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

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PromptMonitorMessageList
          title="Provider Wire Messages"
          messages={providerWireMessages(turn)}
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
    {:else if activeTab === 'timeline'}
      <div class="rounded-xl border border-bark-200 bg-white p-4">
        <h3 class="font-medium text-shadow-900">Stage Timeline</h3>
        <div class="mt-3 space-y-3">
          {#each PROMPT_MONITOR_STAGE_ORDER as stageName}
            {@const stage = turn.stages.find(candidate => candidate.stage === stageName)}
            <div class="rounded-lg border px-3 py-2
              {stage ? 'border-bark-200 bg-bark-50' : 'border-dashed border-bark-200 bg-white'}">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-sm font-medium text-shadow-900">{formatPromptMonitorStageLabel(stageName)}</p>
                  <p class="mt-0.5 text-sm text-shadow-600">
                    {stage ? formatTimestamp(toTimestamp(stage.observedAt)) : 'No telemetry captured'}
                  </p>
                </div>
                <div class="text-right">
                  <p class="font-medium {stage ? metricTone(stage.elapsedMs, stageName === 'prompt' ? 1_500 : 3_000) : 'text-shadow-500'}">
                    {stage ? formatDuration(stage.elapsedMs) : '—'}
                  </p>
                  {#if stage}
                    <p class="mt-0.5 text-sm text-shadow-600">
                      {stageFieldCount(stage)} field{stageFieldCount(stage) === 1 ? '' : 's'}
                    </p>
                  {/if}
                </div>
              </div>
              {#if stage}
                <div class="mt-3 text-sm">
                  <PromptMonitorTextBlock
                    title="Stage Payload"
                    value={formatJson(stage.data)}
                    emptyText="No stage payload recorded."
                    maxHeightClass="max-h-48"
                  />
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else if activeTab === 'raw'}
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <h3 class="font-medium text-shadow-900">Raw Turn Objects</h3>
          <div class="mt-3 space-y-3 text-sm">
            <PromptMonitorTextBlock
              title="Session Record"
              value={formatJson(turn.record)}
              emptyText="No session record captured for this turn."
              maxHeightClass="max-h-[28rem]"
            />
            <PromptMonitorTextBlock
              title="Turn Snapshot"
              value={formatJson(turn.snapshot)}
              emptyText="No turn snapshot captured for this turn."
              maxHeightClass="max-h-[28rem]"
            />
            <PromptMonitorTextBlock
              title="Stage Telemetry"
              value={formatJson(turn.stages)}
              emptyText="No stage telemetry captured for this turn."
              maxHeightClass="max-h-[28rem]"
            />
          </div>
        </div>

        <div class="rounded-xl border border-bark-200 bg-white p-4">
          <div class="flex items-center justify-between gap-3">
            <h3 class="font-medium text-shadow-900">Live Channel Bus</h3>
            <span class="text-sm text-shadow-600">{selectedChannelEvents.length} visible event{selectedChannelEvents.length === 1 ? '' : 's'}</span>
          </div>
          {#if selectedChannelEvents.length === 0}
            <p class="mt-3 text-sm text-shadow-600">No live bus events for this channel are buffered right now.</p>
          {:else}
            <div class="mt-3 space-y-3 max-h-[44rem] overflow-y-auto">
              {#each selectedChannelEvents as event, index (`${event.type}-${event.timestamp}-${index}`)}
                <div class="rounded-lg border border-bark-200 p-3 text-sm">
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-medium text-shadow-900">{event.type}</span>
                    <span class="text-shadow-600">{formatTimestamp(event.timestamp)}</span>
                  </div>
                  <p class="mt-1 text-shadow-600">
                    turn {truncateValue(event.correlation.turnId, 18)} . purpose {truncateValue(event.correlation.purpose, 24)}
                  </p>
                  <PromptMonitorTextBlock
                    title="Event Payload"
                    value={formatJson(event.data)}
                    emptyText="No payload"
                    maxHeightClass="max-h-48"
                  />
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</section>
