import { describe, expect, it, vi } from 'vitest';
import { agentLoopWithScheduler } from './scheduled-agent-loop.js';

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
});
