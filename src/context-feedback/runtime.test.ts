import { describe, expect, it, vi } from 'vitest';
import type { PostTurnActionInferer } from '../core/agent/substrate-agent.js';
import { wirePostTurnActionRuntime } from '../app/startup/composition/post-turn-actions.js';
import { EventBus } from '../shared/event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import type { ContextManifest } from '../session/context-manifest.js';
import type { AgentResponse, InferredPostTurnAction, PostTurnActionCandidate, SubstrateMessage } from '../shared/contracts/runtime.js';
import { CONTEXT_FEEDBACK_ACTION_KIND, wireContextFeedbackRuntime } from './runtime.js';

function makeMessage(): SubstrateMessage {
  return {
    id: 'msg-ctx-1',
    channelId: 'terminal:test',
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'User',
    content: 'Can you summarize what context you used?',
    timestamp: new Date(),
  };
}

function makeResponse(content = 'I used your recent messages and memory summary.'): AgentResponse {
  return {
    channelId: 'terminal:test',
    content,
    metadata: {
      model: 'chat-model',
      inputTokens: 640,
      outputTokens: 120,
      durationMs: 20,
    },
  };
}

function makeManifest(): ContextManifest {
  return {
    channelId: 'terminal:test',
    generatedAt: 1_700_000_001_000,
    session: {
      sourceEntryCount: 8,
      trimmedEntryCount: 0,
      maskedEntryCount: 0,
      compactedEntryCount: 0,
      finalEntryCount: 8,
      finalMessageCount: 8,
      compactionSummaryCount: 0,
      continuityEntryCount: 0,
    },
    memory: {
      includedCount: 2,
      includedTypes: { semantic: 1, procedural: 1 },
      includedTokenCount: 280,
      reason: 'ranked',
      candidateCount: 6,
      policyAllowedCount: 5,
      rankedCount: 4,
      returnedCount: 2,
      excluded: {
        sensitivityRejectedCount: 0,
        policyRejectedCount: 1,
        scoreRejectedCount: 1,
        budgetCappedCount: 2,
      },
      retrieval: {
        mode: 'budget',
        budgetPct: 2,
        tokenBudget: 1_000,
        limit: 5,
      },
    },
    budgets: {
      contextWindow: 128_000,
      adaptive: {
        enabled: true,
        source: 'default',
        category: 'default',
      },
      sessionHistory: {
        mode: 'budget',
        budgetPct: 6,
        tokenBudget: 8_000,
        estimatedCount: 24,
        actualCount: 8,
        actualTokenCount: 1_200,
      },
      memoryRetrieval: {
        mode: 'budget',
        budgetPct: 2,
        tokenBudget: 1_000,
        estimatedCount: 5,
        actualCount: 2,
        actualTokenCount: 280,
      },
      sections: [
        { section: 'system_prompt', tokenCount: 1_000 },
        { section: 'memories', tokenCount: 280 },
        { section: 'session_history', tokenCount: 1_200 },
      ],
    },
    compaction: {
      triggered: false,
      thresholdPct: 70,
      tokenBudget: 90_000,
      totalTokensBefore: 3_100,
      totalTokensAfter: 3_100,
    },
  };
}

function toInferredAction(
  candidate: PostTurnActionCandidate,
  message: SubstrateMessage,
  id: string,
): InferredPostTurnAction {
  return {
    id,
    kind: candidate.kind,
    payload: candidate.payload ?? {},
    dedupeKey: candidate.dedupeKey ?? `${candidate.kind}:${id}`,
    channelId: message.channelId,
    sourceMessageId: message.id,
    inferredAt: Date.now(),
    ...(candidate.maxRetries !== undefined ? { maxRetries: candidate.maxRetries } : {}),
  };
}

