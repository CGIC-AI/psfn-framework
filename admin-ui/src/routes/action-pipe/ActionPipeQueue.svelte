<script lang="ts">
  import type { ActionPipeStatus } from '$lib/api/endpoints/action-pipe';
  import { formatDuration, formatTime, shortRef, stateClass } from './action-pipe-helpers';

  type QueuedAction = ActionPipeStatus['queued'][number];

  let {
    actions,
    mutatingActionRef,
    onCancel,
    onAcknowledge,
  }: {
    actions: QueuedAction[];
    mutatingActionRef: string;
    onCancel: (action: QueuedAction) => void;
    onAcknowledge: (action: QueuedAction) => void;
  } = $props();
</script>

<section class="space-y-4" aria-labelledby="action-pipe-queued-heading">
  <div>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Queue</p>
    <h2 id="action-pipe-queued-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
      Queued autonomous actions
    </h2>
    <p class="mt-1 text-sm text-shadow-600">
      Cancellable entries can be cancelled or acknowledged before execution. Running and historical entries are read-only.
    </p>
  </div>

  {#if actions.length === 0}
    <div class="card-garden p-5 text-sm text-shadow-600">No queued post-turn actions.</div>
  {:else}
    <div class="space-y-3">
      {#each actions as action (action.dedupeKey)}
        <article class="card-garden p-4">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="font-serif font-semibold text-shadow-900">{action.actionKind}</h3>
                <span class="rounded-full border px-2 py-0.5 text-xs font-semibold {stateClass(action.state)}">{action.state}</span>
                <span class="rounded-full border border-bark-300 bg-bark-100 px-2 py-0.5 text-xs text-shadow-700">{action.runtimeClass}</span>
                <span class="rounded-full border border-gold-300 bg-gold-50 px-2 py-0.5 text-xs text-gold-800">{action.capability}</span>
              </div>
              <p class="mt-2 font-mono text-xs text-shadow-500">{shortRef(action.actionId)} · {shortRef(action.dedupeKey)}</p>
              {#if action.subagentSpawn}
                <p class="mt-2 text-sm text-shadow-700">
                  Subagent request: {action.subagentSpawn.requestName ?? 'unnamed'} · max turns {action.subagentSpawn.requestedMaxTurns ?? action.subagentSpawn.budgetMaxTurns ?? '-'} · policy {action.subagentSpawn.policyMode ?? 'unknown'}
                </p>
              {/if}
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => onCancel(action)}
                disabled={!action.cancellable || mutatingActionRef === action.actionId}
                class="rounded-lg border border-wilt-300 px-3 py-1.5 text-sm font-medium text-wilt-700 transition-colors hover:bg-wilt-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onclick={() => onAcknowledge(action)}
                disabled={!action.cancellable || mutatingActionRef === action.actionId}
                class="rounded-lg border border-bark-300 px-3 py-1.5 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Acknowledge
              </button>
            </div>
          </div>
          <dl class="mt-4 grid gap-3 text-sm md:grid-cols-4">
            <div><dt class="text-shadow-500">Attempt</dt><dd class="font-mono text-shadow-900">{action.attempt}/{action.maxAttempts}</dd></div>
            <div><dt class="text-shadow-500">Queued for</dt><dd class="font-mono text-shadow-900">{formatDuration(action.queuedForMs)}</dd></div>
            <div><dt class="text-shadow-500">Runs in</dt><dd class="font-mono text-shadow-900">{formatDuration(action.runAfterMs)}</dd></div>
            <div><dt class="text-shadow-500">Next run</dt><dd class="font-mono text-shadow-900">{formatTime(action.nextRunAt)}</dd></div>
          </dl>
        </article>
      {/each}
    </div>
  {/if}
</section>
