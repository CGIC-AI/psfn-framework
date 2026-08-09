<script lang="ts">
  import type { EffectiveModelSelectionView } from '$lib/types';

  let { effectiveChat, fleetDefault, loading, loadError } = $props<{
    effectiveChat: EffectiveModelSelectionView | null;
    fleetDefault: EffectiveModelSelectionView | null;
    loading: boolean;
    loadError: string;
  }>();
</script>

<section class="garden-section card-garden p-5 space-y-3" aria-labelledby="effective-chat-model-heading">
  <div class="garden-section-header flex flex-wrap items-start justify-between gap-3">
    <div>
    <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Runtime truth</p>
    <h2 id="effective-chat-model-heading" class="garden-section-title mt-1 font-serif text-lg font-semibold text-shadow-900">
      Effective chat model
    </h2>
    </div>
    {#if effectiveChat}
      <span class="garden-status garden-status--success rounded-full border border-moss-300 bg-moss-50 px-2.5 py-1 text-xs font-semibold text-moss-700">resolved</span>
    {/if}
  </div>

  {#if loading}
    <p class="garden-loading text-sm text-shadow-600">Loading effective model selection...</p>
  {:else if loadError}
    <p class="garden-error rounded-lg border border-wilt-200 bg-wilt-50 px-3 py-2 text-sm text-wilt-700">{loadError}</p>
  {:else if effectiveChat}
    <div class="garden-metric rounded-lg border border-moss-300 bg-moss-50 px-4 py-3">
      <p class="font-mono text-base font-medium text-moss-800 break-all">{effectiveChat.model}</p>
      <p class="mt-1 text-xs text-moss-700">
        {effectiveChat.provider}
        {#if effectiveChat.slotKey} · slot {effectiveChat.slotKey}{/if}
        · {effectiveChat.source === 'companion_selection' ? 'Companion selection' : 'Fleet default'}
      </p>
    </div>
  {:else}
    <p class="garden-error rounded-lg border border-wilt-200 bg-wilt-50 px-3 py-2 text-sm text-wilt-700">No effective chat model is currently resolvable.</p>
  {/if}

  {#if fleetDefault}
    <p class="text-sm text-shadow-600">
      Fleet catalog default (unchanged):
      <span class="font-mono text-shadow-800">{fleetDefault.model}</span>
      <span class="text-xs"> · {fleetDefault.provider} · slot {fleetDefault.slotKey}</span>
    </p>
  {/if}
  <p class="text-xs text-shadow-500">
    This read-only runtime view includes the companion's settings overlay. Editing the registry below still updates the fleet-wide models.json catalog.
  </p>
</section>
