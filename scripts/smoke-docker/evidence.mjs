import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocket } from 'ws';

export const hashContent = value => createHash('sha256').update(value).digest('hex');

// An allowlist, not a raw event/log dump: prompts, replies, tool arguments and
// provider errors stay out of portable evidence even when a scenario fails.
export function projectEvent(frame) {
  const data = frame?.data;
  if (!data || typeof data !== 'object') return null;
  const names = ['agent.turn.performance', 'agent.turn.stage', 'agent.tool.start',
    'agent.tool.end', 'memory.retrieval', 'memory.extraction.end'];
  if (!names.includes(frame.type)) return null;
  const result = { type: frame.type };
  for (const name of ['requestId', 'turnId', 'traceId', 'companionId', 'toolCallId']) {
    if (typeof data[name] === 'string') result[name] = data[name];
  }
  for (const name of ['stage', 'stageStatus', 'outcome', 'cancellationOutcome', 'backgroundJobState', 'backgroundJobReason']) {
    if (typeof data[name] === 'string' && /^[a-z0-9_-]+$/u.test(data[name])) result[name] = data[name];
  }
  for (const name of ['timestampMs', 'monotonicAtMs', 'durationMs', 'elapsedMs', 'count']) {
    if (typeof data[name] === 'number' && Number.isFinite(data[name])) result[name] = data[name];
  }
  return result;
}

export async function collectTelemetry({ gardenBase, adminToken, gardenCa }) {
  const socket = new WebSocket(`${gardenBase.replace(/^http/u, 'ws')}/api/admin/events`, {
    headers: { Authorization: `Bearer ${adminToken}`, Origin: new URL(gardenBase).origin },
    ...(gardenCa ? { ca: gardenCa } : {}),
  });
  const events = [];
  const errors = [];
  socket.on('message', data => {
    try {
      const event = projectEvent(JSON.parse(String(data)));
      if (event) events.push(event);
    } catch { errors.push('malformed_telemetry_frame'); }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Telemetry connection timed out')); }, 10_000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  socket.on('error', () => errors.push('telemetry_transport_error'));
  let closedByCollector = false;
  socket.on('close', () => { if (!closedByCollector) errors.push('telemetry_disconnected'); });
  return { events, errors, close() { closedByCollector = true; socket.close(); } };
}

export async function streamChat({ apiBase, apiKey, sessionId, message, signal }) {
  const response = await fetch(`${apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: JSON.stringify({ model: 'companion', stream: true, messages: [{ role: 'user', content: message }] }),
    signal: signal ?? AbortSignal.timeout(90_000),
  });
  assert.equal(response.status, 200, `Chat transport returned HTTP ${response.status}`);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
  let text = '';
  let buffer = '';
  let terminal = false;
  let firstContentBeforeTerminal = false;
  let frameCount = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/u);
    buffer = frames.pop();
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/u)) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        if (raw === '[DONE]') { terminal = true; continue; }
        const payload = JSON.parse(raw);
        frameCount += 1;
        assert.equal(payload.error, undefined, 'Stream returned an error envelope');
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          assert.equal(terminal, false, 'Content arrived after stream completion');
          firstContentBeforeTerminal = true;
          text += delta;
        }
        if (payload.choices?.some(choice => choice.finish_reason != null)) terminal = true;
      }
    }
  }
  assert.equal(buffer.trim(), '', 'Stream ended with a partial SSE frame');
  assert.equal(terminal, true, 'Stream has no terminal event');
  assert.equal(firstContentBeforeTerminal, true, 'Stream has no content before completion');
  return { text, frameCount };
}

export function assertTurnEvidence({ turn, message, reply, events }) {
  const record = turn?.record ?? turn;
  assert.ok(record && typeof record.turnId === 'string', 'Persisted turn missing');
  assert.equal(record.status, 'completed', 'Persisted turn did not complete');
  assert.equal(record.userMessage?.content, message, 'Persisted request does not match this case');
  assert.equal(record.assistantMessage?.content, reply, 'Persisted reply differs from delivered stream');
  assert.ok(record.requestId, 'Persisted turn missing request correlation');
  const correlated = events.filter(event => event.requestId === record.requestId);
  for (const stage of ['provider_request', 'provider_complete', 'turn_complete']) {
    assert.ok(correlated.some(event => event.type === 'agent.turn.performance' && event.stage === stage),
      `Missing correlated ${stage} evidence`);
  }
  // Gateway ingress stages use the request identity before the agent assigns
  // its canonical TurnID. That explicit alias is allowed; unrelated IDs are not.
  assert.ok(correlated.every(event => !event.turnId || event.turnId === record.turnId || event.turnId === record.requestId), 'Trace mixes turns');
  assert.ok(record.observability?.stages?.some(stage => stage.stage === 'first-token'),
    'Persisted turn missing first-token evidence');
  return {
    turnId: record.turnId, requestId: record.requestId, status: record.status,
    requestHash: hashContent(message), responseHash: hashContent(reply),
    events: correlated,
  };
}

export function writeEvidence(path, evidence) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}
