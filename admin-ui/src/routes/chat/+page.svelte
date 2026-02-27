<script lang="ts">
  import { onMount } from 'svelte';
  import { getChatBootstrap } from '$lib/api/endpoints/chat';
  import type { AdminChatBootstrapResponse } from '$lib/types';

  let bootstrap = $state<AdminChatBootstrapResponse | null>(null);
  let loading = $state(true);
  let error = $state('');
  let scriptLoaded = $state(false);

  onMount(async () => {
    try {
      bootstrap = await getChatBootstrap();
      await loadPiWebUi();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load chat configuration';
    } finally {
      loading = false;
    }
  });

  async function loadPiWebUi(): Promise<void> {
    // Check if already loaded
    if (customElements.get('agent-interface')) {
      scriptLoaded = true;
      return;
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = '/static/pi-web-ui/index.js';
      script.onload = () => {
        scriptLoaded = true;
        resolve();
      };
      script.onerror = () => {
        reject(new Error('Failed to load pi-web-ui component'));
      };
      document.head.appendChild(script);
    });
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <!-- Header -->
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Canopy</h1>
    <p class="text-sm text-shadow-400 dark:text-shadow-500 mt-1">
      {#if bootstrap}
        Conversation with {bootstrap.agentName}
      {:else}
        Chat interface
      {/if}
    </p>
  </div>

  {#if loading}
    <!-- Loading state -->
    <div class="card-garden flex-1 flex items-center justify-center">
      <div class="text-center">
        <div class="animate-pulse text-gold-600 dark:text-gold-400 font-serif text-lg mb-2">
          Reaching into the canopy...
        </div>
        <p class="text-xs text-shadow-400 dark:text-shadow-500">Loading chat configuration</p>
      </div>
    </div>
  {:else if error}
    <!-- Error state -->
    <div class="card-garden flex-1 flex items-center justify-center">
      <div class="text-center p-6">
        <p class="text-wilt-600 dark:text-wilt-400 mb-2">{error}</p>
        <p class="text-xs text-shadow-400 dark:text-shadow-500 mb-4">
          Ensure the substrate agent is running and the admin API is accessible.
        </p>
        <button
          onclick={() => location.reload()}
          class="text-sm px-4 py-2 rounded-lg border border-gold-300 dark:border-gold-700
                 text-gold-700 dark:text-gold-400 hover:bg-gold-50 dark:hover:bg-gold-900/20 transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  {:else if bootstrap && scriptLoaded}
    <!-- Chat container -->
    <div class="card-garden flex-1 min-h-0 overflow-hidden">
      <agent-interface
        api-url={bootstrap.chatCompletionsUrl}
        api-key={bootstrap.adminToken}
        agent-name={bootstrap.agentName}
        voice-url={bootstrap.voiceWebSocketUrl || ''}
      ></agent-interface>
    </div>
  {:else if bootstrap}
    <!-- Script not loaded yet -->
    <div class="card-garden flex-1 flex items-center justify-center">
      <div class="text-center p-6">
        <p class="text-shadow-500 dark:text-shadow-400 mb-2">Chat component could not be loaded.</p>
        <p class="text-xs text-shadow-400 dark:text-shadow-500">
          The pi-web-ui module was not found at <code class="font-mono">/static/pi-web-ui/index.js</code>.
        </p>
      </div>
    </div>
  {/if}
</div>
