<script lang="ts">
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';

  let {
    dirty,
    saveMessage,
    saveOk,
  } = $props<{
    dirty: boolean;
    saveMessage: string;
    saveOk: boolean;
  }>();
</script>

{#snippet settingsHeaderActions()}
  {#if dirty}
    <span class="px-2.5 py-1 rounded-full text-sm font-medium bg-gold-100 text-gold-700 border border-gold-300">
      Unsaved changes
    </span>
  {/if}
  <span class="rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm font-medium text-shadow-700">
    Section workspace
  </span>
{/snippet}

<GardenPageHeader
  title="Settings"
  description="Runtime configuration and tuning. Garden context: The Climate."
  actions={settingsHeaderActions}
/>

{#if saveMessage}
  <div class="px-4 py-2.5 rounded-lg text-sm font-medium
    {saveOk
      ? 'bg-moss-50 text-moss-700 border border-moss-300'
      : 'bg-wilt-50 text-wilt-600 border border-wilt-400'}">
    {saveMessage}
  </div>
{/if}
