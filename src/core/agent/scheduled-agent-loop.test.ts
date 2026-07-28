import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai';
import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import type { AgentLoopErrorEvent, ScheduledAgentEvent } from './agent-loop-events.js';
import { agentLoopWithScheduler, resolveStreamResult } from './scheduled-agent-loop.js';
import {
  AGENT_LOOP_ASSISTANT_STEP_CHECK_IN_AT,
  AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN,
  ParentTurnContinuationBudgetExceededError,
} from './turn-limits.js';

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

type ResultContract = 'value' | 'promise';

function makeAssistantMessage(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'chat',
    provider: 'test',
    model: 'test-model',
    usage: ZERO_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function makeLoopConfig() {
  return {
    model: {
      id: 'test-model',
      api: 'chat',
      provider: 'test',
    },
    convertToLlm: async (messages: any[]) => messages,
    getSteeringMessages: async () => [],
    getFollowUpMessages: async () => [],
  };
}

function makeStreamFn(resultContract: ResultContract) {
  return vi.fn(async () => {
    const partial = makeAssistantMessage('partial');
    const final = makeAssistantMessage('final answer');
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial };
        yield { type: 'done' };
      },
      result: resultContract === 'value' ? final : Promise.resolve(final),
    } as any;
  });
}

describe('scheduled-agent-loop stream result contract', () => {
  it.each<ResultContract>(['value', 'promise'])(
    'accepts non-callable stream result as %s',
    async (resultContract) => {
      const streamFn = makeStreamFn(resultContract);
      const events: any[] = [];

      const stream = agentLoopWithScheduler(
        [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as any],
        {
          systemPrompt: 'system prompt',
          messages: [],
          tools: [],
        } as any,
        makeLoopConfig() as any,
        new AbortController().signal,
        streamFn as any,
        { maxParallelToolCalls: 1 },
      );

      for await (const event of stream) {
        events.push(event);
      }

      expect(streamFn).toHaveBeenCalledTimes(1);

      const finalMessageEnd = [...events].reverse().find(
        (event) => event.type === 'message_end' && event.message?.role === 'assistant',
      );
      expect(finalMessageEnd?.message?.content).toEqual([{ type: 'text', text: 'final answer' }]);

      const agentEnd = events.find((event) => event.type === 'agent_end');
      expect(agentEnd?.messages?.at(-1)?.content).toEqual([{ type: 'text', text: 'final answer' }]);
    },
  );

  it('uses done-event message when response.result is absent', async () => {
    const final = makeAssistantMessage('done payload final');
    const streamFn = vi.fn(async () => {
      const partial = makeAssistantMessage('partial');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial };
          yield { type: 'done', message: final };
        },
      } as any;
    });
    const events: any[] = [];

    const stream = agentLoopWithScheduler(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as any],
      {
        systemPrompt: 'system prompt',
        messages: [],
        tools: [],
      } as any,
      makeLoopConfig() as any,
      new AbortController().signal,
      streamFn as any,
      { maxParallelToolCalls: 1 },
    );

    for await (const event of stream) {
      events.push(event);
    }

    const finalMessageEnd = [...events].reverse().find(
      (event) => event.type === 'message_end' && event.message?.role === 'assistant',
    );
    expect(finalMessageEnd?.message?.content).toEqual([{ type: 'text', text: 'done payload final' }]);

    const agentEnd = events.find((event) => event.type === 'agent_end');
    expect(agentEnd?.messages?.at(-1)?.content).toEqual([{ type: 'text', text: 'done payload final' }]);
  });

  it('throws when no final assistant message is available anywhere', async () => {
    await expect(resolveStreamResult({} as any, {
      terminalEvent: { type: 'done' },
      partialMessage: null,
    })).rejects.toThrow('Stream response missing result payload');
  });

  it('surfaces terminal stream failure without emitting a synthetic assistant message', async () => {
    const streamFn = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('terminal model failure');
      },
    }) as any);
    const events: any[] = [];

    const stream = agentLoopWithScheduler(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as any],
      {
        systemPrompt: 'system prompt',
        messages: [],
        tools: [],
      } as any,
      makeLoopConfig() as any,
      new AbortController().signal,
      streamFn as any,
      { maxParallelToolCalls: 1 },
    );

    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'message_end' && event.message?.role === 'assistant')).toBe(false);
    expect(events.find((event) => event.type === 'agent_error')?.error?.message).toBe('terminal model failure');
    const agentEnd = events.find((event) => event.type === 'agent_end');
    expect(agentEnd?.messages).toHaveLength(1);
    expect(agentEnd?.messages?.[0]?.role).toBe('user');
  });

  it('fails closed when no explicit streamFn is provided', async () => {
    const events: any[] = [];

    const stream = agentLoopWithScheduler(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as any],
      {
        systemPrompt: 'system prompt',
        messages: [],
        tools: [],
      } as any,
      makeLoopConfig() as any,
      new AbortController().signal,
      undefined,
      { maxParallelToolCalls: 1 },
    );

    for await (const event of stream) {
      events.push(event);
    }

    expect(events.find((event) => event.type === 'agent_error')?.error?.message)
      .toBe('Scheduled agent loop requires an explicit streamFn; direct provider fallback is disabled.');
    expect(events.some((event) => event.type === 'message_end' && event.message?.role === 'assistant')).toBe(false);
  });

  it('drains pre-queued follow-ups before the reply and marks the boundary only for mid-run drains', async () => {
    const streamFn = makeStreamFn('value');
    const events: any[] = [];
    // First batch is already queued when the run starts (a pre-existing
    // intention whisper); the second batch models a follow-up that arrives
    // mid-run (a background completion) and is drained at end-of-loop.
    const whisperBatches: any[][] = [
      [{
        role: 'custom',
        type: 'internalWhisper',
        messageClass: 'internalWhisper',
        content: 'Note to self: vary the reply.',
        speakerName: 'Whisper',
        timestamp: Date.now(),
      }],
      [{
        role: 'custom',
        type: 'systemNote',
        messageClass: 'systemNote',
        content: '[SYSTEM: CompletionHandoff] internal note',
        timestamp: Date.now(),
      }],
    ];
    const config = {
      ...makeLoopConfig(),
      getFollowUpMessages: async () => whisperBatches.shift() ?? [],
    };

    const stream = agentLoopWithScheduler(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as any],
      {
        systemPrompt: 'system prompt',
        messages: [],
        tools: [],
      } as any,
      config as any,
      new AbortController().signal,
      streamFn as any,
      { maxParallelToolCalls: 1 },
    );

    for await (const event of stream) {
      events.push(event);
    }

    const boundaryIndexes = events
      .map((event, index) => (event.type === 'user_facing_boundary' ? index : -1))
      .filter(index => index >= 0);
    // Only the mid-run drain marks the boundary; the start drain does not.
    expect(boundaryIndexes).toHaveLength(1);

    const customEndIndexes = events
      .map((event, index) => (
        event.type === 'message_end' && event.message?.role === 'custom' ? index : -1
      ))
      .filter(index => index >= 0);
    const assistantEndIndexes = events
      .map((event, index) => (
        event.type === 'message_end' && event.message?.role === 'assistant' ? index : -1
      ))
      .filter(index => index >= 0);

    // The pre-queued whisper is drained at run START as pre-reply context: it
    // appears before both the boundary and the first authored reply, so it
    // shapes that reply rather than trailing it as a continuation.
    expect(customEndIndexes[0]).toBeLessThan(boundaryIndexes[0]!);
    expect(customEndIndexes[0]).toBeLessThan(assistantEndIndexes[0]!);
    // The first reply is authored before the boundary (ay73: the outward reply
    // stays user-facing and cannot be clobbered by later internal continuation).
    expect(assistantEndIndexes[0]).toBeLessThan(boundaryIndexes[0]!);
    // The mid-run follow-up and its continuation reply fall after the boundary.
    expect(customEndIndexes[1]).toBeGreaterThan(boundaryIndexes[0]!);
    expect(assistantEndIndexes.at(-1)).toBeGreaterThan(boundaryIndexes[0]!);
  });

  it('makes a pre-queued whisper visible to the reply it shapes without an extra continuation step', async () => {
    const streamFn = makeStreamFn('value');
    const events: any[] = [];
    const whisperBatches: any[][] = [
      [{
        role: 'custom',
        type: 'internalWhisper',
        messageClass: 'internalWhisper',
        content: 'Whisper: gently check on their arm.',
        speakerName: 'Whisper',
        timestamp: Date.now(),
      }],
    ];
    const config = {
      ...makeLoopConfig(),
      // Snapshot the context per call so the assertion sees exactly what the
      // model was given when it authored the reply (the live array is mutated
      // in place as the assistant partial streams in).
      convertToLlm: async (messages: any[]) => [...messages],
      getFollowUpMessages: async () => whisperBatches.shift() ?? [],
    };

    const stream = agentLoopWithScheduler(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as any],
      {
        systemPrompt: 'system prompt',
        messages: [],
        tools: [],
      } as any,
      config as any,
      new AbortController().signal,
      streamFn as any,
      { maxParallelToolCalls: 1 },
    );

    for await (const event of stream) {
      events.push(event);
    }

    // Exactly one assistant step: the whisper shaped the reply in-line rather
    // than triggering a post-reply continuation LLM call.
    expect(streamFn).toHaveBeenCalledTimes(1);
    // No boundary: a start-drained whisper is pre-reply context, not internal
    // continuation.
    expect(events.some((event) => event.type === 'user_facing_boundary')).toBe(false);

    // The whisper was present in the context the model saw when authoring the
    // reply, and it preceded the (absent) assistant message in that context.
    const firstCallMessages = (streamFn.mock.calls[0]?.[1] as { messages: any[] }).messages;
    const whisperIndex = firstCallMessages.findIndex(
      (message: any) => message?.role === 'custom' && message?.type === 'internalWhisper',
    );
    const userIndex = firstCallMessages.findIndex((message: any) => message?.role === 'user');
    expect(whisperIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(whisperIndex).toBeGreaterThan(userIndex);
    expect(firstCallMessages.some((message: any) => message?.role === 'assistant')).toBe(false);
  });

  it('does not mark the boundary when the drained follow-up batch contains a user message', async () => {
    const streamFn = makeStreamFn('value');
    const events: any[] = [];
    const batches: any[][] = [
      [{
        role: 'user',
        content: [{ type: 'text', text: 'follow-up user message' }],
        timestamp: Date.now(),
      }],
    ];
    const config = {
      ...makeLoopConfig(),
      getFollowUpMessages: async () => batches.shift() ?? [],
    };

    const stream = agentLoopWithScheduler(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as any],
      {
        systemPrompt: 'system prompt',
        messages: [],
        tools: [],
      } as any,
      config as any,
      new AbortController().signal,
      streamFn as any,
      { maxParallelToolCalls: 1 },
    );

    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'user_facing_boundary')).toBe(false);
  });

  it('does not mark the boundary for runs without follow-up drains', async () => {
    const streamFn = makeStreamFn('value');
    const events: any[] = [];

    const stream = agentLoopWithScheduler(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as any],
      {
        systemPrompt: 'system prompt',
        messages: [],
        tools: [],
      } as any,
      makeLoopConfig() as any,
      new AbortController().signal,
      streamFn as any,
      { maxParallelToolCalls: 1 },
    );

    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'user_facing_boundary')).toBe(false);
  });

  it('stops repeated follow-up continuations with a bounded diagnostic', async () => {
    const streamFn = makeStreamFn('value');
    const events: any[] = [];
    const config = {
      ...makeLoopConfig(),
      getFollowUpMessages: async () => [{
        role: 'user',
        content: [{ type: 'text', text: 'continue' }],
        timestamp: Date.now(),
      }],
    };

    const stream = agentLoopWithScheduler(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as any],
      {
        systemPrompt: 'system prompt',
        messages: [],
        tools: [],
      } as any,
      config as any,
      new AbortController().signal,
      streamFn as any,
      { maxParallelToolCalls: 1 },
    );

    for await (const event of stream) {
      events.push(event);
    }

    expect(streamFn).toHaveBeenCalledTimes(AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN);
    const checkInMessages = events.filter((event) => {
      if (event.type !== 'message_end' || event.message?.role !== 'system') return false;
      const text = event.message.content?.[0]?.text;
      return typeof text === 'string' && text.includes('[SYSTEM: Long-Horizon Check-In]');
    });
    expect(checkInMessages).toHaveLength(1);
    expect(checkInMessages[0]?.message?.content?.[0]?.text)
      .toContain(`used ${AGENT_LOOP_ASSISTANT_STEP_CHECK_IN_AT} assistant steps`);
    const terminalError = events.find((event) => event.type === 'agent_error')?.error;
    expect(terminalError).toBeInstanceOf(ParentTurnContinuationBudgetExceededError);
    expect(terminalError).toMatchObject({
      stop: {
        reason: 'prompt_entry_limit',
        promptEntries: AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN,
        maxPromptEntries: AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN,
      },
    });
    expect(events.some((event) => (
      event.type === 'message_end'
      && event.message?.role === 'assistant'
      && event.message?.errorMessage === 'agent_loop_step_limit_exceeded'
    ))).toBe(false);
  });
});

