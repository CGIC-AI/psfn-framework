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

  let tabRefs = $state<Record<string, HTMLButtonElement | null>>({});

  // Roving tabindex: the active tab is Tab-focusable; if the active tab is
  // disabled (or missing), fall back to the first enabled tab so the tablist
  // always remains reachable from the keyboard.
  const focusableId = $derived.by(() => {
    const active = tabs.find((tab: GardenTabItem) => tab.id === activeId && !tab.disabled);
    if (active) return active.id;
    return tabs.find((tab: GardenTabItem) => !tab.disabled)?.id ?? null;
  });

  function enabledIndexOffset(direction: 1 | -1, fromIndex: number): number {
    const count = tabs.length;
    if (count === 0) return -1;
    for (let step = 1; step <= count; step += 1) {
      const candidate = (fromIndex + direction * step + count * step) % count;
      if (!tabs[candidate].disabled) return candidate;
    }
    return -1;
  }

  function firstEnabledIndex(): number {
    return tabs.findIndex((tab: GardenTabItem) => !tab.disabled);
  }

  function lastEnabledIndex(): number {
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      if (!tabs[index].disabled) return index;
    }
    return -1;
  }

  function activateTab(index: number): void {
    if (index < 0 || index >= tabs.length) return;
    const tab = tabs[index];
    if (tab.disabled) return;
    onSelect(tab.id);
    const node = tabRefs[tab.id];
    if (node) node.focus();
  }

  function onTabKeydown(event: KeyboardEvent, index: number): void {
    const { key } = event;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    if (key === 'ArrowRight') {
      activateTab(enabledIndexOffset(1, index));
    } else if (key === 'ArrowLeft') {
      activateTab(enabledIndexOffset(-1, index));
    } else if (key === 'Home') {
      activateTab(firstEnabledIndex());
    } else {
      activateTab(lastEnabledIndex());
    }
  }
</script>

<div class={`overflow-x-auto ${className}`.trim()}>
  <div class="flex min-w-max gap-1 border-b border-bark-300" role="tablist" aria-label={label}>
    {#each tabs as tab, index (tab.id)}
      <button
        bind:this={tabRefs[tab.id]}
        type="button"
        role="tab"
        aria-selected={activeId === tab.id}
        tabindex={focusableId === tab.id ? 0 : -1}
        disabled={tab.disabled}
        onclick={() => onSelect(tab.id)}
        onkeydown={(event) => onTabKeydown(event, index)}
        class="relative min-h-11 border-0 bg-transparent px-3 pb-2.5 pt-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60
          {activeId === tab.id
            ? 'font-semibold text-shadow-900 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-gold-500'
            : 'font-medium text-shadow-600 hover:text-shadow-900'}"
      >
        {tab.label}
        {#if tab.count != null}
          <span class="ml-1 rounded-full px-1.5 py-0.5 text-[0.65rem] tabular-nums {activeId === tab.id ? 'bg-gold-100 text-gold-700' : 'bg-bark-200 text-shadow-600'}">{tab.count}</span>
        {/if}
      </button>
    {/each}
  </div>
</div>
