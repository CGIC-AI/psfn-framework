<script lang="ts">
  import { onMount } from 'svelte';
  import { apiGet } from '$lib/api/client';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';

  interface TraceStep {
    iteration: number;
    inputTokens: number;
    outputTokens: number;
    cumulativeTokens: number;
    durationMs: number;
    code: string;
    output: string;
    error: string | null;
    variablesChanged: string[];
  }

  interface Trace {
    timestamp: number;
    task: string;
    iterations: number;
    totalTokens: number;
    durationMs: number;
    truncated: boolean;
    budgetStop: string | null;
    steps: TraceStep[];
  }

  let traces = $state<Trace[]>([]);
  let loading = $state(true);
  let error = $state('');
  let expandedTask = $state<number | null>(null);
  let totalTokens = $derived(traces.reduce((sum, trace) => sum + trace.totalTokens, 0));
  let averageDuration = $derived(traces.length > 0
    ? traces.reduce((sum, trace) => sum + trace.durationMs, 0) / traces.length
    : 0);
  let constrainedTraceCount = $derived(traces.filter((trace) => trace.truncated || trace.budgetStop).length);

  function formatTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
  }

  function formatDuration(ms: number): string {
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
    if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${ms}ms`;
  }

  function formatWhen(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  function toggle(index: number): void {
    expandedTask = expandedTask === index ? null : index;
  }

  onMount(async () => {
    try {
      const payload = await apiGet<{ traces: Trace[] }>('/api/admin/dashboard/analysis-workbench-traces');
      traces = payload.traces;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load analysis workbench traces';
    } finally {
      loading = false;
    }
  });
</script>

<div class="garden-page space-y-5 pb-10">
  <GardenPageHeader
    eyebrow="Runtime & Tools · Analysis"
    title="Analysis Workbench"
    description="Recent REPL traces for this process lifetime. Traces are in-memory and reset on restart."
    class="border-b border-bark-300 pb-4"
  >
    {#snippet actions()}
      <span class="garden-status {loading ? 'garden-status--warning' : error ? 'garden-status--danger' : 'garden-status--success'} rounded-full border border-bark-300 bg-bark-50 px-2.5 py-1 text-xs font-semibold text-shadow-700">
        {loading ? 'loading traces' : `${traces.length} recent`}
      </span>
    {/snippet}
  </GardenPageHeader>

  <section class="garden-metric-grid grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Analysis trace summary">
    <div class="garden-metric card-garden p-4">
      <p class="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-shadow-500">Traces</p>
      <p class="mt-2 font-serif text-2xl font-semibold text-shadow-900 tabular-nums">{traces.length}</p>
    </div>
    <div class="garden-metric card-garden p-4">
      <p class="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-shadow-500">Tokens</p>
      <p class="mt-2 font-serif text-2xl font-semibold text-gold-700 tabular-nums">{formatTokens(totalTokens)}</p>
    </div>
    <div class="garden-metric card-garden p-4">
      <p class="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-shadow-500">Average duration</p>
      <p class="mt-2 font-serif text-2xl font-semibold text-petal-600 tabular-nums">{formatDuration(averageDuration)}</p>
    </div>
    <div class="garden-metric card-garden p-4">
      <p class="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-shadow-500">Constrained</p>
      <p class="mt-2 font-serif text-2xl font-semibold {constrainedTraceCount > 0 ? 'text-wilt-600' : 'text-moss-600'} tabular-nums">{constrainedTraceCount}</p>
    </div>
  </section>

  {#if error}
    <div class="garden-error card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{error}</p>
    </div>
  {/if}

  {#if loading}
    <div class="garden-loading card-garden animate-pulse p-5">
      <div class="h-4 w-2/3 rounded bg-bark-200"></div>
      <div class="mt-3 h-3 w-full rounded bg-bark-100"></div>
    </div>
  {:else if traces.length === 0}
    <div class="garden-empty card-garden p-8 text-center">
      <p class="text-sm text-shadow-600">No analysis workbench traces recorded since this process started.</p>
    </div>
  {:else}
    <section class="garden-section card-garden overflow-hidden" aria-labelledby="analysis-trace-list-heading">
      <div class="garden-section-header border-b border-bark-300 bg-bark-50 px-4 py-3">
        <h2 id="analysis-trace-list-heading" class="garden-section-title font-serif text-lg font-semibold text-shadow-900">Trace ledger</h2>
        <p class="garden-section-description mt-1 text-sm text-shadow-600">Expand a task to inspect iteration code, outputs, token movement, and budget stops.</p>
      </div>
    <BoundedList maxHeight="40rem" label="Analysis workbench traces" class="p-4">
      <ul class="space-y-3 pr-1">
        {#each traces as trace, index}
          <li class="rounded-xl border border-bark-200 bg-bark-50 transition-colors hover:border-gold-300">
            <button
              type="button"
              aria-expanded={expandedTask === index}
              onclick={() => toggle(index)}
              class="flex w-full flex-wrap items-center justify-between gap-2 p-4 text-left"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold text-shadow-900" title={trace.task}>{trace.task}</p>
                <p class="mt-1 text-xs text-shadow-500">
                  {formatWhen(trace.timestamp)} · {trace.iterations} iteration{trace.iterations === 1 ? '' : 's'}
                  · {formatTokens(trace.totalTokens)} tokens · {formatDuration(trace.durationMs)}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                {#if trace.truncated}
                  <span class="rounded border border-wilt-300 bg-wilt-50 px-1.5 py-0.5 text-xs font-medium text-wilt-700">truncated</span>
                {/if}
                {#if trace.budgetStop}
                  <span class="rounded border border-gold-300 bg-gold-50 px-1.5 py-0.5 text-xs font-medium text-gold-700">budget stop</span>
                {/if}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-4 w-4 text-shadow-400 transition-transform {expandedTask === index ? 'rotate-180' : ''}"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>

            {#if expandedTask === index}
              <div class="space-y-3 border-t border-bark-200 p-4">
                {#if trace.budgetStop}
                  <p class="text-xs text-gold-700">Budget stop: {trace.budgetStop}</p>
                {/if}
                {#each trace.steps as step}
                  <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <p class="text-xs font-semibold uppercase tracking-wide text-shadow-600">
                        Iteration {step.iteration}
                      </p>
                      <p class="text-xs text-shadow-500">
                        {formatTokens(step.inputTokens)} in / {formatTokens(step.outputTokens)} out
                        · cumulative {formatTokens(step.cumulativeTokens)}
                        · {formatDuration(step.durationMs)}
                      </p>
                    </div>
                    {#if step.code}
                      <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-bark-100 p-2 text-xs text-shadow-800">{step.code}</pre>
                    {/if}
                    {#if step.error}
                      <p class="mt-2 rounded bg-wilt-50 p-2 text-xs font-medium text-wilt-700">{step.error}</p>
                    {:else if step.output}
                      <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-bark-50 p-2 text-xs text-shadow-700">{step.output}</pre>
                    {/if}
                    {#if step.variablesChanged.length > 0}
                      <p class="mt-2 text-xs text-shadow-500">
                        Variables changed: {step.variablesChanged.join(', ')}
                      </p>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </BoundedList>
    </section>
  {/if}
</div>
