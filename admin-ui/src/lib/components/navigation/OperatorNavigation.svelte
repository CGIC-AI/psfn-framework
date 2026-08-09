<script lang="ts">
  import { tick } from 'svelte';
  import type { FleetPortalProjection } from '$lib/fleet/portal';
  import {
    filterConsoleNavigation,
    resolveActiveNavigationGroup,
    type ConsoleNavigationGroup,
  } from '$lib/nav/presentation';
  import RailGroupIcon from './RailGroupIcon.svelte';

  interface Props {
    groups: ConsoleNavigationGroup[];
    appTitle: string;
    sidebarSubtitle: string;
    companionName: string;
    activeCompanionId: string | null;
    fleetProjection: FleetPortalProjection | null;
    fleetProjectionError: string;
    onSwitchCompanion: (event: Event) => void;
    onLogout: () => void | Promise<void>;
    mobileOpen?: boolean;
  }

  let {
    groups,
    appTitle,
    sidebarSubtitle,
    companionName,
    activeCompanionId,
    fleetProjection,
    fleetProjectionError,
    onSwitchCompanion,
    onLogout,
    mobileOpen = $bindable(false),
  }: Props = $props();

  let navigationRoot = $state<HTMLDivElement | null>(null);
  let commandInput = $state<HTMLInputElement | null>(null);
  let openPanel = $state<string | null>(null);
  let commandOpen = $state(false);
  let commandQuery = $state('');

  const activeGroupId = $derived(resolveActiveNavigationGroup(groups));
  const activeCompanion = $derived(
    fleetProjection?.companions.find(companion => companion.companionId === activeCompanionId),
  );
  const visibleCommandGroups = $derived(filterConsoleNavigation(groups, commandQuery));
  const activePanel = $derived(groups.find(group => group.id === openPanel) ?? null);

  async function openCommandPalette(): Promise<void> {
    commandOpen = true;
    commandQuery = '';
    openPanel = null;
    await tick();
    commandInput?.focus();
  }

  function closeTransientNavigation(): void {
    openPanel = null;
    commandOpen = false;
    mobileOpen = false;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      void openCommandPalette();
      return;
    }
    if (event.key === 'Escape' && (openPanel || commandOpen || mobileOpen)) {
      event.preventDefault();
      closeTransientNavigation();
    }
  }

  function handleWindowClick(event: MouseEvent): void {
    if (!openPanel || !(event.target instanceof Node)) return;
    if (!navigationRoot?.contains(event.target)) openPanel = null;
  }

  function handleNavigation(): void {
    openPanel = null;
    mobileOpen = false;
    commandOpen = false;
  }

  function companionStateLabel(): string {
    if (!activeCompanion) return 'status unknown';
    const health = activeCompanion.health;
    if (health.agentRpc === 'down' || health.adminTransport === 'down') return 'needs attention';
    if (health.agentRpc === 'up' && health.adminTransport === 'up') return 'online';
    return 'partially available';
  }
</script>

<svelte:window onkeydown={handleKeydown} onclick={handleWindowClick} />

