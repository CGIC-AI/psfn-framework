<script lang="ts">
  import { onMount } from 'svelte';
  import '../app.css';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { navItems } from '$lib/nav';
  import {
    getToken,
    isAuthenticated,
    isAuthResolved,
    ensureAuthResolved,
    clearToken,
  } from '$lib/stores/auth.svelte';
  import { getToasts, removeToast } from '$lib/stores/toast.svelte';

  let { children } = $props();

  let sidebarOpen = $state(true);
  let isDesktop = $state(true);
  let mobileNavOpen = $state(false);

  // Check if current path is the login page
  // SvelteKit strips the base path from $page.url.pathname, so we check for '/login'
  let isLoginPage = $derived($page.url.pathname === '/login');

  // Redirect to login if not authenticated (except on login page itself)
  $effect(() => {
    if (isLoginPage) return;
    if (!isAuthResolved()) {
      void ensureAuthResolved();
      return;
    }
    if (!isAuthenticated()) {
      goto(`${base}/login`);
    }
  });

  async function handleLogout() {
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
    // navPath includes base (e.g., '/garden/memory'), but $page.url.pathname does not
    // Strip the base prefix to compare
    const stripped = navPath.startsWith(base) ? navPath.slice(base.length) || '/' : navPath;
    const currentPath = $page.url.pathname;
    if (stripped === '/') {
      return currentPath === '/';
    }
    return currentPath.startsWith(stripped);
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
    if (!isLoginPage) {
      void ensureAuthResolved();
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

    return () => {
      mediaQuery.removeEventListener('change', syncViewport);
      document.removeEventListener('keydown', handleGlobalKeydown);
    };
  });
</script>

{#if isLoginPage}
  {@render children()}
{:else}
  <div class="flex h-screen bg-bark-100 relative">
    {#if !isDesktop && mobileNavOpen}
      <button
        aria-label="Close navigation"
        onclick={() => mobileNavOpen = false}
        class="fixed inset-0 z-30 bg-shadow-900/20 backdrop-blur-[1px] lg:hidden"
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
          <h1 class="font-serif text-xl text-gold-600 font-semibold leading-tight">
            Purrsephone's Garden
          </h1>
          <p class="text-sm text-shadow-600 mt-1">Admin Console</p>
        {:else}
          <span class="text-gold-500 text-xl block text-center" title="Purrsephone's Garden">
            &#x2727;
          </span>
        {/if}
      </div>

      <!-- Navigation -->
      <nav class="flex-1 overflow-y-auto py-2">
        {#each navItems as item}
          <a
            href={item.path}
            onclick={() => { if (!isDesktop) mobileNavOpen = false; }}
            class="flex items-start gap-3 px-4 py-2.5 mx-2 my-0.5 rounded-lg transition-colors group"
            class:bg-gold-50={isActive(item.path)}
            class:border-l-3={isActive(item.path)}
            class:border-gold-400={isActive(item.path)}
            class:hover:bg-bark-200={!isActive(item.path)}
          >
            <span class="text-lg shrink-0 mt-0.5">{item.icon}</span>
            {#if sidebarOpen || !isDesktop}
              <div class="min-w-0">
                <span
                  class="font-serif text-sm font-medium block"
                  class:text-gold-700={isActive(item.path)}
                  class:text-shadow-700={!isActive(item.path)}
                >
                  {item.gardenName}
                </span>
                <span class="text-sm text-shadow-600 block">
                  {item.technicalName}
                </span>
              </div>
            {/if}
          </a>
        {/each}
      </nav>

      <!-- Footer -->
      <div class="p-3 border-t border-bark-300">
        <div class="flex items-center gap-2">
          {#if isDesktop}
            <button
              onclick={() => (sidebarOpen = !sidebarOpen)}
              class="p-1.5 rounded hover:bg-bark-200 text-shadow-700 transition-colors"
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
              class="ml-auto text-sm text-shadow-600 hover:text-wilt-600 transition-colors"
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
            class="mb-4 inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-700 hover:bg-bark-100 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            Menu
          </button>
        {/if}
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
             'bg-bark-50/95 border-bark-300 text-shadow-700'}"
          role="status"
          aria-live="polite"
        >
          <div class="flex items-start gap-2">
            <p class="text-sm leading-relaxed flex-1">{toast.message}</p>
            <button
              data-esc-close
              onclick={() => removeToast(toast.id)}
              class="text-shadow-500 hover:text-shadow-700 leading-none text-lg"
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
