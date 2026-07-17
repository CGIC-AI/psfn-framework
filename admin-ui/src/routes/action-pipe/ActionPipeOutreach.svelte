<script lang="ts">
  import type { ActionPipeStatus } from '$lib/api/endpoints/action-pipe';
  import { formatTime, shortRef, stateClass } from './action-pipe-helpers';

  type OutreachRecord = NonNullable<ActionPipeStatus['outreachOutbox']>['recentRecords'][number];

  let { records }: { records: OutreachRecord[] } = $props();

  function outreachSummary(record: OutreachRecord): string {
    return record.error
      ?? record.reason
      ?? record.metadata?.skippedReason?.toString()
      ?? `content ${record.contentLength ?? 0} chars`;
  }
</script>

<section class="space-y-4" aria-labelledby="action-pipe-outreach-heading">
  <div>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Outreach</p>
    <h2 id="action-pipe-outreach-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
      Proactive outbound ledger
    </h2>
  </div>
  {#if records.length === 0}
    <div class="card-garden p-5 text-sm text-shadow-600">No recent outreach outbox records.</div>
  {:else}
    <div class="grid gap-4 xl:grid-cols-2">
      {#each records.slice(0, 10) as record}
        <article class="card-garden p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="font-serif font-semibold text-shadow-900">{record.channelType} · {shortRef(record.channelId)}</h3>
              <p class="mt-1 font-mono text-xs text-shadow-500">{shortRef(record.actionId)} · {shortRef(record.dedupeKey)}</p>
            </div>
            <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {stateClass(record.phase)}">{record.phase}</span>
          </div>
          <p class="mt-3 text-sm text-shadow-700">{outreachSummary(record)}</p>
          <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div><dt class="text-shadow-500">Recorded</dt><dd class="font-mono text-shadow-900">{formatTime(record.recordedAt)}</dd></div>
            <div><dt class="text-shadow-500">Source</dt><dd class="font-mono text-shadow-900">{shortRef(record.sourceMessageId)}</dd></div>
            {#if record.runAt}
              <div><dt class="text-shadow-500">Run at</dt><dd class="font-mono text-shadow-900">{formatTime(record.runAt)}</dd></div>
            {/if}
            {#if record.contentHash}
              <div><dt class="text-shadow-500">Content hash</dt><dd class="font-mono text-shadow-900">{shortRef(record.contentHash)}</dd></div>
            {/if}
          </dl>
        </article>
      {/each}
    </div>
  {/if}
</section>
