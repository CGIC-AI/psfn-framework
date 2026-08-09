<script lang="ts">
  import type { AdminDashboardData } from '$lib/types';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';
  import {
    countDashboardTools,
    filterDashboardTools,
    type DashboardToolFilter,
  } from './dashboard-view';

  let { tools } = $props<{ tools: AdminDashboardData['stats']['toolStatus'] }>();
  let filter = $state<DashboardToolFilter>('issues');
  let query = $state('');

  const counts = $derived(countDashboardTools(tools));
  const visibleTools = $derived(filterDashboardTools(tools, filter, query));

  function statusClasses(status: string): string {
    const classes: Record<string, string> = {
      healthy: 'border-bark-300 bg-bark-50 text-shadow-700',
      degraded: 'border-gold-300 bg-gold-50 text-gold-800',
      unavailable: 'border-wilt-300 bg-wilt-50 text-wilt-800',
      not_applicable: 'border-dashed border-bark-300 bg-bark-100 text-shadow-600',
    };
    return classes[status] ?? classes.not_applicable;
  }

  function dotClasses(status: string): string {
    const classes: Record<string, string> = {
      healthy: 'bg-moss-500',
      degraded: 'bg-gold-500',
      unavailable: 'bg-wilt-500',
      not_applicable: 'bg-bark-400',
    };
    return classes[status] ?? classes.not_applicable;
  }

  function statusLabel(status: string): string {
    return status === 'not_applicable' ? 'n/a' : status;
  }
</script>

<section id="health" aria-labelledby="tool-status-heading" class="card-garden scroll-mt-4 p-4 sm:p-5">
  <div class="flex flex-col gap-3 xl:flex-row xl:items-center">
    <div>
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="tool-status-heading" class="font-serif text-lg text-shadow-900">Tool status</h2>
        <p class="text-xs text-shadow-600">
          <span class="font-medium text-moss-700">{counts.healthy} healthy</span> ·
          <span class="font-medium text-gold-700">{counts.degraded} degraded</span> ·
          <span class="font-medium text-wilt-700">{counts.unavailable} down</span> ·
          {counts.notApplicable} n/a
        </p>
      </div>
      <p class="mt-1 text-xs text-shadow-500">Current registry health from the live dashboard snapshot.</p>
    </div>

    <div class="flex flex-wrap items-center gap-2 xl:ml-auto">
      <label class="relative min-w-40 flex-1 sm:flex-none">
        <span class="sr-only">Filter tools</span>
        <svg class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-shadow-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>
        </svg>
        <input
          bind:value={query}
          type="search"
          placeholder="Filter tools"
          class="h-9 w-full rounded-lg border border-bark-300 bg-bark-100 pl-8 pr-3 text-xs text-shadow-900 placeholder:text-shadow-500 focus:border-gold-400 focus:outline-none focus:ring-2 focus:ring-gold-200 sm:w-40"
        />
      </label>
      <div class="flex min-h-9 items-center rounded-lg border border-bark-300 bg-bark-100 p-0.5">
        <button
          type="button"
          class="min-h-8 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500 {filter === 'issues' ? 'bg-gold-200 text-shadow-900' : 'text-shadow-600 hover:text-shadow-900'}"
          aria-pressed={filter === 'issues'}
          onclick={() => (filter = 'issues')}
        >Issues first</button>
        <button
          type="button"
          class="min-h-8 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500 {filter === 'all' ? 'bg-gold-200 text-shadow-900' : 'text-shadow-600 hover:text-shadow-900'}"
          aria-pressed={filter === 'all'}
          onclick={() => (filter = 'all')}
        >All tools</button>
      </div>
      <a href={scopeGardenPath('/tools')} class="inline-flex min-h-9 items-center px-1 text-xs font-medium text-gold-700 hover:text-gold-800">
        Open tools <span class="ml-1" aria-hidden="true">→</span>
      </a>
    </div>
  </div>

  {#if visibleTools.length > 0}
    <ul class="mt-4 flex flex-wrap gap-1.5">
      {#each visibleTools as tool (tool.name)}
        <li>
          <span
            class="inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-xs {statusClasses(tool.status)}"
            title={tool.detail ?? `${tool.name}: ${statusLabel(tool.status)}`}
          >
            <span class="h-1.5 w-1.5 rounded-full {dotClasses(tool.status)}" aria-hidden="true"></span>
            <span class="text-shadow-900">{tool.name}</span>
            {#if tool.status !== 'healthy'}
              <span>{statusLabel(tool.status)}</span>
            {/if}
            {#if tool.detail && tool.status !== 'healthy'}
              <span class="hidden text-shadow-500 sm:inline">· {tool.detail}</span>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-4 rounded-lg border border-dashed border-bark-300 bg-bark-50 px-4 py-6 text-center text-sm text-shadow-600">
      {filter === 'issues' && !query.trim()
        ? 'Every tool is reporting healthy right now.'
        : `No tool matches “${query.trim()}”.`}
    </p>
  {/if}
</section>
