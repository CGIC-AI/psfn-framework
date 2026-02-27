const BOOTSTRAP_URL = '/api/chat/bootstrap';
const DEFAULT_MODEL_ID = 'psfn-admin-chat';
const DEFAULT_MODEL_NAME = 'PSFN Garden Chat';
const DEFAULT_SYSTEM_PROMPT = 'You are PSFN speaking through the garden chat canopy.';
const PROVIDER_KEY_PLACEHOLDER = 'admin-chat-local-key';
const MAX_CONTEXT_MESSAGES = 40;

const PI_WEB_UI_MODULE_CANDIDATES = [
  'https://esm.sh/@mariozechner/pi-web-ui@0.52.12?target=es2022',
  'https://cdn.jsdelivr.net/npm/@mariozechner/pi-web-ui@0.52.12/+esm',
];

const PI_WEB_UI_STYLESHEET_CANDIDATES = [
  'https://esm.sh/@mariozechner/pi-web-ui@0.52.12/app.css',
  'https://cdn.jsdelivr.net/npm/@mariozechner/pi-web-ui@0.52.12/dist/app.css',
];

const PLACEHOLDER_TOKENS = new Set([PROVIDER_KEY_PLACEHOLDER]);

let piWebUiModulePromise = null;

function requiredElement(root, selector) {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function setStatus(dom, message, isError = false) {
  dom.status.textContent = message;
  dom.status.classList.toggle('is-error', isError);
}

function setControlsDisabled(dom, disabled) {
  const fields = dom.form.querySelectorAll('input, select, textarea, button');
  for (const field of fields) {
    field.disabled = disabled;
  }
}

async function readJsonBody(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected JSON payload: ${text.slice(0, 240)}`);
  }
}

async function fetchBootstrapState() {
  const response = await fetch(BOOTSTRAP_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Bootstrap GET failed (${response.status})`);
  }
  return readJsonBody(response);
}

async function postBootstrapState(payload) {
  const response = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await readJsonBody(response).catch(() => ({}));
    const reason = typeof body.error === 'string' ? body.error : `status ${response.status}`;
    throw new Error(`Bootstrap POST failed: ${reason}`);
  }
  return readJsonBody(response);
}

function buildTransportHeaders(bootstrap) {
  return {
    'X-Session-ID': bootstrap.defaultSessionId,
    'X-User-ID': bootstrap.defaultAuthorId,
    'X-User-Name': bootstrap.defaultAuthorName,
  };
}

function readBootstrapApiKey(bootstrap) {
  const key = normalizeText(bootstrap?.api?.apiKey);
  if (!key || PLACEHOLDER_TOKENS.has(key)) return '';
  return key;
}

function resolveClientApiKey(bootstrap) {
  return readBootstrapApiKey(bootstrap) || PROVIDER_KEY_PLACEHOLDER;
}

function createBootstrapSelectionFromControls(dom) {
  return {
    canonicalContactId: dom.canonicalContact.value,
    channel: normalizeText(dom.channel.value),
    userId: normalizeText(dom.userId.value),
    privacyLevel: dom.privacy.value,
    defaultAuthorName: dom.authorName.value,
    defaultAuthorId: dom.authorId.value,
  };
}

function findContactOption(bootstrap, canonicalContactId) {
  return bootstrap.contactOptions.find(option => option.canonicalContactId === canonicalContactId);
}

function chooseIdentityForContact(contact, fallbackIdentity) {
  if (contact && Array.isArray(contact.linkedChannels) && contact.linkedChannels.length > 0) {
    return contact.linkedChannels[0];
  }
  return fallbackIdentity;
}

