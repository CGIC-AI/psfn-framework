<script lang="ts">
  import { onMount } from 'svelte';
  import { apiGet } from '$lib/api/client';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';

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

<div class="space-y-4">
  <div>
    <p class="text-[0.65rem] uppercase tracking-[0.2em] text-shadow-500">Runtime & Tools</p>
    <h1 class="flex items-baseline gap-2 text-xl font-serif font-bold text-shadow-900">
      Analysis Workbench
      <span class="text-sm font-sans font-normal text-shadow-600">
        {traces.length} recent trace{traces.length === 1 ? '' : 's'}
      </span>
    </h1>
    <p class="mt-1 text-sm text-shadow-600">
      Recent REPL traces for this process lifetime. Traces are in-memory and reset on restart.
    </p>
  </div>

  {#if error}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{error}</p>
    </div>
  {/if}

  {#if loading}
    <div class="card-garden animate-pulse p-5">
      <div class="h-4 w-2/3 rounded bg-bark-200"></div>
      <div class="mt-3 h-3 w-full rounded bg-bark-100"></div>
    </div>
  {:else if traces.length === 0}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-600">No analysis workbench traces recorded since this process started.</p>
    </div>
  {:else}
    <BoundedList maxHeight="40rem" label="Analysis workbench traces">
      <ul class="space-y-3 pr-1">
        {#each traces as trace, index}
          <li class="rounded-xl border border-bark-200 bg-bark-50">
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
                  <div class="rounded-lg border border-bark-200 bg-white p-3">
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
  {/if}
</div>
