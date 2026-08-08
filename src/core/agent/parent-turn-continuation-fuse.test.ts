import type { AssistantMessage, Model, UserMessage } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../boundary/pi-agent/index.js';
import {
  abortActiveAgentRun,
  installAgentToolSchedulerPatch,
} from '../../boundary/pi-agent/agent-loop-patch.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import {
  ParentTurnContinuationBudgetExceededError,
} from './turn-limits.js';

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
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

function userMessage(content: string): UserMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

function createModel(): Model<'openai-completions'> {
  return {
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
}

describe('parent-turn continuation fuse', () => {
  it('aborts a long awaited tool inside repeated tool-use continuation and releases prompt admission', async () => {
    let providerCall = 0;
    let recoveryRun = false;
    const streamFn = vi.fn(async () => {
      providerCall += 1;
      const finalMessage = recoveryRun
        ? assistantMessage([{ type: 'text', text: 'fresh turn completed' }], 'stop')
        : assistantMessage([{
            type: 'toolCall',
            id: `search-${providerCall}`,
            name: 'session_search_summary',
            arguments: { query: `continuation-${providerCall}` },
          }], 'toolUse');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: structuredClone(finalMessage) };
          yield { type: 'done' };
        },
        result: async () => structuredClone(finalMessage),
      };
    });
    let toolCall = 0;
    const execute = vi.fn(async (
      _toolCallId: string,
      _args: unknown,
      signal?: AbortSignal,
    ) => {
      toolCall += 1;
      if (toolCall < 3) {
        return {
          content: [{ type: 'text' as const, text: `summary-${toolCall}` }],
          details: {},
        };
      }
      await new Promise<never>((_resolve, reject) => {
        const rejectAborted = (): void => reject(signal?.reason ?? new Error('aborted'));
        if (signal?.aborted) {
          rejectAborted();
          return;
        }
        signal?.addEventListener('abort', rejectAborted, { once: true });
      });
    });
    const agent = new Agent({
      initialState: { model: createModel() },
      streamFn: streamFn as never,
    });
    agent.state.tools = [{
      name: 'session_search_summary',
      label: 'session_search_summary',
      description: 'Summarize session search results.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      execute,
      wiringMeta: {
        concurrency: {
          class: 'read_only',
          maxParallel: 1,
          exclusivityKeyPolicy: 'none',
          interruptibility: 'cooperative',
          eligibility: { foreground: true, background: true },
        },
      },
    } as never];
    installAgentToolSchedulerPatch(
      agent,
      { maxParallelToolCalls: 1 },
      undefined,
      { maxWallTimeMs: 40, maxPromptEntries: 12 },
    );

    let failure: unknown;
    try {
      await agent.prompt(userMessage('search until you have enough evidence'));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ParentTurnContinuationBudgetExceededError);
    expect(failure).toMatchObject({
      stop: {
        schemaVersion: 1,
        reason: 'wall_clock_limit',
        maxWallTimeMs: 40,
        maxPromptEntries: 12,
        promptEntries: 3,
      },
    });
    expect(streamFn).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(agent.state.isStreaming).toBe(false);

    recoveryRun = true;
    await expect(agent.prompt(userMessage('ordinary follow-up'))).resolves.toBeUndefined();
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'fresh turn completed' }],
    });
  });

  it('stops repeated prompt entry even when every tool returns promptly', async () => {
    let providerCall = 0;
    const streamFn = vi.fn(async () => {
      providerCall += 1;
      const finalMessage = assistantMessage([{
        type: 'toolCall',
        id: `loop-${providerCall}`,
        name: 'loop_tool',
        arguments: { iteration: providerCall },
      }], 'toolUse');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: structuredClone(finalMessage) };
          yield { type: 'done' };
        },
        result: async () => structuredClone(finalMessage),
      };
    });
    const agent = new Agent({
      initialState: { model: createModel() },
      streamFn: streamFn as never,
    });
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'continue' }],
      details: {},
    }));
    agent.state.tools = [{
      name: 'loop_tool',
      label: 'loop_tool',
      description: 'Return continuation evidence.',
      parameters: {
        type: 'object',
        properties: { iteration: { type: 'number' } },
        required: ['iteration'],
        additionalProperties: false,
      },
      execute,
      wiringMeta: {
        concurrency: {
          class: 'read_only',
          maxParallel: 1,
          exclusivityKeyPolicy: 'none',
          interruptibility: 'cooperative',
          eligibility: { foreground: true, background: true },
        },
      },
    } as never];
    installAgentToolSchedulerPatch(
      agent,
      { maxParallelToolCalls: 1 },
      undefined,
      { maxWallTimeMs: 5_000, maxPromptEntries: 3 },
    );

    await expect(agent.prompt(userMessage('keep going forever'))).rejects.toMatchObject({
      stop: {
        reason: 'prompt_entry_limit',
        promptEntries: 3,
        maxPromptEntries: 3,
      },
    });
    expect(streamFn).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(agent.state.isStreaming).toBe(false);
  });
});