function normalizeSelectionForSubmit(dom, bootstrap, changedField) {
  const selected = createBootstrapSelectionFromControls(dom);
  const selectedContact = findContactOption(bootstrap, selected.canonicalContactId) || bootstrap.contactOptions[0];
  if (selectedContact) {
    selected.canonicalContactId = selectedContact.canonicalContactId;
  }

  const mustRebaseIdentity = changedField === 'canonicalContactId' || !selected.channel || !selected.userId;
  if (mustRebaseIdentity && selectedContact) {
    const identity = chooseIdentityForContact(selectedContact, bootstrap.selectedIdentity);
    selected.channel = identity.channel;
    selected.userId = identity.userId;
    selected.privacyLevel = identity.privacyLevel;
  }

  if (!bootstrap.privacy.availableLevels.includes(selected.privacyLevel)) {
    selected.privacyLevel = bootstrap.privacy.selectedLevel;
  }

  dom.channel.value = selected.channel;
  dom.userId.value = selected.userId;
  dom.privacy.value = selected.privacyLevel;

  return selected;
}

function toBootstrapUpdatePayload(selection) {
  const payload = {
    canonicalContactId: selection.canonicalContactId,
    privacyLevel: selection.privacyLevel,
    defaultAuthorName: selection.defaultAuthorName,
    defaultAuthorId: selection.defaultAuthorId,
  };

  if (selection.channel && selection.userId) {
    payload.channel = selection.channel;
    payload.userId = selection.userId;
  }

  return payload;
}

function createContactLabel(contact) {
  const nickname = normalizeText(contact.nickname);
  return nickname
    ? `${contact.displayName} (${nickname})`
    : contact.displayName;
}

function replaceSelectOptions(select, options, selectedValue) {
  const fragments = options.map(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (value === selectedValue) {
      option.selected = true;
    }
    return option;
  });
  select.replaceChildren(...fragments);
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
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 131072,
    maxTokens: 4096,
  };
}

function renderControls(dom, bootstrap, model = null) {
  const contactOptions = bootstrap.contactOptions.map(option => ({
    value: option.canonicalContactId,
    label: createContactLabel(option),
  }));
  replaceSelectOptions(dom.canonicalContact, contactOptions, bootstrap.canonicalContactId);

  const privacyOptions = bootstrap.privacy.availableLevels.map(level => ({
    value: level,
    label: level,
  }));
  replaceSelectOptions(dom.privacy, privacyOptions, bootstrap.privacy.selectedLevel);

  dom.channel.value = bootstrap.selectedIdentity.channel;
  dom.userId.value = bootstrap.selectedIdentity.userId;
  dom.authorName.value = bootstrap.defaultAuthorName;
  dom.authorId.value = bootstrap.defaultAuthorId;

  const nickname = normalizeText(bootstrap.nickname);
  const displayName = nickname ? `${bootstrap.displayName} (${nickname})` : bootstrap.displayName;
  const modelName = normalizeText(model?.name) || DEFAULT_MODEL_NAME;
  dom.contactMeta.textContent = `Mapped contact: ${displayName} | Session: ${bootstrap.defaultSessionId} | Model: ${modelName}`;
  dom.agentContext.textContent = `Identity ${bootstrap.selectedIdentity.channel}:${bootstrap.selectedIdentity.userId} | Privacy ${bootstrap.privacy.selectedLevel}`;
}

function createDomBindings(root) {
  return {
    form: requiredElement(root, '[data-chat-controls]'),
    canonicalContact: requiredElement(root, '#chat-canonical-contact'),
    channel: requiredElement(root, '#chat-channel'),
    userId: requiredElement(root, '#chat-user-id'),
    privacy: requiredElement(root, '#chat-privacy'),
    authorName: requiredElement(root, '#chat-author-name'),
    authorId: requiredElement(root, '#chat-author-id'),
    contactMeta: requiredElement(root, '[data-chat-contact-meta]'),
    agentContext: requiredElement(root, '[data-chat-agent-context]'),
    status: requiredElement(root, '[data-chat-status]'),
    agentHost: requiredElement(root, '[data-chat-agent-host]'),
  };
}

function parseMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (part.type === 'text' && typeof part.content === 'string') return part.content;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

