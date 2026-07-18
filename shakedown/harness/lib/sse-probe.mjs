// OpenAI-compatible SSE chat probe used by the Sprint 10 TTFT case.
//
// The response body is parsed incrementally. The proof records when the first
// non-empty assistant delta arrived and when the first terminal marker arrived;
// the caller independently binds the request to the exact persisted TurnRecord.

function parseSseFrame(frame) {
  return frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

function contentDelta(payload) {
  const value = payload?.choices?.[0]?.delta?.content;
  return typeof value === 'string' ? value : '';
}

function isTerminalPayload(payload) {
  return payload?.choices?.some((choice) => (
    choice?.finish_reason !== null
    && choice?.finish_reason !== undefined
  )) === true;
}

export async function probeSseChatCompletion({
  apiUrl,
  headers,
  message,
  model = 'psfn-live',
  responseStyle = 'concise',
  timeoutMs = 120_000,
  waitForTurnRecord,
}) {
  if (typeof waitForTurnRecord !== 'function') {
    throw new Error('probeSseChatCompletion requires waitForTurnRecord');
  }
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let fetchError = null;
  let firstContent = '';
  let contentText = '';
  let firstContentAtMs = null;
  let terminalAtMs = null;
  let eventCount = 0;
  let buffer = '';

  const consumeFrame = (frame) => {
    for (const data of parseSseFrame(frame)) {
      eventCount += 1;
      if (data === '[DONE]') {
        terminalAtMs ??= Date.now();
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = contentDelta(payload);
      if (delta.length > 0) {
        if (firstContentAtMs === null) {
          firstContentAtMs = Date.now();
          firstContent = delta;
        }
        contentText += delta;
      }
      if (isTerminalPayload(payload)) {
        terminalAtMs ??= Date.now();
      }
    }
  };

  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        ...(responseStyle ? { response_style: responseStyle } : {}),
        messages: [{ role: 'user', content: message }],
      }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('SSE response has no readable body');
    }
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? '';
      for (const frame of frames) consumeFrame(frame);
      if (done) break;
    }
    if (buffer.trim()) consumeFrame(buffer);
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  const turnRecord = await waitForTurnRecord({
    message,
    minStartedAtMs: startedAtMs - 2_000,
    timeoutMs,
  });

  return {
    response: {
      status: response?.status ?? null,
      ok: response?.ok ?? false,
      body: null,
      rawText: '',
      fetchError,
    },
    stream: {
      eventCount,
      firstContent,
      contentText,
      firstContentAtMs,
      terminalAtMs,
    },
    turnRecord,
    startedAtMs,
  };
}
