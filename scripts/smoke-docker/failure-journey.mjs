import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { collectTelemetry, hashContent, streamChat } from './evidence.mjs';
import { eventually } from './journeys.mjs';
import { readCaseTurn } from './memory-journey.mjs';

export async function runFailureJourney(options) {
  const sessionId = `failures-${randomBytes(8).toString('hex')}`;
  const channelId = options.channelForSession(sessionId);
  const collector = await collectTelemetry(options);
  try {
    const failureMessage = 'SMOKE_PROVIDER_FAILURE';
    const response = await fetch(`${options.apiBase}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ model: 'companion', messages: [{ role: 'user', content: failureMessage }] }),
      signal: AbortSignal.timeout(60_000),
    });
    await response.arrayBuffer();
    assert.ok(response.status >= 400, 'Provider failure returned success');
    const failed = await readCaseTurn(options, channelId, failureMessage, 'failed');
    assert.ok((await options.providerEvidence()).failure > 0, 'Fault did not reach the external provider boundary');
    options.report('external provider failure reaches the client and persists a failed turn');

    const previous = await options.providerEvidence();
    const controller = new AbortController();
    const held = fetch(`${options.apiBase}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ model: 'companion', stream: true, messages: [{ role: 'user', content: 'SMOKE_PROVIDER_HOLD' }] }),
      signal: controller.signal,
    }).then(async value => { await value.arrayBuffer(); return 'completed'; }, error => error.name);
    try {
      await eventually(options.providerEvidence, value => value.hold > previous.hold, 'held external provider request');
    } finally { controller.abort(); }
    assert.equal(await held, 'AbortError', 'Client cancellation was not observed');
    const cancelled = await readCaseTurn(options, channelId, 'SMOKE_PROVIDER_HOLD', 'failed');
    await eventually(async () => collector.events,
      events => events.some(event => event.requestId === cancelled.record.requestId && event.stage === 'cancellation_ack'),
      'correlated cancellation acknowledgment');
    const recoveryMessage = 'Recovery request after provider failure and cancellation.';
    const recovery = await streamChat({ ...options, sessionId, message: recoveryMessage });
    const recovered = await readCaseTurn(options, channelId, recoveryMessage);
    assert.equal(recovered.record.assistantMessage.content, recovery.text);
    assert.deepEqual(collector.errors, [], 'Failure trace collection lost evidence');
    options.report('cancelled turn terminalizes and the same session accepts a subsequent persisted reply');
    const requestIds = [failed.record.requestId, cancelled.record.requestId, recovered.record.requestId];
    return { name: 'provider-failure-cancel-recovery', failedTurnId: failed.record.turnId,
      cancelledTurnId: cancelled.record.turnId, recoveredTurnId: recovered.record.turnId,
      responseHash: hashContent(recovery.text), providerFaultVerified: true,
      events: collector.events.filter(event => requestIds.includes(event.requestId)) };
  } finally { collector.close(); }
}
