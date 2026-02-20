import { initializeChatVoiceCockpit } from './chat-voice.js';

const BOOTSTRAP_URL = '/api/chat/bootstrap';
const DEFAULT_MODEL_ID = 'purrsephone-admin-chat';
const DEFAULT_MODEL_NAME = 'PSFN Garden Chat';
const DEFAULT_SYSTEM_PROMPT = 'You are Purrsephone speaking through the garden chat canopy.';
const PROVIDER_KEY_PLACEHOLDER = 'admin-chat-local-key';
const MAX_CONTEXT_MESSAGES = 40;

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

function formatClockTime(timestampMs) {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
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

function setComposerDisabled(dom, disabled) {
  dom.input.disabled = disabled;
  dom.sendButton.disabled = disabled;
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
  return normalizeText(bootstrap?.api?.apiKey);
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
  dom.contactMeta.textContent = `Mapped contact: ${displayName} | Session: ${bootstrap.defaultSessionId} | Model: ${DEFAULT_MODEL_NAME}`;
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
    thread: requiredElement(root, '[data-chat-thread]'),
    composer: requiredElement(root, '[data-chat-composer]'),
    input: requiredElement(root, '[data-chat-input]'),
    sendButton: requiredElement(root, '[data-chat-send]'),
    clearButton: requiredElement(root, '[data-chat-clear]'),
  };
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createMessageNode(entry) {
  const item = document.createElement('article');
  item.className = `chat-message chat-message-${entry.role}`;

  const meta = document.createElement('div');
  meta.className = 'chat-message-meta';
  meta.textContent = `${entry.label} • ${formatClockTime(entry.timestamp)}`;

  const content = document.createElement('div');
  content.className = 'chat-message-content';
  content.textContent = entry.content;

  item.append(meta, content);
  return item;
}

function appendMessage(dom, role, content, timestamp = Date.now()) {
  const roleLabel = role === 'user'
    ? 'You'
    : role === 'assistant'
      ? 'Purrsephone'
      : role === 'error'
        ? 'Error'
        : 'System';

  const node = createMessageNode({
    role,
    content,
    timestamp,
    label: roleLabel,
  });
  dom.thread.append(node);
  dom.thread.scrollTop = dom.thread.scrollHeight;
}

function clearConversation(context) {
  context.messages = [];
  context.dom.thread.replaceChildren();
  appendMessage(context.dom, 'system', 'Garden bed cleared. Start a fresh turn.');
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

function buildApiMessages(history) {
  const recent = history.slice(-MAX_CONTEXT_MESSAGES);
  const messages = [{
    role: 'system',
    content: DEFAULT_SYSTEM_PROMPT,
  }];

  for (const message of recent) {
    messages.push({
      role: message.role,
      content: message.content,
    });
  }

  return messages;
}

async function requestChatCompletion(context) {
  const endpointUrl = new URL(context.bootstrap.api.chatCompletionsUrl, window.location.origin);
  const apiKey = resolveClientApiKey(context.bootstrap);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...buildTransportHeaders(context.bootstrap),
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: DEFAULT_MODEL_ID,
      stream: false,
      messages: buildApiMessages(context.messages),
    }),
  });

  if (!response.ok) {
    const body = await readJsonBody(response).catch(() => ({}));
    const reason = body?.error?.message || body?.error?.type || `status ${response.status}`;
    throw new Error(`Completion request failed: ${reason}`);
  }

  return readJsonBody(response);
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
    renderControls(context.dom, refreshed);
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

async function sendPrompt(context, promptText) {
  if (context.isSending) return;

  context.isSending = true;
  setComposerDisabled(context.dom, true);

  const sentAt = Date.now();
  context.messages.push({ role: 'user', content: promptText });
  appendMessage(context.dom, 'user', promptText, sentAt);
  context.dom.input.value = '';
  setStatus(context.dom, 'Waiting for Purrsephone...');

  try {
    const completion = await requestChatCompletion(context);
    const assistantText = parseCompletionText(completion);
    if (!assistantText) {
      throw new Error('Completion payload did not include assistant text');
    }
    context.messages.push({ role: 'assistant', content: assistantText });
    appendMessage(context.dom, 'assistant', assistantText);
    setStatus(context.dom, 'Garden chat is ready.');
  } catch (error) {
    const message = formatError(error);
    appendMessage(context.dom, 'error', message);
    setStatus(context.dom, `Garden chat request failed: ${message}`, true);
  } finally {
    context.isSending = false;
    setComposerDisabled(context.dom, false);
    context.dom.input.focus();
  }
}

function bindComposer(context) {
  context.dom.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = normalizeText(context.dom.input.value);
    if (!prompt) {
      context.dom.input.focus();
      return;
    }
    void sendPrompt(context, prompt);
  });

  context.dom.clearButton.addEventListener('click', () => {
    clearConversation(context);
  });
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
      messages: [],
      isUpdating: false,
      pendingField: '',
      isSending: false,
    };

    renderControls(dom, bootstrap);
    bindControlPersistence(context);
    bindComposer(context);
    dom.input.focus();
    setStatus(dom, 'Garden chat is ready.');

    try {
      initializeChatVoiceCockpit({
        root,
        getBootstrap: () => context.bootstrap,
      });
    } catch (voiceError) {
      console.error('[admin/chat/voice]', voiceError);
    }
  } catch (error) {
    setStatus(dom, `Failed to initialize garden chat: ${formatError(error)}`, true);
    console.error('[admin/chat]', error);
  }
}

void initializeGardenChat();
