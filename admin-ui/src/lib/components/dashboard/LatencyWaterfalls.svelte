<script lang="ts">
  import type { AdminDashboardData } from '$lib/types';

  let {
    waterfalls,
    formatDuration,
    formatTimestamp,
  } = $props<{
    waterfalls: AdminDashboardData['stats']['transientSessionTelemetry']['recentLatencyWaterfalls'];
    formatDuration: (value: number) => string;
    formatTimestamp: (value: number | null) => string;
  }>();
</script>

<section aria-labelledby="latency-heading" class="card-garden p-4 sm:p-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 id="latency-heading" class="font-serif text-lg text-shadow-900">Recent turn latency</h2>
      <p class="mt-1 text-xs text-shadow-600">Content-free timing for correlated messages on this companion.</p>
    </div>
    <span class="rounded-full border border-bark-300 bg-bark-100 px-2.5 py-1 text-xs text-shadow-600">
      live since operator start
    </span>
  </div>

  {#if waterfalls.length > 0}
    <div class="mt-4 space-y-3">
      {#each waterfalls.slice(0, 5) as waterfall (`${waterfall.companionId ?? 'local'}:${waterfall.traceId}`)}
        <article class="rounded-lg border border-bark-300 bg-bark-100 p-3 sm:p-4" aria-label={`Latency for message ${waterfall.traceId}`}>
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate font-mono text-xs text-shadow-700" title={waterfall.traceId}>{waterfall.traceId}</p>
              <p class="mt-1 text-xs text-shadow-500">
                {waterfall.channelType ?? 'unknown channel'} · {formatTimestamp(waterfall.observedAtMs)}
              </p>
            </div>
            <p class="font-serif text-xl tabular-nums text-shadow-900">{formatDuration(Math.round(waterfall.totalObservedMs))} total</p>
          </div>
          <ol class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-7">
            {#each waterfall.stages as stage (stage.stage)}
              <li class="relative rounded-md border border-bark-200 bg-bark-50 px-3 py-2 xl:after:absolute xl:after:-right-2 xl:after:top-1/2 xl:after:h-px xl:after:w-2 xl:after:bg-bark-300 xl:last:after:hidden">
                <p class="text-[11px] font-medium leading-tight text-shadow-600">{stage.label}</p>
                {#if stage.status === 'observed' && stage.durationMs !== null}
                  <p class="mt-1 font-mono text-sm tabular-nums text-shadow-900">{formatDuration(Math.round(stage.durationMs))}</p>
                {:else}
                  <p class="mt-1 text-xs text-shadow-500">not run</p>
                {/if}
              </li>
            {/each}
          </ol>
        </article>
      {/each}
    </div>
  {:else}
    <p class="mt-4 rounded-lg border border-dashed border-bark-300 px-4 py-6 text-center text-sm text-shadow-600">
      No correlated turn timing has arrived yet.
    </p>
  {/if}
</section>