function parseCompletionText(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return '';

  const fromMessage = parseMessageContentText(choice?.message?.content);
  if (fromMessage) return fromMessage;

  const fromDelta = parseMessageContentText(choice?.delta?.content);
  if (fromDelta) return fromDelta;

  return '';
}

function buildApiMessages(history, systemPrompt) {
  const recent = history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-MAX_CONTEXT_MESSAGES);

  const messages = [{
    role: 'system',
    content: systemPrompt,
  }];

  for (const message of recent) {
    const content = parseMessageContentText(message.content);
    if (!content) continue;
    messages.push({
      role: message.role,
      content,
    });
  }

  return messages;
}

function normalizePromptInput(input) {
  if (typeof input === 'string') return normalizeText(input);
  if (!input || typeof input !== 'object') return '';
  if ('content' in input) {
    return normalizeText(parseMessageContentText(input.content));
  }
  return '';
}

function createUsageSummary(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;
  const input = Number(rawUsage.prompt_tokens) || 0;
  const output = Number(rawUsage.completion_tokens) || 0;
  if (!input && !output) return undefined;

  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistantMessage(content, payload, model) {
  return {
    role: 'assistant',
    content,
    timestamp: Date.now(),
    api: model?.api || 'openai-completions',
    provider: model?.provider || 'openai',
    model: model?.id || DEFAULT_MODEL_ID,
    stopReason: 'stop',
    usage: createUsageSummary(payload?.usage),
  };
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function requestChatCompletion({ bootstrap, modelId, history, systemPrompt, signal }) {
  const endpointUrl = new URL(bootstrap.api.chatCompletionsUrl, window.location.origin);
  const apiKey = resolveClientApiKey(bootstrap);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...buildTransportHeaders(bootstrap),
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: modelId,
      stream: false,
      messages: buildApiMessages(history, systemPrompt),
    }),
  });

  if (!response.ok) {
    const body = await readJsonBody(response).catch(() => ({}));
    const reason = body?.error?.message || body?.error?.type || `status ${response.status}`;
    throw new Error(`Completion request failed: ${reason}`);
  }

  return readJsonBody(response);
}

class AgentInterfaceSession {
  constructor(options) {
    this.options = options;
    this.listeners = new Set();
    this.abortController = null;
    this.streamFn = null;
    this.getApiKey = async (provider) => this.options.providerKeys.get(provider);
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

  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[admin/chat/session-listener]', error);
      }
    }
  }

  emitViewRefresh() {
    const lastMessage = this.state.messages[this.state.messages.length - 1]
      || createAssistantMessage('', null, this.state.model);

    this.emit({
      type: 'turn_end',
      message: lastMessage,
      toolResults: [],
    });
  }

  setModel(model) {
    if (!model || typeof model !== 'object') return;
    this.state.model = model;
    void this.options.seedProviderKey(model.provider);
    this.options.onModelChange(model);
    this.emitViewRefresh();
  }

  setThinkingLevel(level) {
    this.state.thinkingLevel = level;
    this.emitViewRefresh();
  }

  abort() {
    if (!this.abortController) return;
    this.abortController.abort();
  }

  async prompt(input) {
    const promptText = normalizePromptInput(input);
    if (!promptText || this.state.isStreaming) return;

    const userMessage = {
      role: 'user',
      content: promptText,
      timestamp: Date.now(),
    };

    this.state.messages.push(userMessage);
    this.state.error = undefined;
    this.state.isStreaming = true;
    this.options.onStatus('Waiting for PSFN...');

    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });
    this.emit({ type: 'message_start', message: userMessage });
    this.emit({ type: 'message_end', message: userMessage });

    let assistantMessage = null;
    this.abortController = new AbortController();

    try {
      const completion = await requestChatCompletion({
        bootstrap: this.options.getBootstrap(),
        modelId: this.state.model?.id || DEFAULT_MODEL_ID,
        history: this.state.messages,
        systemPrompt: this.state.systemPrompt,
        signal: this.abortController.signal,
      });

      const assistantText = parseCompletionText(completion);
      if (!assistantText) {
        throw new Error('Completion payload did not include assistant text');
      }

      assistantMessage = createAssistantMessage(assistantText, completion, this.state.model);
      this.state.messages.push(assistantMessage);
      this.emit({ type: 'message_start', message: assistantMessage });
      this.emit({ type: 'message_end', message: assistantMessage });
      this.options.onStatus('Garden chat is ready.');
    } catch (error) {
      if (isAbortError(error)) {
        this.options.onStatus('Request aborted.');
      } else {
        const message = formatError(error);
        this.state.error = message;
        assistantMessage = createAssistantMessage(`Error: ${message}`, null, this.state.model);
        this.state.messages.push(assistantMessage);
        this.emit({ type: 'message_start', message: assistantMessage });
        this.emit({ type: 'message_end', message: assistantMessage });
        this.options.onStatus(`Garden chat request failed: ${message}`, true);
      }
    } finally {
      this.state.isStreaming = false;
      this.abortController = null;

      this.emit({
        type: 'turn_end',
        message: assistantMessage || createAssistantMessage('', null, this.state.model),
        toolResults: [],
      });
      this.emit({ type: 'agent_end', messages: [...this.state.messages] });
    }
  }
}

