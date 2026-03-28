import { describe, expect, it, vi } from 'vitest';
import { agentLoopWithScheduler, resolveStreamResult } from './scheduled-agent-loop.js';

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
});
