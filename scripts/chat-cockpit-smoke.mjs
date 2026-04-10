#!/usr/bin/env node

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const DEFAULT_ADMIN_URL = 'http://127.0.0.1:3001';
const DEFAULT_BOOTSTRAP_PATH = '/api/admin/chat/bootstrap';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_VOICE_TIMEOUT_MS = 8_000;

function printUsage() {
  console.log(`Chat Cockpit Smoke Harness

Usage:
  node scripts/chat-cockpit-smoke.mjs [options]

Options:
  --admin-url <url>        Admin server base URL (default: ${DEFAULT_ADMIN_URL})
  --api-base-url <url>     Base URL for API endpoint resolution (default: admin URL)
  --admin-token <token>    Admin bearer token for the bootstrap route
  --bootstrap-path <path>  Bootstrap path (default: ${DEFAULT_BOOTSTRAP_PATH})
  --message <text>         Prompt text for chat completion smoke
  --voice                  Enable optional websocket handshake check
  --timeout-ms <ms>        HTTP timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --voice-timeout-ms <ms>  Voice websocket timeout milliseconds (default: ${DEFAULT_VOICE_TIMEOUT_MS})
  --help                   Show this help
`);
}

function info(message) {
  console.log(`[smoke:chat] ${message}`);
}

function pass(message) {
  console.log(`[smoke:chat] PASS  ${message}`);
}

function fail(message) {
  console.error(`[smoke:chat] FAIL  ${message}`);
}

function ensureString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Expected ${fieldName} to be a non-empty string`);
  }
  return value.trim();
}

function parseInteger(value, fieldName, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    adminUrl: process.env.ADMIN_URL || DEFAULT_ADMIN_URL,
    apiBaseUrl: process.env.API_BASE_URL || '',
    adminToken: process.env.ADMIN_TOKEN || '',
    bootstrapPath: DEFAULT_BOOTSTRAP_PATH,
    message: 'Smoke ping from chat cockpit.',
    enableVoice: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    voiceTimeoutMs: DEFAULT_VOICE_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      case '--admin-url':
        options.adminUrl = ensureString(argv[++i], '--admin-url');
        break;
      case '--api-base-url':
        options.apiBaseUrl = ensureString(argv[++i], '--api-base-url');
        break;
      case '--admin-token':
        options.adminToken = ensureString(argv[++i], '--admin-token');
        break;
      case '--bootstrap-path':
        options.bootstrapPath = ensureString(argv[++i], '--bootstrap-path');
        break;
      case '--message':
        options.message = ensureString(argv[++i], '--message');
        break;
      case '--voice':
        options.enableVoice = true;
        break;
      case '--timeout-ms':
        options.timeoutMs = parseInteger(argv[++i], '--timeout-ms', DEFAULT_TIMEOUT_MS);
        break;
      case '--voice-timeout-ms':
        options.voiceTimeoutMs = parseInteger(argv[++i], '--voice-timeout-ms', DEFAULT_VOICE_TIMEOUT_MS);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response, got: ${text.slice(0, 280)}`);
  }
}

function validateBootstrapPayload(payload) {
  ensureString(payload?.canonicalContactId, 'bootstrap.canonicalContactId');
  ensureString(payload?.defaultSessionId, 'bootstrap.defaultSessionId');
  ensureString(payload?.defaultAuthorId, 'bootstrap.defaultAuthorId');
  ensureString(payload?.defaultAuthorName, 'bootstrap.defaultAuthorName');
  ensureString(payload?.selectedTarget?.channel, 'bootstrap.selectedTarget.channel');
  ensureString(payload?.selectedTarget?.canonicalContactId, 'bootstrap.selectedTarget.canonicalContactId');
  ensureString(payload?.api?.chatCompletionsUrl, 'bootstrap.api.chatCompletionsUrl');
  ensureString(payload?.api?.voiceWebSocketUrl, 'bootstrap.api.voiceWebSocketUrl');
}

function createAuthHeaders(apiKey) {
  const headers = {};
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

function resolveUrl(rawUrl, baseUrl) {
  return new URL(rawUrl, baseUrl).toString();
}

function toWebSocketUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  return parsed;
}

