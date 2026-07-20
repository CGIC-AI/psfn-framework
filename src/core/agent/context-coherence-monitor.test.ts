import { describe, expect, it } from 'vitest';
import { EventBus, type EventMap } from '../../shared/event-bus.js';
import type { ContextCoherenceEvent } from '../../shared/contracts/context-coherence.js';
import { createTurnId } from '../turns/id.js';
import type { SessionEntry } from '../session/types.js';
import { installContextCoherenceMonitor } from './context-coherence-monitor.js';
import type { TurnSessionContextSnapshot } from '../turns/snapshot.js';
import { healStaleCapturedSessionWindow } from './substrate-agent/turn-execution/pre-turn-state.js';

describe('context-coherence telemetry', () => {
  it('correlates a seeded missing-turn incident with a confusion event', async () => {
    const eventBus = new EventBus();
    const turnId = createTurnId();
    const now = 1_721_234_567_890;
    const recentEntries: SessionEntry[] = [
      {
        id: 40,
        channelId: 'api:test',
        role: 'assistant',
        content: 'The earlier response.',
        timestamp: now - 60_000,
      },
      {
        id: 41,
        channelId: 'api:test',
        role: 'system',
        content: 'Cross-channel context.',
        authorId: 'session-mirror',
        timestamp: now - 30_000,
        metadata: JSON.stringify({ type: 'mirror', sourceChannelId: 'discord:dm' }),
      },
    ];
    const events: ContextCoherenceEvent[] = [];
    const dispose = installContextCoherenceMonitor({
      eventBus,
      getRecentSessionEntries: () => recentEntries,
      now: () => now,
    });
    eventBus.on('context.coherence.detected', event => events.push(event));

    const staleSnapshot: TurnSessionContextSnapshot = {
      channelId: 'api:test',
      recentEntries: [],
      compactionSummaryTexts: [],
      focusKnowledgeTexts: [],
      continuityEntries: [],
      versionPointer: 'stale',
      storeWindowMaxEntryId: 40,
    };
    await healStaleCapturedSessionWindow({
      snapshot: staleSnapshot,
      currentSessionEntryId: 42,
      channelId: 'api:test',
      turnId,
      requestId: 'request-1',
      sessionManager: {
        reconcileSessionChannelFromDisk: async () => ({ maxEntryId: 42, lastMessageEntryId: 42 }),
      },
      recapture: async () => ({
        ...staleSnapshot,
        versionPointer: 'healed',
        storeWindowMaxEntryId: 42,
      }),
      emitTelemetry: (event, payload) => {
        if (event === 'session.context.stale_window_heal') {
          void eventBus.emit(event, payload as EventMap[typeof event]);
        } else if (event === 'session.context.stale_window_heal_failed') {
          void eventBus.emit(event, payload as EventMap[typeof event]);
        }
      },
    });
    await eventBus.emit('agent.turn.end', {
      message: {
        id: 'message-1',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'operator',
        authorName: 'Operator',
        content: 'Please continue.',
        timestamp: new Date(now),
      },
      response: {
        channelId: 'api:test',
        content: 'Can you remind me which thread we were in?',
        metadata: {
          model: 'test-model',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
          turnId,
          requestId: 'request-1',
        },
      },
      turnId,
      requestId: 'request-1',
      sessionId: 'session:test',
      requesterProvenance: 'human',
      requestAudience: 'primary_contact',
    } satisfies EventMap['agent.turn.end']);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      signal: 'confusion_ask',
      source: 'turn_end',
      channelId: 'api:test',
      sessionId: 'session:test',
      turnId,
      requestId: 'request-1',
      detail: 'asked_for_reminder',
      groundTruth: false,
      context: {
        recentMirrorNoteCount: 1,
        timeGapMs: 60_000,
        activeConcernCount: null,
      },
      correlations: [{
        kind: 'missing_turn',
        healed: true,
        expectedMinEntryId: 42,
        observedMaxEntryId: 40,
      }],
      eligibleForEmotionAppraisal: false,
      eligibleForMemoryCandidacy: false,
    });

    dispose();
  });

  it('reports repetition, confabulation self-reports, and operator labels as separate signals', async () => {
    const eventBus = new EventBus();
    const turnId = createTurnId();
    const events: ContextCoherenceEvent[] = [];
    const dispose = installContextCoherenceMonitor({
      eventBus,
      getRecentSessionEntries: () => [],
      now: () => 200,
    });
    eventBus.on('context.coherence.detected', event => events.push(event));

    await eventBus.emit('agent.turn.end', {
      message: {
        id: 'message-2',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'operator',
        authorName: 'Operator',
        content: "You're looping love; pause for a second.",
        timestamp: new Date(100),
      },
      response: {
        channelId: 'api:test',
        content: 'I realize I was confabulating there.',
        metadata: {
          model: 'test-model',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
          turnId,
          requestId: 'request-2',
          metacognitiveFlags: [{
            flag: 'repetition',
            confidence: 0.9,
            evidence: 'duplicate reply',
          }],
        },
      },
      turnId,
      requestId: 'request-2',
      sessionId: 'session:test',
      requesterProvenance: 'human',
      requestAudience: 'primary_contact',
    } satisfies EventMap['agent.turn.end']);

    expect(events.map(event => event.signal)).toEqual([
      'looping',
      'confabulation_self_report',
      'operator_intervention',
    ]);
    expect(events.at(-1)).toMatchObject({
      detail: 'operator_named_looping',
      groundTruth: true,
      operatorLabel: 'looping',
    });

    dispose();
  });

  it('does not treat third-person mentions or non-partner ingress as confirmed incidents', async () => {
    const eventBus = new EventBus();
    const turnId = createTurnId();
    const events: ContextCoherenceEvent[] = [];
    const dispose = installContextCoherenceMonitor({
      eventBus,
      getRecentSessionEntries: () => [],
      now: () => 300,
    });
    eventBus.on('context.coherence.detected', event => events.push(event));

    await eventBus.emit('agent.turn.end', {
      message: {
        id: 'message-3',
        channelId: 'discord:group',
        channelType: 'discord',
        authorId: 'group-participant',
        authorName: 'Participant',
        content: "You're looping.",
        timestamp: new Date(250),
      },
      response: {
        channelId: 'discord:group',
        content: 'The article discusses hallucination and confabulation as model risks.',
        metadata: {
          model: 'test-model',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
          turnId,
          requestId: 'request-3',
        },
      },
      turnId,
      requestId: 'request-3',
      sessionId: 'session:test',
      requesterProvenance: 'human',
      requestAudience: 'external',
    } satisfies EventMap['agent.turn.end']);

    expect(events).toEqual([]);
    dispose();
  });
});