describe('patched agent active-run cancellation', () => {
  it('only aborts the provider run owned by the expected request', async () => {
    let providerSignal: AbortSignal | undefined;
    let markProviderEntered!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      markProviderEntered = resolve;
    });
    const streamFn = vi.fn(async (
      _model: unknown,
      _context: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      providerSignal = options?.signal;
      markProviderEntered();
      const finalMessage = assistantMessage([{ type: 'text', text: 'unreachable' }], 'stop');
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<never>((_resolve, reject) => {
            const rejectAborted = (): void => reject(providerSignal?.reason ?? new Error('aborted'));
            if (providerSignal?.aborted) {
              rejectAborted();
              return;
            }
            providerSignal?.addEventListener('abort', rejectAborted, { once: true });
          });
        },
        result: async () => structuredClone(finalMessage),
      };
    });
    const agent = new Agent({
      initialState: { model: createModel() },
      streamFn: streamFn as never,
    });
    installAgentToolSchedulerPatch(agent, { maxParallelToolCalls: 1 });

    expect(abortActiveAgentRun(agent, 'request-b')).toEqual({ status: 'not_active' });
    const prompt = runWithRequestContext(
      { requestId: 'request-b', channelId: 'api:request-b' },
      () => agent.prompt(userMessage('wait for the provider')),
    );
    await providerEntered;
    expect(abortActiveAgentRun(agent, 'request-a')).toEqual({ status: 'owner_mismatch' });
    expect(providerSignal?.aborted).toBe(false);

    const abortSpy = vi.spyOn(agent, 'abort').mockImplementation(() => {});
    expect(abortActiveAgentRun(agent, 'request-b')).toEqual({ status: 'not_signaled' });
    expect(providerSignal?.aborted).toBe(false);
    abortSpy.mockRestore();

    expect(abortActiveAgentRun(agent, 'request-b')).toEqual({ status: 'signaled' });
    expect(providerSignal?.aborted).toBe(true);
    expect(abortActiveAgentRun(agent, 'request-b')).toEqual({ status: 'already_aborted' });

    await expect(prompt).rejects.toBeDefined();

    providerSignal = undefined;
    const ownerlessPrompt = agent.prompt(userMessage('wait without request ownership'));
    await vi.waitFor(() => {
      expect(providerSignal).toBeDefined();
    });
    expect(abortActiveAgentRun(agent, 'request-unknown')).toEqual({ status: 'owner_mismatch' });
    expect(providerSignal?.aborted).toBe(false);
    expect(abortActiveAgentRun(agent)).toEqual({ status: 'signaled' });
    expect(providerSignal?.aborted).toBe(true);
    await expect(ownerlessPrompt).rejects.toBeDefined();
    expect(abortActiveAgentRun(agent, 'request-b')).toEqual({ status: 'not_active' });
  });

  it('propagates the active run signal into cooperative tool execution and settles', async () => {
    let providerCall = 0;
    let toolSignal: AbortSignal | undefined;
    let markToolEntered!: () => void;
    const toolEntered = new Promise<void>((resolve) => {
      markToolEntered = resolve;
    });
    const streamFn = vi.fn(async (
      _model: unknown,
      _context: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      providerCall += 1;
      if (providerCall > 1) {
        throw options?.signal?.reason ?? new Error('aborted');
      }
      const finalMessage = assistantMessage([{
        type: 'toolCall',
        id: 'slow-tool-1',
        name: 'slow_tool',
        arguments: {},
      }], 'toolUse');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: structuredClone(finalMessage) };
          yield { type: 'done' };
        },
        result: async () => structuredClone(finalMessage),
      };
    });
    const agent = new Agent({
      initialState: { model: createModel() },
      streamFn: streamFn as never,
    });
    agent.state.tools = [{
      name: 'slow_tool',
      label: 'slow_tool',
      description: 'Wait until cancellation.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: vi.fn(async (
        _toolCallId: string,
        _args: unknown,
        signal?: AbortSignal,
      ) => {
        toolSignal = signal;
        markToolEntered();
        await new Promise<never>((_resolve, reject) => {
          const rejectAborted = (): void => reject(signal?.reason ?? new Error('aborted'));
          if (signal?.aborted) {
            rejectAborted();
            return;
          }
          signal?.addEventListener('abort', rejectAborted, { once: true });
        });
      }),
      wiringMeta: {
        concurrency: {
          class: 'read_only',
          maxParallel: 1,
          exclusivityKeyPolicy: 'none',
          interruptibility: 'cooperative',
          eligibility: { foreground: true, background: true },
        },
      },
    } as never];
    installAgentToolSchedulerPatch(agent, { maxParallelToolCalls: 1 });

    const prompt = runWithRequestContext(
      { requestId: 'request-tool', channelId: 'api:request-tool' },
      () => agent.prompt(userMessage('run the slow tool')),
    );
    await toolEntered;
    expect(abortActiveAgentRun(agent, 'different-request')).toEqual({ status: 'owner_mismatch' });
    expect(toolSignal?.aborted).toBe(false);
    expect(abortActiveAgentRun(agent, 'request-tool')).toEqual({ status: 'signaled' });
    expect(toolSignal?.aborted).toBe(true);
    await expect(prompt).rejects.toBeDefined();
    expect(agent.state.isStreaming).toBe(false);
    expect(abortActiveAgentRun(agent, 'request-tool')).toEqual({ status: 'not_active' });
  });
});
