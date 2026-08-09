<script lang="ts">
  import type { ActionPipeStatus } from '$lib/api/endpoints/action-pipe';
  import { recordSummary, shortRef } from './action-pipe-helpers';

  type FailureRecord = ActionPipeStatus['failures']['recentFailures'][number];
  type DropRecord = ActionPipeStatus['backPressure']['recentDrops'][number];
  type TerminalRecord = ActionPipeStatus['terminal']['recentTerminals'][number];
  type CompletionRecord = ActionPipeStatus['completions']['recentCompletions'][number];
  type HistoryRecord = FailureRecord | DropRecord | TerminalRecord | CompletionRecord;

  interface HistoryPanel {
    title: string;
    records: HistoryRecord[];
    empty: string;
  }

  let { panels }: { panels: HistoryPanel[] } = $props();
</script>

<section class="garden-section space-y-4" aria-labelledby="action-pipe-history-heading">
  <div>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Recent History</p>
    <h2 id="action-pipe-history-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
      Failures, drops, operator actions, and completions
    </h2>
  </div>
  <div class="grid gap-4 xl:grid-cols-2">
    {#each panels as panel (panel.title)}
      <article class="garden-section card-garden p-5">
        <h3 class="font-serif font-semibold text-shadow-900">{panel.title}</h3>
        {#if panel.records.length === 0}
          <p class="garden-empty mt-3 text-sm text-shadow-600">{panel.empty}</p>
        {:else}
          <div class="mt-4 space-y-3">
            {#each panel.records.slice(0, 8) as record}
              <div class="rounded-xl border border-bark-200 bg-bark-50 p-3">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="font-mono text-xs text-shadow-500">{shortRef(record.actionId)} · {record.actionKind}</p>
                    <p class="mt-1 text-sm text-shadow-800">{recordSummary(record)}</p>
                  </div>
                  <span class="rounded-full border border-bark-300 bg-bark-100 px-2 py-0.5 text-xs text-shadow-700">
                    {record.runtimeClass}
                  </span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </article>
    {/each}
  </div>
</section>
