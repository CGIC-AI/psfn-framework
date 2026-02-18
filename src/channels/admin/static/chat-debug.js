const DEBUG_STREAM_PATH = '/api/chat/events/stream';
const MAX_TIMELINE_EVENTS = 250;
const MAX_VISIBLE_EVENTS = 180;
const CATEGORY_SET = new Set(['thinking', 'text', 'tools', 'memory', 'errors']);

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

function truncate(value, maxChars) {
  if (typeof value !== 'string') return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function createDomBindings(root) {
  const categories = Array.from(root.querySelectorAll('[data-chat-debug-category]'));
  return {
    root,
    enable: requiredElement(root, '[data-chat-debug-enable]'),
    channel: requiredElement(root, '[data-chat-debug-channel]'),
    clear: requiredElement(root, '[data-chat-debug-clear]'),
    status: requiredElement(root, '[data-chat-debug-status]'),
    timeline: requiredElement(root, '[data-chat-debug-timeline]'),
    categories,
  };
}

function setStatus(dom, message, isError = false) {
  dom.status.textContent = message;
  dom.status.classList.toggle('is-error', isError);
}

function buildStreamUrl(channelId) {
  const url = new URL(DEBUG_STREAM_PATH, window.location.origin);
  const normalizedChannelId = normalizeText(channelId);
  if (normalizedChannelId) {
    url.searchParams.set('channelId', normalizedChannelId);
  }
  return url.toString();
}

function parseEventPayload(rawData) {
  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const category = CATEGORY_SET.has(parsed.category) ? parsed.category : 'text';
  const details = normalizeDetails(parsed.details);

  return {
    id: typeof parsed.id === 'string' ? parsed.id : `debug-${Date.now()}`,
    timestamp: Number.isFinite(parsed.timestamp) ? Number(parsed.timestamp) : Date.now(),
    event: typeof parsed.event === 'string' ? parsed.event : 'chat-debug',
    category,
    channelId: typeof parsed.channelId === 'string' ? parsed.channelId : '',
    message: truncate(typeof parsed.message === 'string' ? parsed.message : '', 280),
    details,
  };
}

function normalizeDetails(rawDetails) {
  if (!rawDetails || typeof rawDetails !== 'object' || Array.isArray(rawDetails)) {
    return null;
  }

  const details = [];
  for (const [key, value] of Object.entries(rawDetails)) {
    if (!key) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      details.push([key, truncate(String(value), 160)]);
    }
    if (details.length >= 8) break;
  }

  return details.length > 0 ? details : null;
}

function selectedCategories(dom) {
  const selected = new Set();
  for (const toggle of dom.categories) {
    if (toggle.checked && CATEGORY_SET.has(toggle.value)) {
      selected.add(toggle.value);
    }
  }
  return selected;
}

function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function renderTimeline(state) {
  const activeCategories = selectedCategories(state.dom);
  const visible = state.events
    .filter((entry) => activeCategories.has(entry.category))
    .slice(-MAX_VISIBLE_EVENTS)
    .reverse();

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-debug-empty';
    empty.textContent = state.events.length === 0
      ? 'No debug events yet.'
      : 'No events match selected categories.';
    state.dom.timeline.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of visible) {
    fragment.append(createTimelineEntry(entry));
  }
  state.dom.timeline.replaceChildren(fragment);
}

function createTimelineEntry(entry) {
  const item = document.createElement('article');
  item.className = `chat-debug-entry chat-debug-entry-${entry.category}`;

  const meta = document.createElement('div');
  meta.className = 'chat-debug-entry-meta';

  const timestamp = document.createElement('span');
  timestamp.className = 'chat-debug-entry-time';
  timestamp.textContent = formatTimestamp(entry.timestamp);
  meta.append(timestamp);

  const eventName = document.createElement('span');
  eventName.className = 'chat-debug-entry-event';
  eventName.textContent = entry.event;
  meta.append(eventName);

  const category = document.createElement('span');
  category.className = 'chat-debug-entry-category';
  category.textContent = entry.category;
  meta.append(category);

  if (entry.channelId) {
    const channel = document.createElement('span');
    channel.className = 'chat-debug-entry-channel';
    channel.textContent = entry.channelId;
    meta.append(channel);
  }

  const message = document.createElement('div');
  message.className = 'chat-debug-entry-message';
  message.textContent = entry.message || '[empty message]';

  item.append(meta, message);

  if (entry.details) {
    const details = document.createElement('div');
    details.className = 'chat-debug-entry-details';
    details.textContent = entry.details
      .map(([key, value]) => `${key}=${value}`)
      .join(' | ');
    item.append(details);
  }

  return item;
}

function closeEventSource(state) {
  if (!state.source) return;
  state.source.close();
  state.source = null;
}

function connectEventSource(state) {
  closeEventSource(state);

  if (!state.dom.enable.checked) {
    setStatus(state.dom, 'Debug stream paused.');
    return;
  }

  const url = buildStreamUrl(state.dom.channel.value);
  const source = new EventSource(url, { withCredentials: true });

  source.addEventListener('chat-debug', (event) => {
    const payload = parseEventPayload(event.data);
    if (!payload) return;

    state.events.push(payload);
    if (state.events.length > MAX_TIMELINE_EVENTS) {
      state.events.splice(0, state.events.length - MAX_TIMELINE_EVENTS);
    }

    renderTimeline(state);
  });

  source.onopen = () => {
    const filterValue = normalizeText(state.dom.channel.value);
    setStatus(
      state.dom,
      filterValue ? `Connected (channel: ${filterValue}).` : 'Connected to debug stream.',
    );
  };

  source.onerror = () => {
    setStatus(state.dom, 'Debug stream disconnected. Waiting to reconnect...', true);
  };

  state.source = source;
}

function bindEvents(state) {
  let reconnectTimer = null;

  const scheduleReconnect = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectEventSource(state);
    }, 280);
  };

  state.dom.enable.addEventListener('change', () => {
    connectEventSource(state);
  });

  state.dom.channel.addEventListener('input', scheduleReconnect);
  state.dom.channel.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    connectEventSource(state);
  });

  for (const toggle of state.dom.categories) {
    toggle.addEventListener('change', () => renderTimeline(state));
  }

  state.dom.clear.addEventListener('click', () => {
    state.events = [];
    renderTimeline(state);
  });

  window.addEventListener('beforeunload', () => {
    closeEventSource(state);
  }, { once: true });
}

function initializeChatDebug() {
  const root = document.querySelector('[data-chat-debug]');
  if (!root) return;

  try {
    const dom = createDomBindings(root);
    const state = {
      dom,
      events: [],
      source: null,
    };

    renderTimeline(state);
    bindEvents(state);
    connectEventSource(state);
  } catch (error) {
    console.error('[admin/chat-debug] failed to initialize', error);
  }
}

void initializeChatDebug();
