import {
  buildChatHeaders,
  chatCompletionsUrl,
  postChatCompletion,
  sleep,
  turnRecordPath,
  waitForMatchingTurnRecord,
} from './probe.mjs';

async function probeHttp({ url, token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      detail: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAgentConnection({ url, token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const rawBody = await response.text();
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, detail: `HTTP ${response.status} returned invalid JSON` };
    }
    const gatewayLink = body?.continuity?.checks?.gatewayLink;
    if (!gatewayLink || typeof gatewayLink !== 'object') {
      return { ok: false, detail: `HTTP ${response.status} omitted continuity.checks.gatewayLink` };
    }
    if (gatewayLink.status !== 'healthy' || gatewayLink.meta?.agentConnected !== true) {
      return {
        ok: false,
        detail: gatewayLink.detail
          ?? `HTTP ${response.status} did not report a healthy, explicitly connected agent`,
      };
    }
    return { ok: true, detail: `HTTP ${response.status} returned agent health` };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForRuntimeReadiness({
  config,
  timeoutMs = 90_000,
  pollMs = 1_500,
}) {
  const deadline = Date.now() + timeoutMs;
  let last = {
    gatewayModels: { ok: false, detail: 'not probed' },
    gardenAdmin: { ok: false, detail: 'not probed' },
    agentConnected: { ok: false, detail: 'not probed' },
  };

  while (Date.now() <= deadline) {
    const probeTimeoutMs = Math.max(250, Math.min(5_000, deadline - Date.now()));
    const [gatewayModels, gardenAdmin, agentConnected] = await Promise.all([
      probeHttp({
        url: `${config.apiBase}/v1/models`,
        token: config.apiKey,
        timeoutMs: probeTimeoutMs,
      }),
      probeHttp({
        url: `${config.adminBase}/health`,
        token: config.adminToken,
        timeoutMs: probeTimeoutMs,
      }),
      // Parse the canonical gateway-link connection marker. Overall /health can
      // be degraded for unrelated subsystems while the agent is connected.
      probeAgentConnection({
        url: `${config.apiBase}/health`,
        token: config.apiKey,
        timeoutMs: probeTimeoutMs,
      }),
    ]);
    last = { gatewayModels, gardenAdmin, agentConnected };
    if (gatewayModels.ok && gardenAdmin.ok && agentConnected.ok) {
      return {
        gatewayModels: true,
        gardenAdmin: true,
        agentConnected: true,
      };
    }
    if (Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  throw new Error(
    'Runtime readiness timed out: '
    + `gateway /v1/models=${last.gatewayModels.detail}; `
    + `Garden /health=${last.gardenAdmin.detail}; `
    + `agent-backed gateway /health=${last.agentConnected.detail}`,
  );
}

export async function proveFirstConversation({
  config,
  message,
  sessionId,
  turnRecordsDir,
  turnRecordTimeoutMs = 30_000,
  pollMs = 1_500,
}) {
  const startedAt = Date.now();
  const apiUserId = 'testing-harness';
  const response = await postChatCompletion({
    apiUrl: chatCompletionsUrl(config.apiBase),
    headers: buildChatHeaders({
      apiKey: config.apiKey,
      sessionId,
      privacy: 'private',
    }),
    message,
  });
  if (!response.ok) {
    throw new Error(
      `First-conversation probe failed: ${response.status === null ? response.fetchError : `HTTP ${response.status}`} `
      + `${response.rawText.slice(0, 300)}`,
    );
  }

  const record = await waitForMatchingTurnRecord(
    turnRecordsDir,
    sessionId,
    message,
    startedAt,
    turnRecordTimeoutMs,
    apiUserId,
    pollMs,
  );
  if (
    record?.status !== 'completed'
    || record?.userMessage?.content !== message
    || typeof record?.assistantMessage?.content !== 'string'
    || record.assistantMessage.content.trim().length === 0
  ) {
    throw new Error(
      `First-conversation HTTP request completed but no completed persisted turn record `
      + `matched the exact probe message within ${turnRecordTimeoutMs}ms`,
    );
  }

  return {
    message,
    sessionId,
    turnRecordPath: turnRecordPath(turnRecordsDir, sessionId, apiUserId),
  };
}
