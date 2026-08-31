// Shared chat-probe primitives for the shakedown harness.
//
// Every case file drives the runtime through this one module: the
// /v1/chat/completions transport (with session / privacy / identity-claim
// headers), turn-record lookup, and the agent-busy retry loop. It replaces the
// copy-pasted probe code that used to live independently in live-chat-probe.mjs,
// live-sweep.mjs, and live-system-shakedown.mjs. Proof always comes from the
// persisted turn record, never the reply text.
//
// Nothing here reads process.env or module-global paths — callers pass the
// turn-records directory and the resolved API principal id explicitly, so the
// primitives stay reusable and fail-closed configuration stays with the
// entrypoint.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const INSECURE_LOCAL_API_PRINCIPAL_ID = 'local-insecure';
const API_KEY_PRINCIPAL_DIGEST_LENGTH = 24;

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (!signal) {
    setTimeout(resolve, ms);
    return;
  }
  if (signal.aborted) {
    reject(signal.reason instanceof Error ? signal.reason : new Error('operation aborted'));
    return;
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  function onAbort() {
    clearTimeout(timer);
    reject(signal.reason instanceof Error ? signal.reason : new Error('operation aborted'));
  }
  signal.addEventListener('abort', onAbort, { once: true });
});

/** Build the OpenAI-compatible chat-completions URL from a gateway base. */
export function chatCompletionsUrl(base) {
  return `${base.replace(/\/$/, '')}/v1/chat/completions`;
}

// Canonical wire names from the public framework contract
// (src/shared/contracts/testing-harness.ts); the gateway reads exactly these.
export const TESTING_HARNESS_RUN_ID_HEADER = 'x-testing-harness-run-id';
export const TESTING_HARNESS_MANIFEST_ID_HEADER = 'x-testing-harness-manifest-id';

/**
 * Build the testing-harness provenance headers the gateway records on turns.
 * Callers supply the ids; this helper does not read process.env.
 */
export function testingHarnessProvenanceHeaders({ runId, manifestId } = {}) {
  const headers = {};
  if (typeof runId === 'string' && runId.trim().length > 0) {
    headers[TESTING_HARNESS_RUN_ID_HEADER] = runId.trim();
  }
  if (typeof manifestId === 'string' && manifestId.trim().length > 0) {
    headers[TESTING_HARNESS_MANIFEST_ID_HEADER] = manifestId.trim();
  }
  return headers;
}

/**
 * Merge provenance headers over caller-supplied headers so case-supplied
 * headers can never override the run/manifest provenance of the dispatch.
 */
export function withTestingHarnessProvenance(headers, provenance) {
  return { ...(headers ?? {}), ...testingHarnessProvenanceHeaders(provenance) };
}


/**
 * Probe that the gateway is reachable at `base` (the local split runtime, or a
 * kube gateway behind a port-forward). Hits GET /v1/models — the same signal the
 * bootstrap health gate uses — with the API key attached. Never throws: returns
 * { ok, status, detail } so callers can turn an unreachable port-forward into a
 * clear fail-closed message instead of a raw fetch stack.
 */
