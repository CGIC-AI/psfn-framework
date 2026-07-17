<script lang="ts">
  import type { ActionPipeStatus } from '$lib/api/endpoints/action-pipe';
  import { formatDuration, shortRef, stateClass } from './action-pipe-helpers';

  type CompletionRecord = ActionPipeStatus['completions']['recentCompletions'][number];

  let { outcomes }: { outcomes: CompletionRecord[] } = $props();
</script>

<section class="space-y-4" aria-labelledby="action-pipe-subagents-heading">
  <div>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Subagents</p>
    <h2 id="action-pipe-subagents-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
      Spawned-agent outcomes
    </h2>
  </div>
  {#if outcomes.length === 0}
    <div class="card-garden p-5 text-sm text-shadow-600">No completed subagent spawn actions in recent history.</div>
  {:else}
    <div class="grid gap-4 xl:grid-cols-2">
      {#each outcomes as outcome (outcome.dedupeKey)}
        {@const spawn = outcome.subagentSpawn}
        {#if spawn}
          <article class="card-garden p-5">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="font-serif font-semibold text-shadow-900">{spawn.name}</h3>
                <p class="mt-1 font-mono text-xs text-shadow-500">{shortRef(spawn.subagentId)}</p>
              </div>
              <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {stateClass(spawn.health)}">{spawn.health}</span>
            </div>
            <p class="mt-3 text-sm text-shadow-700">{spawn.stateReason}</p>
            {#if spawn.failureReason}
              <p class="mt-2 text-sm text-wilt-700">{spawn.failureReason}</p>
            {/if}
            <dl class="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div><dt class="text-shadow-500">Lifecycle</dt><dd class="font-mono text-shadow-900">{spawn.lifecycleState}</dd></div>
              <div><dt class="text-shadow-500">Model</dt><dd class="font-mono text-shadow-900">{spawn.model}</dd></div>
              <div><dt class="text-shadow-500">Turns</dt><dd class="font-mono text-shadow-900">{spawn.turns}</dd></div>
              <div><dt class="text-shadow-500">Duration</dt><dd class="font-mono text-shadow-900">{formatDuration(spawn.durationMs)}</dd></div>
            </dl>
          </article>
        {/if}
      {/each}
    </div>
  {/if}
</section>
