<script lang="ts">
  import { scopeGardenPath } from '$lib/fleet/companion-scope';
  import { memorySharePercent } from './dashboard-view';

  let {
    memoryByType,
    total,
    avgSalience,
  } = $props<{
    memoryByType: Record<string, number>;
    total: number;
    avgSalience: number;
  }>();

  const memoryEntries = $derived(Object.entries(memoryByType) as Array<[string, number]>);

  function typeClasses(type: string): string {
    const classes: Record<string, string> = {
      episodic: 'bg-moss-500',
      semantic: 'bg-gold-500',
      emotional: 'bg-petal-400',
      procedural: 'bg-shadow-500',
      reflection: 'bg-shadow-400',
      relational: 'bg-petal-500',
      boundary: 'bg-wilt-400',
    };
    return classes[type] ?? 'bg-bark-500';
  }
</script>

<section id="memory" aria-labelledby="memory-breakdown-heading" class="card-garden scroll-mt-4 p-4 sm:p-5">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h2 id="memory-breakdown-heading" class="font-serif text-lg text-shadow-900">Memory breakdown</h2>
      <p class="mt-1 text-xs text-shadow-600">
        {total.toLocaleString()} memories · average salience {(avgSalience * 100).toFixed(0)}%
      </p>
    </div>
    <a href={scopeGardenPath('/memory')} class="whitespace-nowrap text-xs font-medium text-gold-700 hover:text-gold-800">
      Open memory <span aria-hidden="true">→</span>
    </a>
  </div>

  {#if memoryEntries.length > 0}
    <ul class="mt-4 space-y-2.5">
      {#each memoryEntries as [type, count] (type)}
        {@const percent = memorySharePercent(count, total)}
        <li>
          <a
            href={scopeGardenPath(`/memory?type=${encodeURIComponent(type)}`)}
            class="group grid min-h-8 grid-cols-[5.5rem_minmax(0,1fr)_3rem] items-center gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-bark-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500 sm:grid-cols-[6rem_minmax(0,1fr)_3.25rem_2.75rem]"
          >
            <span class="truncate font-mono text-xs text-shadow-800" title={type}>{type}</span>
            <span class="h-2 overflow-hidden rounded-full bg-bark-200">
              <span
                class="block h-full rounded-full transition-[width] duration-500 {typeClasses(type)}"
                style={`width: ${percent}%`}
              ></span>
            </span>
            <span class="text-right text-xs font-medium tabular-nums text-shadow-800">{count.toLocaleString()}</span>
            <span class="hidden text-right text-xs tabular-nums text-shadow-500 sm:block">{percent.toFixed(0)}%</span>
          </a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-4 rounded-lg border border-dashed border-bark-300 px-4 py-6 text-center text-sm text-shadow-600">
      No memory type breakdown is available yet.
    </p>
  {/if}
</section>