export async function probeGatewayReady({ base, apiKey, timeoutMs = 10000 }) {
  const url = `${base.replace(/\/$/, '')}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, detail: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: null, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Derive the gateway principal id for an API key exactly the way the runtime
 * does (api-key-<sha256(key)[:24]>), so harness turn-record channel ids line up
 * with what the gateway persists. Returns null for the insecure-local default.
 */
export function deriveApiKeyPrincipalId(apiToken) {
  const normalized = typeof apiToken === 'string' ? apiToken.trim() : '';
  if (normalized.length === 0) return null;
  return `api-key-${createHash('sha256').update(normalized).digest('hex').slice(0, API_KEY_PRINCIPAL_DIGEST_LENGTH)}`;
}

export function resolveSessionChannelId(sessionId, apiUserId) {
  const principal = typeof apiUserId === 'string' && apiUserId.trim().length > 0
    ? apiUserId.trim()
    : INSECURE_LOCAL_API_PRINCIPAL_ID;
  if (principal === 'testing-harness') {
    return 'api:testing-harness';
  }
  return `api:${principal}:${sessionId}`;
}

export function turnRecordPath(turnRecordsDir, sessionId, apiUserId) {
  return `${turnRecordsDir}/${encodeURIComponent(resolveSessionChannelId(sessionId, apiUserId))}.jsonl`;
}

/** Generic JSONL reader: tolerant of blank lines and partial trailing writes. */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function turnRecordsForSession(turnRecordsDir, sessionId, apiUserId) {
  return readJsonl(turnRecordPath(turnRecordsDir, sessionId, apiUserId));
}

export function lastTurnForSession(turnRecordsDir, sessionId, apiUserId) {
  const records = turnRecordsForSession(turnRecordsDir, sessionId, apiUserId);
  return records.length > 0 ? records.at(-1) : null;
}

export function isActiveTurnStatus(status) {
  return status === 'pending' || status === 'started' || status === 'running';
}

export function lastTurnAfter(turnRecordsDir, sessionId, minStartedAtMs, apiUserId) {
  const records = turnRecordsForSession(turnRecordsDir, sessionId, apiUserId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (typeof record?.startedAt === 'number' && record.startedAt < (minStartedAtMs ?? 0)) continue;
    return record;
  }
  return null;
}

export function findMatchingTurnRecord(turnRecordsDir, sessionId, message, minStartedAtMs, apiUserId) {
  return findCaseTurnRecord(turnRecordsDir, {
    sessionId,
    message,
    minStartedAtMs,
    apiUserId,
  });
}

export function findCaseTurnRecord(turnRecordsDir, {
  sessionId,
  apiUserId,
  message,
  messageIncludes,
  minStartedAtMs = 0,
  searchAllChannels = false,
}) {
  if (searchAllChannels) {
    if (!existsSync(turnRecordsDir)) return null;
    let latest = null;
    for (const entry of readdirSync(turnRecordsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      for (const record of readJsonl(`${turnRecordsDir}/${entry.name}`)) {
        if (!recordMatchesCase(record, { message, messageIncludes, minStartedAtMs })) continue;
        if (!latest || Number(record?.startedAt ?? 0) > Number(latest?.startedAt ?? 0)) {
          latest = record;
        }
      }
    }
    return latest;
  }
  const records = turnRecordsForSession(turnRecordsDir, sessionId, apiUserId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!recordMatchesCase(record, { message, messageIncludes, minStartedAtMs })) continue;
    return record;
  }
  return null;
}

function recordMatchesCase(record, { message, messageIncludes, minStartedAtMs }) {
  const persisted = record?.userMessage?.content;
  if (typeof message === 'string' && persisted !== message) return false;
  if (
    typeof messageIncludes === 'string'
    && (typeof persisted !== 'string' || !persisted.includes(messageIncludes))
  ) {
    return false;
  }
  if (minStartedAtMs > 0) {
    return typeof record?.startedAt === 'number' && record.startedAt >= minStartedAtMs;
  }
  return true;
}

export function isCompletedAssistantTurn(turn) {
  return turn?.status === 'completed'
    && typeof turn?.assistantMessage?.content === 'string'
    && turn.assistantMessage.content.trim().length > 0;
}

/**
 * Poll the turn-record journal until a completed turn for `message` appears, or
 * the timeout elapses. Returns the best matching record found (completed if
 * possible, else the last matching record).
 */
export async function waitForMatchingTurnRecord(
  turnRecordsDir,
  sessionId,
  message,
  minStartedAtMs,
  timeoutMs,
  apiUserId,
  pollIntervalMs = 1500,
  signal,
  searchAllChannels = false,
) {
  return waitForCaseTurnRecord(turnRecordsDir, {
    sessionId,
    message,
    minStartedAtMs,
    timeoutMs,
    apiUserId,
    pollIntervalMs,
    requireCompletedAssistant: true,
    signal,
    searchAllChannels,
  });
}

export async function waitForCaseTurnRecord(turnRecordsDir, {
  sessionId,
  apiUserId,
  message,
  messageIncludes,
  minStartedAtMs = 0,
  timeoutMs,
  pollIntervalMs = 1500,
  requireCompletedAssistant = false,
  signal,
}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = findCaseTurnRecord(turnRecordsDir, {
      sessionId,
      apiUserId,
      message,
      messageIncludes,
      minStartedAtMs,
    });
    if (
      latest
      && !isActiveTurnStatus(latest.status)
      && (
        !requireCompletedAssistant
        || (
          latest.status === 'completed'
          && typeof latest.assistantMessage?.content === 'string'
          && latest.assistantMessage.content.length > 0
        )
      )
    ) {
      return latest;
    }
    await sleep(pollIntervalMs, signal);
  }
  return latest;
}

/**
 * Wait for the newest turn on a session to leave an active (pending/started/
 * running) state, i.e. to settle. Used to recover a turn record when the HTTP
 * response was aborted or returned busy but the turn still ran to completion.
 */
export async function waitForTurnSettlement(
  turnRecordsDir,
  sessionId,
  minStartedAtMs,
  timeoutMs,
  apiUserId,
  pollIntervalMs = 1500,
  signal,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() <= deadline) {
    latest = lastTurnAfter(turnRecordsDir, sessionId, minStartedAtMs, apiUserId);
    if (latest && !isActiveTurnStatus(latest.status)) {
      return latest;
    }
    await sleep(pollIntervalMs, signal);
  }
  return latest;
}

export function isAgentBusyResponse(response) {
  return response?.status === 503 && response?.body?.error?.type === 'agent_busy';
}

// Identity-claim headers the gateway understands. A caller may pass any subset;
// only present values are attached. This is the enrollment/presence claim path
// (canonical contact plus a signed hub identity claim).
export const IDENTITY_CLAIM_HEADERS = [
  'X-Canonical-Contact-ID',
  'X-Identity-Claim-Channel',
  'X-Identity-Claim-User-ID',
  'X-Identity-Claim-Nonce',
  'X-Identity-Claim-Expires',
  'X-Identity-Claim-Signature',
];

/**
 * Build the /v1/chat/completions headers: auth, session, channel privacy, and
 * any identity-claim headers. `identityClaim` keys may be either the raw header
 * name (X-Identity-Claim-Nonce) or its PSFN_HEADER_* env-suffix form; both are
 * accepted so callers can forward sourced env directly.
 */
export function buildChatHeaders({ apiKey, sessionId, privacy = 'private', identityClaim = {}, extra = {} }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Session-ID': sessionId,
    'X-Channel-Privacy': privacy,
  };
  for (const headerName of IDENTITY_CLAIM_HEADERS) {
    const envSuffixKey = `PSFN_HEADER_${headerName.replace(/-/g, '_')}`;
    const value = identityClaim[headerName] ?? identityClaim[envSuffixKey];
    if (typeof value === 'string' && value.length > 0) headers[headerName] = value;
  }
  return { ...headers, ...extra };
}

/** Collect identity-claim headers from the process env (PSFN_HEADER_* form). */
export function identityClaimHeadersFromEnv(env = process.env) {
  const claim = {};
  for (const headerName of IDENTITY_CLAIM_HEADERS) {
    const envKey = `PSFN_HEADER_${headerName.replace(/-/g, '_')}`;
    const value = env[envKey];
    if (typeof value === 'string' && value.length > 0) claim[headerName] = value;
  }
  return claim;
}

/**
 * Low-level chat transport. Posts one turn and returns a normalized response
 * envelope { status, ok, body, rawText, fetchError }. Never throws on transport
 * failure — the abort/error is reported in the envelope so the caller can decide
 * whether the turn nonetheless settled in the persisted record.
 */
export async function postChatCompletion({
  apiUrl,
  headers,
  message,
  content,
  model = 'psfn-live',
  responseStyle = 'concise',
  timeoutMs = 120000,
  signal,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const body = {
    model,
    stream: false,
    ...(responseStyle ? { response_style: responseStyle } : {}),
    messages: [{ role: 'user', content: content ?? message }],
  };
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { rawText };
    }
    return {
      status: response.status,
      ok: response.ok,
      body: parsed,
      rawText,
      fetchError: null,
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      body: null,
      rawText: '',
      fetchError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