async function runBootstrapCheck(options) {
  const bootstrapUrl = resolveUrl(options.bootstrapPath, options.adminUrl);
  info(`Checking bootstrap endpoint: ${bootstrapUrl}`);

  const headers = { Accept: 'application/json' };
  if (options.adminToken) {
    headers.Authorization = `Bearer ${options.adminToken}`;
  }

  const response = await fetchWithTimeout(bootstrapUrl, {
    method: 'GET',
    headers,
  }, options.timeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Bootstrap request failed (${response.status}): ${text.slice(0, 220)}`);
  }

  const payload = await readJsonSafe(response);
  validateBootstrapPayload(payload);
  pass('Bootstrap returned required chat cockpit fields');
  return payload;
}

async function runChatCompletionCheck(options, bootstrap) {
  const apiBase = options.apiBaseUrl || options.adminUrl;
  const chatCompletionsUrl = resolveUrl(bootstrap.api.chatCompletionsUrl, apiBase);
  info(`Checking chat completions endpoint: ${chatCompletionsUrl}`);

  const response = await fetchWithTimeout(chatCompletionsUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-ID': bootstrap.defaultSessionId,
      'X-User-ID': bootstrap.defaultAuthorId,
      'X-User-Name': bootstrap.defaultAuthorName,
      ...createAuthHeaders(bootstrap?.api?.apiKey),
    },
    body: JSON.stringify({
      model: bootstrap?.runtime?.model?.id || 'companion',
      messages: [{ role: 'user', content: options.message }],
      stream: false,
    }),
  }, options.timeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Chat completions request failed (${response.status}): ${text.slice(0, 280)}`);
  }

  const payload = await readJsonSafe(response);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Chat completions response missing assistant content');
  }

  pass(`Chat completion returned assistant content: ${content.slice(0, 120)}`);
}

async function waitForWebSocketOpen(ws, timeoutMs) {
  await Promise.race([
    new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        reject(new Error(`Unexpected websocket response status: ${status}`));
      });
    }),
    delay(timeoutMs).then(() => {
      throw new Error(`Websocket open timed out after ${timeoutMs}ms`);
    }),
  ]);
}

async function waitForSessionStartAck(ws, expectedSessionId, timeoutMs) {
  return Promise.race([
    new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const text = typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : String(raw);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }

        if (parsed?.wire !== 'voice-wire-v1') return;
        if (parsed?.type !== 'ack') return;
        if (parsed?.ackType !== 'session.start') return;
        if (parsed?.sessionId !== expectedSessionId) return;
        resolve(parsed);
      });

      ws.once('error', reject);
      ws.once('close', (code) => {
        reject(new Error(`Websocket closed before ack (code ${code})`));
      });
    }),
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for session.start ack after ${timeoutMs}ms`);
    }),
  ]);
}

async function runVoiceHandshakeCheck(options, bootstrap) {
  const apiBase = options.apiBaseUrl || options.adminUrl;
  const voiceUrl = toWebSocketUrl(resolveUrl(bootstrap.api.voiceWebSocketUrl, apiBase));
  const sessionId = `${bootstrap.defaultSessionId}-smoke-${Date.now().toString(36)}`;

  if (bootstrap?.api?.apiKey) {
    const token = bootstrap.api.apiKey.trim();
    if (token) {
      voiceUrl.searchParams.set('api_key', token);
      voiceUrl.searchParams.set('token', token);
    }
  }
  voiceUrl.searchParams.set('session_id', bootstrap.defaultSessionId);
  voiceUrl.searchParams.set('user_id', bootstrap.defaultAuthorId);
  voiceUrl.searchParams.set('user_name', bootstrap.defaultAuthorName);

  info(`Checking voice websocket handshake: ${voiceUrl.toString()}`);
  const ws = new WebSocket(voiceUrl.toString());

  try {
    await waitForWebSocketOpen(ws, options.voiceTimeoutMs);
    ws.send(JSON.stringify({
      wire: 'voice-wire-v1',
      type: 'session.start',
      sessionId,
      timestampMs: Date.now(),
    }));
    await waitForSessionStartAck(ws, sessionId, options.voiceTimeoutMs);
    pass('Voice websocket accepted session.start and returned ack');
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bootstrap = await runBootstrapCheck(options);
  await runChatCompletionCheck(options, bootstrap);

  if (options.enableVoice) {
    await runVoiceHandshakeCheck(options, bootstrap);
  } else {
    info('Skipping optional voice websocket check (pass --voice to enable)');
  }

  pass('Chat cockpit smoke harness completed');
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
  process.exit(1);
}
