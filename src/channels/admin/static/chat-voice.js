const VOICE_WIRE_PROTOCOL = 'voice-wire-v1';
const AUTH_SUBPROTOCOL_PREFIX = 'auth.b64.';
const HOTKEY = 'v';
const TARGET_SAMPLE_RATE_HZ = 48_000;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;
const PLACEHOLDER_TOKENS = new Set(['admin-chat-local-key']);
const TOKEN_STORAGE_KEYS = [
  'psfn.apiKey',
  'psfn_api_key',
  'api_key',
  'apiKey',
  'openai_api_key',
];

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function asElement(value) {
  return value instanceof HTMLElement ? value : null;
}

function toWsUrl(rawUrl) {
  const url = new URL(rawUrl, window.location.href);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  return url;
}

function safeReadStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function resolveLocalApiToken() {
  for (const key of TOKEN_STORAGE_KEYS) {
    const value = normalizeText(safeReadStorage(key) ?? '');
    if (value && !PLACEHOLDER_TOKENS.has(value)) {
      return value;
    }
  }

  return '';
}

function readBootstrapApiToken(bootstrap) {
  const token = normalizeText(bootstrap?.api?.apiKey);
  if (!token || PLACEHOLDER_TOKENS.has(token)) return '';
  return token;
}

function resolveApiToken(bootstrap) {
  return readBootstrapApiToken(bootstrap) || resolveLocalApiToken();
}

function encodeBase64Url(value) {
  if (!value) return '';
  const encoded = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of encoded) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildAuthSubprotocol(token) {
  const normalized = normalizeText(token);
  if (!normalized) return '';
  const encoded = encodeBase64Url(normalized);
  if (!encoded) return '';
  return `${AUTH_SUBPROTOCOL_PREFIX}${encoded}`;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const view = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...view);
  }
  return btoa(binary);
}

