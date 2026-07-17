<script lang="ts">
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import type { SaveFeedbackState } from '../../../routes/settings/settings-page-helpers';

  let {
    dirty,
    feedback,
    onDismiss,
  } = $props<{
    dirty: boolean;
    feedback: SaveFeedbackState | null;
    onDismiss: () => void;
  }>();

  // Persistent feedback (errors, and successes that skipped owner files) carries
  // a manual dismiss affordance; auto-dismissing successes do not.
  let persistent = $derived(feedback !== null && feedback.autoDismissMs === null);
</script>

{#snippet settingsHeaderActions()}
  {#if dirty}
    <span class="px-2.5 py-1 rounded-full text-sm font-medium bg-gold-100 text-gold-700 border border-gold-300">
      Unsaved changes
    </span>
  {/if}
{/snippet}

<GardenPageHeader
  title="Settings"
  description="Runtime configuration and tuning. Garden context: The Climate."
  actions={settingsHeaderActions}
/>

{#if feedback}
  <div class="flex items-start justify-between gap-3 px-4 py-2.5 rounded-lg text-sm font-medium
    {feedback.tone === 'success'
      ? 'bg-moss-50 text-moss-700 border border-moss-300'
      : 'bg-wilt-50 text-wilt-600 border border-wilt-400'}">
    <span class="min-w-0">{feedback.message}</span>
    {#if persistent}
      <button
        type="button"
        onclick={onDismiss}
        class="shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-gold-300"
      >
        Dismiss
      </button>
    {/if}
  </div>
{/if}