function createMemoryStore(initialEntries = []) {
  const map = new Map(initialEntries);
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async keys() {
      return Array.from(map.keys());
    },
    has(key) {
      return map.has(key);
    },
  };
}

function createRuntimeStores(initialApiKey) {
  const normalizedApiKey = normalizeText(initialApiKey);
  const providerEntries = normalizedApiKey
    ? [['openai', normalizedApiKey]]
    : [['openai', PROVIDER_KEY_PLACEHOLDER]];

  const providerKeys = createMemoryStore(providerEntries);
  const settings = createMemoryStore([
    ['proxy.enabled', false],
    ['proxy.url', ''],
  ]);

  const customProviders = {
    async getAll() {
      return [];
    },
  };

  const appStorage = {
    settings,
    providerKeys,
    customProviders,
    sessions: null,
    backend: {
      async getQuotaInfo() {
        return null;
      },
      async requestPersistence() {
        return false;
      },
    },
  };

  return {
    appStorage,
    providerKeys,
  };
}

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`link[data-chat-agent-style="${href}"]`);
    if (existing) {
      resolve();
      return;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.chatAgentStyle = href;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error(`Failed loading stylesheet ${href}`));
    };
    document.head.append(link);
  });
}

async function ensurePiWebUiStylesheets() {
  let lastError = null;

  for (const href of PI_WEB_UI_STYLESHEET_CANDIDATES) {
    try {
      await loadStylesheet(href);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to load pi-web-ui stylesheets: ${formatError(lastError)}`);
}

async function importPiWebUiModule() {
  let lastError = null;

  for (const url of PI_WEB_UI_MODULE_CANDIDATES) {
    try {
      return await import(url);
    } catch (error) {
      lastError = error;
      console.warn('[admin/chat] failed module import', { url, error: formatError(error) });
    }
  }

  throw new Error(`Unable to load pi-web-ui module: ${formatError(lastError)}`);
}

function loadPiWebUiModule() {
  if (!piWebUiModulePromise) {
    piWebUiModulePromise = importPiWebUiModule();
  }
  return piWebUiModulePromise;
}

function updateViewFromBootstrap(context) {
  const model = context.session?.state?.model || null;
  renderControls(context.dom, context.bootstrap, model);
}

function bindControlPersistence(context) {
  const handleChange = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const changedField = target.getAttribute('name') ?? '';
    if (!changedField) return;
    void persistControlChanges(context, changedField);
  };

  context.dom.form.addEventListener('change', handleChange);
}

async function persistControlChanges(context, changedField) {
  if (context.isUpdating) {
    context.pendingField = changedField;
    return;
  }

  context.isUpdating = true;
  context.pendingField = '';
  setControlsDisabled(context.dom, true);
  setStatus(context.dom, 'Saving garden identity settings...');

  try {
    const normalizedSelection = normalizeSelectionForSubmit(context.dom, context.bootstrap, changedField);
    const payload = toBootstrapUpdatePayload(normalizedSelection);
    const refreshed = await postBootstrapState(payload);
    context.bootstrap = refreshed;
    updateViewFromBootstrap(context);

    if (context.seedProviderKey) {
      await context.seedProviderKey(context.session?.state?.model?.provider || 'openai');
    }

    setStatus(context.dom, 'Garden chat is ready.');
  } catch (error) {
    setStatus(context.dom, `Unable to update garden chat settings: ${formatError(error)}`, true);
  } finally {
    setControlsDisabled(context.dom, false);
    context.isUpdating = false;
    if (context.pendingField) {
      const nextField = context.pendingField;
      context.pendingField = '';
      void persistControlChanges(context, nextField);
    }
  }
}

async function mountAgentInterface(context) {
  setStatus(context.dom, 'Loading AgentInterface runtime...');

  const module = await loadPiWebUiModule();
  await ensurePiWebUiStylesheets();

  const stores = createRuntimeStores(resolveClientApiKey(context.bootstrap));
  module.setAppStorage(stores.appStorage);

  context.seedProviderKey = async (provider) => {
    const normalizedProvider = normalizeText(provider) || 'openai';
    const bootstrapKey = resolveClientApiKey(context.bootstrap);
    if (!bootstrapKey) return;

    const currentKey = normalizeText(await stores.providerKeys.get(normalizedProvider));
    if (!currentKey || PLACEHOLDER_TOKENS.has(currentKey)) {
      await stores.providerKeys.set(normalizedProvider, bootstrapKey);
    }
  };

  const session = new AgentInterfaceSession({
    providerKeys: stores.providerKeys,
    getBootstrap: () => context.bootstrap,
    onStatus: (message, isError = false) => setStatus(context.dom, message, isError),
    onModelChange: () => updateViewFromBootstrap(context),
    seedProviderKey: context.seedProviderKey,
  });
  context.session = session;

  await context.seedProviderKey(session.state.model.provider);
  updateViewFromBootstrap(context);

  const agentInterface = document.createElement('agent-interface');
  agentInterface.enableAttachments = false;
  agentInterface.enableModelSelector = true;
  agentInterface.enableThinkingSelector = true;
  agentInterface.showThemeToggle = false;
  agentInterface.onApiKeyRequired = async (provider) => {
    const existing = normalizeText(await stores.providerKeys.get(provider));
    if (existing && !PLACEHOLDER_TOKENS.has(existing)) return true;

    const entered = window.prompt(`Enter API key for ${provider}`);
    const normalized = normalizeText(entered || '');
    if (!normalized) return false;

    await stores.providerKeys.set(provider, normalized);
    return true;
  };
  agentInterface.session = session;

  context.dom.agentHost.replaceChildren(agentInterface);
}

async function initializeGardenChat() {
  const root = document.querySelector('[data-chat-cockpit]');
  if (!root) return;

  const dom = createDomBindings(root);
  setStatus(dom, 'Loading garden chat state...');

  try {
    const bootstrap = await fetchBootstrapState();

    const context = {
      bootstrap,
      dom,
      session: null,
      isUpdating: false,
      pendingField: '',
      seedProviderKey: null,
    };

    updateViewFromBootstrap(context);
    bindControlPersistence(context);
    await mountAgentInterface(context);
    setStatus(dom, 'Garden chat is ready.');
  } catch (error) {
    setStatus(dom, `Failed to initialize garden chat: ${formatError(error)}`, true);
    console.error('[admin/chat]', error);
  }
}

void initializeGardenChat();
