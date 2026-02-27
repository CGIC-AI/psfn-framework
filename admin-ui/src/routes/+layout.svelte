<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { navItems } from '$lib/nav';
  import { isAuthenticated, clearToken } from '$lib/stores/auth.svelte';

  let { children } = $props();

  let sidebarOpen = $state(true);

  // Check if current path is the login page
  // SvelteKit strips the base path from $page.url.pathname, so we check for '/login'
  let isLoginPage = $derived($page.url.pathname === '/login');

  // Redirect to login if not authenticated (except on login page itself)
  $effect(() => {
    if (!isLoginPage && !isAuthenticated()) {
      goto(`${base}/login`);
    }
  });

  function handleLogout() {
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
</script>

{#if isLoginPage}
  {@render children()}
{:else}
  <div class="flex h-screen bg-bark-100">
    <!-- Sidebar -->
    <aside
      class="flex flex-col bg-bark-50 border-r border-bark-300 transition-all duration-200"
      class:w-64={sidebarOpen}
      class:w-16={!sidebarOpen}
    >
      <!-- Header -->
      <div class="p-4 border-b border-bark-300">
        {#if sidebarOpen}
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
            class="flex items-start gap-3 px-4 py-2.5 mx-2 my-0.5 rounded-lg transition-colors group"
            class:bg-gold-50={isActive(item.path)}
            class:border-l-3={isActive(item.path)}
            class:border-gold-400={isActive(item.path)}
            class:hover:bg-bark-200={!isActive(item.path)}
          >
            <span class="text-lg shrink-0 mt-0.5">{item.icon}</span>
            {#if sidebarOpen}
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
          {#if sidebarOpen}
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
      <div class="p-6 max-w-7xl mx-auto">
        {@render children()}
      </div>
    </main>
  </div>
{/if}
