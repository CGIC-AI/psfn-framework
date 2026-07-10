import { Agent, type AgentMessage } from '../../../../boundary/pi-agent/index.js';
import { installAgentToolSchedulerPatch } from '../../../../boundary/pi-agent/agent-loop-patch.js';
import type { AssistantMessage, Model, UserMessage } from '@mariozechner/pi-ai';
import { describe, expect, it, vi } from 'vitest';

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function userMessage(content: string, timestamp: number): UserMessage {
  return { role: 'user', content, timestamp };
}

describe('scheduled prompt history', () => {
  it('keeps the final prior assistant and one current input in every tool-loop provider call', async () => {
    const priorAssistant = assistantMessage([{ type: 'text', text: 'earlier assistant reply' }], 'stop');
    const providerContexts: AgentMessage[][] = [];
    const streamedMessages = [
      assistantMessage([{
        type: 'toolCall',
        id: 'call-1',
        name: 'orient',
        arguments: {},
      }], 'toolUse'),
      assistantMessage([{ type: 'text', text: 'fresh answer after orienting' }], 'stop'),
    ];
    let streamIndex = 0;
    const streamFn = vi.fn(async (_model: unknown, context: { messages: AgentMessage[] }) => {
      providerContexts.push(structuredClone(context.messages));
      const finalMessage = structuredClone(streamedMessages[streamIndex] ?? streamedMessages.at(-1));
      streamIndex += 1;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: structuredClone(finalMessage) };
          yield { type: 'done' };
        },
        result: async () => structuredClone(finalMessage),
      };
    });
    const model: Model<'openai-completions'> = {
      id: 'test-model',
      name: 'Test Model',
      api: 'openai-completions',
      provider: 'test',
      baseUrl: 'http://127.0.0.1.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    };
    const agent = new Agent({
      initialState: { model },
      streamFn: streamFn as never,
    });
    installAgentToolSchedulerPatch(agent, { maxParallelToolCalls: 1 });
    const orient = {
      name: 'orient',
      label: 'orient',
      description: 'Inspect current runtime orientation.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: vi.fn(async () => ({
        content: [{ type: 'text', text: 'orientation is clear' }],
        details: {},
      })),
      wiringMeta: {
        concurrency: {
          class: 'read_only',
          maxParallel: 1,
          exclusivityKeyPolicy: 'none',
          interruptibility: 'cooperative',
          eligibility: { foreground: true, background: true },
        },
      },
    };
    agent.state.tools = [orient as never];
    agent.state.messages = [
      userMessage('earlier user request', 1),
      priorAssistant,
    ];

    await agent.prompt(userMessage('current orient request', 2));

    expect(orient.execute).toHaveBeenCalledTimes(1);
    expect(providerContexts).toHaveLength(2);
    for (const providerContext of providerContexts) {
      expect(providerContext.slice(0, 3)).toEqual([
        expect.objectContaining({ role: 'user', content: 'earlier user request' }),
        expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: 'earlier assistant reply' }],
        }),
        expect.objectContaining({ role: 'user', content: 'current orient request' }),
      ]);
      expect(providerContext.filter(message => (
        message.role === 'user' && message.content === 'current orient request'
      ))).toHaveLength(1);
    }
    expect(providerContexts[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'toolResult', toolCallId: 'call-1' }),
    ]));
  });
});
