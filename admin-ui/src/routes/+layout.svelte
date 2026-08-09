<script lang="ts">
  import { onMount } from 'svelte';
  import '../app.css';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { navGroups } from '$lib/nav';
  import OperatorNavigation from '$lib/components/navigation/OperatorNavigation.svelte';
  import type { ConsoleNavigationGroup } from '$lib/nav/presentation';
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
    activateSessionScopeFromPath,
    ensureAuthResolved,
    clearToken,
    startServerSessionRefresh,
    stopServerSessionRefresh,
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
    isFleetOverviewPath,
    parseCompanionGardenScope,
    scopeGardenPath,
  } from '$lib/fleet/companion-scope';
  import {
    fetchFleetPortalProjection,
    type FleetPortalProjection,
  } from '$lib/fleet/portal';
  import { fleetCostNavigationPath } from '$lib/fleet/fleet-costs';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import { reconcilePollingSnapshot } from '$lib/polling/silent-background-revalidation';
  import { logoutFleetSession } from '$lib/api/fleet-session';

  let { children } = $props();

  let isDesktop = $state(true);
  let mobileNavOpen = $state(false);
  let fleetProjection = $state<FleetPortalProjection | null>(null);
  let fleetProjectionController: AbortController | null = null;
  let fleetProjectionError = $state('');
  const companionScope = $derived(parseCompanionGardenScope($page.url.pathname));
  const activeCompanionId = $derived(companionScope?.companionId ?? null);
  const companionName = $derived(getCompanionName());
  const activeTheme = $derived(getActiveThemePack());
  const sidebarSubtitle = $derived(resolveThemeTemplate(activeTheme.ui.sidebarSubtitleTemplate, { companionName }));
  const appTitle = $derived(resolveThemeTemplate(activeTheme.ui.appTitleTemplate, { companionName }));

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
      const reconciledCompanions = fleetProjection
        ? reconcilePollingSnapshot(fleetProjection.companions, result.companions)
        : result.companions;
      if (!fleetProjection || reconciledCompanions !== fleetProjection.companions) {
        fleetProjection = { ...result, companions: reconciledCompanions };
      }
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

  const consoleNavigationGroups = $derived(navGroups.map((group) => ({
    id: group.id,
    label: group.defaultLabel,
    attention: group.items.reduce((sum, item) => sum + (attentionCounts[item.path] ?? 0), 0),
    items: group.items.map((item) => {
      const labels = resolveThemeMenuLabel(activeTheme, item.id, item.defaultLabel, { companionName });
      return {
        id: item.id,
        path: item.path,
        href: item.id === 'fleet-costs'
          ? fleetCostNavigationPath($page.url.pathname)
          : scopeGardenPath(item.path, $page.url.pathname),
        icon: item.icon,
        primaryLabel: labels.primaryLabel,
        secondaryLabel: labels.secondaryLabel,
        attention: attentionCounts[item.path] ?? 0,
        active: isActive(item.path),
      };
    }),
  })) as ConsoleNavigationGroup[]);

  // Check if current path is the login page
  // SvelteKit strips the base path from $page.url.pathname, so we check for '/login'
  let isLoginPage = $derived(
    $page.url.pathname === '/login' || companionScope?.innerPath === '/login',
  );
  let isFleetPage = $derived(isFleetOverviewPath($page.url.pathname));

  // Redirect to login if not authenticated (except on login page itself)
  $effect(() => {
    const pathname = $page.url.pathname;
    void activateSessionScopeFromPath(pathname).catch((error: unknown) => {
      console.warn('Garden session scope activation failed.', error);
    });
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
        await logoutFleetSession();
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
    startServerSessionRefresh();
    if (!isLoginPage) {
      void ensureAuthResolved();
    }
    if (!isLoginPage && !isFleetPage) {
      void ensureUiPreferencesLoaded();
    }

    const mediaQuery = window.matchMedia('(min-width: 1024px)');

    const syncViewport = () => {
      isDesktop = mediaQuery.matches;
      if (isDesktop) {
        mobileNavOpen = false;
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

    const attentionPoller = createVisibilityAwarePoller({
      intervalMs: 30_000,
      refresh: refreshAttentionCounts,
    });
    const fleetProjectionPoller = createVisibilityAwarePoller({
      intervalMs: 30_000,
      refresh: () => {
        if (activeCompanionId) return refreshFleetProjection();
      },
    });
    attentionPoller.start();
    fleetProjectionPoller.start();

    return () => {
      mediaQuery.removeEventListener('change', syncViewport);
      document.removeEventListener('keydown', handleGlobalKeydown);
      attentionPoller.stop();
      fleetProjectionPoller.stop();
      stopServerSessionRefresh();
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
  <div class="relative flex h-screen bg-bark-100">
    <OperatorNavigation
      groups={consoleNavigationGroups}
      {appTitle}
      {sidebarSubtitle}
      {companionName}
      {activeCompanionId}
      {fleetProjection}
      {fleetProjectionError}
      onSwitchCompanion={(event) => void switchCompanion(event)}
      onLogout={handleLogout}
      bind:mobileOpen={mobileNavOpen}
    />

    <main class="min-w-0 flex-1 overflow-y-auto">
      {#if !isDesktop}
        <button
          type="button"
          onclick={() => mobileNavOpen = true}
          class="fixed bottom-4 left-4 z-20 inline-flex items-center gap-2 rounded-full border border-bark-300 bg-bark-50/95 px-4 py-2 text-sm font-semibold text-bark-700 shadow-lg backdrop-blur transition-colors hover:bg-bark-100 lg:hidden"
          aria-label="Open operator navigation"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          Menu
        </button>
      {/if}
      <div class="console-page-frame mx-auto w-full max-w-[100rem] px-3 py-4 sm:px-5 sm:py-5 lg:px-7 lg:py-6">
        {@render children()}
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
