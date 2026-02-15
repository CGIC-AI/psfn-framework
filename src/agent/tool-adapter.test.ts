import { describe, it, expect } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import type { SubstrateTool, ToolResult } from '../types.js';
import { wrapSubstrateTool, wrapSubstrateTools, toSubstrateToolResult } from './tool-adapter.js';
import { createSubstrateStreamFn } from './stream-adapter.js';

function makeDummyTool(name = 'test_tool', response = 'ok'): SubstrateTool {
  return {
    name,
    description: `A test tool named ${name}`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Test input' },
      },
      required: ['input'],
    },
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => ({
      content: `${response}: ${input.input}`,
    }),
  };
}

function makeErrorTool(): SubstrateTool {
  return {
    name: 'fail_tool',
    description: 'A tool that always errors',
    inputSchema: { type: 'object', properties: {} },
    execute: async (): Promise<ToolResult> => ({
      content: 'something went wrong',
      isError: true,
    }),
  };
}

describe('wrapSubstrateTool', () => {
  it('preserves name and description', () => {
    const tool = makeDummyTool('my_tool');
    const wrapped = wrapSubstrateTool(tool);
    expect(wrapped.name).toBe('my_tool');
    expect(wrapped.description).toBe('A test tool named my_tool');
  });

  it('uses tool name as default label', () => {
    const wrapped = wrapSubstrateTool(makeDummyTool('search'));
    expect(wrapped.label).toBe('search');
  });

  it('accepts custom label', () => {
    const wrapped = wrapSubstrateTool(makeDummyTool('search'), 'Semantic Search');
    expect(wrapped.label).toBe('Semantic Search');
  });

  it('wraps inputSchema as TypeBox parameters', () => {
    const wrapped = wrapSubstrateTool(makeDummyTool());
    expect(wrapped.parameters).toBeDefined();
    // TypeBox schemas are JSON Schema-compatible
    expect(wrapped.parameters.type).toBe('object');
  });

  it('execute returns AgentToolResult with text content', async () => {
    const wrapped = wrapSubstrateTool(makeDummyTool());
    const result = await wrapped.execute('call-1', { input: 'hello' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'ok: hello' });
    expect(result.details.isError).toBeUndefined();
  });

  it('passes isError through details', async () => {
    const wrapped = wrapSubstrateTool(makeErrorTool());
    const result = await wrapped.execute('call-2', {});
    expect(result.content[0]).toEqual({ type: 'text', text: 'something went wrong' });
    expect(result.details.isError).toBe(true);
  });

  it('receives toolCallId (unused by legacy tools)', async () => {
    const tool = makeDummyTool();
    const wrapped = wrapSubstrateTool(tool);
    // Should not throw regardless of toolCallId value
    const result = await wrapped.execute('tc-abc123', { input: 'test' });
    expect(result.content).toHaveLength(1);
  });

  it('receives signal (unused by legacy tools)', async () => {
    const tool = makeDummyTool();
    const wrapped = wrapSubstrateTool(tool);
    const controller = new AbortController();
    const result = await wrapped.execute('tc-1', { input: 'test' }, controller.signal);
    expect(result.content).toHaveLength(1);
  });
});

describe('wrapSubstrateTools', () => {
  it('wraps multiple tools', () => {
    const tools = [makeDummyTool('a'), makeDummyTool('b'), makeDummyTool('c')];
    const wrapped = wrapSubstrateTools(tools);
    expect(wrapped).toHaveLength(3);
    expect(wrapped.map(t => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for empty input', () => {
    expect(wrapSubstrateTools([])).toEqual([]);
  });
});

describe('toSubstrateToolResult', () => {
  it('extracts text from AgentToolResult', () => {
    const result = toSubstrateToolResult({
      content: [{ type: 'text', text: 'hello world' }],
      details: {},
    });
    expect(result.content).toBe('hello world');
    expect(result.isError).toBeUndefined();
  });

  it('concatenates multiple text blocks', () => {
    const result = toSubstrateToolResult({
      content: [
        { type: 'text', text: 'part1' },
        { type: 'text', text: 'part2' },
      ],
      details: {},
    });
    expect(result.content).toBe('part1part2');
  });

  it('preserves isError from details', () => {
    const result = toSubstrateToolResult({
      content: [{ type: 'text', text: 'error' }],
      details: { isError: true },
    });
    expect(result.isError).toBe(true);
  });

  it('skips non-text content blocks', () => {
    const result = toSubstrateToolResult({
      content: [
        { type: 'text', text: 'text' },
        { type: 'image', source: { type: 'url', url: 'http://example.com' } } as any,
      ],
      details: {},
    });
    expect(result.content).toBe('text');
  });
});

describe('Agent tool integration', () => {
  it('Agent accepts wrapped SubstrateTools', () => {
    const tools = [makeDummyTool('think'), makeDummyTool('search')];
    const wrapped = wrapSubstrateTools(tools);

    const agent = new Agent({
      streamFn: createSubstrateStreamFn({
        primaryModel: 'test',
        primaryProvider: 'test',
        extractionModel: 'test',
        extractionProvider: 'test',
        primaryMaxTokens: 1000,
        extractionMaxTokens: 1000,
        discordToken: '', discordBotId: '', characterCardPath: '',
        dataDir: './data', databasePath: './data/test.db',
        sessionMessageLimit: 30, memoryRetrievalLimit: 15,
        extractionInterval: 5, maintenanceIntervalMs: 300_000,
        defaultContextWindow: 128_000,
        memoryBudgetPct: 20, extractionThresholdPct: 30, compactionThresholdPct: 70,
        modelRoster: { chat: { model: 'test', provider: 'test', maxTokens: 1000 } },
      }),
    });

    agent.setTools(wrapped);
    expect(agent.state.tools).toHaveLength(2);
    expect(agent.state.tools[0].name).toBe('think');
    expect(agent.state.tools[0].label).toBe('think');
    expect(agent.state.tools[1].name).toBe('search');
  });
});
