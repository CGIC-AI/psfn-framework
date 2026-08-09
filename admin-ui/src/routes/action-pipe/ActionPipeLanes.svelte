<script lang="ts">
  import type { ActionPipeStatus } from '$lib/api/endpoints/action-pipe';
  import { formatTime } from './action-pipe-helpers';

  type LaneStatus = ActionPipeStatus['lanes'][number];

  let { lanes }: { lanes: LaneStatus[] } = $props();
</script>

<section class="garden-section space-y-4" aria-labelledby="action-pipe-lanes-heading">
  <div>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Runtime Lanes</p>
    <h2 id="action-pipe-lanes-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
      Lane pressure and back-pressure
    </h2>
  </div>
  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
    {#each lanes as lane (lane.runtimeClass)}
      <article class="card-garden p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="font-serif font-semibold text-shadow-900">{lane.runtimeClass}</h3>
            <p class="mt-1 text-xs uppercase tracking-[0.16em] text-shadow-500">{lane.chargeLane}</p>
          </div>
          <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {lane.saturated ? 'border-wilt-300 bg-wilt-50 text-wilt-700' : 'border-leaf-300 bg-leaf-50 text-leaf-700'}">
            {lane.saturated ? 'saturated' : 'available'}
          </span>
        </div>
        <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div><dt class="text-shadow-500">Depth</dt><dd class="font-mono text-shadow-900">{lane.queueDepth}/{lane.maxQueuedActions}</dd></div>
          <div><dt class="text-shadow-500">Ready</dt><dd class="font-mono text-shadow-900">{lane.readyCount}</dd></div>
          <div><dt class="text-shadow-500">Retries</dt><dd class="font-mono text-shadow-900">{lane.retryScheduledCount}</dd></div>
          <div><dt class="text-shadow-500">Dropped</dt><dd class="font-mono text-shadow-900">{lane.droppedCount}</dd></div>
        </dl>
        {#if lane.nextRunAt}
          <p class="mt-3 text-xs text-shadow-500">Next run: {formatTime(lane.nextRunAt)}</p>
        {/if}
      </article>
    {/each}
  </div>
</section>
