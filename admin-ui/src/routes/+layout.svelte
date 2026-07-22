<script lang="ts">
  import { onMount } from 'svelte';
  import '../app.css';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { navGroups } from '$lib/nav';
  import {
    ATTENTION_SOURCES,
    mergeAttentionPollResults,
    type AttentionCounts,
    updateAttentionCountsIfChanged,
  } from '$lib/nav/attention';
  import { resolveThemeMenuLabel, resolveThemeTemplate } from '$lib/theme/loader';
  import {
    getToken,
    isAuthenticated,
    isAuthResolved,
    ensureAuthResolved,
    clearToken,
  } from '$lib/stores/auth.svelte';
  import {
    ensureCompanionNameLoaded,
    getCompanionName,
  } from '$lib/stores/companion.svelte';
  import {
    ensureUiPreferencesLoaded,
    getActiveThemePack,
  } from '$lib/stores/ui-preferences.svelte';
  import { getToasts, removeToast } from '$lib/stores/toast.svelte';
  import { clearToasts } from '$lib/stores/toast.svelte';
  import {
    activateCompanionScopeFromPath,
    getCompanionCacheScope,
    isFleetOverviewPath,
    parseCompanionGardenScope,
    scopeGardenPath,
  } from '$lib/fleet/companion-scope';
  import {
    fetchFleetPortalProjection,
    type FleetPortalProjection,
  } from '$lib/fleet/portal';
  import { fleetCostNavigationPath } from '$lib/fleet/fleet-costs';

  let { children } = $props();

  let sidebarOpen = $state(true);
  let isDesktop = $state(true);
  let mobileNavOpen = $state(false);
  let fleetProjection = $state<FleetPortalProjection | null>(null);
  let fleetProjectionController: AbortController | null = null;
  let fleetProjectionError = $state('');
  const companionScope = $derived(parseCompanionGardenScope($page.url.pathname));
  const activeCompanionId = $derived(companionScope?.companionId ?? null);
  const companionName = $derived(getCompanionName());
  const activeTheme = $derived(getActiveThemePack());
  const sidebarTitle = $derived(resolveThemeTemplate(activeTheme.ui.sidebarTitleTemplate, { companionName }));
  const sidebarSubtitle = $derived(resolveThemeTemplate(activeTheme.ui.sidebarSubtitleTemplate, { companionName }));
  const appTitle = $derived(resolveThemeTemplate(activeTheme.ui.appTitleTemplate, { companionName }));

  // ── Collapsible nav groups (persisted per browser profile) ──
  let collapsedGroups = $state<Record<string, boolean>>(loadCollapsedGroups());

  function navGroupsStorageKey(): string {
    return `garden.nav.collapsedGroups:${getCompanionCacheScope()}`;
  }

  function loadCollapsedGroups(): Record<string, boolean> {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(navGroupsStorageKey());
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const out: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  function toggleNavGroup(groupId: string): void {
    collapsedGroups = { ...collapsedGroups, [groupId]: !collapsedGroups[groupId] };
    try {
      window.localStorage.setItem(navGroupsStorageKey(), JSON.stringify(collapsedGroups));
    } catch {
      // Storage unavailable (private mode, quota) — collapse still works for the session.
    }
  }

  // ── Human-in-the-loop attention badges (polled, fail-quiet) ──
  let attentionCounts = $state<AttentionCounts>({});
  let attentionPollGeneration = 0;

  async function refreshAttentionCounts(): Promise<void> {
    if (!isAuthenticated()) return;
    const requestGeneration = ++attentionPollGeneration;
    const requestCompanionId = activeCompanionId;
    const results = await Promise.all(
      ATTENTION_SOURCES.map(async (source) => {
        try {
          const count = await source.fetchCount();
          return { path: source.path, count };
        } catch {
          return { path: source.path };
        }
      }),
    );
    if (
      requestGeneration === attentionPollGeneration
      && requestCompanionId === activeCompanionId
    ) {
      const polledCounts = mergeAttentionPollResults(attentionCounts, results);
      updateAttentionCountsIfChanged(attentionCounts, polledCounts, (nextCounts) => {
        attentionCounts = nextCounts;
      });
    }
  }

  async function refreshFleetProjection(): Promise<void> {
    if (!activeCompanionId) return;
    fleetProjectionController?.abort();
    const controller = new AbortController();
    fleetProjectionController = controller;
    try {
      const result = await fetchFleetPortalProjection(controller.signal);
      if (fleetProjectionController !== controller) return;
      fleetProjection = result;
      fleetProjectionError = '';
      if (!result.companions.some(companion => (
        companion.companionId === activeCompanionId && companion.gardenPath
      ))) {
        attentionCounts = {};
        clearToasts();
        await activateCompanionScopeFromPath('/fleet');
        window.location.assign('/fleet');
      }
    } catch (error) {
      if (controller.signal.aborted || fleetProjectionController !== controller) return;
      fleetProjection = null;
      fleetProjectionError = error instanceof Error ? error.message : 'Cluster roster unavailable';
    }
  }

  async function switchCompanion(event: Event): Promise<void> {
    const target = event.currentTarget as HTMLSelectElement;
    const selected = fleetProjection?.companions.find(companion => (
      companion.companionId === target.value
    ));
    if (!selected?.gardenPath || selected.companionId === activeCompanionId) return;
    attentionCounts = {};
    clearToasts();
    try {
      await activateCompanionScopeFromPath(selected.gardenPath);
      window.location.assign(selected.gardenPath);
    } catch {
      fleetProjectionError = 'Unable to clear the previous companion session. Try again.';
    }
  }

  const themedNavGroups = $derived(navGroups.map((group) => ({
    ...group,
    attention: group.items.reduce((sum, item) => sum + (attentionCounts[item.path] ?? 0), 0),
    items: group.items.map((item) => {
      const labels = resolveThemeMenuLabel(activeTheme, item.id, item.defaultLabel, { companionName });
      return {
        ...item,
        ...labels,
        attention: attentionCounts[item.path] ?? 0,
      };
    }),
  })));

  // Check if current path is the login page
  // SvelteKit strips the base path from $page.url.pathname, so we check for '/login'
  let isLoginPage = $derived(
    $page.url.pathname === '/login' || companionScope?.innerPath === '/login',
  );
  let isFleetPage = $derived(isFleetOverviewPath($page.url.pathname));

  // Redirect to login if not authenticated (except on login page itself)
  $effect(() => {
    const pathname = $page.url.pathname;
    void activateCompanionScopeFromPath(pathname);
    collapsedGroups = loadCollapsedGroups();
    attentionCounts = {};
    clearToasts();
    if (isLoginPage || isFleetPage) return;
    if (!isAuthResolved()) {
      void ensureAuthResolved();
      return;
    }
    if (!isAuthenticated()) {
      if (companionScope) {
        window.location.assign('/fleet/login');
      } else {
        goto(`${base}/login`);
      }
      return;
    }
    void ensureCompanionNameLoaded(true);
    void ensureUiPreferencesLoaded();
    if (companionScope) void refreshFleetProjection();
  });

  $effect(() => {
    if (typeof document === 'undefined') return;
    document.title = appTitle;
  });

  async function handleLogout() {
    if (companionScope || isFleetPage) {
      try {
        const csrfResponse = await fetch('/v1/fleet-auth/session/csrf', {
          cache: 'no-store',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const csrf = await csrfResponse.json() as { csrfToken?: unknown };
        if (!csrfResponse.ok
          || typeof csrf.csrfToken !== 'string'
          || !/^[A-Za-z0-9_-]{43}$/u.test(csrf.csrfToken)) {
          throw new Error('Cluster logout ceremony unavailable');
        }
        const logoutResponse = await fetch('/v1/fleet-auth/logout', {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-PSFN-CSRF': csrf.csrfToken },
        });
        if (!logoutResponse.ok) throw new Error('Cluster logout failed');
        clearToken();
        window.location.assign('/fleet/login');
        return;
      } catch {
        fleetProjectionError = 'Sign out failed. Please try again.';
        return;
      }
    }
    const token = getToken();
    const headers = token
      ? { Authorization: `Bearer ${token}` }
      : undefined;
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        ...(headers ? { headers } : {}),
        credentials: 'include',
      });
    } catch {
      // Best-effort server-side cookie clear; client token clear still executes.
    }
    clearToken();
    goto(`${base}/login`);
  }

  function isActive(navPath: string): boolean {
    const currentPath = companionScope?.innerPath ?? $page.url.pathname;
    if (navPath === '/') {
      return currentPath === '/';
    }
    return currentPath.startsWith(navPath);
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    if (element.isContentEditable) return true;
    return !!element.closest('input, textarea, select, [contenteditable="true"]');
  }

  function isVisibleElement(element: HTMLElement): boolean {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function focusSearchTarget() {
    if (typeof window === 'undefined') return;
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-search-shortcut]'));
    const target = targets.find(isVisibleElement);
    if (!target) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.focus();
      target.select?.();
      return;
    }
    target.focus();
  }

  function closeEscapeTarget() {
    if (typeof window === 'undefined') return;
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-esc-close]'));
    const target = targets.find(isVisibleElement);
    target?.click();
  }

  onMount(() => {
    if (!isLoginPage && !isFleetPage) {
      void ensureAuthResolved();
      void ensureUiPreferencesLoaded();
    }

    const mediaQuery = window.matchMedia('(min-width: 1024px)');

    const syncViewport = () => {
      isDesktop = mediaQuery.matches;
      if (isDesktop) {
        mobileNavOpen = false;
      } else {
        sidebarOpen = false;
      }
    };

    const handleGlobalKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === '/') {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        focusSearchTarget();
        return;
      }
      if (event.key === 'Escape') {
        closeEscapeTarget();
      }
    };

    syncViewport();
    mediaQuery.addEventListener('change', syncViewport);
    document.addEventListener('keydown', handleGlobalKeydown);

    void refreshAttentionCounts();
    const attentionTimer = window.setInterval(() => {
      void refreshAttentionCounts();
    }, 30_000);
    const fleetProjectionTimer = window.setInterval(() => {
      if (activeCompanionId) void refreshFleetProjection();
    }, 30_000);

    return () => {
      mediaQuery.removeEventListener('change', syncViewport);
      document.removeEventListener('keydown', handleGlobalKeydown);
      window.clearInterval(attentionTimer);
      window.clearInterval(fleetProjectionTimer);
      fleetProjectionController?.abort();
      fleetProjectionController = null;
    };
  });
