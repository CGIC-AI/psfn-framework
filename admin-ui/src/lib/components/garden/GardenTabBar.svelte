<script lang="ts">
  export interface GardenTabItem {
    id: string;
    label: string;
    count?: number;
    disabled?: boolean;
  }

  let {
    tabs,
    activeId,
    onSelect,
    label = 'Page views',
    class: className = '',
  } = $props<{
    tabs: GardenTabItem[];
    activeId: string;
    onSelect: (id: string) => void;
    label?: string;
    class?: string;
  }>();
</script>

<div class={`overflow-x-auto ${className}`.trim()}>
  <div class="flex min-w-max gap-2" role="tablist" aria-label={label}>
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        role="tab"
        aria-selected={activeId === tab.id}
        disabled={tab.disabled}
        onclick={() => onSelect(tab.id)}
        class="rounded-t-xl border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60
          {activeId === tab.id
            ? 'border-gold-300 bg-white text-shadow-900 shadow-sm'
            : 'border-bark-300 bg-bark-50 text-shadow-600 hover:bg-white hover:text-shadow-900'}"
      >
        {tab.label}
        {#if tab.count != null}
          <span class="ml-1 text-xs opacity-75">({tab.count})</span>
        {/if}
      </button>
    {/each}
  </div>
</div>
