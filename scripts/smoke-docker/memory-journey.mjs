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
  const recallSession = sourceSession;
  const message = `My project ${project} has launch phrase ${phrase}.`;
  options.checkpoint?.('source_turn');
  let collector = await collectTelemetry(options);
  options.capture?.(collector);
  try {
    const source = await streamChat({ ...options, sessionId: sourceSession, message });
    const sourceTurn = await readCaseTurn(options, options.channelForSession(sourceSession), message);
    assert.equal(sourceTurn.record.assistantMessage.content, source.text);
    assert.ok(sourceTurn.record.backgroundWorkHandoff, 'Production turn did not persist a background handoff');
    options.checkpoint?.('automatic_extraction');
    const jobs = await eventually(() => options.readBackgroundJobs(sourceTurn.record.turnId),
      values => values.some(job => job.kind === 'memory_extraction' && job.state === 'succeeded'),
      'automatic memory extraction for the source turn', 120_000);
    // Independent durable readback; Garden correctly withholds another subject's
    // memories from its standalone admin identity. Product recall below must still
    // authorize this same API contact and retrieve the actual persisted row.
    const found = await options.readCaseMemory(project);
    const memory = found.find(candidate => candidate.text?.includes(phrase));
    assert.ok(memory?.id, 'Automatic extraction did not persist the randomized fact');
    options.report('production post-turn extraction persisted the randomized fact and completed its source-bound job');
    options.checkpoint?.('fresh_context_window');
    // Keep the same authorized room, but roll the source message out of the
    // real bounded history. Session reset deliberately quarantines its derived
    // memories; another API room lacks proven DM identity and cannot recall it.
    for (let index = 0; index < 3; index += 1) {
      await streamChat({ ...options, sessionId: sourceSession,
        message: `Context window passage ${index}: ${'The orchard paths are quiet today. '.repeat(450)}` });
    }
    collector.close();
    collector = undefined;
    options.checkpoint?.('restart');
    await options.restartAgent();
    await options.waitForHealth(120_000);
    collector = await collectTelemetry(options);
    options.capture?.(collector);
    options.checkpoint?.('fresh_context_retrieval');
    const coldQuestion = `What is the launch phrase for my project ${project}?`;
    assert.equal(coldQuestion.includes(phrase), false, 'Recall request leaks the expected answer');
    const coldReply = await streamChat({ ...options, sessionId: recallSession, message: coldQuestion });
    const coldTurn = await readCaseTurn(options, options.channelForSession(recallSession), coldQuestion);
    // Production recall reads a last-good active context and refreshes it in the
    // background. Await evidence of that refresh, never poll answers to green.
    await eventually(() => gardenJson(options, `/api/admin/sessions/${encodeURIComponent(options.channelForSession(recallSession))}/turns/${coldTurn.record.turnId}`),
      value => value.turn?.retrievals?.some(item => item.requestId === coldTurn.record.requestId
        && item.data?.provenanceRefs?.includes(`memory:${memory.id}`)), 'source-bound post-restart memory refresh');
    options.checkpoint?.('eventual_recall_after_refresh');
    const question = `${coldQuestion} Answer with the phrase only.`;
    const reply = await streamChat({ ...options, sessionId: recallSession, message: question });
    assert.equal(reply.text.trim(), phrase, 'Provider did not receive the stored fact through retrieval');
    const turn = await readCaseTurn(options, options.channelForSession(recallSession), question);
    const snapshot = turn.snapshot;
    const memoryBlock = snapshot?.plan?.blocks?.find(block => block.id === 'memory.retrieval');
    assert.ok(memoryBlock?.sources?.some(source => source.kind === 'memory' && source.refId === memory.id),
      'Consumed prompt plan does not identify the stored memory');
    assert.ok(snapshot?.sessionContext, 'Recall snapshot omitted session context');
    // If startup hydration already delivered the answer on the cold turn, that
    // answer naturally appears in the next history. Assert the first successful
    // recall's context, while both successes still require memory-only oracle.
    const freshContext = coldReply.text.trim() === phrase ? coldTurn.snapshot?.sessionContext : snapshot.sessionContext;
    assert.ok(freshContext, 'Cold recall snapshot omitted session context');
    assert.equal(JSON.stringify(freshContext).includes(phrase), false,
      'Recall answer leaked into history, continuity, compaction or orientation summaries');
    assert.deepEqual(collector.errors, [], 'Memory trace collection lost evidence');
    options.report('post-restart recall after active-context refresh consumes the actual memory ID; first successful answer absent from request and all history');
    return { name: 'automatic-memory-restart-retrieval', sourceTurnId: sourceTurn.record.turnId,
      sourceRequestId: sourceTurn.record.requestId, recallTurnId: turn.record.turnId, refreshTurnId: coldTurn.record.turnId, coldRecallDelivered: coldReply.text.trim() === phrase,
      memoryId: memory.id, sourceSession, factHash: hashContent(memory.text), answerHash: hashContent(phrase),
      jobIds: jobs.filter(job => job.kind === 'memory_extraction').map(job => job.job_id),
      events: collector.events.filter(event => event.requestId === turn.record.requestId), restartVerified: true };
  } finally { collector?.close(); }
}
