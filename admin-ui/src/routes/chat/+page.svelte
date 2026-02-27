<script lang="ts">
  import { onMount } from 'svelte';
  import { getChatBootstrap } from '$lib/api/endpoints/chat';
  import type { AdminChatBootstrapResponse } from '$lib/types';

  let bootstrap = $state<AdminChatBootstrapResponse | null>(null);
  let error = $state('');
  let loading = $state(true);
  let chatLoaded = $state(false);

  onMount(async () => {
    try {
      bootstrap = await getChatBootstrap();
      await loadChatWidget();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load chat bootstrap';
    } finally {
      loading = false;
    }
  });

  async function loadChatWidget() {
    if (!bootstrap) return;

    try {
      // Load the stylesheet from the runtime assets
      if (bootstrap.runtime.assets.stylesheetUrl) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = bootstrap.runtime.assets.stylesheetUrl;
        document.head.appendChild(link);
      }

      // Load the module script from the runtime assets
      if (bootstrap.runtime.assets.moduleUrl) {
        const script = document.createElement('script');
        script.type = 'module';
        script.src = bootstrap.runtime.assets.moduleUrl;
        document.head.appendChild(script);

        // Wait for the custom element to be defined
        script.onload = () => {
          setupChatElement();
        };

        // Also try after a short delay in case the element registers async
        setTimeout(() => {
          if (!chatLoaded) setupChatElement();
        }, 2000);
      }
    } catch {
      // Widget loading failed; fall back to iframe approach
    }
  }

  function setupChatElement() {
    if (!bootstrap || chatLoaded) return;

    const container = document.getElementById('chat-container');
    if (!container) return;

    // Check if the custom element is registered
    if (customElements.get('agent-interface')) {
      const el = document.createElement('agent-interface');

      // Configure the element with bootstrap data
      el.setAttribute('data-session-id', bootstrap.defaultSessionId);
      el.setAttribute('data-author-name', bootstrap.defaultAuthorName);
      el.setAttribute('data-author-id', bootstrap.defaultAuthorId);

      // Set API configuration
      if (bootstrap.api.chatCompletionsUrl) {
        el.setAttribute('data-completions-url', bootstrap.api.chatCompletionsUrl);
      }
      if (bootstrap.api.apiKey) {
        el.setAttribute('data-api-key', bootstrap.api.apiKey);
      }

      // Set model info
      if (bootstrap.runtime.model) {
        el.setAttribute('data-model-id', bootstrap.runtime.model.id);
      }

      container.innerHTML = '';
      container.appendChild(el);
      chatLoaded = true;
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Canopy</h1>
    <p class="text-shadow-600 text-sm mt-1">Chat Interface</p>
  </div>

  {#if loading}
    <div class="card p-6 animate-pulse">
      <div class="h-4 bg-bark-200 rounded w-48 mb-4"></div>
      <div class="h-64 bg-bark-200 rounded"></div>
    </div>
  {:else if error}
    <div class="card p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium">Failed to load chat</p>
      <p class="text-shadow-600 text-sm mt-1">{error}</p>
      <p class="text-shadow-600 text-sm mt-3">
        Make sure the admin server is running and the chat bootstrap endpoint is available.
      </p>
    </div>
  {:else if bootstrap}
    <!-- Chat widget container -->
    <div id="chat-container" class="h-[calc(100vh-14rem)] rounded-xl overflow-hidden border border-bark-300">
      {#if !chatLoaded}
        <!-- Fallback: link to existing chat page -->
        <div class="flex flex-col items-center justify-center h-full bg-bark-50 p-8">
          <p class="text-shadow-600 text-lg font-serif mb-4">Chat widget loading...</p>
          <p class="text-shadow-700 text-sm mb-6 text-center max-w-md">
            If the embedded chat does not load, you can open the standalone chat interface:
          </p>
          <a
            href={bootstrap.api.chatCompletionsUrl?.replace('/v1/chat/completions', '/chat') ?? '/chat'}
            target="_blank"
            rel="noopener noreferrer"
            class="px-6 py-2.5 rounded-lg bg-gold-400 text-bark-50 font-medium
                   hover:bg-gold-500 transition-colors inline-flex items-center gap-2"
          >
            Open Chat
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      {/if}
    </div>

    <!-- Bootstrap configuration details -->
    <details class="card p-4">
      <summary class="text-sm font-medium text-shadow-600 cursor-pointer hover:text-gold-600">
        Chat Configuration
      </summary>
      <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <h3 class="text-sm text-shadow-700 font-semibold uppercase tracking-wide mb-1">Identity</h3>
          <p class="text-shadow-700">{bootstrap.displayName}
            {#if bootstrap.nickname}
              <span class="text-shadow-600">({bootstrap.nickname})</span>
            {/if}
          </p>
          <p class="text-sm text-shadow-600 mt-1">Contact: {bootstrap.canonicalContactId}</p>
        </div>

        <div>
          <h3 class="text-sm text-shadow-700 font-semibold uppercase tracking-wide mb-1">Session</h3>
          <p class="text-shadow-700">{bootstrap.defaultSessionId}</p>
          <p class="text-sm text-shadow-600 mt-1">
            Author: {bootstrap.defaultAuthorName} ({bootstrap.defaultAuthorId})
          </p>
        </div>

        <div>
          <h3 class="text-sm text-shadow-700 font-semibold uppercase tracking-wide mb-1">API</h3>
          <p class="text-shadow-800 text-sm font-mono break-all">{bootstrap.api.chatCompletionsUrl}</p>
          {#if bootstrap.api.voiceWebSocketUrl}
            <p class="text-shadow-800 text-sm font-mono break-all mt-1">{bootstrap.api.voiceWebSocketUrl}</p>
          {/if}
        </div>

        <div>
          <h3 class="text-sm text-shadow-700 font-semibold uppercase tracking-wide mb-1">Model</h3>
          <p class="text-shadow-700">{bootstrap.runtime.model.name}</p>
          <p class="text-sm text-shadow-600 mt-1">
            {bootstrap.runtime.model.provider} / {bootstrap.runtime.model.api}
          </p>
        </div>

        <div>
          <h3 class="text-sm text-shadow-700 font-semibold uppercase tracking-wide mb-1">Privacy</h3>
          <p class="text-shadow-700">Level: {bootstrap.privacy.selectedLevel}</p>
          <p class="text-sm text-shadow-600 mt-1">
            Available: {bootstrap.privacy.availableLevels.join(', ')}
          </p>
        </div>

        {#if bootstrap.contactOptions.length > 1}
          <div>
            <h3 class="text-sm text-shadow-700 font-semibold uppercase tracking-wide mb-1">Contact Options</h3>
            {#each bootstrap.contactOptions as opt}
              <p class="text-shadow-700 text-xs">{opt.displayName} ({opt.canonicalContactId})</p>
            {/each}
          </div>
        {/if}
      </div>
    </details>
  {/if}
</div>
