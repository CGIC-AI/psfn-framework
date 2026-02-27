<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getChatBootstrap, updateChatBootstrap } from '$lib/api/endpoints/chat';
  import type { AdminChatBootstrapResponse } from '$lib/types';

  let bootstrap = $state<AdminChatBootstrapResponse | null>(null);
  let error = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let connectionStatus = $state<'connecting' | 'connected' | 'error'>('connecting');
  let statusDetail = $state('');
  let iframeEl = $state<HTMLIFrameElement | null>(null);

  // Form state
  let selectedContactId = $state('');
  let selectedPrivacyLevel = $state('');
  let showIdentityDetails = $state(false);

  // Health check interval
  let healthInterval: ReturnType<typeof setInterval> | undefined;

  onMount(async () => {
    try {
      bootstrap = await getChatBootstrap();
      selectedContactId = bootstrap.canonicalContactId;
      selectedPrivacyLevel = bootstrap.privacy.selectedLevel;
      await checkConnection();
      healthInterval = setInterval(checkConnection, 30_000);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load chat bootstrap';
      connectionStatus = 'error';
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    if (healthInterval) clearInterval(healthInterval);
  });

  async function checkConnection() {
    try {
      const res = await fetch('/health');
      if (res.ok) {
        connectionStatus = 'connected';
        const data = await res.json() as { status?: string; uptime?: number };
        statusDetail = data.uptime ? `Uptime: ${formatUptime(data.uptime)}` : 'Connected';
      } else {
        connectionStatus = 'error';
        statusDetail = `HTTP ${res.status}`;
      }
    } catch {
      connectionStatus = 'error';
      statusDetail = 'Admin server unreachable';
    }
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  async function onContactChange() {
    if (!bootstrap || saving) return;
    saving = true;
    try {
      const result = await updateChatBootstrap({
        canonicalContactId: selectedContactId,
        privacyLevel: selectedPrivacyLevel,
      });
      // Re-fetch bootstrap to get updated state
      bootstrap = await getChatBootstrap();
      selectedContactId = bootstrap.canonicalContactId;
      selectedPrivacyLevel = bootstrap.privacy.selectedLevel;
      // Reload iframe to pick up new identity
      reloadIframe();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update chat settings';
    } finally {
      saving = false;
    }
  }

  async function onPrivacyChange() {
    if (!bootstrap || saving) return;
    saving = true;
    try {
      await updateChatBootstrap({
        canonicalContactId: selectedContactId,
        privacyLevel: selectedPrivacyLevel,
      });
      bootstrap = await getChatBootstrap();
      selectedContactId = bootstrap.canonicalContactId;
      selectedPrivacyLevel = bootstrap.privacy.selectedLevel;
      reloadIframe();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update privacy level';
    } finally {
      saving = false;
    }
  }

  function reloadIframe() {
    if (iframeEl) {
      // Force reload by re-assigning src
      const src = iframeEl.src;
      iframeEl.src = '';
      requestAnimationFrame(() => {
        if (iframeEl) iframeEl.src = src;
      });
    }
  }

  function contactLabel(opt: AdminChatBootstrapResponse['contactOptions'][0]): string {
    return opt.nickname ? `${opt.displayName} (${opt.nickname})` : opt.displayName;
  }

  const STATUS_DOT: Record<string, string> = {
    connecting: 'bg-bark-400 animate-pulse',
    connected: 'bg-moss-500',
    error: 'bg-wilt-500',
  };

  const STATUS_LABEL: Record<string, string> = {
    connecting: 'Connecting...',
    connected: 'Connected',
    error: 'Disconnected',
  };

  const STATUS_TEXT: Record<string, string> = {
    connecting: 'text-shadow-700',
    connected: 'text-moss-700',
    error: 'text-wilt-600',
  };
</script>

<div class="space-y-4">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Canopy</h1>
      <p class="text-shadow-600 text-sm mt-1">Chat interface</p>
    </div>
    <!-- Connection Status -->
    <div class="flex items-center gap-2">
      <span class="inline-block w-2.5 h-2.5 rounded-full {STATUS_DOT[connectionStatus]}"></span>
      <span class="text-sm font-medium {STATUS_TEXT[connectionStatus]}">{STATUS_LABEL[connectionStatus]}</span>
      {#if statusDetail && connectionStatus !== 'connecting'}
        <span class="text-sm text-shadow-600">-- {statusDetail}</span>
      {/if}
    </div>
  </div>

  {#if loading}
    <div class="card p-6 animate-pulse">
      <div class="h-4 bg-bark-200 rounded w-48 mb-4"></div>
      <div class="h-64 bg-bark-200 rounded"></div>
    </div>
  {:else if error && !bootstrap}
    <div class="card p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium">Failed to load chat</p>
      <p class="text-shadow-600 text-sm mt-1">{error}</p>
      <p class="text-shadow-600 text-sm mt-3">
        Make sure the admin server is running and the chat bootstrap endpoint is available.
      </p>
    </div>
  {:else if bootstrap}
    <!-- Controls Bar -->
    <div class="card-garden p-4">
      <div class="flex flex-wrap items-end gap-4">
        <!-- Contact Selector -->
        <div class="flex flex-col gap-1">
          <label for="chat-contact" class="text-sm font-semibold text-shadow-800">Contact</label>
          <select
            id="chat-contact"
            bind:value={selectedContactId}
            onchange={onContactChange}
            disabled={saving}
            class="rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm text-shadow-900
                   focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400
                   disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {#each bootstrap.contactOptions as opt}
              <option value={opt.canonicalContactId}>{contactLabel(opt)}</option>
            {/each}
          </select>
        </div>

        <!-- Privacy Level Selector -->
        <div class="flex flex-col gap-1">
          <label for="chat-privacy" class="text-sm font-semibold text-shadow-800">Privacy Level</label>
          <select
            id="chat-privacy"
            bind:value={selectedPrivacyLevel}
            onchange={onPrivacyChange}
            disabled={saving}
            class="rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm text-shadow-900
                   focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400
                   disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {#each bootstrap.privacy.availableLevels as level}
              <option value={level}>{level}</option>
            {/each}
          </select>
        </div>

        <!-- Identity Summary -->
        <div class="flex-1 min-w-0">
          <p class="text-sm text-shadow-800 truncate">
            <span class="font-medium">{bootstrap.displayName}</span>
            {#if bootstrap.nickname}
              <span class="text-shadow-600">({bootstrap.nickname})</span>
            {/if}
            <span class="text-shadow-600 mx-1">|</span>
            <span class="text-shadow-600 font-mono text-sm">{bootstrap.selectedIdentity.channel}:{bootstrap.selectedIdentity.userId}</span>
          </p>
          <p class="text-sm text-shadow-600 truncate">
            Session: {bootstrap.defaultSessionId} | Model: {bootstrap.runtime.model.name}
          </p>
        </div>

        <!-- Identity Details Toggle -->
        <button
          onclick={() => showIdentityDetails = !showIdentityDetails}
          class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
                 text-shadow-700 hover:bg-bark-100 transition-colors font-medium shrink-0"
        >
          {showIdentityDetails ? 'Hide Details' : 'Details'}
        </button>
      </div>

      {#if saving}
        <p class="text-sm text-gold-600 mt-2">Updating identity...</p>
      {/if}
      {#if error && bootstrap}
        <p class="text-sm text-wilt-600 mt-2">{error}</p>
      {/if}

      <!-- Expanded Identity Details -->
      {#if showIdentityDetails}
        <div class="mt-4 pt-4 border-t border-bark-200 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
          <div>
            <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">Identity</h3>
            <p class="text-shadow-800">Channel: <span class="font-mono">{bootstrap.selectedIdentity.channel}</span></p>
            <p class="text-shadow-800">User ID: <span class="font-mono">{bootstrap.selectedIdentity.userId}</span></p>
            <p class="text-shadow-800">Privacy: {bootstrap.selectedIdentity.privacyLevel}</p>
          </div>
          <div>
            <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">Session</h3>
            <p class="text-shadow-800 font-mono break-all">{bootstrap.defaultSessionId}</p>
            <p class="text-shadow-600 mt-1">Author: {bootstrap.defaultAuthorName} ({bootstrap.defaultAuthorId})</p>
          </div>
          <div>
            <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">API</h3>
            <p class="text-shadow-800 font-mono text-sm break-all">{bootstrap.api.chatCompletionsUrl}</p>
            {#if bootstrap.api.voiceWebSocketUrl}
              <p class="text-shadow-800 font-mono text-sm break-all mt-1">{bootstrap.api.voiceWebSocketUrl}</p>
            {/if}
          </div>
          <div>
            <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">Model</h3>
            <p class="text-shadow-800">{bootstrap.runtime.model.name}</p>
            <p class="text-shadow-600 mt-1">{bootstrap.runtime.model.provider} / {bootstrap.runtime.model.api}</p>
          </div>
          {#if bootstrap.contactOptions.length > 1}
            <div>
              <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">Contacts</h3>
              {#each bootstrap.contactOptions as opt}
                <p class="text-shadow-800 text-sm">{contactLabel(opt)}</p>
              {/each}
            </div>
          {/if}
          {#if bootstrap.linkedChannels.length > 0}
            <div>
              <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">Linked Channels</h3>
              {#each bootstrap.linkedChannels as ch}
                <p class="text-shadow-800 text-sm font-mono">{ch.channel}:{ch.userId} ({ch.privacyLevel})</p>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Chat Iframe -->
    <div class="rounded-xl overflow-hidden border border-bark-300 bg-white" style="height: calc(100vh - 16rem);">
      <iframe
        bind:this={iframeEl}
        src="/chat"
        title="Garden Chat"
        class="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      ></iframe>
    </div>
  {/if}
</div>
