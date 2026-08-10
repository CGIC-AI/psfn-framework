<script lang="ts">
  import {
    FLEET_VIEW_DESTINATIONS,
    fleetViewHref,
    type FleetView,
  } from '$lib/fleet/fleet-views';
  import FleetViewIcon from './FleetViewIcon.svelte';

  interface Props {
    activeView: FleetView;
    onLogout: () => void | Promise<void>;
    mobileOpen?: boolean;
  }

  let {
    activeView,
    onLogout,
    mobileOpen = $bindable(false),
  }: Props = $props();

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && mobileOpen) {
      event.preventDefault();
      mobileOpen = false;
    }
  }

  function handleNavigation(): void {
    mobileOpen = false;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="relative z-40 shrink-0">
  {#if mobileOpen}
    <button
      type="button"
      class="fixed inset-0 z-40 bg-shadow-950/25 backdrop-blur-[1px] lg:hidden"
      aria-label="Close cluster navigation"
      onclick={() => mobileOpen = false}
    ></button>
  {/if}

  <nav
    aria-label="Cluster sections"
    class="hidden h-screen w-16 flex-col items-center gap-1.5 border-r border-bark-300 bg-bark-50 py-4 lg:flex"
  >
    {#each FLEET_VIEW_DESTINATIONS as destination (destination.id)}
      {@const isActive = activeView === destination.id}
      <a
        href={fleetViewHref(destination.id)}
        aria-current={isActive ? 'page' : undefined}
        aria-label={destination.label}
        class="group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500 {destination.id === 'info'
          ? isActive
            ? 'border border-shadow-800 bg-shadow-800 text-bark-50'
            : 'border border-bark-300 text-shadow-400 hover:border-shadow-800/40 hover:text-shadow-800'
          : isActive
            ? 'bg-gold-50 text-gold-700'
            : 'text-shadow-400 hover:bg-bark-100 hover:text-shadow-800'}"
      >
        <FleetViewIcon viewId={destination.id} />
        {#if isActive && destination.id !== 'info'}
          <span class="absolute -left-[13px] h-5 w-[3px] rounded-r-full bg-gold-500"></span>
        {/if}
        <span class="rail-tip">{destination.label}</span>
      </a>
    {/each}

    <button
      type="button"
      aria-label="Sign out"
      onclick={() => void onLogout()}
      class="group relative mt-auto flex h-10 w-10 items-center justify-center rounded-xl text-shadow-400 transition-colors hover:bg-wilt-50 hover:text-wilt-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
        <path d="M10 17l5-5-5-5m5 5H3" />
        <path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
      </svg>
      <span class="rail-tip">Sign out</span>
    </button>
  </nav>

  <aside
    aria-label="Cluster navigation"
    class="fixed inset-y-0 left-0 z-50 flex w-[min(22rem,88vw)] flex-col border-r border-bark-300 bg-bark-50 shadow-2xl transition-transform duration-200 lg:hidden {mobileOpen ? 'translate-x-0' : '-translate-x-full'}"
  >
    <div class="flex items-start gap-3 border-b border-bark-300 p-4">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-shadow-800 bg-shadow-800 text-bark-50">
        <FleetViewIcon viewId="info" />
      </div>
      <div class="min-w-0 flex-1">
        <h1 class="truncate font-serif text-lg font-semibold text-shadow-900">Garden Cluster</h1>
        <p class="text-xs text-shadow-500">All companions · no companion selected</p>
      </div>
      <button
        type="button"
        aria-label="Close navigation"
        onclick={() => mobileOpen = false}
        class="rounded-lg p-2 text-shadow-500 hover:bg-bark-100 hover:text-shadow-900"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>

    <nav class="flex-1 overflow-y-auto p-3" aria-label="Cluster surfaces">
      <ul class="space-y-0.5">
        {#each FLEET_VIEW_DESTINATIONS as destination (destination.id)}
          {@const isActive = activeView === destination.id}
          <li>
            <a
              href={fleetViewHref(destination.id)}
              aria-current={isActive ? 'page' : undefined}
              onclick={handleNavigation}
              class="flex items-center gap-2.5 rounded-lg px-2 py-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500 {isActive ? 'bg-gold-50' : 'hover:bg-bark-100'}"
            >
              <span class="text-shadow-400" aria-hidden="true"><FleetViewIcon viewId={destination.id} /></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm {isActive ? 'font-semibold text-gold-700' : 'font-medium text-shadow-800'}">{destination.label}</span>
                <span class="block truncate font-serif text-xs text-shadow-500">{destination.description}</span>
              </span>
            </a>
          </li>
        {/each}
      </ul>
    </nav>

    <div class="border-t border-bark-300 p-3">
      <button
        type="button"
        onclick={() => void onLogout()}
        class="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-shadow-500 hover:bg-wilt-50 hover:text-wilt-700"
      >
        Sign out
      </button>
    </div>
  </aside>
</div>
