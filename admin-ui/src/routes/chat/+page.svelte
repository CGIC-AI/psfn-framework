<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { getChatBootstrap, updateChatBootstrap } from '$lib/api/endpoints/chat';
  import { getToken } from '$lib/stores/auth.svelte';
  import type { AdminChatBootstrapResponse } from '$lib/types';

  // ── State ──
  let bootstrap = $state<AdminChatBootstrapResponse | null>(null);
  let error = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let connectionStatus = $state<'connecting' | 'connected' | 'error'>('connecting');
  let statusDetail = $state('');

  // Chat state
  interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    thinking?: string;
    toolCalls?: Array<{ name: string; id: string; args: string; result?: string; isError?: boolean }>;
  }

  let messages = $state<ChatMessage[]>([]);
  let inputText = $state('');
  let isStreaming = $state(false);
  let streamingContent = $state('');
  let streamingThinking = $state('');
  let pendingToolCalls = $state<Array<{ name: string; id: string; args: string; result?: string; isError?: boolean }>>([]);

  // Contact/privacy selectors
  let selectedContactId = $state('');
  let selectedPrivacyLevel = $state('');
  let showIdentityDetails = $state(false);

  // Message area refs
  let messagesContainer: HTMLDivElement | undefined = $state(undefined);
  let inputEl: HTMLTextAreaElement | undefined = $state(undefined);

  // SSE debug stream
  let debugEventSource: EventSource | null = null;

  // Health check
  let healthInterval: ReturnType<typeof setInterval> | undefined;

  // Abort controller for streaming
  let abortController: AbortController | null = null;

  // Collapsed thinking/tool sections
  let expandedThinking = $state<Set<string>>(new Set());
  let expandedTools = $state<Set<string>>(new Set());

  // ── Constants ──
  const MAX_CONTEXT_MESSAGES = 40;
  const DEBUG_SSE_PATH = '/api/chat/events/stream';

  // ── Lifecycle ──

  onMount(async () => {
    try {
      bootstrap = await getChatBootstrap();
      selectedContactId = bootstrap.canonicalContactId;
      selectedPrivacyLevel = bootstrap.privacy.selectedLevel;
      await checkConnection();
      healthInterval = setInterval(checkConnection, 30_000);
      connectDebugStream();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load chat bootstrap';
      connectionStatus = 'error';
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    if (healthInterval) clearInterval(healthInterval);
    disconnectDebugStream();
    if (abortController) abortController.abort();
  });

  // ── Connection check ──

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

  // ── Debug SSE stream for tool/thinking events ──

  function connectDebugStream() {
    if (debugEventSource) return;
    const url = new URL(DEBUG_SSE_PATH, window.location.origin);
    const source = new EventSource(url, { withCredentials: true });
    source.addEventListener('chat-debug', (event: MessageEvent) => {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!payload || typeof payload !== 'object' || !isStreaming) return;
      switch (payload.event) {
        case 'agent.stream.thinking': {
          const text = typeof payload.message === 'string' ? payload.message : '';
          if (text) streamingThinking += text;
          break;
        }
        case 'agent.tool.start': {
          const details = (payload.details || {}) as Record<string, unknown>;
          const toolCallId = (details.toolCallId || `tool-${Date.now()}`) as string;
          const toolName = (details.toolName || 'unknown') as string;
          pendingToolCalls = [...pendingToolCalls, { name: toolName, id: toolCallId, args: '' }];
          break;
        }
        case 'agent.tool.end': {
          const details = (payload.details || {}) as Record<string, unknown>;
          const toolCallId = (details.toolCallId || '') as string;
          const toolName = (details.toolName || 'unknown') as string;
          const isError = details.isError === true || details.isError === 'true';
          pendingToolCalls = pendingToolCalls.map(tc =>
            tc.id === toolCallId
              ? { ...tc, result: `${toolName} completed`, isError }
              : tc
          );
          break;
        }
      }
    });
    source.onerror = () => {};
    debugEventSource = source;
  }

  function disconnectDebugStream() {
    if (debugEventSource) { debugEventSource.close(); debugEventSource = null; }
  }

  // ── SSE parsing ──

  function parseSseLine(line: string): { field: string; value: string } | null {
    if (!line || line.startsWith(':')) return null;
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) return { field: line, value: '' };
    return { field: line.slice(0, colonIndex), value: line.slice(colonIndex + 1).replace(/^ /, '') };
  }

  // ── Send message ──

  async function sendMessage() {
    if (!inputText.trim() || isStreaming || !bootstrap) return;

    const userText = inputText.trim();
    inputText = '';

    // Add user message
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userText,
      timestamp: Date.now(),
    };
    messages = [...messages, userMsg];
    await scrollToBottom();

    // Begin streaming
    isStreaming = true;
    streamingContent = '';
    streamingThinking = '';
    pendingToolCalls = [];
    abortController = new AbortController();

    try {
      const endpointUrl = new URL(bootstrap.api.chatCompletionsUrl, window.location.origin);
      const apiKey = bootstrap.api.apiKey || bootstrap.runtime.apiKey || getToken();

      const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'X-Session-ID': bootstrap.defaultSessionId,
        'X-User-ID': bootstrap.defaultAuthorId,
        'X-User-Name': bootstrap.defaultAuthorName,
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      // Build message history for the API
      const recent = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-MAX_CONTEXT_MESSAGES);
      const apiMessages = [
        ...recent.map(m => ({ role: m.role, content: m.content })).filter(m => m.content),
      ];

      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        signal: abortController.signal,
        body: JSON.stringify({
          model: bootstrap.runtime.model.id,
          stream: true,
          messages: apiMessages,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        let reason = `status ${response.status}`;
        try { const j = JSON.parse(body); reason = j?.error?.message || j?.error?.type || reason; } catch { /* skip */ }
        throw new Error(`Completion request failed: ${reason}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseSseLine(line);
          if (!parsed || parsed.field !== 'data') continue;
          const dataValue = parsed.value.trim();
          if (dataValue === '[DONE]' || !dataValue) continue;
          let chunk;
          try { chunk = JSON.parse(dataValue); } catch { continue; }
          const choice = chunk?.choices?.[0];
          if (choice?.delta?.content) {
            streamingContent += choice.delta.content;
            await scrollToBottom();
          }
        }
      }

      if (!streamingContent) throw new Error('Completion stream did not produce any text');

      // Finalize assistant message
      const assistantMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        content: streamingContent,
        timestamp: Date.now(),
        thinking: streamingThinking || undefined,
        toolCalls: pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined,
      };
      messages = [...messages, assistantMsg];
      statusDetail = 'Garden chat is ready.';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        statusDetail = 'Request aborted.';
      } else {
        const message = err instanceof Error ? err.message : String(err);
        error = message;
        const errorMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${message}`,
          timestamp: Date.now(),
        };
        messages = [...messages, errorMsg];
        statusDetail = `Chat request failed: ${message}`;
      }
    } finally {
      isStreaming = false;
      streamingContent = '';
      streamingThinking = '';
      pendingToolCalls = [];
      abortController = null;
      await scrollToBottom();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function abortStream() {
    if (abortController) abortController.abort();
  }

  async function scrollToBottom() {
    await tick();
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  // ── Contact/privacy selectors ──

  async function onContactChange() {
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
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update privacy level';
    } finally {
      saving = false;
    }
  }

  function contactLabel(opt: AdminChatBootstrapResponse['contactOptions'][0]): string {
    return opt.nickname ? `${opt.displayName} (${opt.nickname})` : opt.displayName;
  }

  function toggleThinking(id: string) {
    const next = new Set(expandedThinking);
    if (next.has(id)) next.delete(id); else next.add(id);
    expandedThinking = next;
  }

  function toggleTools(id: string) {
    const next = new Set(expandedTools);
    if (next.has(id)) next.delete(id); else next.add(id);
    expandedTools = next;
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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

<div class="flex flex-col" style="height: calc(100vh - 6rem);">
  <!-- Header -->
  <div class="flex items-center justify-between mb-3 shrink-0">
    <div>
      <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Canopy</h1>
      <p class="text-shadow-600 text-sm mt-0.5">Chat interface</p>
    </div>
    <div class="flex items-center gap-2">
      <span class="inline-block w-2.5 h-2.5 rounded-full {STATUS_DOT[connectionStatus]}"></span>
      <span class="text-sm font-medium {STATUS_TEXT[connectionStatus]}">{STATUS_LABEL[connectionStatus]}</span>
      {#if statusDetail && connectionStatus !== 'connecting'}
        <span class="text-sm text-shadow-600">-- {statusDetail}</span>
      {/if}
    </div>
  </div>

  {#if loading}
    <div class="card-garden p-6 animate-pulse flex-1">
      <div class="h-4 bg-bark-200 rounded w-48 mb-4"></div>
      <div class="h-64 bg-bark-200 rounded"></div>
    </div>
  {:else if error && !bootstrap}
    <div class="card-garden p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium text-sm">Failed to load chat</p>
      <p class="text-shadow-600 text-sm mt-1">{error}</p>
      <p class="text-shadow-600 text-sm mt-3">
        Make sure the admin server is running and the chat bootstrap endpoint is available.
      </p>
    </div>
  {:else if bootstrap}
    <!-- Controls Bar -->
    <div class="card-garden p-3 mb-3 shrink-0">
      <div class="flex flex-wrap items-end gap-3">
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
            Model: {bootstrap.runtime.model.name}
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
        <div class="mt-3 pt-3 border-t border-bark-200 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
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
        </div>
      {/if}
    </div>

    <!-- Chat Messages Area -->
    <div
      bind:this={messagesContainer}
      class="flex-1 overflow-y-auto rounded-xl border border-bark-300 bg-bark-100 px-4 py-3"
    >
      {#if messages.length === 0 && !isStreaming}
        <div class="flex items-center justify-center h-full">
          <div class="text-center">
            <p class="text-shadow-600 text-sm">No messages yet.</p>
            <p class="text-shadow-500 text-sm mt-1">Type a message below to start chatting.</p>
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          {#each messages as msg (msg.id)}
            <!-- Thinking section (collapsible) -->
            {#if msg.thinking}
              <div class="max-w-[85%]">
                <button
                  onclick={() => toggleThinking(msg.id)}
                  class="flex items-center gap-1.5 text-sm text-shadow-500 hover:text-shadow-700 transition-colors mb-1"
                >
                  <svg class="w-3.5 h-3.5 transition-transform {expandedThinking.has(msg.id) ? 'rotate-90' : ''}"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                  Thinking...
                </button>
                {#if expandedThinking.has(msg.id)}
                  <div class="ml-5 p-3 rounded-lg bg-bark-200 border border-bark-300 text-sm text-shadow-700 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {msg.thinking}
                  </div>
                {/if}
              </div>
            {/if}

            <!-- Tool calls section (collapsible) -->
            {#if msg.toolCalls && msg.toolCalls.length > 0}
              <div class="max-w-[85%]">
                <button
                  onclick={() => toggleTools(msg.id)}
                  class="flex items-center gap-1.5 text-sm text-shadow-500 hover:text-shadow-700 transition-colors mb-1"
                >
                  <svg class="w-3.5 h-3.5 transition-transform {expandedTools.has(msg.id) ? 'rotate-90' : ''}"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                  {msg.toolCalls.length} tool call{msg.toolCalls.length !== 1 ? 's' : ''}
                </button>
                {#if expandedTools.has(msg.id)}
                  <div class="ml-5 space-y-1.5">
                    {#each msg.toolCalls as tc}
                      <div class="p-2.5 rounded-lg border text-sm
                        {tc.isError ? 'bg-wilt-50 border-wilt-200' : 'bg-bark-200 border-bark-300'}">
                        <span class="font-medium text-shadow-800">{tc.name}</span>
                        {#if tc.result}
                          <span class="text-shadow-600 ml-2">{tc.result}</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}

            <!-- Message bubble -->
            <div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
              <div class="max-w-[85%] {msg.role === 'user'
                ? 'bg-gold-50 border border-gold-200 rounded-2xl rounded-br-md'
                : 'bg-white border border-bark-300 rounded-2xl rounded-bl-md'} px-4 py-2.5 shadow-sm">
                <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed break-words">{msg.content}</div>
                <div class="text-right mt-1">
                  <span class="text-sm text-shadow-500">{formatTime(msg.timestamp)}</span>
                </div>
              </div>
            </div>
          {/each}

          <!-- Streaming message in progress -->
          {#if isStreaming}
            <!-- Streaming thinking -->
            {#if streamingThinking}
              <div class="max-w-[85%]">
                <div class="flex items-center gap-1.5 text-sm text-shadow-500 mb-1">
                  <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2v4m0 12v4m-8-10H2m20 0h-4m-2.343-5.657L16.243 4.929M7.757 19.071l-1.414 1.414M19.071 16.243l1.414 1.414M4.929 7.757 3.515 6.343" />
                  </svg>
                  Thinking...
                </div>
                <div class="ml-5 p-3 rounded-lg bg-bark-200 border border-bark-300 text-sm text-shadow-700 font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {streamingThinking}
                </div>
              </div>
            {/if}

            <!-- Streaming tool calls -->
            {#if pendingToolCalls.length > 0}
              <div class="max-w-[85%] space-y-1.5">
                {#each pendingToolCalls as tc}
                  <div class="p-2.5 rounded-lg border text-sm
                    {tc.result ? (tc.isError ? 'bg-wilt-50 border-wilt-200' : 'bg-bark-200 border-bark-300') : 'bg-gold-50 border-gold-200 animate-pulse'}">
                    <span class="font-medium text-shadow-800">{tc.name}</span>
                    {#if tc.result}
                      <span class="text-shadow-600 ml-2">{tc.result}</span>
                    {:else}
                      <span class="text-shadow-500 ml-2">running...</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Streaming content bubble -->
            {#if streamingContent}
              <div class="flex justify-start">
                <div class="max-w-[85%] bg-white border border-bark-300 rounded-2xl rounded-bl-md px-4 py-2.5 shadow-sm">
                  <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed break-words">{streamingContent}</div>
                </div>
              </div>
            {:else if !streamingThinking && pendingToolCalls.length === 0}
              <div class="flex justify-start">
                <div class="max-w-[85%] bg-white border border-bark-300 rounded-2xl rounded-bl-md px-4 py-2.5 shadow-sm">
                  <div class="flex items-center gap-2 text-sm text-shadow-600">
                    <span class="inline-block w-2 h-2 bg-gold-400 rounded-full animate-pulse"></span>
                    Waiting for Purrsephone...
                  </div>
                </div>
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Input Area -->
    <div class="mt-3 shrink-0">
      <div class="card-garden p-3 flex items-end gap-2">
        <textarea
          bind:this={inputEl}
          bind:value={inputText}
          onkeydown={handleKeydown}
          disabled={isStreaming}
          rows={2}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          class="flex-1 px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm resize-none
                 placeholder:text-shadow-400
                 focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400
                 disabled:opacity-50 disabled:cursor-not-allowed"
        ></textarea>
        {#if isStreaming}
          <button
            onclick={abortStream}
            class="px-4 py-2 rounded-lg bg-wilt-600 text-white text-sm font-medium
                   hover:bg-wilt-400 transition-colors shrink-0"
          >
            Stop
          </button>
        {:else}
          <button
            onclick={sendMessage}
            disabled={!inputText.trim()}
            class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium
                   hover:bg-gold-700 disabled:opacity-50 transition-colors shrink-0"
          >
            Send
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>