</script>

{#if isLoginPage}
  {@render children()}
{:else if isFleetPage}
  <div class="relative">
    <button
      type="button"
      onclick={handleLogout}
      class="fixed right-4 top-4 z-20 rounded-lg border border-bark-300 bg-bark-50/95 px-3 py-2 text-sm font-medium text-bark-700 shadow-sm backdrop-blur hover:bg-bark-100"
    >
      Sign out
    </button>
    {@render children()}
  </div>
{:else}
  <div class="flex h-screen bg-bark-100 relative">
    {#if !isDesktop && mobileNavOpen}
      <button
        aria-label="Close navigation"
        onclick={() => mobileNavOpen = false}
        class="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px] lg:hidden"
      ></button>
    {/if}

    <!-- Sidebar -->
    <aside
      class="flex flex-col bg-bark-50 border-r border-bark-300 transition-all duration-200 z-40
             fixed inset-y-0 left-0 lg:static lg:translate-x-0 shadow-lg lg:shadow-none"
      class:w-64={!isDesktop || sidebarOpen}
      class:w-16={isDesktop && !sidebarOpen}
      class:translate-x-0={isDesktop || mobileNavOpen}
      class:-translate-x-full={!isDesktop && !mobileNavOpen}
    >
      <!-- Header -->
      <div class="p-4 border-b border-bark-300">
        {#if sidebarOpen || !isDesktop}
          <h1 class="font-serif text-xl text-gold-300 font-semibold leading-tight">
            {sidebarTitle}
          </h1>
          <p class="text-sm text-bark-700 mt-1">{sidebarSubtitle}</p>
        {:else}
          <span class="text-gold-300 text-xl block text-center" title={appTitle}>
            &#x2727;
          </span>
        {/if}
        {#if (sidebarOpen || !isDesktop) && companionScope}
          <label
            for="companion-switcher"
            class="mt-3 block text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-shadow-400"
          >
            Companion
          </label>
          <select
            id="companion-switcher"
            value={activeCompanionId ?? ''}
            onchange={(event) => void switchCompanion(event)}
            disabled={!fleetProjection}
            class="mt-1 w-full rounded-md border border-bark-300 bg-bark-100 px-2 py-1.5 text-xs text-shadow-800"
          >
            {#if fleetProjection}
              {#each fleetProjection.companions.filter(companion => companion.gardenPath) as companion (companion.companionId)}
                <option value={companion.companionId}>{companion.displayName}</option>
              {/each}
            {:else}
              <option value={activeCompanionId ?? ''}>{companionName}</option>
            {/if}
          </select>
          <a
            href="/fleet"
            class="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-gold-300 bg-gold-50 px-3 py-2 text-sm font-semibold text-gold-800 transition-colors hover:border-gold-400 hover:bg-gold-100"
          >
            Cluster Overview
          </a>
          {#if fleetProjectionError}
            <p class="mt-1 text-[0.68rem] text-wilt-600">{fleetProjectionError}</p>
          {/if}
        {/if}
      </div>

      <!-- Navigation -->
      <nav class="flex-1 overflow-y-auto py-2">
        {#each themedNavGroups as group, groupIndex}
          {#if isDesktop && !sidebarOpen && groupIndex > 0}
            <div class="mx-4 my-2 border-t border-bark-200"></div>
          {/if}

          <div class="px-2 py-1.5">
            {#if sidebarOpen || !isDesktop}
              <button
                type="button"
                aria-expanded={!collapsedGroups[group.id]}
                aria-controls="nav-group-{group.id}"
                onclick={() => toggleNavGroup(group.id)}
                class="flex w-full items-center justify-between gap-2 rounded px-2 pb-1.5 text-left"
              >
                <span class="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-shadow-400">
                  {group.defaultLabel}
                </span>
                <span class="flex items-center gap-1.5">
                  {#if group.attention > 0}
                    <span
                      class="rounded-full bg-wilt-500 px-1.5 py-0.5 text-[0.65rem] font-bold leading-none text-white"
                      title="{group.attention} item{group.attention === 1 ? '' : 's'} need attention in {group.defaultLabel}"
                    >{group.attention}</span>
                  {/if}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-3 w-3 text-shadow-400 transition-transform {collapsedGroups[group.id] ? '' : 'rotate-180'}"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
              </button>
            {/if}

            <div
              id="nav-group-{group.id}"
              class="space-y-0.5"
              hidden={Boolean(collapsedGroups[group.id]) && (!isDesktop || sidebarOpen)}
            >
              {#each group.items as item}
                <a
                  href={item.id === 'fleet-costs'
                    ? fleetCostNavigationPath($page.url.pathname)
                    : scopeGardenPath(item.path, $page.url.pathname)}
                  onclick={() => { if (!isDesktop) mobileNavOpen = false; }}
                  class="relative flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors group"
                  class:bg-gold-50={isActive(item.path)}
                  class:border-l-3={isActive(item.path)}
                  class:border-gold-400={isActive(item.path)}
                  class:hover:bg-bark-200={!isActive(item.path)}
                >
                  <span class="text-lg shrink-0 mt-0.5">{item.icon}</span>
                  {#if sidebarOpen || !isDesktop}
                    <div class="min-w-0 flex-1">
                      <span
                        class="flex items-center justify-between gap-2 text-sm font-semibold"
                        class:text-gold-700={isActive(item.path)}
                        class:text-bark-700={!isActive(item.path)}
                      >
                        <span class="truncate">{item.primaryLabel}</span>
                        {#if item.attention > 0}
                          <span
                            class="shrink-0 rounded-full bg-wilt-500 px-1.5 py-0.5 text-[0.65rem] font-bold leading-none text-white"
                            title="{item.attention} pending — needs a human"
                          >{item.attention}</span>
                        {/if}
                      </span>
                      {#if item.secondaryLabel}
                        <span class="font-serif text-sm text-bark-600 block">
                          {item.secondaryLabel}
                        </span>
                      {/if}
                    </div>
                  {:else if item.attention > 0}
                    <span
                      class="absolute ml-5 -mt-1 rounded-full bg-wilt-500 px-1.5 py-0.5 text-[0.65rem] font-bold leading-none text-white"
                      title="{item.attention} pending — needs a human"
                    >{item.attention}</span>
                  {/if}
                </a>
              {/each}
            </div>
          </div>
        {/each}
      </nav>

      <!-- Footer -->
      <div class="p-3 border-t border-bark-300">
        <div class="flex items-center gap-2">
          {#if isDesktop}
            <button
              onclick={() => (sidebarOpen = !sidebarOpen)}
              class="p-1.5 rounded hover:bg-bark-200 text-bark-700 transition-colors"
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                {#if sidebarOpen}
                  <path stroke-linecap="round" stroke-linejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                {:else}
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                {/if}
              </svg>
            </button>
          {/if}
          {#if sidebarOpen || !isDesktop}
            <button
              onclick={handleLogout}
              class="ml-auto text-sm text-bark-600 hover:text-wilt-600 transition-colors"
            >
              Logout
            </button>
          {/if}
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto">
      <div class="px-3 py-4 sm:px-5 sm:py-5 lg:p-6 max-w-7xl mx-auto">
        {#if !isDesktop}
          <button
            onclick={() => mobileNavOpen = !mobileNavOpen}
            class="mb-4 inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-bark-700 hover:bg-bark-100 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            Menu
          </button>
        {/if}
        {#key activeCompanionId ?? $page.url.pathname}
          {@render children()}
        {/key}
      </div>
    </main>

    <!-- Global toasts -->
    <div class="fixed top-3 right-3 sm:top-4 sm:right-4 z-50 space-y-2 w-[calc(100%-1.5rem)] sm:w-full sm:max-w-sm pointer-events-none">
      {#each getToasts() as toast (toast.id)}
        <div
          class="pointer-events-auto rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur-sm
            {toast.kind === 'success' ? 'bg-moss-50/95 border-moss-200 text-moss-700' :
             toast.kind === 'error' ? 'bg-wilt-50/95 border-wilt-200 text-wilt-700' :
             'bg-bark-50/95 border-bark-300 text-bark-700'}"
          role="status"
          aria-live="polite"
        >
          <div class="flex items-start gap-2">
            <p class="text-sm leading-relaxed flex-1">{toast.message}</p>
            <button
              data-esc-close
              onclick={() => removeToast(toast.id)}
              class="text-bark-500 hover:text-bark-700 leading-none text-lg"
              aria-label="Dismiss notification"
            >
              &times;
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}
