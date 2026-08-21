<script lang="ts">
  import { onMount } from 'svelte';
  import type { DashboardCostWindow } from '$lib/types';
  import type { DashboardCostWindowOption } from '$lib/dashboard/cost-window';
  import {
    DASHBOARD_SECTIONS,
    resolveDashboardSection,
    type DashboardSectionId,
  } from './dashboard-view';

  let {
    options,
    selectedWindow,
    loading = false,
    controlsDisabled = false,
    freshnessState,
    refreshedAt,
    freshnessMessage,
    refreshError = '',
    onSelectWindow,
  } = $props<{
    options: readonly DashboardCostWindowOption[];
    selectedWindow: DashboardCostWindow;
    loading?: boolean;
    controlsDisabled?: boolean;
    freshnessState: 'loading' | 'fresh' | 'stale' | 'unavailable';
    refreshedAt: string;
    freshnessMessage?: string;
    refreshError?: string;
    onSelectWindow: (window: DashboardCostWindow) => void;
  }>();

  let activeSection = $state<DashboardSectionId>('overview');

  onMount(() => {
    const syncActiveSection = () => {
      activeSection = resolveDashboardSection(window.location.hash);
    };
    syncActiveSection();
    window.addEventListener('hashchange', syncActiveSection);
    return () => window.removeEventListener('hashchange', syncActiveSection);
  });
</script>

<header class="rounded-xl border border-bark-300 bg-bark-50/95 shadow-sm backdrop-blur">
  <div class="flex flex-col gap-4 px-4 pt-4 sm:px-5 lg:flex-row lg:items-start">
    <div class="min-w-0">
      <p class="text-[11px] font-semibold uppercase tracking-[0.14em] text-shadow-500">
        Garden · Live operations
      </p>
      <h1 class="mt-0.5 font-serif text-2xl font-semibold leading-tight text-shadow-900">The Trunk</h1>
      <p class="mt-1 text-sm text-shadow-600">Live companion health, memory, cost, and runtime activity.</p>
    </div>

    <div class="flex flex-col gap-2 lg:ml-auto lg:items-end">
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium {freshnessState === 'fresh'
            ? 'border-moss-300 bg-moss-50 text-moss-700'
            : freshnessState === 'loading'
              ? 'border-gold-300 bg-gold-50 text-gold-800'
              : 'border-wilt-300 bg-wilt-50 text-wilt-700'}"
          title={freshnessMessage ?? `Durable model usage is ${freshnessState}`}
        >
          <span
            class="h-1.5 w-1.5 rounded-full {freshnessState === 'fresh' ? 'bg-moss-500' : freshnessState === 'loading' ? 'bg-gold-500' : 'bg-wilt-500'} {loading ? 'animate-pulse' : ''}"
            aria-hidden="true"
          ></span>
          {freshnessState === 'loading' ? 'Loading data' : loading ? 'Refreshing' : freshnessState === 'fresh' ? 'Live data' : freshnessState}
          <span class="font-normal opacity-80">· {refreshedAt}</span>
        </span>

        <div
          class="flex min-h-9 max-w-full items-center overflow-x-auto rounded-lg border border-bark-300 bg-bark-100 p-0.5"
          aria-label="Model usage range"
        >
          {#each options as option (option.value)}
            <button
              type="button"
              class="min-h-8 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500 disabled:cursor-not-allowed disabled:opacity-60 {option.value === selectedWindow
                ? 'bg-gold-200 text-shadow-900 shadow-sm'
                : 'text-shadow-600 hover:bg-bark-200 hover:text-shadow-900'}"
              aria-pressed={option.value === selectedWindow}
              disabled={controlsDisabled}
              onclick={() => onSelectWindow(option.value)}
            >
              {option.label}
            </button>
          {/each}
        </div>
      </div>

      {#if freshnessMessage || refreshError}
        <p class="max-w-2xl text-xs text-wilt-700" role={refreshError ? 'alert' : undefined}>
          {refreshError || freshnessMessage}
        </p>
      {/if}
    </div>
  </div>

  <nav aria-label="Dashboard sections" class="mt-3 flex gap-1 overflow-x-auto border-t border-bark-200 px-3 sm:px-4">
    {#each DASHBOARD_SECTIONS as tab (tab.id)}
      <a
        href={tab.href}
        aria-current={activeSection === tab.id ? 'location' : undefined}
        class="relative min-h-11 whitespace-nowrap px-3 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-500 {activeSection === tab.id
          ? 'font-medium text-shadow-900 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-gold-500'
          : 'text-shadow-600 hover:text-shadow-900'}"
        onclick={() => (activeSection = tab.id)}
      >
        {tab.label}
      </a>
    {/each}
  </nav>
</header>
