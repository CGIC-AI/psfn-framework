import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolResultMessage } from '@mariozechner/pi-ai';
import type { ToolConcurrencyMeta, WirableTool } from './tool-wiring-validator.js';
import { executeToolCallsWithScheduler } from './tool-call-scheduler.js';

function makeTool(
  name: string,
  execute: AgentTool<any>['execute'],
  wiringMeta: WirableTool['wiringMeta'],
): AgentTool<any> {
  const tool: AgentTool<any> = {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    execute,
  };
  (tool as WirableTool).wiringMeta = wiringMeta;
  return tool;
}

function makeAssistantMessage(toolNames: string[]) {
  return {
    role: 'assistant',
    content: toolNames.map((name, index) => ({
      type: 'toolCall',
      id: `call-${index + 1}`,
      name,
      arguments: {},
    })),
    stopReason: 'stop',
  };
}

function makeConcurrencyMeta(
  className: ToolConcurrencyMeta['class'],
  overrides: Partial<ToolConcurrencyMeta> = {},
): ToolConcurrencyMeta {
  const defaults: ToolConcurrencyMeta = className === 'exclusive'
    ? {
      class: 'exclusive',
      exclusivityKeyPolicy: 'static_key',
      exclusivityKey: 'core:test',
      interruptibility: 'cooperative',
      eligibility: {
        foreground: true,
        background: true,
      },
    }
    : {
      class: className,
      exclusivityKeyPolicy: 'none',
      interruptibility: 'cooperative',
      eligibility: {
        foreground: true,
        background: true,
      },
    };

  return {
    ...defaults,
    ...overrides,
    class: className,
    eligibility: {
      ...defaults.eligibility,
      ...(overrides.eligibility ?? {}),
    },
  };
}