function base64ToBytes(base64Value) {
  const binary = atob(base64Value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function resampleFloat32(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;

  const outputLength = Math.max(1, Math.round((input.length * outputRate) / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const blend = sourceIndex - leftIndex;
    output[index] = input[leftIndex] + ((input[rightIndex] - input[leftIndex]) * blend);
  }

  return output;
}

function floatToPcmS16le(input) {
  const bytes = new Uint8Array(input.length * 2);
  let offset = 0;

  for (let index = 0; index < input.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, input[index]));
    const scaled = clamped < 0
      ? Math.round(clamped * 0x8000)
      : Math.round(clamped * 0x7fff);
    bytes[offset] = scaled & 0xff;
    bytes[offset + 1] = (scaled >> 8) & 0xff;
    offset += 2;
  }

  return bytes;
}

function createWireSessionId(sessionBase) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${sessionBase}-${Date.now().toString(36)}-${suffix}`;
}

function isTextInputTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function ensureVoiceControlStrip(root) {
  const form = asElement(root.querySelector('[data-chat-controls]'));
  if (!form) {
    throw new Error('Chat controls form not found');
  }

  const existing = asElement(form.querySelector('[data-chat-voice-controls]'));
  if (existing) {
    return {
      container: existing,
      button: asElement(existing.querySelector('[data-chat-voice-ptt]')),
      status: asElement(existing.querySelector('[data-chat-voice-status]')),
      transcript: asElement(existing.querySelector('[data-chat-voice-transcript]')),
    };
  }

  const strip = document.createElement('section');
  strip.setAttribute('data-chat-voice-controls', 'true');
  strip.style.marginTop = '0.75rem';
  strip.style.padding = '0.65rem 0.75rem';
  strip.style.border = '1px solid var(--border)';
  strip.style.borderRadius = '8px';
  strip.style.background = 'var(--panel-bg, var(--bg))';

  const heading = document.createElement('div');
  heading.style.display = 'flex';
  heading.style.justifyContent = 'space-between';
  heading.style.alignItems = 'center';
  heading.style.gap = '0.5rem';
  heading.style.flexWrap = 'wrap';

  const title = document.createElement('strong');
  title.textContent = 'Voice Push-to-Talk';
  title.style.fontSize = '0.88rem';

  const hint = document.createElement('span');
  hint.textContent = 'Hold V or hold button';
  hint.style.fontSize = '0.78rem';
  hint.style.color = 'var(--text-muted)';

  heading.append(title, hint);

  const actionRow = document.createElement('div');
  actionRow.style.display = 'flex';
  actionRow.style.alignItems = 'center';
  actionRow.style.gap = '0.65rem';
  actionRow.style.marginTop = '0.5rem';
  actionRow.style.flexWrap = 'wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.setAttribute('data-chat-voice-ptt', 'true');
  button.textContent = 'Hold to Talk';

  const status = document.createElement('span');
  status.setAttribute('data-chat-voice-status', 'true');
  status.textContent = 'Voice ready.';
  status.style.fontSize = '0.82rem';
  status.style.color = 'var(--text-muted)';

  actionRow.append(button, status);

  const transcript = document.createElement('div');
  transcript.setAttribute('data-chat-voice-transcript', 'true');
  transcript.style.marginTop = '0.5rem';
  transcript.style.minHeight = '1.1rem';
  transcript.style.fontSize = '0.82rem';
  transcript.style.color = 'var(--text-muted)';

  strip.append(heading, actionRow, transcript);
  form.append(strip);

  return {
    container: strip,
    button,
    status,
    transcript,
  };
}

function setVoiceStatus(ui, message, isError = false) {
  ui.status.textContent = message;
  ui.status.style.color = isError ? 'var(--danger, #b42318)' : 'var(--text-muted)';
}

function setButtonActive(ui, isActive) {
  ui.button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  ui.button.textContent = isActive ? 'Release to Send' : 'Hold to Talk';
  ui.button.style.opacity = isActive ? '0.9' : '1';
}

function setTranscript(ui, text) {
  ui.transcript.textContent = text;
}

function createPlaybackState() {
  return {
    nextSeq: null,
    pendingBySeq: new Map(),
    orderedChunks: [],
  };
}

function readBootstrap(getBootstrap) {
  if (typeof getBootstrap !== 'function') return null;
  try {
    return getBootstrap();
  } catch {
    return null;
  }
}

function readValue(root, selector) {
  const input = root.querySelector(selector);
  if (!(input instanceof HTMLInputElement)) return '';
  return normalizeText(input.value);
}

function computeIdentity(root, bootstrap) {
  const selectedIdentity = bootstrap?.selectedIdentity ?? {};
  const channel = readValue(root, '#chat-channel')
    || normalizeText(selectedIdentity.channel)
    || 'api';
  const channelUserId = readValue(root, '#chat-user-id')
    || normalizeText(selectedIdentity.userId)
    || 'voice-user';
  const authorId = readValue(root, '#chat-author-id')
    || normalizeText(bootstrap?.defaultAuthorId)
    || channelUserId;
  const authorName = readValue(root, '#chat-author-name')
    || normalizeText(bootstrap?.defaultAuthorName)
    || 'Voice User';
  const sessionId = normalizeText(`${channel}:${channelUserId}`)
    || normalizeText(bootstrap?.defaultSessionId)
    || `api:${channelUserId}`;

  return {
    sessionId,
    userId: authorId,
    userName: authorName,
  };
}

function buildSocketConnection(root, getBootstrap) {
  const bootstrap = readBootstrap(getBootstrap);
  const endpoint = normalizeText(bootstrap?.api?.voiceWebSocketUrl) || '/v1/voice/ws';
  const identity = computeIdentity(root, bootstrap);
  const token = resolveApiToken(bootstrap);
  const wsUrl = toWsUrl(endpoint);
  const protocols = [VOICE_WIRE_PROTOCOL];
  const authSubprotocol = buildAuthSubprotocol(token);

  if (authSubprotocol) {
    protocols.push(authSubprotocol);
  }

  wsUrl.searchParams.set('session_id', identity.sessionId);
  wsUrl.searchParams.set('user_id', identity.userId);
  wsUrl.searchParams.set('user_name', identity.userName);

  return {
    url: wsUrl.toString(),
    protocols,
    key: `${wsUrl.toString()}|${identity.sessionId}|${identity.userId}|${authSubprotocol}`,
    identity,
  };
}

function serializeFrame(frame) {
  return JSON.stringify({
    wire: VOICE_WIRE_PROTOCOL,
    timestampMs: Date.now(),
    ...frame,
  });
}

function createAudioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) {
    throw new Error('Web Audio API is unavailable in this browser');
  }
  return new Ctor({ sampleRate: TARGET_SAMPLE_RATE_HZ });
}

async function decodeMessageData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return '';
}

function parseInboundFrame(raw) {
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.wire !== VOICE_WIRE_PROTOCOL) return null;
  if (typeof parsed.type !== 'string') return null;
  if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;

  return parsed;
}

function createVoiceRuntime(root, ui, getBootstrap) {
  const audio = new Audio();
  audio.preload = 'auto';

  const state = {
    root,
    ui,
    getBootstrap,
    socket: null,
    socketReady: null,
    socketKey: '',
    isPressing: false,
    startPending: false,
    isCapturing: false,
    sessionId: '',
    audioSeq: 0,
    endSent: false,
    mediaStream: null,
    audioContext: null,
    sourceNode: null,
    processorNode: null,
    muteNode: null,
    playback: createPlaybackState(),
    audio,
    audioUrl: '',
    pointerDown: false,
    hotkeyDown: false,
    suppressSocketCloseStatus: false,
  };

  audio.addEventListener('ended', () => {
    setVoiceStatus(ui, 'Voice ready.');
  });

  audio.addEventListener('error', () => {
    setVoiceStatus(ui, 'Unable to play assistant audio.', true);
  });

  async function ensureSocket() {
    const connection = buildSocketConnection(state.root, state.getBootstrap);

    if (state.socket
      && state.socket.readyState === WebSocket.OPEN
      && state.socketKey === connection.key) {
      return;
    }

    if (state.socketReady && state.socketKey === connection.key) {
      await state.socketReady;
      return;
    }

    await closeSocket(true);

    setVoiceStatus(ui, 'Connecting voice websocket...');
    const socket = new WebSocket(connection.url, connection.protocols);
    state.socket = socket;
    state.socketKey = connection.key;

    state.socketReady = new Promise((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };

      const handleError = () => {
        cleanup();
        reject(new Error('Voice websocket connection failed'));
      };

      const cleanup = () => {
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('error', handleError);
      };

      socket.addEventListener('open', handleOpen, { once: true });
      socket.addEventListener('error', handleError, { once: true });
    });

    socket.addEventListener('message', (event) => {
      void handleSocketMessage(event.data);
    });

    socket.addEventListener('close', () => {
      state.socket = null;
      state.socketReady = null;
      state.socketKey = '';

      if (state.suppressSocketCloseStatus) {
        state.suppressSocketCloseStatus = false;
        return;
      }

      if (!state.isPressing && !state.startPending) {
        setVoiceStatus(ui, 'Voice websocket disconnected.');
      }
    });

    await state.socketReady;
    setVoiceStatus(ui, 'Voice connection ready. Hold V to talk.');
  }

  function sendFrame(frame) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Voice websocket is not connected');
    }

    state.socket.send(serializeFrame(frame));
  }

  function resetPlayback() {
    state.playback = createPlaybackState();
  }

  async function stopCapture() {
    if (state.processorNode) {
      state.processorNode.onaudioprocess = null;
      state.processorNode.disconnect();
      state.processorNode = null;
    }

    if (state.sourceNode) {
      state.sourceNode.disconnect();
      state.sourceNode = null;
    }

    if (state.muteNode) {
      state.muteNode.disconnect();
      state.muteNode = null;
    }

    if (state.mediaStream) {
      for (const track of state.mediaStream.getTracks()) {
        track.stop();
      }
      state.mediaStream = null;
    }

    if (state.audioContext) {
      await state.audioContext.close().catch(() => undefined);
      state.audioContext = null;
    }

    state.isCapturing = false;
  }

  async function startCapture() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error('Microphone access is not available in this browser');
    }

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE_HZ,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const audioContext = createAudioContext();
    await audioContext.resume();

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const processorNode = audioContext.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE,
      1,
      1,
    );
    const muteNode = audioContext.createGain();
    muteNode.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (!state.isPressing || !state.sessionId) return;
      const input = event.inputBuffer.getChannelData(0);
      const mono = resampleFloat32(input, event.inputBuffer.sampleRate, TARGET_SAMPLE_RATE_HZ);
      const pcm = floatToPcmS16le(mono);
      state.audioSeq += 1;

      try {
        sendFrame({
          type: 'audio.chunk',
          sessionId: state.sessionId,
          seq: state.audioSeq,
          audioBase64: bytesToBase64(pcm),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setVoiceStatus(ui, `Audio send failed: ${message}`, true);
      }
    };

    sourceNode.connect(processorNode);
    processorNode.connect(muteNode);
    muteNode.connect(audioContext.destination);

    state.mediaStream = mediaStream;
    state.audioContext = audioContext;
    state.sourceNode = sourceNode;
    state.processorNode = processorNode;
    state.muteNode = muteNode;
    state.isCapturing = true;
  }

  async function appendPlaybackChunk(frame) {
    let audioBytes;
    try {
      audioBytes = base64ToBytes(String(frame.audioBase64 ?? ''));
    } catch {
      return;
    }

    const seq = Number(frame.seq);
    if (!Number.isFinite(seq)) return;

    const playback = state.playback;
    if (playback.nextSeq === null) {
      playback.nextSeq = seq;
    }

    playback.pendingBySeq.set(seq, audioBytes);

    while (playback.nextSeq !== null && playback.pendingBySeq.has(playback.nextSeq)) {
      const chunk = playback.pendingBySeq.get(playback.nextSeq);
      if (chunk) {
        playback.orderedChunks.push(chunk);
      }
      playback.pendingBySeq.delete(playback.nextSeq);
      playback.nextSeq += 1;
    }

    setVoiceStatus(ui, 'Receiving playback audio...');
  }

  async function playBufferedAudio() {
    const chunks = state.playback.orderedChunks;
    if (chunks.length === 0) {
      setVoiceStatus(ui, 'Voice turn completed.');
      return;
    }

    if (state.audioUrl) {
      URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = '';
    }

    const parts = chunks.map((chunk) => chunk.slice().buffer);
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    state.audioUrl = URL.createObjectURL(blob);

    state.audio.pause();
    state.audio.currentTime = 0;
    state.audio.src = state.audioUrl;
    setVoiceStatus(ui, 'Playing assistant audio...');

    try {
      await state.audio.play();
    } catch {
      setVoiceStatus(ui, 'Playback is blocked. Click the page and try again.', true);
    }
  }

  async function handleSocketMessage(data) {
    const raw = await decodeMessageData(data);
    const frame = parseInboundFrame(raw);
    if (!frame) return;
    if (state.sessionId && frame.sessionId !== state.sessionId) return;

    switch (frame.type) {
      case 'ack': {
        const ackType = String(frame.ackType ?? '');
        if (ackType === 'session.start') {
          setVoiceStatus(ui, 'Listening... release to send.');
        } else if (ackType === 'session.end') {
          setVoiceStatus(ui, 'Voice turn completed.');
          state.endSent = true;
          await playBufferedAudio();
        }
        break;
      }
      case 'transcript.partial': {
        const text = normalizeText(String(frame.text ?? ''));
        if (text) setTranscript(ui, `Heard (partial): ${text}`);
        break;
      }
      case 'transcript.final': {
        const text = normalizeText(String(frame.text ?? ''));
        if (text) setTranscript(ui, `Heard: ${text}`);
        break;
      }
      case 'playback.chunk': {
        await appendPlaybackChunk(frame);
        break;
      }
      case 'error': {
        const message = normalizeText(String(frame.message ?? 'voice error'));
        setVoiceStatus(ui, `Voice runtime error: ${message}`, true);
        break;
      }
      default:
        break;
    }
  }

  async function finishPress() {
    await stopCapture();

    if (!state.sessionId || state.endSent) {
      return;
    }

    state.endSent = true;
    try {
      sendFrame({
        type: 'session.end',
        sessionId: state.sessionId,
      });
      setVoiceStatus(ui, 'Processing voice turn...');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVoiceStatus(ui, `Unable to end voice turn: ${message}`, true);
      state.sessionId = '';
    }
  }

  async function beginPress() {
    if (state.isPressing || state.startPending) return;
    state.isPressing = true;
    state.startPending = true;
    setButtonActive(ui, true);

    try {
      await ensureSocket();

      if (!state.isPressing) {
        return;
      }

      resetPlayback();
      setTranscript(ui, '');
      state.audioSeq = 0;
      state.endSent = false;
      const { identity } = buildSocketConnection(state.root, state.getBootstrap);
      state.sessionId = createWireSessionId(identity.sessionId);

      sendFrame({
        type: 'session.start',
        sessionId: state.sessionId,
      });

      await startCapture();
      if (!state.isPressing) {
        await finishPress();
        return;
      }

      setVoiceStatus(ui, 'Capturing microphone...');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVoiceStatus(ui, `Unable to start voice capture: ${message}`, true);
      state.sessionId = '';
      state.endSent = true;
      state.isPressing = false;
      setButtonActive(ui, false);
      await stopCapture();
    } finally {
      state.startPending = false;
    }
  }

  async function endPress() {
    if (!state.isPressing && !state.startPending && !state.isCapturing) return;
    state.isPressing = false;
    setButtonActive(ui, false);
    await finishPress();
  }

  function handleKeyDown(event) {
    if (event.key.toLowerCase() !== HOTKEY) return;
    if (event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTextInputTarget(event.target)) return;

    state.hotkeyDown = true;
    event.preventDefault();
    void beginPress();
  }

  function handleKeyUp(event) {
    if (event.key.toLowerCase() !== HOTKEY) return;
    if (!state.hotkeyDown) return;

    state.hotkeyDown = false;
    event.preventDefault();
    void endPress();
  }

  function handlePointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    state.pointerDown = true;
    event.preventDefault();
    void beginPress();
  }

  function handleGlobalPointerUp() {
    if (!state.pointerDown) return;
    state.pointerDown = false;
    void endPress();
  }

  function handleWindowBlur() {
    if (!state.hotkeyDown && !state.pointerDown) return;
    state.hotkeyDown = false;
    state.pointerDown = false;
    void endPress();
  }

  async function closeSocket(suppressStatus = false) {
    if (!state.socket) return;

    state.suppressSocketCloseStatus = suppressStatus;
    try {
      state.socket.close();
    } catch {
      // Ignore close races.
    }

    state.socket = null;
    state.socketReady = null;
    state.socketKey = '';
  }

  function mount() {
    ui.button.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('pointercancel', handleGlobalPointerUp);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);

    return async () => {
      ui.button.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      window.removeEventListener('pointercancel', handleGlobalPointerUp);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);

      state.pointerDown = false;
      state.hotkeyDown = false;
      state.isPressing = false;
      await stopCapture();
      await closeSocket(true);

      if (state.audioUrl) {
        URL.revokeObjectURL(state.audioUrl);
        state.audioUrl = '';
      }
      state.audio.pause();
      state.audio.src = '';
    };
  }

  return {
    mount,
  };
}

export function initializeChatVoiceCockpit(options = {}) {
  const root = options.root instanceof HTMLElement
    ? options.root
    : document.querySelector('[data-chat-cockpit]');
  if (!root) return () => {};

  const ui = ensureVoiceControlStrip(root);
  if (!ui.button || !ui.status || !ui.transcript) {
    throw new Error('Failed to create voice controls');
  }

  setVoiceStatus(ui, 'Voice ready. Hold V to talk.');

  const runtime = createVoiceRuntime(root, ui, options.getBootstrap);
  return runtime.mount();
}
