const PI_VERSION = '0.52.12';
const BOOTSTRAP_URL = '/api/chat/bootstrap';
const DEFAULT_MODEL_ID = 'purrsephone-admin-chat';
const DEFAULT_MODEL_NAME = 'PSFN Admin Cockpit';
const DEFAULT_SYSTEM_PROMPT = 'You are Purrsephone speaking through the admin cockpit.';
const PI_WEB_UI_MODULE = `https://esm.sh/@mariozechner/pi-web-ui@${PI_VERSION}?bundle`;
const PI_AGENT_CORE_MODULE = `https://esm.sh/@mariozechner/pi-agent-core@${PI_VERSION}?bundle`;
const PI_AI_MODULE = `https://esm.sh/@mariozechner/pi-ai@${PI_VERSION}?bundle`;
const PI_WEB_UI_CSS = `https://esm.sh/@mariozechner/pi-web-ui@${PI_VERSION}/app.css`;
const PROVIDER_KEY_PLACEHOLDER = 'admin-chat-local-key';

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

function setStatus(dom, message, isError = false) {
  dom.status.textContent = message;
  dom.status.classList.toggle('is-error', isError);
}

function setControlsDisabled(dom, disabled) {
  const fields = dom.form.querySelectorAll('input, select');
  for (const field of fields) {
    field.disabled = disabled;
  }
}

function ensureWebUiStylesheet() {
  const existing = document.querySelector('link[data-chat-cockpit-pi-ui="true"]');
  if (existing) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = PI_WEB_UI_CSS;
  link.setAttribute('data-chat-cockpit-pi-ui', 'true');
  document.head.append(link);
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

function createOpenAICompletionsModel(bootstrap) {
  const endpointUrl = new URL(bootstrap.api.chatCompletionsUrl, window.location.origin);
  const suffix = '/chat/completions';
  const baseUrl = new URL(endpointUrl.toString());
  if (baseUrl.pathname.endsWith(suffix)) {
    baseUrl.pathname = baseUrl.pathname.slice(0, -suffix.length) || '/';
  }
  baseUrl.search = '';
  baseUrl.hash = '';

  return {
    id: DEFAULT_MODEL_ID,
    name: DEFAULT_MODEL_NAME,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: baseUrl.toString(),
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
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

function renderControls(dom, bootstrap) {
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
  dom.contactMeta.textContent = `Mapped contact: ${displayName} | Session: ${bootstrap.defaultSessionId}`;
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
    status: requiredElement(root, '[data-chat-status]'),
    chatSurface: requiredElement(root, '#admin-chat-surface'),
  };
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createAppStorageStub() {
  return {
    settings: {
      async get() {
        return undefined;
      },
      async set() {},
    },
    providerKeys: {
      async get() {
        return PROVIDER_KEY_PLACEHOLDER;
      },
      async set() {},
    },
    sessions: {},
    customProviders: {},
    backend: {},
  };
}

async function loadPiModules() {
  const [agentCore, webUi, piAi] = await Promise.all([
    import(PI_AGENT_CORE_MODULE),
    import(PI_WEB_UI_MODULE),
    import(PI_AI_MODULE),
  ]);

  if (typeof webUi.setAppStorage !== 'function') {
    throw new Error('pi-web-ui setAppStorage export not found');
  }

  webUi.setAppStorage(createAppStorageStub());
  return { agentCore, webUi, piAi };
}

function createStreamFunction(piAi, getBootstrapState) {
  return (model, context, options = {}) => {
    const bootstrap = getBootstrapState();
    return piAi.streamSimple(model, context, {
      ...options,
      apiKey: PROVIDER_KEY_PLACEHOLDER,
      sessionId: bootstrap.defaultSessionId,
      headers: {
        ...(options.headers ?? {}),
        ...buildTransportHeaders(bootstrap),
      },
    });
  };
}

function createAgent(modules, getBootstrapState) {
  const bootstrap = getBootstrapState();
  const streamFn = createStreamFunction(modules.piAi, getBootstrapState);
  const convertToLlm = typeof modules.webUi.defaultConvertToLlm === 'function'
    ? modules.webUi.defaultConvertToLlm
    : undefined;
  if (!convertToLlm) {
    throw new Error('pi-web-ui defaultConvertToLlm export not found');
  }

  return new modules.agentCore.Agent({
    initialState: {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      model: createOpenAICompletionsModel(bootstrap),
      thinkingLevel: 'off',
      messages: [],
      tools: [],
    },
    convertToLlm,
    streamFn,
    getApiKey: () => PROVIDER_KEY_PLACEHOLDER,
    sessionId: bootstrap.defaultSessionId,
  });
}

function mountAgentInterface(dom, agent) {
  const agentInterface = document.createElement('agent-interface');
  agentInterface.session = agent;
  agentInterface.enableAttachments = false;
  agentInterface.enableModelSelector = false;
  agentInterface.enableThinkingSelector = false;
  agentInterface.showThemeToggle = false;
  agentInterface.onApiKeyRequired = async () => true;

  dom.chatSurface.replaceChildren(agentInterface);
  return agentInterface;
}

function syncAgentWithBootstrap(agent, bootstrap) {
  agent.sessionId = bootstrap.defaultSessionId;
  agent.setModel(createOpenAICompletionsModel(bootstrap));
}

function bindControlPersistence(context) {
  const handleChange = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const changedField = target.getAttribute('name') ?? '';
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
  setStatus(context.dom, 'Saving selection...');

  try {
    const normalizedSelection = normalizeSelectionForSubmit(context.dom, context.bootstrap, changedField);
    const payload = toBootstrapUpdatePayload(normalizedSelection);
    const refreshed = await postBootstrapState(payload);
    context.bootstrap = refreshed;
    renderControls(context.dom, refreshed);
    syncAgentWithBootstrap(context.agent, refreshed);
    setStatus(context.dom, 'Chat cockpit is ready.');
  } catch (error) {
    setStatus(context.dom, `Unable to update cockpit state: ${formatError(error)}`, true);
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

async function initializeCockpit() {
  const root = document.querySelector('[data-chat-cockpit]');
  if (!root) return;

  const dom = createDomBindings(root);
  ensureWebUiStylesheet();
  setStatus(dom, 'Loading cockpit state...');

  try {
    const [bootstrap, modules] = await Promise.all([
      fetchBootstrapState(),
      loadPiModules(),
    ]);

    const context = {
      bootstrap,
      modules,
      dom,
      agent: null,
      isUpdating: false,
      pendingField: '',
    };

    context.agent = createAgent(modules, () => context.bootstrap);
    mountAgentInterface(dom, context.agent);
    renderControls(dom, bootstrap);
    syncAgentWithBootstrap(context.agent, bootstrap);
    bindControlPersistence(context);
    setStatus(dom, 'Chat cockpit is ready.');
  } catch (error) {
    setStatus(dom, `Failed to initialize chat cockpit: ${formatError(error)}`, true);
    console.error('[admin/chat]', error);
  }
}

void initializeCockpit();
