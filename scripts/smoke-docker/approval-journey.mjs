import { fixtureFetch } from './https.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { collectTelemetry, streamChat } from './evidence.mjs';
import { eventually, gardenJson } from './journeys.mjs';
import { readCaseTurn } from './memory-journey.mjs';

async function resolveApproval(options, id, decision) {
  const response = await fixtureFetch(options, `${options.gardenBase}/api/admin/confirmations/resolve`, {
    method: 'POST', headers: { Authorization: `Bearer ${options.adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, decision }), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `Confirmation transport returned HTTP ${response.status}`);
  return response.json();
}

export async function runApprovalJourney(options) {
  const collector = await collectTelemetry(options);
  options.capture?.(collector);
  try {
    const initial = await options.readDeletionEffect(options.memoryId);
    assert.deepEqual(initial, { deleted: false, checkpointCount: 0 });
    const proof = [];
    for (const decision of ['deny', 'approve']) {
      options.checkpoint?.(`request_${decision}`);
      const sessionId = options.sourceSession;
      const message = `SMOKE_DELETE_MEMORY ${options.memoryId} ${decision} ${randomBytes(8).toString('hex')}`;
      await streamChat({ ...options, sessionId, message });
      const turn = await readCaseTurn(options, options.channelForSession(sessionId), message);
      const queue = await eventually(() => gardenJson(options, '/api/admin/confirmations'),
        value => value.entries?.some(entry => entry.params?.memoryId === options.memoryId && entry.status === 'pending'),
        'actual tool approval queue entry');
      const entry = queue.entries.find(candidate => candidate.params?.memoryId === options.memoryId && candidate.status === 'pending');
      assert.equal(entry.method, 'memory.deletion.validate');
      assert.deepEqual(await options.readDeletionEffect(options.memoryId), initial, 'Tool changed memory before approval');
      const toolEvents = collector.events.filter(event => event.requestId === turn.record.requestId && event.type === 'agent.tool.end');
      assert.ok(toolEvents.length > 0, 'No correlated tool execution evidence');
      options.checkpoint?.(`resolve_${decision}`);
      const result = await resolveApproval(options, entry.id, decision);
      assert.equal(result.status, decision === 'approve' ? 'approved' : 'denied');
      const expected = { deleted: decision === 'approve', checkpointCount: decision === 'approve' ? 1 : 0 };
      assert.deepEqual(await options.readDeletionEffect(options.memoryId), expected, 'Approval effect differs from the operator decision');
      options.checkpoint?.(`replay_${decision}`);
      const replay = await resolveApproval(options, entry.id, decision);
      assert.notEqual(replay.executed, true, 'Replayed approval executed again');
      assert.deepEqual(await options.readDeletionEffect(options.memoryId), expected, 'Replayed decision changed the effect count');
      proof.push({ turnId: turn.record.turnId, requestId: turn.record.requestId, approvalId: entry.id, decision, checkpointCount: expected.checkpointCount });
    }
    assert.deepEqual(collector.errors, []);
    options.report('real memory tool has no premature effect; denial preserves it; approval creates exactly one checkpoint and replay creates none');
    return { memoryId: options.memoryId, decisions: proof };
  } finally { collector.close(); }
}
