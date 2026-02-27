<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { NAV_ITEMS } from '$lib/nav';
  import { initAuth, isAuthenticated } from '$lib/stores/auth.svelte';
  import { initTheme, isDark, toggleTheme } from '$lib/stores/theme.svelte';
  import { connectTelemetry, isConnected } from '$lib/stores/telemetry.svelte';
  import '../app.css';

  let { children } = $props();
  let sidebarOpen = $state(false);
  let ready = $state(false);

  onMount(() => {
    initAuth();
    initTheme();

    if (!isAuthenticated()) {
      goto(`${base}/login`);
    } else {
      connectTelemetry();
    }

    ready = true;
  });

  function currentPath(): string {
    const full = $page.url.pathname;
    if (base && full.startsWith(base)) {
      return full.slice(base.length) || '/';
    }
    return full;
  }

  function isActive(path: string): boolean {
    const current = currentPath();
    if (path === '/') return current === '/';
    return current.startsWith(path);
  }
</script>

{#if !ready}
  <div class="flex items-center justify-center h-screen bg-bark-50">
    <div class="animate-pulse text-gold-600 font-serif text-2xl">Loading...</div>
  </div>
{:else if !isAuthenticated()}
  {@render children()}
{:else}
  <div class="flex h-screen overflow-hidden bg-bark-50 dark:bg-shadow-950">
    <!-- Mobile overlay -->
    {#if sidebarOpen}
      <button
        class="fixed inset-0 z-30 bg-black/30 lg:hidden"
        onclick={() => sidebarOpen = false}
        aria-label="Close sidebar"
      ></button>
    {/if}

    <!-- Sidebar -->
    <aside class="
      fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200
      lg:static lg:translate-x-0
      {sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      bg-white dark:bg-shadow-900 border-r border-bark-200 dark:border-shadow-700
      flex flex-col
    ">
      <!-- Brand -->
      <div class="px-5 py-4 border-b border-bark-200 dark:border-shadow-700">
        <a href="{base}/" class="block">
          <h1 class="text-lg font-serif font-bold text-shadow-800 dark:text-bark-200">
            Purrsephone's Garden
          </h1>
          <p class="text-xs text-shadow-400 dark:text-shadow-500 mt-0.5">Substrate Admin</p>
        </a>
      </div>

      <!-- Nav items -->
      <nav class="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
        {#each NAV_ITEMS as item}
          <a
            href="{base}{item.path}"
            class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors
              {isActive(item.path)
                ? 'bg-gold-50 dark:bg-gold-900/20 text-gold-800 dark:text-gold-300 font-medium filigree-border'
                : 'text-shadow-600 dark:text-shadow-400 hover:bg-bark-100 dark:hover:bg-shadow-800 hover:text-shadow-900 dark:hover:text-bark-200'
              }"
            onclick={() => sidebarOpen = false}
          >
            <svg class="w-5 h-5 shrink-0 {isActive(item.path) ? 'text-gold-600 dark:text-gold-400' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d={item.icon} />
            </svg>
            <span class="flex flex-col leading-tight">
              <span class="font-serif text-[13px]">{item.gardenName}</span>
              <span class="text-[10px] text-shadow-400 dark:text-shadow-500">{item.techName}</span>
            </span>
          </a>
        {/each}
      </nav>

      <!-- Footer -->
      <div class="px-4 py-3 border-t border-bark-200 dark:border-shadow-700 flex items-center justify-between">
        <div class="flex items-center gap-2 text-xs text-shadow-400 dark:text-shadow-500">
          <span class="w-2 h-2 rounded-full {isConnected() ? 'bg-moss-400' : 'bg-wilt-400'}"></span>
          {isConnected() ? 'Connected' : 'Disconnected'}
        </div>

        <button
          onclick={toggleTheme}
          class="p-1.5 rounded-md hover:bg-bark-100 dark:hover:bg-shadow-800 text-shadow-400 dark:text-shadow-500 transition-colors"
          title="Toggle dark mode"
        >
          {#if isDark()}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.36-6.36l-.7.7M6.34 17.66l-.7.7m12.72 0l-.7-.7M6.34 6.34l-.7-.7M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
          {:else}
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
          {/if}
        </button>
      </div>
    </aside>

    <!-- Main content area -->
    <div class="flex-1 flex flex-col overflow-hidden">
      <!-- Top bar -->
      <header class="h-14 border-b border-bark-200 dark:border-shadow-700 bg-white dark:bg-shadow-900 flex items-center px-4 gap-4 shrink-0">
        <button
          class="lg:hidden p-1.5 rounded-md hover:bg-bark-100 dark:hover:bg-shadow-800"
          onclick={() => sidebarOpen = !sidebarOpen}
          aria-label="Toggle sidebar"
        >
          <svg class="w-5 h-5 text-shadow-600 dark:text-shadow-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>

        <nav class="text-sm text-shadow-500 dark:text-shadow-400">
          {#each NAV_ITEMS as item}
            {#if isActive(item.path)}
              <span class="font-serif text-shadow-800 dark:text-bark-200">{item.gardenName}</span>
              <span class="text-shadow-300 dark:text-shadow-600 mx-1">/</span>
              <span class="text-shadow-400 dark:text-shadow-500">{item.techName}</span>
            {/if}
          {/each}
        </nav>

        <div class="flex-1"></div>

        <a href="/" target="_blank" class="text-xs text-shadow-400 dark:text-shadow-500 hover:text-gold-600 dark:hover:text-gold-400 transition-colors">
          Classic UI
        </a>
      </header>

      <!-- Page content -->
      <main class="flex-1 overflow-y-auto p-6">
        {@render children()}
      </main>
    </div>
  </div>
{/if}
