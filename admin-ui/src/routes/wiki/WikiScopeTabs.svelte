<script lang="ts">
  import type { WikiScopeSummary } from '$lib/api/endpoints/wiki';

  let {
    activeScopeKey,
    personalCount,
    sharedScopes,
    onSelectPersonal,
    onSelectShared,
  } = $props<{
    activeScopeKey: string;
    personalCount: number;
    sharedScopes: WikiScopeSummary[];
    onSelectPersonal: () => void;
    onSelectShared: (siteId: string) => void;
  }>();

  const activeSharedSiteId = $derived(
    activeScopeKey === 'personal'
      ? (sharedScopes[0]?.siteId ?? '')
      : activeScopeKey,
  );
  const sharedDocumentCount = $derived(
    sharedScopes.reduce((count: number, scope: WikiScopeSummary) => count + scope.documentCount, 0),
  );
</script>

<div class="space-y-3">
  <div class="flex flex-wrap gap-2" role="tablist" aria-label="Wiki writing surfaces">
    <button
      type="button"
      role="tab"
      aria-selected={activeScopeKey === 'personal'}
      onclick={onSelectPersonal}
      class="rounded-full border px-3 py-1.5 text-sm font-medium transition-colors {activeScopeKey === 'personal' ? 'border-gold-400 bg-gold-50 text-gold-800' : 'border-bark-300 text-shadow-700 hover:bg-bark-100'}"
    >
      Personal Wiki
      <span class="ml-1 text-xs text-shadow-500">{personalCount}</span>
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={activeScopeKey !== 'personal'}
      disabled={sharedScopes.length === 0}
      onclick={() => {
        if (activeSharedSiteId) onSelectShared(activeSharedSiteId);
      }}
      class="rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {activeScopeKey !== 'personal' ? 'border-gold-400 bg-gold-50 text-gold-800' : 'border-bark-300 text-shadow-700 hover:bg-bark-100'}"
    >
      Shared Wiki
      <span class="ml-1 text-xs text-shadow-500">{sharedDocumentCount}</span>
    </button>
  </div>

  {#if activeScopeKey !== 'personal' && sharedScopes.length > 1}
    <label class="inline-flex items-center gap-2 text-sm text-shadow-700">
      <span class="font-medium">Shared Wiki location</span>
      <select
        value={activeSharedSiteId}
        onchange={(event) => onSelectShared((event.currentTarget as HTMLSelectElement).value)}
        class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm text-shadow-800"
      >
        {#each sharedScopes as scope}
          <option value={scope.siteId ?? scope.scope}>{scope.displayName} ({scope.documentCount})</option>
        {/each}
      </select>
    </label>
  {/if}
</div>
