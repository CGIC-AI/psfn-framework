export const SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES = 64 * 1024;
export const SESSION_INTEGRITY_VERIFY_CACHE_MAX_ENTRIES = 4_096;

export const SESSION_INTEGRITY_WORKER_SOURCE = `
const net = require('node:net');
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
const { WebSocket } = require('ws');

const GATEWAY_RPC_WS_PROTOCOL = 'psfn-rpc-v1';

if (!parentPort) {
  throw new Error('Session integrity worker requires a parent port');
}

function errorMessage(error) {
  if (error && typeof error.message === 'string') return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown session integrity worker error';
  }
}

function writeResponse(stateBuffer, payloadBuffer, payload) {
  const state = new Int32Array(stateBuffer);
  const view = new Uint8Array(payloadBuffer);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
  const max = view.length;
  const size = Math.min(max, encoded.length);
  view.fill(0);
  view.set(encoded.subarray(0, size), 0);
  Atomics.store(state, 1, size);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}

let activeConnection = null;
let activeEndpointKey = null;
let activeConnectionIdentified = false;
let connectPromise = null;
let buffer = '';
const pendingById = new Map();

function rejectPending(error) {
  for (const [id, pending] of pendingById.entries()) {
    clearTimeout(pending.timer);
    pending.reject(error);
    pendingById.delete(id);
  }
}

function resetConnection(error) {
  const connection = activeConnection;
  activeConnection = null;
  activeEndpointKey = null;
  activeConnectionIdentified = false;
  connectPromise = null;
  buffer = '';

  if (connection) {
    connection.removeAllListeners();
    connection.destroy();
  }
  rejectPending(error);
}

function handleMessage(message) {
  const pending = message && pendingById.get(message.id);
  if (!pending) return;

  clearTimeout(pending.timer);
  pending.resolve(message);
  pendingById.delete(message.id);
}

function wireUnixSocket(socket) {
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newline = buffer.indexOf('\\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      handleMessage(message);
    }
  });

  socket.on('error', (error) => {
    resetConnection(error instanceof Error ? error : new Error(errorMessage(error)));
  });
  socket.on('close', () => {
    resetConnection(new Error('Session integrity RPC connection closed'));
  });

  return {
    sendPayload: (payload) => socket.write(JSON.stringify(payload) + '\\n'),
    destroy: () => socket.destroy(),
    isOpen: () => !socket.destroyed,
    removeAllListeners: () => socket.removeAllListeners(),
  };
}

function normalizeWebSocketMessage(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function wireWebSocket(socket) {
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;

    const text = normalizeWebSocketMessage(data);
    if (!text.trim()) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    handleMessage(message);
  });

  socket.on('error', (error) => {
    resetConnection(error instanceof Error ? error : new Error(errorMessage(error)));
  });
  socket.on('close', () => {
    resetConnection(new Error('Session integrity RPC connection closed'));
  });

  return {
    sendPayload: (payload) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(payload));
      return true;
    },
    destroy: () => socket.terminate(),
    isOpen: () => socket.readyState === WebSocket.OPEN,
    removeAllListeners: () => socket.removeAllListeners(),
  };
}

function endpointKey(endpoint) {
  if (!endpoint) return null;
  if (endpoint.kind === 'unix') return 'unix:' + endpoint.socketPath;
  if (endpoint.kind === 'wss') return 'wss:' + endpoint.url;
  return null;
}

async function ensureConnection(endpoint) {
  const key = endpointKey(endpoint);
  if (!key) {
    throw new Error('Session integrity RPC requires a valid gateway endpoint');
  }
  if (
    activeConnection
    && activeConnection.isOpen()
    && activeEndpointKey === key
  ) {
    return activeConnection;
  }

  if (connectPromise) {
    return await connectPromise;
  }

  if (activeConnection && activeEndpointKey !== key) {
    resetConnection(new Error('Session integrity endpoint changed'));
  }

  connectPromise = endpoint.kind === 'unix'
    ? connectUnixSocket(endpoint.socketPath, key)
    : connectWebSocket(endpoint, key);

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

function connectUnixSocket(socketPath, key) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const cleanup = () => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
    };

    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      activeConnection = wireUnixSocket(socket);
      activeEndpointKey = key;
      resolve(activeConnection);
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error instanceof Error ? error : new Error(errorMessage(error)));
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
  });

}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(fieldName + ' is required');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(fieldName + ' is required');
  }
  return trimmed;
}

function normalizeSpiffeUri(value, fieldName) {
  const trimmed = requireNonEmptyString(value, fieldName);
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(fieldName + ' must be a valid spiffe:// URI');
  }
  if (
    parsed.protocol !== 'spiffe:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(fieldName + ' must be a spiffe:// URI without credentials, query, or fragment');
  }
  return trimmed;
}

function splitSubjectAltName(subjectAltName) {
  const entries = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;
  for (const char of subjectAltName) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      current += char;
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed) entries.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }
  const trimmed = current.trim();
  if (trimmed) entries.push(trimmed);
  return entries;
}

function decodeSubjectAltNameValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === 'string') {
        return decoded;
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function isSpiffeUri(value) {
  try {
    normalizeSpiffeUri(value, 'certificate URI SAN');
    return true;
  } catch {
    return false;
  }
}

function extractSpiffeUriSans(subjectAltName) {
  if (!subjectAltName) return [];
  const values = [];
  for (const entry of splitSubjectAltName(subjectAltName)) {
    const separator = entry.indexOf(':');
    if (separator < 0) continue;
    const kind = entry.slice(0, separator).trim().toLowerCase();
    if (kind !== 'uri') continue;
    const uri = decodeSubjectAltNameValue(entry.slice(separator + 1));
    if (isSpiffeUri(uri)) {
      values.push(uri);
    }
  }
  return values;
}

function verifyPeerCertificateSpiffeUri(certificate, expectedPeerSpiffeUri) {
  const expected = normalizeSpiffeUri(expectedPeerSpiffeUri, 'expected peer SPIFFE URI');
  const spiffeUris = extractSpiffeUriSans(certificate && certificate.subjectaltname);
  if (spiffeUris.length === 0) {
    return 'peer TLS certificate is missing SPIFFE URI SAN';
  }
  if (!spiffeUris.includes(expected)) {
    return 'peer TLS certificate SPIFFE URI SAN did not match expected peer identity';
  }
  return null;
}

function loadWebSocketTlsOptions(tls) {
  if (!tls || !tls.caPath || !tls.certPath || !tls.keyPath || !tls.expectedPeerSpiffeUri) {
    throw new Error('Session integrity WSS endpoint requires TLS caPath, certPath, keyPath, and expectedPeerSpiffeUri');
  }
  const expectedPeerSpiffeUri = normalizeSpiffeUri(tls.expectedPeerSpiffeUri, 'expected peer SPIFFE URI');
  return {
    ca: fs.readFileSync(tls.caPath),
    cert: fs.readFileSync(tls.certPath),
    key: fs.readFileSync(tls.keyPath),
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, certificate) => {
      const rejectionReason = verifyPeerCertificateSpiffeUri(certificate, expectedPeerSpiffeUri);
      return rejectionReason ? new Error(rejectionReason) : undefined;
    },
    ...(tls.serverName ? { servername: tls.serverName } : {}),
  };
}

function terminateOpenWebSocket(socket) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
    socket.terminate();
  }
}

function connectWebSocket(endpoint, key) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint.url, GATEWAY_RPC_WS_PROTOCOL, loadWebSocketTlsOptions(endpoint.tls));
    let settled = false;

    const cleanup = () => {
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('unexpected-response', onUnexpectedResponse);
    };

    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      activeConnection = wireWebSocket(socket);
      activeEndpointKey = key;
      resolve(activeConnection);
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateOpenWebSocket(socket);
      reject(error instanceof Error ? error : new Error(errorMessage(error)));
    };

    const onUnexpectedResponse = (_req, res) => {
      onError(new Error('Session integrity WSS upgrade failed with HTTP ' + (res.statusCode || 0)));
    };

    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

function sendRpc(connection, method, params, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = { jsonrpc: '2.0', id, method, params };

    const timer = setTimeout(() => {
      pendingById.delete(id);
      reject(new Error('Session integrity RPC timed out'));
    }, timeoutMs);

    pendingById.set(id, { resolve, reject, timer });

    try {
      const sent = connection.sendPayload(request);
      if (sent === false) {
        throw new Error('Session integrity RPC connection is closed');
      }
    } catch (error) {
      clearTimeout(timer);
      pendingById.delete(id);
      reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  });
}

async function identifySessionIntegrityConnection(connection, requestId, timeoutMs) {
  if (activeConnectionIdentified) {
    return;
  }
  await sendRpc(
    connection,
    'gateway.client.identify',
    { role: 'internal_session_integrity' },
    'session-integrity-identify-' + requestId,
    timeoutMs,
  );
  activeConnectionIdentified = true;
}

async function requestRpc(endpoint, method, params, id, timeoutMs) {
  const connection = await ensureConnection(endpoint);
  await identifySessionIntegrityConnection(connection, id, timeoutMs);
  return await sendRpc(connection, method, params, id, timeoutMs);
}

parentPort.on('message', async (job) => {
  const { stateBuffer, payloadBuffer, socketPath, endpoint, method, params, requestId, timeoutMs } = job || {};
  const resolvedEndpoint = endpoint || (socketPath ? { kind: 'unix', socketPath } : null);
  if (!stateBuffer || !payloadBuffer || !resolvedEndpoint || !method) {
    return;
  }
  try {
    const response = await requestRpc(resolvedEndpoint, method, params, requestId, timeoutMs);
    writeResponse(stateBuffer, payloadBuffer, { ok: true, response });
  } catch (error) {
    const message = errorMessage(error);
    writeResponse(stateBuffer, payloadBuffer, { ok: false, error: message });
  }
});

parentPort.on('close', () => {
  resetConnection(new Error('Session integrity worker closed'));
});
`;