describe('wireContextFeedbackRuntime', () => {
  it('infers context-feedback actions and emits scored telemetry without waiting for idle', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });

    const inferers: PostTurnActionInferer[] = [];
    const agentLoop = {
      waitForIdle: vi.fn(() => new Promise<void>(() => {})),
      registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
        inferers.push(inferer);
        return () => {};
      }),
    };
    const postTurnActions = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 10,
    });

    const llmProvider = {
      stream: vi.fn(),
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          effectivenessScore: 0.91,
          signals: {
            confabulation: false,
            missed_context: false,
            wasted_tokens: false,
            good: true,
          },
          summary: 'Context matched task and avoided irrelevant history.',
        }),
        model: 'context-model',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 25,
        stopReason: 'stop',
      }),
    };
    const sessionStore = {
      getRecent: vi.fn().mockReturnValue([{
        id: 99,
        channelId: 'terminal:test',
        role: 'user',
        content: 'Thanks, that seems right.',
        timestamp: 1_700_000_010_500,
      }]),
    };

    const telemetryPhases: string[] = [];
    eventBus.on('context.feedback.telemetry', ({ phase }) => {
      telemetryPhases.push(phase);
    });

    wireContextFeedbackRuntime({
      agentLoop,
      postTurnActions,
      llmProvider: llmProvider as any,
      sessionStore: sessionStore as any,
      eventBus,
    });

    expect(inferers).toHaveLength(1);
    const inferer = inferers[0];
    const message = makeMessage();
    const response = makeResponse();
    const candidates = await inferer({
      message,
      response,
      turnMessages: [],
      turnId: 'turn-ctx-1' as any,
      completedAt: 1_700_000_010_000,
      contextManifest: makeManifest(),
      canonicalContactKey: 'contact:primary',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe(CONTEXT_FEEDBACK_ACTION_KIND);

    const inferredAction = toInferredAction(candidates[0]!, message, 'context-action-1');
    await eventBus.emit('agent.post_turn.actions.inferred', {
      message,
      response,
      actions: [inferredAction],
    });

    await scheduler.tick();

    expect(agentLoop.waitForIdle).not.toHaveBeenCalled();
    expect(llmProvider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        correlation: expect.objectContaining({
          callType: 'memory',
          originType: 'memory',
          originStage: 'context.feedback',
          purpose: 'context.feedback',
          channelId: 'terminal:test',
          turnId: 'turn-ctx-1',
          requestId: 'turn-ctx-1',
        }),
      }),
      'memory',
    );
    expect(telemetryPhases).toEqual(expect.arrayContaining(['started', 'scored', 'persisted']));
  });

  it('fails closed on malformed payload and emits failure telemetry', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    });

    const inferers: PostTurnActionInferer[] = [];
    const agentLoop = {
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
        inferers.push(inferer);
        return () => {};
      }),
    };
    const postTurnActions = wirePostTurnActionRuntime({
      eventBus,
      scheduler,
      agentLoop,
      intervalMs: 10,
    });

    const contextPhases: string[] = [];
    const postTurnPhases: string[] = [];
    eventBus.on('context.feedback.telemetry', ({ phase }) => {
      contextPhases.push(phase);
    });
    eventBus.on('agent.post_turn.action.telemetry', ({ phase, actionKind }) => {
      if (actionKind === CONTEXT_FEEDBACK_ACTION_KIND) {
        postTurnPhases.push(phase);
      }
    });

    wireContextFeedbackRuntime({
      agentLoop,
      postTurnActions,
      llmProvider: {
        stream: vi.fn(),
        complete: vi.fn(),
      } as any,
      sessionStore: {
        getRecent: vi.fn().mockReturnValue([]),
      } as any,
      eventBus,
    });

    const message = makeMessage();
    const response = makeResponse();
    const malformedAction: InferredPostTurnAction = {
      id: 'context-action-malformed',
      kind: CONTEXT_FEEDBACK_ACTION_KIND,
      payload: {},
      dedupeKey: 'context.score_feedback:malformed',
      channelId: message.channelId,
      sourceMessageId: message.id,
      inferredAt: Date.now(),
      maxRetries: 0,
    };
    await eventBus.emit('agent.post_turn.actions.inferred', {
      message,
      response,
      actions: [malformedAction],
    });

    await scheduler.tick();

    expect(contextPhases).toContain('failed');
    expect(postTurnPhases).toContain('failed');
  });
});
