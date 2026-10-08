import { fixtureFetch } from './https.mjs';
import assert from 'node:assert/strict';
import { assertTurnEvidence, collectTelemetry, streamChat } from './evidence.mjs';

export async function eventually(read, accept, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function gardenJson(options, path) {
  const { gardenBase, adminToken } = options;
  const response = await fixtureFetch(options, `${gardenBase}${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `Garden returned HTTP ${response.status} for ${path.split('?')[0]}`);
  return response.json();
}

export async function runStreamRestartJourney(options) {
  const { apiBase, apiKey, channelId, sessionId, message, restartAgent, waitForHealth, report } = options;
  options.checkpoint?.('stream');
  let collector = await collectTelemetry(options);
  options.capture?.(collector);
  try {
    const delivered = await streamChat({ apiBase, apiKey, sessionId, message });
    options.checkpoint?.('persist_and_correlate');
    const sessionPath = `/api/admin/sessions/${encodeURIComponent(channelId)}`;
    const session = await eventually(() => gardenJson(options, sessionPath),
      value => value.turns?.some(turn => turn.record?.userMessage?.content === message && turn.record?.status === 'completed'),
      'the exact completed turn through Garden');
    const turn = session.turns.find(entry => entry.record?.userMessage?.content === message);
    await eventually(async () => collector.events,
      events => events.some(event => event.requestId === turn.record.requestId && event.stage === 'turn_complete'),
      'terminal correlated telemetry');
    assert.deepEqual(collector.errors, [], 'Telemetry collector lost evidence');
    const proof = assertTurnEvidence({ turn, message, reply: delivered.text, events: collector.events });
    report('streamed response equals its durable turn; correlated provider and completion stages present');
    collector.close();
    collector = undefined;
    options.checkpoint?.('restart');
    await restartAgent();
    await waitForHealth(120_000);
    const reread = await gardenJson(options, `${sessionPath}/turns/${encodeURIComponent(proof.turnId)}`);
    const persisted = reread.record ?? reread.turn?.record;
    assert.equal(persisted?.turnId, proof.turnId, 'Restart lost the persisted turn');
    assert.equal(persisted?.requestId, proof.requestId, 'Restart changed turn correlation');
    assert.equal(persisted?.assistantMessage?.content, delivered.text, 'Restart changed the durable response');
    report('agent restart preserves the same turn, request identity and delivered reply');
    return { ...proof, streamFrameCount: delivered.frameCount, restartVerified: true };
  } finally { collector?.close(); }
}
