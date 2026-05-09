<script lang="ts">
  export interface GardenSectionNavItem {
    id: string;
    title: string;
    description?: string;
  }

  export interface GardenSectionNavGroup {
    id: string;
    label: string;
    items: GardenSectionNavItem[];
  }

  let {
    groups,
    activeId,
    onNavigate,
    label = 'Page sections',
    class: className = '',
  } = $props<{
    groups: GardenSectionNavGroup[];
    activeId: string | null;
    onNavigate: (id: string) => void;
    label?: string;
    class?: string;
  }>();
</script>

<nav class={`card-garden p-3 space-y-4 ${className}`.trim()} aria-label={label}>
  {#each groups as group (group.id)}
    <section>
      <h2 class="px-2 text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">{group.label}</h2>
      <div class="mt-2 space-y-1">
        {#each group.items as item (item.id)}
          <button
            type="button"
            onclick={() => onNavigate(item.id)}
            aria-current={activeId === item.id ? 'location' : undefined}
            class="w-full rounded-lg px-3 py-2 text-left transition-colors
              {activeId === item.id
                ? 'bg-moss-100 text-moss-800'
                : 'text-shadow-700 hover:bg-bark-100 hover:text-shadow-900'}"
          >
            <span class="block text-sm font-medium">{item.title}</span>
            {#if item.description}
              <span class="mt-0.5 block text-xs text-shadow-500">{item.description}</span>
            {/if}
          </button>
        {/each}
      </div>
    </section>
  {/each}
</nav>