<div bind:this={navigationRoot} class="relative z-40 shrink-0">
  {#if mobileOpen}
    <button
      type="button"
      class="fixed inset-0 z-40 bg-shadow-950/25 backdrop-blur-[1px] lg:hidden"
      aria-label="Close operator navigation"
      onclick={() => mobileOpen = false}
    ></button>
  {/if}

  <aside class="hidden h-screen w-16 flex-col items-center border-r border-bark-300 bg-bark-50 py-4 lg:flex">
    <a
      href="/fleet"
      aria-label="Cluster overview — all companions"
      class="group relative flex h-10 w-10 items-center justify-center rounded-xl border border-shadow-800 bg-shadow-800 text-bark-50 transition-colors hover:bg-shadow-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <circle cx="5" cy="5" r="2" />
        <circle cx="19" cy="5" r="2" />
        <circle cx="12" cy="20" r="2" />
        <path d="m7 6 3 4m7-4-3 4m-1 5-.5 3" />
      </svg>
      <span class="rail-tip">Cluster · all companions</span>
    </a>

    <span class="my-2 h-px w-6 bg-gradient-to-r from-transparent via-gold-300 to-transparent"></span>

    <button
      type="button"
      aria-expanded={openPanel === 'scope'}
      aria-label={`Active companion: ${companionName}`}
      onclick={() => openPanel = openPanel === 'scope' ? null : 'scope'}
      class="group relative flex h-10 w-10 items-center justify-center rounded-xl border border-gold-300 bg-gold-50 font-serif text-base font-semibold text-gold-700 transition-colors hover:border-gold-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
    >
      {companionName.slice(0, 1).toUpperCase()}
      <span
        class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bark-50 {companionStateLabel() === 'online' ? 'bg-moss-500' : companionStateLabel() === 'needs attention' ? 'bg-wilt-500' : 'bg-gold-500'}"
        aria-hidden="true"
      ></span>
      <span class="rail-tip">{companionName} · {companionStateLabel()}</span>
    </button>

    <span class="my-2 h-px w-6 bg-gradient-to-r from-transparent via-gold-300 to-transparent"></span>

    <button
      type="button"
      aria-label="Search all sections"
      onclick={() => void openCommandPalette()}
      class="group relative mb-1 flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-bark-300 text-shadow-400 transition-colors hover:border-gold-300 hover:text-gold-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </svg>
      <span class="rail-tip">Search · ⌘K</span>
    </button>

    {#each groups as group (group.id)}
      <button
        type="button"
        aria-label={group.label}
        aria-expanded={openPanel === group.id}
        aria-current={activeGroupId === group.id ? 'page' : undefined}
        onclick={() => openPanel = openPanel === group.id ? null : group.id}
        onmouseenter={() => { if (activePanel) openPanel = group.id; }}
        class="group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500 {activeGroupId === group.id || openPanel === group.id ? 'bg-gold-50 text-gold-700' : 'text-shadow-400 hover:bg-bark-100 hover:text-shadow-800'}"
      >
        <RailGroupIcon groupId={group.id} />
        {#if activeGroupId === group.id}
          <span class="absolute -left-[13px] h-5 w-[3px] rounded-r-full bg-gold-500"></span>
        {/if}
        {#if group.attention > 0}
          <span class="absolute -right-1 -top-1 min-w-4 rounded-full border border-bark-50 bg-wilt-500 px-1 text-[0.55rem] font-bold leading-4 text-white tabular-nums">
            {group.attention > 99 ? '99+' : group.attention}
          </span>
        {/if}
        <span class="rail-tip">{group.label}</span>
      </button>
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
  </aside>

  {#if openPanel && !commandOpen}
    <section class="fixed bottom-0 left-16 top-0 hidden w-72 overflow-y-auto border-r border-bark-300 bg-bark-50 p-3 shadow-xl lg:block">
      {#if openPanel === 'scope'}
        <div class="px-1 pb-3">
          <p class="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-shadow-400">Active scope</p>
          <h2 class="mt-1 font-serif text-lg text-shadow-900">{companionName}</h2>
          <p class="text-xs text-shadow-500">{companionStateLabel()}</p>
        </div>
        <label for="rail-companion-switcher" class="mb-1 block px-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-shadow-400">
          Companion
        </label>
        <select
          id="rail-companion-switcher"
          value={activeCompanionId ?? ''}
          onchange={onSwitchCompanion}
          disabled={!fleetProjection}
          class="h-10 w-full rounded-lg border border-bark-300 bg-bark-100 px-3 text-sm text-shadow-800 focus:border-gold-400 focus:outline-none focus:ring-2 focus:ring-gold-100"
        >
          {#if fleetProjection}
            {#each fleetProjection.companions.filter(companion => companion.gardenPath) as companion (companion.companionId)}
              <option value={companion.companionId}>{companion.displayName}</option>
            {/each}
          {:else}
            <option value={activeCompanionId ?? ''}>{companionName}</option>
          {/if}
        </select>
        <a href="/fleet" class="mt-3 flex items-center justify-between rounded-lg border border-gold-300 bg-gold-50 px-3 py-2.5 text-sm font-semibold text-gold-800 hover:border-gold-500 hover:bg-gold-100">
          <span>Cluster overview</span><span aria-hidden="true">→</span>
        </a>
        {#if fleetProjectionError}
          <p class="mt-2 rounded-lg border border-wilt-200 bg-wilt-50 px-3 py-2 text-xs text-wilt-700">{fleetProjectionError}</p>
        {/if}
      {:else if activePanel}
        <div class="flex items-baseline justify-between px-1 pb-2">
          <div>
            <p class="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-shadow-400">{appTitle}</p>
            <h2 class="mt-1 font-serif text-lg text-shadow-900">{activePanel.label}</h2>
          </div>
          <span class="text-[0.68rem] text-shadow-400 tabular-nums">{activePanel.items.length}</span>
        </div>
        <span class="mb-2 block h-px bg-gradient-to-r from-gold-300/70 via-bark-300 to-transparent"></span>
        <ul class="space-y-0.5">
          {#each activePanel.items as item (item.id)}
            <li>
              <a
                href={item.href}
                aria-current={item.active ? 'page' : undefined}
                onclick={handleNavigation}
                class="flex items-center gap-2.5 rounded-lg px-2 py-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-500 {item.active ? 'bg-gold-50' : 'hover:bg-bark-100'}"
              >
                <span class="text-base leading-none" aria-hidden="true">{item.icon}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm {item.active ? 'font-semibold text-gold-700' : 'font-medium text-shadow-800'}">{item.primaryLabel}</span>
                  {#if item.secondaryLabel}
                    <span class="block truncate font-serif text-xs text-shadow-500">{item.secondaryLabel}</span>
                  {/if}
                </span>
                {#if item.attention > 0}
                  <span class="rounded-full bg-wilt-500 px-1.5 py-0.5 text-[0.62rem] font-bold text-white tabular-nums">{item.attention}</span>
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <aside
    aria-label="Garden navigation"
    class="fixed inset-y-0 left-0 z-50 flex w-[min(22rem,88vw)] flex-col border-r border-bark-300 bg-bark-50 shadow-2xl transition-transform duration-200 lg:hidden {mobileOpen ? 'translate-x-0' : '-translate-x-full'}"
  >
    <div class="flex items-start gap-3 border-b border-bark-300 p-4">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gold-300 bg-gold-50 font-serif font-semibold text-gold-700">
        {companionName.slice(0, 1).toUpperCase()}
      </div>
      <div class="min-w-0 flex-1">
        <h1 class="truncate font-serif text-lg font-semibold text-shadow-900">{appTitle}</h1>
        <p class="text-xs text-shadow-500">{sidebarSubtitle}</p>
      </div>
      <button type="button" aria-label="Close navigation" onclick={() => mobileOpen = false} class="rounded-lg p-2 text-shadow-500 hover:bg-bark-100 hover:text-shadow-900">
        <span aria-hidden="true">×</span>
      </button>
    </div>

    <button type="button" onclick={() => void openCommandPalette()} class="mx-3 mt-3 flex h-10 items-center gap-2 rounded-lg border border-bark-300 bg-bark-100 px-3 text-sm text-shadow-500">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
      <span>Search the garden…</span>
    </button>

    <nav class="flex-1 overflow-y-auto p-3">
      <a href="/fleet" class="mb-3 flex items-center justify-between rounded-lg border border-shadow-800 bg-shadow-800 px-3 py-2.5 text-sm font-semibold text-bark-50">
        <span>Cluster overview</span><span aria-hidden="true">→</span>
      </a>
      {#each groups as group (group.id)}
        <section class="mb-4">
          <h2 class="mb-1 flex items-center justify-between px-2 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-shadow-400">
            <span>{group.label}</span>
            {#if group.attention > 0}<span class="rounded-full bg-wilt-500 px-1.5 text-[0.6rem] leading-4 text-white">{group.attention}</span>{/if}
          </h2>
          <ul class="space-y-0.5">
            {#each group.items as item (item.id)}
              <li>
                <a href={item.href} onclick={handleNavigation} aria-current={item.active ? 'page' : undefined} class="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm {item.active ? 'bg-gold-50 font-semibold text-gold-700' : 'text-shadow-800 hover:bg-bark-100'}">
                  <span aria-hidden="true">{item.icon}</span><span class="min-w-0 flex-1 truncate">{item.primaryLabel}</span>
                  {#if item.attention > 0}<span class="rounded-full bg-wilt-500 px-1.5 text-[0.62rem] text-white">{item.attention}</span>{/if}
                </a>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </nav>

    <div class="border-t border-bark-300 p-3">
      <button type="button" onclick={() => void onLogout()} class="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-shadow-500 hover:bg-wilt-50 hover:text-wilt-700">Sign out</button>
    </div>
  </aside>
</div>

{#if commandOpen}
  <div class="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[10vh]">
    <button type="button" class="absolute inset-0 bg-shadow-950/35 backdrop-blur-[2px]" aria-label="Close search" onclick={() => commandOpen = false}></button>
    <div class="relative flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-bark-300 bg-bark-50 shadow-2xl" role="dialog" aria-modal="true" aria-label="Search the garden">
      <label class="flex items-center gap-3 border-b border-bark-300 px-4 py-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" class="shrink-0 text-shadow-400" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
        <span class="sr-only">Search destinations</span>
        <input bind:this={commandInput} bind:value={commandQuery} placeholder="Search sections, pages, or garden names…" class="min-w-0 flex-1 bg-transparent text-base text-shadow-900 outline-none placeholder:text-shadow-400" />
        <kbd class="rounded border border-bark-300 bg-bark-100 px-1.5 py-0.5 font-mono text-[0.65rem] text-shadow-500">Esc</kbd>
      </label>
      <div class="overflow-y-auto p-2">
        {#if visibleCommandGroups.length === 0}
          <p class="px-4 py-10 text-center text-sm text-shadow-500">No garden destination matches “{commandQuery}”.</p>
        {:else}
          {#each visibleCommandGroups as group (group.id)}
            <div class="mb-2">
              <p class="px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-shadow-400">{group.label}</p>
              {#each group.items as item (item.id)}
                <a href={item.href} onclick={handleNavigation} class="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-gold-50 focus:bg-gold-50 focus:outline-none">
                  <span class="text-base" aria-hidden="true">{item.icon}</span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium text-shadow-900">{item.primaryLabel}</span>
                    {#if item.secondaryLabel}<span class="block text-xs text-shadow-500">{item.secondaryLabel}</span>{/if}
                  </span>
                  {#if item.attention > 0}<span class="rounded-full bg-wilt-500 px-1.5 py-0.5 text-[0.62rem] font-bold text-white">{item.attention}</span>{/if}
                </a>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  :global(.rail-tip) {
    pointer-events: none;
    position: absolute;
    left: 3rem;
    z-index: 80;
    display: none;
    white-space: nowrap;
    border-radius: 0.375rem;
    background: var(--color-shadow-900);
    padding: 0.3rem 0.5rem;
    color: var(--color-bark-50);
    font-size: 0.72rem;
    line-height: 1rem;
    box-shadow: 0 8px 20px rgba(38, 35, 30, 0.16);
  }

  :global(.group:hover > .rail-tip) {
    display: block;
  }
</style>
