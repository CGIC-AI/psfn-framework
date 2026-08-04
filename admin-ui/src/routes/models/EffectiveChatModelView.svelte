<script lang="ts">
  import type { EffectiveModelSelectionView } from '$lib/types';

  let { effectiveChat, fleetDefault, loading, loadError } = $props<{
    effectiveChat: EffectiveModelSelectionView | null;
    fleetDefault: EffectiveModelSelectionView | null;
    loading: boolean;
    loadError: string;
  }>();
</script>

<section class="card-garden p-4 space-y-3" aria-labelledby="effective-chat-model-heading">
  <div>
    <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Runtime truth</p>
    <h2 id="effective-chat-model-heading" class="text-sm font-serif font-semibold text-shadow-800">
      Effective chat model
    </h2>
  </div>

  {#if loading}
    <p class="text-sm text-shadow-600">Loading effective model selection...</p>
  {:else if loadError}
    <p class="text-sm text-wilt-700">{loadError}</p>
  {:else if effectiveChat}
    <div class="rounded-lg border border-moss-300 bg-moss-50 px-3 py-2">
      <p class="font-mono text-sm text-moss-800 break-all">{effectiveChat.model}</p>
      <p class="mt-1 text-xs text-moss-700">
        {effectiveChat.provider}
        {#if effectiveChat.slotKey} · slot {effectiveChat.slotKey}{/if}
        · {effectiveChat.source === 'companion_selection' ? 'Companion selection' : 'Fleet default'}
      </p>
    </div>
  {:else}
    <p class="text-sm text-wilt-700">No effective chat model is currently resolvable.</p>
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
