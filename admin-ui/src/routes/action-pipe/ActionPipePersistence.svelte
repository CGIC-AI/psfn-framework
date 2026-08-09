<script lang="ts">
  import type { ActionPipeStatus } from '$lib/api/endpoints/action-pipe';
  import { formatTime } from './action-pipe-helpers';

  let { status }: { status: ActionPipeStatus } = $props();
</script>

<section class="garden-section grid gap-4 xl:grid-cols-2" aria-label="Action pipe persistence and quarantine">
  <article class="garden-section card-garden p-5">
    <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Persistence</p>
    <h2 class="mt-1 text-lg font-serif font-semibold text-shadow-900">Queue file state</h2>
    <dl class="mt-4 space-y-2 text-sm">
      <div class="flex justify-between gap-4"><dt class="text-shadow-500">Load state</dt><dd class="font-mono text-shadow-900">{status.persistence.loadState}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-shadow-500">Loaded entries</dt><dd class="font-mono text-shadow-900">{status.persistence.loadedEntries}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-shadow-500">Quarantined entries</dt><dd class="font-mono text-shadow-900">{status.persistence.quarantinedEntries}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-shadow-500">Last persisted</dt><dd class="font-mono text-shadow-900">{formatTime(status.persistence.lastPersistedAt)}</dd></div>
    </dl>
    {#if status.persistence.path}
      <p class="mt-4 break-all rounded-lg border border-bark-200 bg-bark-50 p-3 font-mono text-xs text-shadow-600">{status.persistence.path}</p>
    {/if}
    {#if status.persistence.lastLoadError || status.persistence.lastPersistError}
      <p class="mt-3 text-sm text-wilt-700">{status.persistence.lastLoadError ?? status.persistence.lastPersistError}</p>
    {/if}
  </article>

  <article class="garden-section card-garden p-5">
    <p class="text-xs uppercase tracking-[0.18em] text-shadow-500">Quarantine</p>
    <h2 class="mt-1 text-lg font-serif font-semibold text-shadow-900">Invalid persisted entries</h2>
    <p class="mt-2 text-sm text-shadow-600">
      {status.quarantine.count} entries quarantined; sidecar persisted: {status.quarantine.persisted ? 'yes' : 'no'}.
    </p>
    {#if status.quarantine.entries.length > 0}
      <div class="mt-4 space-y-2">
        {#each status.quarantine.entries as entry}
          <div class="rounded-lg border border-wilt-200 bg-wilt-50 p-3">
            <p class="text-sm font-medium text-wilt-700">Entry {entry.entryNumber}: {entry.error}</p>
            <pre class="mt-2 max-h-40 overflow-auto text-xs text-shadow-700">{JSON.stringify(entry.raw, null, 2)}</pre>
          </div>
        {/each}
      </div>
    {:else}
      <p class="mt-4 text-sm text-shadow-600">No quarantined queue entries.</p>
    {/if}
  </article>
</section>
