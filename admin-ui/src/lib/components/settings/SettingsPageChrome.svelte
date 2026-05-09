<script lang="ts">
  export type SettingsViewMode = 'simple' | 'advanced' | 'raw';

  let {
    dirty,
    mode,
    saveMessage,
    saveOk,
    onModeChange,
  } = $props<{
    dirty: boolean;
    mode: SettingsViewMode;
    saveMessage: string;
    saveOk: boolean;
    onModeChange: (mode: SettingsViewMode) => void;
  }>();

  const MODES: readonly SettingsViewMode[] = ['simple', 'advanced', 'raw'];
</script>

<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
  <div class="flex items-center gap-3">
    <div>
      <h1 class="text-2xl font-serif font-bold text-bark-900">The Climate</h1>
      <p class="text-sm text-bark-700 mt-1">Runtime configuration and tuning</p>
    </div>
    {#if dirty}
      <span class="px-2.5 py-1 rounded-full text-sm font-medium bg-gold-100 text-gold-700 border border-gold-300">
        Unsaved changes
      </span>
    {/if}
  </div>

  <div class="flex items-center gap-3">
    <div class="flex rounded-lg border border-bark-300 overflow-hidden">
      {#each MODES as option}
        <button
          onclick={() => onModeChange(option)}
          class="px-3 py-1.5 text-sm font-medium capitalize transition-colors
            {mode === option ? 'bg-gold-600 text-white' : 'bg-white text-shadow-700 hover:bg-bark-200'}"
        >
          {option}
        </button>
      {/each}
    </div>
  </div>
</div>

{#if saveMessage}
  <div class="px-4 py-2.5 rounded-lg text-sm font-medium
    {saveOk
      ? 'bg-moss-50 text-moss-700 border border-moss-300'
      : 'bg-wilt-50 text-wilt-600 border border-wilt-400'}">
    {saveMessage}
  </div>
{/if}