describe('scheduled agent loop event typing', () => {
  it('pins the ScheduledAgentEvent alphabet emitted by the loop stream', () => {
    type LoopEvent = ReturnType<typeof agentLoopWithScheduler> extends AsyncIterable<infer TEvent>
      ? TEvent
      : never;
    expectTypeOf<LoopEvent>().toEqualTypeOf<ScheduledAgentEvent>();
    expectTypeOf<{ type: 'user_facing_boundary' }>().toExtend<ScheduledAgentEvent>();
    expectTypeOf<AgentLoopErrorEvent>().toExtend<ScheduledAgentEvent>();
    expectTypeOf<Extract<ScheduledAgentEvent, { type: 'turn_end' }>>().toEqualTypeOf<{
      type: 'turn_end';
      message: AgentMessage;
      toolResults: ToolResultMessage[];
    }>();
  });

  it('narrows assistant content to ToolCall structurally, without assertions', () => {
    const narrowToolCalls = (content: AssistantMessage['content']) =>
      content.filter((entry): entry is ToolCall => entry.type === 'toolCall');
    expectTypeOf(narrowToolCalls).returns.toEqualTypeOf<ToolCall[]>();
    expectTypeOf(narrowToolCalls).parameter(0)
      .toEqualTypeOf<(AssistantMessage['content'][number])[]>();
  });
});
