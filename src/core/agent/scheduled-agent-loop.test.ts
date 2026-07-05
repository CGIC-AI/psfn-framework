import { describe, expect, it, vi } from 'vitest';
import { agentLoopWithScheduler, resolveStreamResult } from './scheduled-agent-loop.js';
import {
  AGENT_LOOP_ASSISTANT_STEP_CHECK_IN_AT,
  AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN,
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

  it('marks the user-facing boundary once when internal follow-ups drain into the run', async () => {
    const streamFn = makeStreamFn('value');
    const events: any[] = [];
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
    expect(boundaryIndexes).toHaveLength(1);

    // The boundary must precede the injected whisper and every later
    // assistant message so bounded extraction excludes continuation text.
    const firstWhisperEventIndex = events.findIndex(
      (event) => event.type === 'message_end' && event.message?.role === 'custom',
    );
    expect(firstWhisperEventIndex).toBeGreaterThan(boundaryIndexes[0]!);

    const assistantEndIndexes = events
      .map((event, index) => (
        event.type === 'message_end' && event.message?.role === 'assistant' ? index : -1
      ))
      .filter(index => index >= 0);
    expect(assistantEndIndexes[0]).toBeLessThan(boundaryIndexes[0]!);
    expect(assistantEndIndexes.at(-1)).toBeGreaterThan(boundaryIndexes[0]!);
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
    const finalAssistant = [...events].reverse().find(
      (event) => event.type === 'message_end' && event.message?.role === 'assistant',
    )?.message;
    expect(finalAssistant?.errorMessage).toBe('agent_loop_step_limit_exceeded');
    expect(finalAssistant?.content?.[0]?.text)
      .toContain(`Turn stopped after ${AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN} assistant steps`);
  });
});
