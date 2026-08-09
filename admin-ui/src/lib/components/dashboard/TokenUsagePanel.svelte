<script lang="ts">
  import type { AdminDashboardData, DashboardCostWindow, DashboardCostWindowUsage } from '$lib/types';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';

  type LatencySeries = AdminDashboardData['stats']['transientSessionTelemetry']['latencyPercentiles']['series'][number];

  let {
    usage,
    window,
    loading = false,
    transientTelemetry,
    formatTokens,
    formatCost,
    formatDuration,
  } = $props<{
    usage: DashboardCostWindowUsage | null;
    window: DashboardCostWindow;
    loading?: boolean;
    transientTelemetry: AdminDashboardData['stats']['transientSessionTelemetry'];
    formatTokens: (value: number) => string;
    formatCost: (value: number) => string;
    formatDuration: (value: number | null | undefined) => string;
  }>();

  const ttft = $derived(
    transientTelemetry.latencyPercentiles.series.find(
      (series: LatencySeries) => series.metric === 'llm_ttft' && Object.keys(series.dimensions).length === 0,
    )?.percentiles,
  );
  const ttfa = $derived(
    transientTelemetry.latencyPercentiles.series.find(
      (series: LatencySeries) => series.metric === 'ttfa' && Object.keys(series.dimensions).length === 0,
    )?.percentiles,
  );

  const metrics = $derived(
    usage
      ? [
          { label: 'Input tokens', value: formatTokens(usage.inputTokens) },
          { label: 'Output tokens', value: formatTokens(usage.outputTokens) },
          { label: 'Cache read', value: formatTokens(usage.cacheReadTokens) },
          { label: 'Cache write', value: formatTokens(usage.cacheWriteTokens) },
          {
            label: 'Avg / call',
            value: usage.calls > 0 ? formatTokens(Math.round(usage.totalTokens / usage.calls)) : '—',
          },
          { label: 'Failed calls', value: usage.failedCalls.toLocaleString(), warning: usage.failedCalls > 0 },
        ]
      : [],
  );
</script>

<section id="cost" aria-labelledby="token-usage-heading" class="card-garden scroll-mt-4 p-4 sm:p-5" aria-busy={loading}>
  <div class="flex items-start justify-between gap-3">
    <div>
      <h2 id="token-usage-heading" class="font-serif text-lg text-shadow-900">Token usage</h2>
      <p class="mt-1 text-xs text-shadow-600">Canonical PostgreSQL accounting · {window}</p>
    </div>
    <a href={scopeGardenPath('/charge-budget')} class="whitespace-nowrap text-xs font-medium text-gold-700 hover:text-gold-800">
      Charge / Budget <span aria-hidden="true">→</span>
    </a>
  </div>

  {#if usage && usage.calls > 0}
    <dl class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {#each metrics as metric (metric.label)}
        <div class="rounded-lg border p-3 {metric.warning ? 'border-wilt-300 bg-wilt-50' : 'border-bark-300 bg-bark-100'}">
          <dt class="text-[11px] font-medium uppercase tracking-[0.08em] text-shadow-600">{metric.label}</dt>
          <dd class="mt-1 font-serif text-xl leading-none tabular-nums {metric.warning ? 'text-wilt-800' : 'text-shadow-900'}">
            {metric.value}
          </dd>
        </div>
      {/each}
    </dl>
    <div class="mt-4 grid gap-2 rounded-lg border border-bark-200 bg-bark-50 p-3 text-xs text-shadow-600 sm:grid-cols-3">
      <p><span class="block text-shadow-500">Model calls</span><strong class="font-medium text-shadow-800">{usage.calls.toLocaleString()}</strong></p>
      <p><span class="block text-shadow-500">Provider cost</span><strong class="font-medium text-shadow-800">{formatCost(usage.providerCostUsd)}</strong></p>
      <p><span class="block text-shadow-500">Estimated cost</span><strong class="font-medium text-shadow-800">{formatCost(usage.estimatedCostUsd)}</strong></p>
    </div>
  {:else if usage}
    <p class="mt-4 rounded-lg border border-dashed border-bark-300 px-4 py-6 text-center text-sm text-shadow-600">
      No durable model usage is recorded in this window.
    </p>
  {:else}
    <p class="mt-4 rounded-lg border border-wilt-300 bg-wilt-50 px-4 py-6 text-center text-sm text-wilt-700">
      Token accounting is unavailable because durable model-usage storage could not be read.
    </p>
  {/if}

  <div class="mt-4 border-t border-bark-200 pt-3 text-xs leading-relaxed text-shadow-600">
    <p>
      Live latency is separate · last TTFT {formatDuration(transientTelemetry.lastTtftMs)} · average TTFT {formatDuration(transientTelemetry.averageTtftMs)}.
    </p>
    {#if ttft}
      <p class="mt-1">LLM TTFT p50/p95/p99: {formatDuration(ttft.p50Ms)} / {formatDuration(ttft.p95Ms)} / {formatDuration(ttft.p99Ms)}.</p>
    {/if}
    {#if ttfa}
      <p class="mt-1">Voice TTFA playback proxy p50/p95/p99: {formatDuration(ttfa.p50Ms)} / {formatDuration(ttfa.p95Ms)} / {formatDuration(ttfa.p99Ms)}.</p>
    {/if}
  </div>
</section>