describe('tool-call-scheduler', () => {
  it('runs sibling shard calls concurrently when bounded parallelism allows it', async () => {
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();
    const spawnShard = makeTool(
      'shard',
      async (toolCallId) => {
        starts.set(toolCallId, Date.now());
        await new Promise((resolve) => setTimeout(resolve, 25));
        ends.set(toolCallId, Date.now());
        return {
          content: [{ type: 'text', text: `done:${toolCallId}` }],
          details: {},
        };
      },
      { concurrency: makeConcurrencyMeta('shard', { maxParallel: 3 }) },
    );

    const streamEvents: any[] = [];
    const telemetry = vi.fn();
    const result = await executeToolCallsWithScheduler(
      [spawnShard],
      makeAssistantMessage(['shard', 'shard', 'shard']),
      undefined,
      { stream: { push: (event) => { streamEvents.push(event); } } },
      { maxParallelToolCalls: 3, onTelemetry: telemetry },
    );

    expect(result.toolResults).toHaveLength(3);
    const firstEnd = ends.get('call-1') as number;
    const secondStart = starts.get('call-2') as number;
    const thirdStart = starts.get('call-3') as number;
    expect(secondStart).toBeLessThan(firstEnd);
    expect(thirdStart).toBeLessThan(firstEnd);
    expect(streamEvents.filter(event => event.type === 'tool_execution_start')).toHaveLength(3);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.parallel',
      expect.objectContaining({
        batchSize: 3,
      }),
    );
  });

  it('fails closed to sequential execution for exclusive tool calls', async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const memoryWrite = makeTool(
      'memory_write',
      async () => {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        ends.push(Date.now());
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
      {
        concurrency: makeConcurrencyMeta('exclusive', {
          exclusivityKeyPolicy: 'category_tool_name',
          exclusivityKey: 'core:memory_write',
        }),
      },
    );

    const telemetry = vi.fn();
    await executeToolCallsWithScheduler(
      [memoryWrite],
      makeAssistantMessage(['memory_write', 'memory_write']),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 8, onTelemetry: telemetry },
    );

    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[1]).toBeGreaterThanOrEqual(ends[0] as number);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.serialized',
      expect.objectContaining({
        batchSize: 1,
      }),
    );
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.queued',
      expect.objectContaining({
        queuedCount: 1,
      }),
    );
  });

  it('respects maxParallelToolCalls bound for shard batches', async () => {
    let active = 0;
    let peak = 0;
    const spawnShard = makeTool(
      'shard',
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return {
          content: [{ type: 'text', text: 'ok' }],
          details: {},
        };
      },
      { concurrency: makeConcurrencyMeta('shard', { maxParallel: 5 }) },
    );

    await executeToolCallsWithScheduler(
      [spawnShard],
      makeAssistantMessage(['shard', 'shard', 'shard']),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 2 },
    );

    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('keeps non-shard tools sequential even when metadata marks them read_only', async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const repoStatus = makeTool(
      'repo_status',
      async () => {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        ends.push(Date.now());
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
      { concurrency: makeConcurrencyMeta('read_only', { maxParallel: 3 }) },
    );

    await executeToolCallsWithScheduler(
      [repoStatus],
      makeAssistantMessage(['repo_status', 'repo_status']),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 8 },
    );

    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[1]).toBeGreaterThanOrEqual(ends[0] as number);
  });

  it('fails closed to sequential when shard metadata carries exclusivity wiring', async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const telemetry = vi.fn();
    const spawnShard = makeTool(
      'shard',
      async () => {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        ends.push(Date.now());
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
      {
        concurrency: makeConcurrencyMeta('shard', {
          maxParallel: 4,
          exclusivityKeyPolicy: 'static_key',
          exclusivityKey: 'unsafe:key',
        }),
      },
    );

    await executeToolCallsWithScheduler(
      [spawnShard],
      makeAssistantMessage(['shard', 'shard']),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 4, onTelemetry: telemetry },
    );

    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[1]).toBeGreaterThanOrEqual(ends[0] as number);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.serialized',
      expect.objectContaining({
        batchSize: 1,
      }),
    );
  });

  it('fails closed when one sibling shard call errors in a parallel batch', async () => {
    const spawnShard = makeTool(
      'shard',
      async (toolCallId) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (toolCallId === 'call-2') {
          throw new Error('spawn failed');
        }
        return {
          content: [{ type: 'text', text: `done:${toolCallId}` }],
          details: {},
        };
      },
      { concurrency: makeConcurrencyMeta('shard', { maxParallel: 3 }) },
    );

    const result = await executeToolCallsWithScheduler(
      [spawnShard],
      makeAssistantMessage(['shard', 'shard', 'shard']),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 3 },
    );

    expect(result.toolResults).toHaveLength(3);
    expect((result.toolResults[0] as ToolResultMessage).isError).toBe(false);
    expect((result.toolResults[1] as ToolResultMessage).isError).toBe(true);
    expect((result.toolResults[2] as ToolResultMessage).isError).toBe(false);
  });

  it('skips remaining queued calls when steering messages arrive mid-batch', async () => {
    let steeringPollCount = 0;
    const telemetry = vi.fn();
    const issueShow = makeTool(
      'issue_show',
      async () => ({
        content: [{ type: 'text', text: 'show' }],
        details: {},
      }),
      {
        concurrency: makeConcurrencyMeta('exclusive', {
          exclusivityKeyPolicy: 'category_tool_name',
          exclusivityKey: 'extended:issue_show',
        }),
      },
    );

    const result = await executeToolCallsWithScheduler(
      [issueShow],
      makeAssistantMessage(['issue_show', 'issue_show', 'issue_show']),
      async () => {
        steeringPollCount += 1;
        return steeringPollCount >= 1
          ? [{ role: 'user', content: [{ type: 'text', text: 'interrupt' }], timestamp: Date.now() } as any]
          : [];
      },
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 2, onTelemetry: telemetry },
    );

    expect(result.toolResults).toHaveLength(3);
    expect((result.toolResults[0] as ToolResultMessage).isError).toBe(false);
    expect((result.toolResults[1] as ToolResultMessage).isError).toBe(true);
    expect((result.toolResults[2] as ToolResultMessage).isError).toBe(true);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.skipped',
      expect.objectContaining({
        skippedCount: 2,
        reason: 'queued_user_message',
      }),
    );
  });

  it('emits cancelled telemetry when execution aborts before a tool call runs', async () => {
    const telemetry = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const issueShow = makeTool(
      'issue_show',
      async () => {
        throw new Error('aborted');
      },
      {
        concurrency: makeConcurrencyMeta('exclusive', {
          exclusivityKeyPolicy: 'category_tool_name',
          exclusivityKey: 'extended:issue_show',
        }),
      },
    );

    const result = await executeToolCallsWithScheduler(
      [issueShow],
      makeAssistantMessage(['issue_show']),
      undefined,
      {
        signal: controller.signal,
        stream: { push: () => undefined },
      },
      { maxParallelToolCalls: 1, onTelemetry: telemetry },
    );

    expect((result.toolResults[0] as ToolResultMessage).isError).toBe(true);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.cancelled',
      expect.objectContaining({
        toolName: 'issue_show',
      }),
    );
  });
});
