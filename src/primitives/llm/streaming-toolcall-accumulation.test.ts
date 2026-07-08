import { describe, it, expect, afterEach } from 'vitest';
import { streamSimple } from '@mariozechner/pi-ai';
import { createModel } from './models.js';

// ── gu8m regression: streamed tool-call argument accumulation ──
// Live Purrsephone (z-ai/glm-5.2 via OpenRouter, interleaved reasoning) intermittently
// received EMPTY arguments for required-action first-party tools. Root cause was in
// pi-ai 0.62.0's openai-completions streaming accumulator: it keyed tool-call
// continuation fragments off `currentBlock`, so a reasoning/text delta arriving
// *between* a tool call's name chunk and its argument fragments orphaned the fragments
// into blank blocks and finalized the named call with `{}`. pi-ai 0.73.1 replaces
// that local patch with an upstream accumulator that routes by wire index or id.
//
// This exercises the REAL pi-ai 0.73.1 accumulator + the real `openai` SDK end-to-end
// against an in-process SSE fetch response. (vitest externalizes node_modules, so
// module-mocking `openai` would not reach pi-ai's internal import; exercising the real
// OpenAI SDK stream parser is faithful for both the OpenRouter-direct and LiteLLM-proxy
// code paths, which share this provider.)

interface WireChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: unknown;
}

let originalFetch: typeof globalThis.fetch | undefined;

function installSseFetch(body: string): void {
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })) as typeof globalThis.fetch;
}

async function streamToolCalls(chunks: WireChunk[]): Promise<Array<{ name: string; arguments: Record<string, unknown> }>> {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
  installSseFetch(body);

  const baseUrl = 'http://pi-ai-streaming-toolcall-accumulation.test/v1';
  const model = createModel(baseUrl, 'z-ai/glm-5.2', 4096, 131072, 'openai-completions', { reasoning: true });
  const stream = streamSimple(model as never, {
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'do it' }],
  } as never, { apiKey: 'test-key' } as never);

  let done: { message: { content: Array<Record<string, unknown>> } } | undefined;
  for await (const event of stream as AsyncIterable<{ type: string } & Record<string, unknown>>) {
    if (event.type === 'error') {
      throw new Error(`stream error: ${JSON.stringify((event as { error?: unknown }).error)}`);
    }
    if (event.type === 'done') {
      done = event as never;
    }
  }
  if (!done) throw new Error('stream produced no done event');
  return done.message.content
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({ name: String(block.name), arguments: block.arguments as Record<string, unknown> }));
}

function textDelta(content: string): WireChunk {
  return { id: 'chatcmpl-x', choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }] };
}

function toolNameChunk(index: number, id: string, name: string, args = ''): WireChunk {
  return {
    id: 'chatcmpl-x',
    choices: [{ index: 0, delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] }, finish_reason: null }],
  };
}

function toolNameChunkWithoutIndex(id: string, name: string, args = ''): WireChunk {
  return {
    id: 'chatcmpl-x',
    choices: [{ index: 0, delta: { tool_calls: [{ id, function: { name, arguments: args } }] }, finish_reason: null }],
  };
}

function toolArgChunk(index: number, argsFragment: string): WireChunk {
  return {
    id: 'chatcmpl-x',
    choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: argsFragment } }] }, finish_reason: null }],
  };
}

function toolArgChunkById(id: string, argsFragment: string): WireChunk {
  return {
    id: 'chatcmpl-x',
    choices: [{ index: 0, delta: { tool_calls: [{ id, function: { arguments: argsFragment } }] }, finish_reason: null }],
  };
}

function finishChunk(): WireChunk {
  return {
    id: 'chatcmpl-x',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  };
}

describe('pi-ai openai-completions tool-call accumulation', () => {
  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
    }
  });

  it('recovers action-only args when reasoning is interleaved WITHIN a tool call argument stream', async () => {
    // memory/orient/journal, each action-only, argument fragments split across chunks
    // with reasoning deltas interposed between the name chunk and the argument fragments.
    const toolCalls = await streamToolCalls([
      textDelta('Let me start.'),
      toolNameChunk(0, 'chatcmpl-tool-mem', 'memory', ''),
      textDelta('checking memory'), // interposed reasoning mid-call
      toolArgChunk(0, '{"action":'),
      textDelta('almost'), // interposed reasoning mid-call
      toolArgChunk(0, '"list"}'),
      toolNameChunk(1, 'chatcmpl-tool-ori', 'orient', ''),
      textDelta('orient now'),
      toolArgChunk(1, '{"action":"status"}'),
      toolNameChunk(2, 'chatcmpl-tool-jou', 'journal', '{"action"'),
      textDelta('journaling'),
      toolArgChunk(2, ':"list"}'),
      finishChunk(),
    ]);

    const byName = Object.fromEntries(toolCalls.map((c) => [c.name, c.arguments]));
    expect(byName.memory).toEqual({ action: 'list' });
    expect(byName.orient).toEqual({ action: 'status' });
    expect(byName.journal).toEqual({ action: 'list' });
    // No orphan blank-name tool blocks.
    expect(toolCalls.every((c) => c.name.length > 0)).toBe(true);
  });

  it('repairs malformed-but-recoverable streamed args instead of finalizing {}', async () => {
    const toolCalls = await streamToolCalls([
      toolNameChunk(0, 'chatcmpl-tool-jou', 'journal', '{"action":"write","note":"line one'),
      toolArgChunk(0, '\nline two with invalid \\q escape"}'),
      finishChunk(),
    ]);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      name: 'journal',
      arguments: { action: 'write', note: 'line one\nline two with invalid \\q escape' },
    });
  });

  it('routes missing wire-index continuation chunks by id instead of defaulting to index zero', async () => {
    const toolCalls = await streamToolCalls([
      toolNameChunk(0, 'chatcmpl-tool-mem', 'memory', '{"action":"list"}'),
      toolNameChunkWithoutIndex('chatcmpl-tool-jou', 'journal', '{"action":'),
      toolArgChunkById('chatcmpl-tool-jou', '"write"}'),
      finishChunk(),
    ]);

    const byName = Object.fromEntries(toolCalls.map((c) => [c.name, c.arguments]));
    expect(byName.memory).toEqual({ action: 'list' });
    expect(byName.journal).toEqual({ action: 'write' });
  });

  it('accumulates sequential parallel tool calls (no interleaving) without cross-contamination', async () => {
    const toolCalls = await streamToolCalls([
      toolNameChunk(0, 'chatcmpl-tool-mem', 'memory', ''),
      toolArgChunk(0, '{"action":"list"}'),
      toolNameChunk(1, 'chatcmpl-tool-ori', 'orient', ''),
      toolArgChunk(1, '{"action":"status"}'),
      finishChunk(),
    ]);
    const byName = Object.fromEntries(toolCalls.map((c) => [c.name, c.arguments]));
    expect(byName.memory).toEqual({ action: 'list' });
    expect(byName.orient).toEqual({ action: 'status' });
  });

  it('preserves a genuinely-empty tool call (no argument fragments emitted)', async () => {
    const toolCalls = await streamToolCalls([
      toolNameChunk(0, 'chatcmpl-tool-mem', 'memory', ''),
      finishChunk(),
    ]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe('memory');
    expect(toolCalls[0]!.arguments).toEqual({});
  });
});
