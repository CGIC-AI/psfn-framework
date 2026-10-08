import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { collectTelemetry, hashContent, streamChat } from './evidence.mjs';
import { eventually, gardenJson } from './journeys.mjs';

export async function readCaseTurn(options, channelId, message, status = 'completed') {
  const path = `/api/admin/sessions/${encodeURIComponent(channelId)}`;
  const session = await eventually(() => gardenJson(options, path),
    value => value.turns?.some(turn => turn.record?.userMessage?.content === message && turn.record?.status === status),
    `the exact ${status} case turn`);
  return session.turns.find(turn => turn.record?.userMessage?.content === message && turn.record?.status === status);
}

export async function runMemoryJourney(options) {
  const token = randomBytes(8).toString('hex');
  const project = `orchard${token}`;
  const phrase = `violet-${randomBytes(8).toString('hex')}`;
  const sourceSession = `memory-source-${token}`;
  const recallSession = `memory-recall-${token}`;
  const message = `My project ${project} has launch phrase ${phrase}.`;
  const source = await streamChat({ ...options, sessionId: sourceSession, message });
  const sourceTurn = await readCaseTurn(options, options.channelForSession(sourceSession), message);
  assert.equal(sourceTurn.record.assistantMessage.content, source.text);
  assert.ok(sourceTurn.record.backgroundWorkHandoff, 'Production turn did not persist a background handoff');
  const jobs = await eventually(() => options.readBackgroundJobs(sourceTurn.record.turnId),
    values => values.some(job => job.kind === 'memory_extraction' && job.state === 'succeeded'),
    'automatic memory extraction for the source turn', 60_000);
  const found = await gardenJson(options, `/api/admin/memory/search?q=${encodeURIComponent(project)}`);
  const memory = found.results?.find(candidate => candidate.text?.includes(phrase));
  assert.ok(memory?.id, 'Automatic extraction did not persist the randomized fact');
  options.report('production post-turn extraction persisted the randomized fact and completed its source-bound job');
  await options.restartAgent();
  await options.waitForHealth(120_000);
  const collector = await collectTelemetry(options);
  try {
    const question = `What is the launch phrase for my project ${project}?`;
    assert.equal(question.includes(phrase), false, 'Recall request leaks the expected answer');
    const reply = await streamChat({ ...options, sessionId: recallSession, message: question });
    assert.equal(reply.text.trim(), phrase, 'Provider did not receive the stored fact through retrieval');
    const turn = await readCaseTurn(options, options.channelForSession(recallSession), question);
    const snapshot = turn.snapshot ?? turn.record.observability?.snapshot;
    const candidates = [...(snapshot?.memory?.semanticCandidates ?? []), ...(snapshot?.memory?.lexicalCandidates ?? []),
      ...(snapshot?.memory?.contactEmotionalMemories ?? []), ...(snapshot?.memory?.proactiveCandidates ?? [])];
    assert.ok(candidates.some(candidate => candidate.id === memory.id), 'Recall trace does not identify the stored memory');
    const history = snapshot?.sessionContext?.recentEntries ?? [];
    assert.ok(history.every(entry => !String(entry.content).includes(phrase)), 'Fresh-context recall was answered from conversation history');
    assert.deepEqual(collector.errors, [], 'Memory trace collection lost evidence');
    options.report('fresh-session recall after restart uses the actual stored memory ID; answer absent from request and history');
    return { name: 'automatic-memory-restart-retrieval', sourceTurnId: sourceTurn.record.turnId,
      sourceRequestId: sourceTurn.record.requestId, recallTurnId: turn.record.turnId,
      memoryId: memory.id, factHash: hashContent(memory.text), answerHash: hashContent(phrase),
      jobIds: jobs.filter(job => job.kind === 'memory_extraction').map(job => job.job_id),
      events: collector.events.filter(event => event.requestId === turn.record.requestId), restartVerified: true };
  } finally { collector.close(); }
}
