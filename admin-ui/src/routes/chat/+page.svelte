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
  let moduleError = $state('');
  let agentHostEl = $state<HTMLDivElement | null>(null);

  // Form state
  let selectedContactId = $state('');
  let selectedPrivacyLevel = $state('');
  let showIdentityDetails = $state(false);

  // pi-web-ui module + session state
  let piModule: { setAppStorage: (s: unknown) => void } | null = null;
  let session: AgentInterfaceSession | null = null;
  let debugEventSource: EventSource | null = null;

  // Health check interval
  let healthInterval: ReturnType<typeof setInterval> | undefined;

  // ── Constants ──
  const PROVIDER_KEY_PLACEHOLDER = 'admin-chat-local-key';
  const DEFAULT_MODEL_ID = 'purrsephone-admin-chat';
  const DEFAULT_MODEL_NAME = 'PSFN Garden Chat';
  const DEFAULT_SYSTEM_PROMPT = 'You are Purrsephone speaking through the garden chat canopy.';
  const MAX_CONTEXT_MESSAGES = 40;
  const DEBUG_SSE_PATH = '/api/chat/events/stream';

  // ── AgentInterfaceSession (port from chat.js) ──
  // Minimal session implementation for the pi-web-ui <agent-interface> component

  interface AgentInterfaceSessionOptions {
    providerKeys: SimpleKVStore;
    getBootstrap: () => AdminChatBootstrapResponse;
    onStatus: (message: string, isError?: boolean) => void;
    onModelChange: () => void;
    seedProviderKey: (provider: string) => Promise<void>;
  }

  interface SimpleKVStore {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
    has(key: string): boolean;
  }

  function createMemoryStore(entries: [string, string][] = []): SimpleKVStore {
    const map = new Map<string, string>(entries);
    return {
      async get(key: string) { return map.get(key); },
      async set(key: string, value: string) { map.set(key, value); },
      async delete(key: string) { map.delete(key); },
      async keys() { return Array.from(map.keys()); },
      has(key: string) { return map.has(key); },
    };
  }

  function createDefaultModel() {
    return {
      id: DEFAULT_MODEL_ID,
      name: DEFAULT_MODEL_NAME,
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 4096,
    };
  }

  function createAssistantMessage(content: string, payload: { usage?: unknown } | null, model: ReturnType<typeof createDefaultModel>) {
    const rawUsage = (payload as { usage?: Record<string, unknown> })?.usage;
    const input = Number(rawUsage?.prompt_tokens) || 0;
    const output = Number(rawUsage?.completion_tokens) || 0;
    return {
      role: 'assistant' as const,
      content,
      timestamp: Date.now(),
      api: model?.api || 'openai-completions',
      provider: model?.provider || 'openai',
      model: model?.id || DEFAULT_MODEL_ID,
      stopReason: 'stop',
      usage: (input || output) ? {
        input, output, cacheRead: 0, cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } : undefined,
    };
  }

  function parseMessageContentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
        }
        return '';
      }).join('').trim();
    }
    if (content && typeof content === 'object') {
      const c = content as Record<string, unknown>;
      if (typeof c.text === 'string') return c.text;
      if (typeof c.content === 'string') return c.content;
    }
    return '';
  }

  function parseSseLine(line: string): { field: string; value: string } | null {
    if (!line || line.startsWith(':')) return null;
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) return { field: line, value: '' };
    return { field: line.slice(0, colonIndex), value: line.slice(colonIndex + 1).replace(/^ /, '') };
  }

  async function streamChatCompletion(opts: {
    bootstrap: AdminChatBootstrapResponse;
    modelId: string;
    history: Array<{ role: string; content: unknown }>;
    systemPrompt: string;
    signal: AbortSignal;
    onDelta: (delta: string) => void;
  }) {
    const endpointUrl = new URL(opts.bootstrap.api.chatCompletionsUrl, window.location.origin);
    const apiKey = opts.bootstrap.api.apiKey || opts.bootstrap.runtime.apiKey || PROVIDER_KEY_PLACEHOLDER;
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Session-ID': opts.bootstrap.defaultSessionId,
      'X-User-ID': opts.bootstrap.defaultAuthorId,
      'X-User-Name': opts.bootstrap.defaultAuthorName,
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const recent = opts.history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_CONTEXT_MESSAGES);
    const messages = [
      { role: 'system', content: opts.systemPrompt },
      ...recent.map(m => ({ role: m.role, content: parseMessageContentText(m.content) })).filter(m => m.content),
    ];

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      signal: opts.signal,
      body: JSON.stringify({ model: opts.modelId, stream: true, messages }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let reason = `status ${response.status}`;
      try { const j = JSON.parse(body); reason = j?.error?.message || j?.error?.type || reason; } catch { /* ignore */ }
      throw new Error(`Completion request failed: ${reason}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage = null;

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
        if (choice?.delta?.content) opts.onDelta(choice.delta.content);
        if (chunk?.usage) lastUsage = chunk.usage;
      }
    }
    return lastUsage;
  }

  class AgentInterfaceSession {
    listeners = new Set<(event: unknown) => void>();
    abortController: AbortController | null = null;
    debugEventSource: EventSource | null = null;
    state: {
      systemPrompt: string;
      model: ReturnType<typeof createDefaultModel>;
      thinkingLevel: string;
      tools: unknown[];
      messages: Array<{ role: string; content: unknown; timestamp?: number; [k: string]: unknown }>;
      isStreaming: boolean;
      streamMessage: Record<string, unknown> | null;
      pendingToolCalls: Set<string>;
      error?: string;
    };
    options: AgentInterfaceSessionOptions;
    getApiKey: (provider: string) => Promise<string | undefined>;

    constructor(options: AgentInterfaceSessionOptions) {
      this.options = options;
      this.getApiKey = async (provider: string) => options.providerKeys.get(provider);
      this.state = {
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        model: createDefaultModel(),
        thinkingLevel: 'off',
        tools: [],
        messages: [],
        isStreaming: false,
        streamMessage: null,
        pendingToolCalls: new Set(),
        error: undefined,
      };
    }

    connectDebugStream() {
      if (this.debugEventSource) return;
      const url = new URL(DEBUG_SSE_PATH, window.location.origin);
      const source = new EventSource(url, { withCredentials: true });
      source.addEventListener('chat-debug', (event: MessageEvent) => {
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (!payload || typeof payload !== 'object' || !this.state.isStreaming || !this.state.streamMessage) return;
        const streamMsg = this.state.streamMessage;
        switch (payload.event) {
          case 'agent.stream.thinking': {
            const text = typeof payload.message === 'string' ? payload.message : '';
            if (text) this.emit({ type: 'message_update', message: streamMsg, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: text, partial: streamMsg } });
            break;
          }
          case 'agent.tool.start': {
            const details = (payload.details || {}) as Record<string, unknown>;
            const toolCallId = (details.toolCallId || `tool-${Date.now()}`) as string;
            this.state.pendingToolCalls.add(toolCallId);
            this.emit({ type: 'tool_execution_start', toolCallId, toolName: (details.toolName || 'unknown') as string, args: {} });
            break;
          }
          case 'agent.tool.end': {
            const details = (payload.details || {}) as Record<string, unknown>;
            const toolCallId = (details.toolCallId || '') as string;
            this.state.pendingToolCalls.delete(toolCallId);
            this.emit({ type: 'tool_execution_end', toolCallId, toolName: (details.toolName || 'unknown') as string, result: {}, isError: details.isError === true || details.isError === 'true' });
            break;
          }
        }
      });
      source.onerror = () => {};
      this.debugEventSource = source;
    }

    disconnectDebugStream() {
      if (this.debugEventSource) { this.debugEventSource.close(); this.debugEventSource = null; }
    }

    subscribe(listener: (event: unknown) => void) {
      this.listeners.add(listener);
      return () => { this.listeners.delete(listener); };
    }

    emit(event: unknown) {
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* ignore */ }
      }
    }

    emitViewRefresh() {
      const lastMessage = this.state.messages[this.state.messages.length - 1] || createAssistantMessage('', null, this.state.model);
      this.emit({ type: 'turn_end', message: lastMessage, toolResults: [] });
    }

    setModel(model: ReturnType<typeof createDefaultModel>) {
      if (!model) return;
      this.state.model = model;
      void this.options.seedProviderKey(model.provider);
      this.options.onModelChange();
      this.emitViewRefresh();
    }

    setThinkingLevel(level: string) {
      this.state.thinkingLevel = level;
      this.emitViewRefresh();
    }

    abort() { if (this.abortController) this.abortController.abort(); }

    async prompt(input: unknown) {
      const promptText = typeof input === 'string' ? input.trim()
        : (input && typeof input === 'object' && 'content' in (input as Record<string, unknown>))
          ? parseMessageContentText((input as Record<string, unknown>).content)
          : '';
      if (!promptText || this.state.isStreaming) return;

      const userMessage = { role: 'user' as const, content: promptText, timestamp: Date.now() };
      this.state.messages.push(userMessage);
      this.state.error = undefined;
      this.state.isStreaming = true;
      this.options.onStatus('Waiting for Purrsephone...');
      this.emit({ type: 'agent_start' });
      this.emit({ type: 'turn_start' });
      this.emit({ type: 'message_start', message: userMessage });
      this.emit({ type: 'message_end', message: userMessage });

      let assistantMessage: Record<string, unknown> | null = null;
      this.abortController = new AbortController();

      try {
        let accumulatedText = '';
        const streamingMessage = createAssistantMessage('', null, this.state.model);
        this.state.streamMessage = streamingMessage;
        this.emit({ type: 'message_start', message: streamingMessage });

        const usage = await streamChatCompletion({
          bootstrap: this.options.getBootstrap(),
          modelId: this.state.model?.id || DEFAULT_MODEL_ID,
          history: this.state.messages,
          systemPrompt: this.state.systemPrompt,
          signal: this.abortController.signal,
          onDelta: (delta: string) => {
            accumulatedText += delta;
            streamingMessage.content = [{ type: 'text', text: accumulatedText }];
            this.emit({
              type: 'message_update', message: streamingMessage,
              assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: streamingMessage },
            });
          },
        });

        if (!accumulatedText) throw new Error('Completion stream did not produce any text');
        assistantMessage = createAssistantMessage(accumulatedText, { usage }, this.state.model);
        this.state.messages.push(assistantMessage as { role: string; content: unknown; [k: string]: unknown });
        this.state.streamMessage = null;
        this.emit({ type: 'message_end', message: assistantMessage });
        this.options.onStatus('Garden chat is ready.');
      } catch (err) {
        this.state.streamMessage = null;
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.options.onStatus('Request aborted.');
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.state.error = message;
          assistantMessage = createAssistantMessage(`Error: ${message}`, null, this.state.model);
          this.state.messages.push(assistantMessage as { role: string; content: unknown; [k: string]: unknown });
          this.emit({ type: 'message_start', message: assistantMessage });
          this.emit({ type: 'message_end', message: assistantMessage });
          this.options.onStatus(`Garden chat request failed: ${message}`, true);
        }
      } finally {
        this.state.isStreaming = false;
        this.abortController = null;
        this.emit({ type: 'turn_end', message: assistantMessage || createAssistantMessage('', null, this.state.model), toolResults: [] });
        this.emit({ type: 'agent_end', messages: [...this.state.messages] });
      }
    }
  }

  // ── localStorage sessions store ──
  const SESSIONS_STORAGE_KEY = 'psfn-garden-chat-sessions';
  const SESSION_META_STORAGE_KEY = 'psfn-garden-chat-sessions-meta';

  function readMap(storageKey: string): Record<string, unknown> {
    try { const raw = localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  }
  function writeMap(storageKey: string, map: Record<string, unknown>) {
    try { localStorage.setItem(storageKey, JSON.stringify(map)); } catch { /* ignore */ }
  }

  function createLocalStorageSessions() {
    return {
      getConfig() { return { name: 'sessions', keyPath: 'id' }; },
      static: { getMetadataConfig() { return { name: 'sessions-metadata', keyPath: 'id' }; } },
      async save(data: Record<string, unknown>, metadata: Record<string, unknown>) {
        const s = readMap(SESSIONS_STORAGE_KEY); s[(data as { id: string }).id] = data; writeMap(SESSIONS_STORAGE_KEY, s);
        const m = readMap(SESSION_META_STORAGE_KEY); m[(metadata as { id: string }).id] = metadata; writeMap(SESSION_META_STORAGE_KEY, m);
      },
      async get(id: string) { return (readMap(SESSIONS_STORAGE_KEY) as Record<string, unknown>)[id] || null; },
      async getMetadata(id: string) { return (readMap(SESSION_META_STORAGE_KEY) as Record<string, unknown>)[id] || null; },
      async getAllMetadata() { return Object.values(readMap(SESSION_META_STORAGE_KEY)).sort((a, b) => ((b as Record<string, string>).lastModified || '').localeCompare((a as Record<string, string>).lastModified || '')); },
      async delete(id: string) { const s = readMap(SESSIONS_STORAGE_KEY); delete s[id]; writeMap(SESSIONS_STORAGE_KEY, s); const m = readMap(SESSION_META_STORAGE_KEY); delete m[id]; writeMap(SESSION_META_STORAGE_KEY, m); },
      async deleteSession(id: string) { return this.delete(id); },
      async updateTitle(id: string, title: string) { const m = readMap(SESSION_META_STORAGE_KEY); if (m[id]) { (m[id] as Record<string, unknown>).title = title; writeMap(SESSION_META_STORAGE_KEY, m); } },
      async getQuotaInfo() { return { usage: 0, quota: 5 * 1024 * 1024, percent: 0 }; },
      async requestPersistence() { return true; },
      async saveSession(id: string, state: Record<string, unknown>, metadata: Record<string, unknown> | null, title?: string) {
        const now = new Date().toISOString();
        const data = { id, title: title || (metadata as Record<string, string>)?.title || 'Garden Chat', model: state.model, thinkingLevel: state.thinkingLevel, messages: state.messages, createdAt: (metadata as Record<string, string>)?.createdAt || now, lastModified: now };
        const meta = metadata || { id, title: title || 'Garden Chat', createdAt: now, lastModified: now, messageCount: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, thinkingLevel: 'off', preview: '' };
        (meta as Record<string, unknown>).lastModified = now;
        (meta as Record<string, unknown>).messageCount = (state.messages as unknown[]).length;
        await this.save(data, meta as Record<string, unknown>);
      },
      async loadSession(id: string) { return this.get(id); },
      async getLatestSessionId() { const all = await this.getAllMetadata(); return all.length > 0 ? (all[0] as Record<string, string>).id : null; },
      setBackend() {},
    };
  }

  function createRuntimeStores(initialApiKey: string) {
    const key = initialApiKey?.trim() || PROVIDER_KEY_PLACEHOLDER;
    const providerKeys = createMemoryStore([['openai', key]]);
    const settings = createMemoryStore([['proxy.enabled', 'false'], ['proxy.url', '']]);
    const sessions = createLocalStorageSessions();
    return {
      appStorage: {
        settings,
        providerKeys,
        customProviders: { async getAll() { return []; } },
        sessions,
        backend: { async getQuotaInfo() { return { usage: 0, quota: 5 * 1024 * 1024, percent: 0 }; }, async requestPersistence() { return true; } },
      },
      providerKeys,
    };
  }

  // ── Lifecycle ──

  onMount(async () => {
    try {
      bootstrap = await getChatBootstrap();
      selectedContactId = bootstrap.canonicalContactId;
      selectedPrivacyLevel = bootstrap.privacy.selectedLevel;
      await checkConnection();
      healthInterval = setInterval(checkConnection, 30_000);
      // Mount the pi-web-ui agent-interface element
      await mountAgentInterface();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load chat bootstrap';
      connectionStatus = 'error';
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    if (healthInterval) clearInterval(healthInterval);
    if (session) session.disconnectDebugStream();
    if (debugEventSource) { debugEventSource.close(); debugEventSource = null; }
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

  async function mountAgentInterface() {
    if (!bootstrap || !agentHostEl) return;

    const assets = bootstrap.runtime.assets;
    const moduleUrl = assets.moduleUrl || '/static/pi-web-ui/index.js';
    const stylesheetUrl = assets.stylesheetUrl || '/static/pi-web-ui/app.css';

    // Load stylesheet
    try {
      await loadStylesheet(stylesheetUrl);
    } catch (e) {
      moduleError = `Failed to load pi-web-ui stylesheet: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }

    // Load the module (dynamic import via the admin server's import-rewriting system)
    try {
      piModule = await import(/* @vite-ignore */ moduleUrl) as { setAppStorage: (s: unknown) => void };
    } catch (e) {
      moduleError = `Failed to load pi-web-ui module: ${e instanceof Error ? e.message : String(e)}. The admin server's import rewriting may not be running.`;
      return;
    }

    // Set up runtime stores
    const apiKey = bootstrap.api.apiKey || bootstrap.runtime.apiKey || PROVIDER_KEY_PLACEHOLDER;
    const stores = createRuntimeStores(apiKey);
    piModule.setAppStorage(stores.appStorage);

    const seedProviderKey = async (provider: string) => {
      const normalizedProvider = provider?.trim() || 'openai';
      const bootstrapKey = bootstrap!.api.apiKey || bootstrap!.runtime.apiKey || '';
      if (!bootstrapKey) return;
      const currentKey = (await stores.providerKeys.get(normalizedProvider))?.trim() || '';
      if (!currentKey || currentKey === PROVIDER_KEY_PLACEHOLDER) {
        await stores.providerKeys.set(normalizedProvider, bootstrapKey);
      }
    };

    // Create the session
    session = new AgentInterfaceSession({
      providerKeys: stores.providerKeys,
      getBootstrap: () => bootstrap!,
      onStatus: (message: string) => { statusDetail = message; },
      onModelChange: () => {},
      seedProviderKey,
    });

    session.connectDebugStream();
    await seedProviderKey(session.state.model.provider);

    // Wait for the custom element to be defined, then create and mount it
    try {
      await customElements.whenDefined('agent-interface');
    } catch {
      // If whenDefined times out or fails, try creating the element anyway
    }

    const agentInterface = document.createElement('agent-interface');
    (agentInterface as unknown as Record<string, unknown>).enableAttachments = false;
    (agentInterface as unknown as Record<string, unknown>).enableModelSelector = true;
    (agentInterface as unknown as Record<string, unknown>).enableThinkingSelector = true;
    (agentInterface as unknown as Record<string, unknown>).showThemeToggle = false;
    (agentInterface as unknown as Record<string, unknown>).onApiKeyRequired = async (provider: string) => {
      const existing = (await stores.providerKeys.get(provider))?.trim() || '';
      if (existing && existing !== PROVIDER_KEY_PLACEHOLDER) return true;
      const entered = window.prompt(`Enter API key for ${provider}`);
      if (!entered?.trim()) return false;
      await stores.providerKeys.set(provider, entered.trim());
      return true;
    };
    (agentInterface as unknown as Record<string, unknown>).session = session;

    agentHostEl.replaceChildren(agentInterface);
  }

  function loadStylesheet(href: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`link[data-chat-agent-style="${href}"]`);
      if (existing) { resolve(); return; }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.chatAgentStyle = href;
      link.onload = () => resolve();
      link.onerror = () => { link.remove(); reject(new Error(`Failed loading stylesheet ${href}`)); };
      document.head.append(link);
    });
  }

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
      // Remount the agent interface with new identity
      if (agentHostEl) await mountAgentInterface();
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
      if (agentHostEl) await mountAgentInterface();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update privacy level';
    } finally {
      saving = false;
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

    <!-- Agent Interface Host -->
    {#if moduleError}
      <div class="card-garden p-6 border-l-4 border-l-wilt-400">
        <p class="text-sm font-medium text-shadow-800 mb-2">Unable to load pi-web-ui chat component</p>
        <p class="text-sm text-shadow-600 mb-3">{moduleError}</p>
        <a
          href="/chat"
          class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium
                 hover:bg-gold-700 transition-colors"
        >
          Open htmx chat fallback
        </a>
      </div>
    {:else}
      <div
        bind:this={agentHostEl}
        class="rounded-xl overflow-hidden border border-bark-300 bg-white"
        style="height: calc(100vh - 16rem);"
      >
        <div class="flex items-center justify-center h-full text-shadow-600 text-sm">
          Loading AgentInterface runtime...
        </div>
      </div>
    {/if}
  {/if}
</div>
