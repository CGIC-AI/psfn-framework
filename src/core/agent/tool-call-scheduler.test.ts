import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolResultMessage } from '@mariozechner/pi-ai';
import type { ToolConcurrencyMeta, WirableTool } from './tool-wiring-validator.js';
import { createToolCallExecutionGuard, executeToolCallsWithScheduler } from './tool-call-scheduler.js';

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
  it('promotes tool result details.isError to the top-level tool result error flag', async () => {
    const orient = makeTool(
      'orient',
      async () => ({
        content: [{ type: 'text', text: 'resolve_concern failed: concernId is required' }],
        details: { isError: true },
      }),
      { concurrency: makeConcurrencyMeta('exclusive') },
    );
    const streamEvents: any[] = [];

    const result = await executeToolCallsWithScheduler(
      [orient],
      makeAssistantMessage(['orient']),
      undefined,
      { stream: { push: (event) => { streamEvents.push(event); } } },
      { maxParallelToolCalls: 1 },
    );

    expect(result.toolResults).toHaveLength(1);
    expect((result.toolResults[0] as ToolResultMessage).isError).toBe(true);
    expect(streamEvents.find(event => event.type === 'tool_execution_end')).toEqual(
      expect.objectContaining({
        toolName: 'orient',
        isError: true,
      }),
    );
  });

  it('runs sibling spawn_subagent calls concurrently when bounded parallelism allows it', async () => {
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();
    const spawnSubagent = makeTool(
      'spawn_subagent',
      async (toolCallId) => {
        starts.set(toolCallId, Date.now());
        await new Promise((resolve) => setTimeout(resolve, 25));
        ends.set(toolCallId, Date.now());
        return {
          content: [{ type: 'text', text: `done:${toolCallId}` }],
          details: {},
        };
      },
      { concurrency: makeConcurrencyMeta('spawn_subagent', { maxParallel: 3 }) },
    );

    const streamEvents: any[] = [];
    const telemetry = vi.fn();
    const result = await executeToolCallsWithScheduler(
      [spawnSubagent],
      makeAssistantMessage(['spawn_subagent', 'spawn_subagent', 'spawn_subagent']),
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

  it('respects maxParallelToolCalls bound for spawn_subagent batches', async () => {
    let active = 0;
    let peak = 0;
    const spawnSubagent = makeTool(
      'spawn_subagent',
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
      { concurrency: makeConcurrencyMeta('spawn_subagent', { maxParallel: 5 }) },
    );

    await executeToolCallsWithScheduler(
      [spawnSubagent],
      makeAssistantMessage(['spawn_subagent', 'spawn_subagent', 'spawn_subagent']),
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

  it('fails closed to sequential when spawn_subagent metadata carries exclusivity wiring', async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const telemetry = vi.fn();
    const spawnSubagent = makeTool(
      'spawn_subagent',
      async () => {
        starts.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        ends.push(Date.now());
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
      {
        concurrency: makeConcurrencyMeta('spawn_subagent', {
          maxParallel: 4,
          exclusivityKeyPolicy: 'static_key',
          exclusivityKey: 'unsafe:key',
        }),
      },
    );

    await executeToolCallsWithScheduler(
      [spawnSubagent],
      makeAssistantMessage(['spawn_subagent', 'spawn_subagent']),
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

  it('fails closed when one sibling spawn_subagent call errors in a parallel batch', async () => {
    const spawnSubagent = makeTool(
      'spawn_subagent',
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
      { concurrency: makeConcurrencyMeta('spawn_subagent', { maxParallel: 3 }) },
    );

    const result = await executeToolCallsWithScheduler(
      [spawnSubagent],
      makeAssistantMessage(['spawn_subagent', 'spawn_subagent', 'spawn_subagent']),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 3 },
    );

    expect(result.toolResults).toHaveLength(3);
    expect((result.toolResults[0] as ToolResultMessage).isError).toBe(false);
    expect((result.toolResults[1] as ToolResultMessage).isError).toBe(true);
    expect((result.toolResults[2] as ToolResultMessage).isError).toBe(false);
  });

  it('skips remaining sequential calls after a tool error so dependent chains can retry after seeing results', async () => {
    const tool = makeTool(
      'memory_patch',
      async (toolCallId) => {
        if (toolCallId === 'call-2') {
          throw new Error('memory_id is required');
        }
        return {
          content: [{ type: 'text', text: `done:${toolCallId}` }],
          details: {},
        };
      },
      {
        concurrency: makeConcurrencyMeta('exclusive', {
          exclusivityKeyPolicy: 'category_tool_name',
          exclusivityKey: 'extended:memory_patch',
        }),
      },
    );
    const telemetry = vi.fn();

    const result = await executeToolCallsWithScheduler(
      [tool],
      makeAssistantMessage(['memory_patch', 'memory_patch', 'memory_patch']),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 1, onTelemetry: telemetry },
    );

    expect(result.toolResults).toHaveLength(3);
    expect((result.toolResults[0] as ToolResultMessage).isError).toBe(false);
    expect((result.toolResults[1] as ToolResultMessage).isError).toBe(true);
    expect((result.toolResults[2] as ToolResultMessage).isError).toBe(true);
    expect((result.toolResults[2] as ToolResultMessage).content).toEqual([
      {
        type: 'text',
        text: 'Skipped because an earlier sequential tool call failed. Read the tool result and retry only the needed follow-up call.',
      },
    ]);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.skipped',
      expect.objectContaining({
        skippedCount: 1,
        reason: 'prior_tool_error',
      }),
    );
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

  it('classifies queued system steering separately from queued user turns', async () => {
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
      makeAssistantMessage(['issue_show', 'issue_show']),
      async () => [{
        role: 'custom',
        type: 'systemNote',
        messageClass: 'system_note',
        content: '[SYSTEM: Runtime] Queue a private follow-up reminder.',
        timestamp: Date.now(),
      } as any],
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 1, onTelemetry: telemetry },
    );

    expect((result.toolResults[1] as ToolResultMessage).isError).toBe(true);
    expect((result.toolResults[1] as ToolResultMessage).content).toEqual([
      { type: 'text', text: 'Skipped due to queued system message.' },
    ]);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.skipped',
      expect.objectContaining({
        skippedCount: 1,
        reason: 'queued_system_message',
      }),
    );
  });

  it('classifies queued internal whispers separately from queued user turns', async () => {
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
      makeAssistantMessage(['issue_show', 'issue_show']),
      async () => [{
        role: 'custom',
        type: 'internalWhisper',
        messageClass: 'internal_whisper',
        content: 'Keep the answer concrete and grounded.',
        timestamp: Date.now(),
      } as any],
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 1, onTelemetry: telemetry },
    );

    expect((result.toolResults[1] as ToolResultMessage).isError).toBe(true);
    expect((result.toolResults[1] as ToolResultMessage).content).toEqual([
      { type: 'text', text: 'Skipped due to queued internal note.' },
    ]);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.skipped',
      expect.objectContaining({
        skippedCount: 1,
        reason: 'queued_internal_note',
      }),
    );
  });

  it('skips identical calls that already succeeded in the same turn', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text', text: 'oriented' }],
      details: {},
    }));
    const orient = makeTool(
      'orient',
      execute,
      {
        concurrency: makeConcurrencyMeta('exclusive', {
          exclusivityKeyPolicy: 'category_tool_name',
          exclusivityKey: 'core:orient',
        }),
      },
    );
    const telemetry = vi.fn();

    const result = await executeToolCallsWithScheduler(
      [orient],
      makeAssistantMessage(['orient', 'orient']),
      undefined,
      { stream: { push: () => undefined } },
      {
        maxParallelToolCalls: 1,
        guard: createToolCallExecutionGuard(),
        onTelemetry: telemetry,
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolResults).toHaveLength(2);
    expect((result.toolResults[0] as ToolResultMessage).isError).toBe(false);
    expect((result.toolResults[1] as ToolResultMessage).isError).toBe(true);
    expect((result.toolResults[1] as ToolResultMessage).content).toEqual([
      {
        type: 'text',
        text: 'Internal tool status: skipped duplicate tool call because the same tool/action/input already succeeded this turn. This is not a user-facing message.',
      },
    ]);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.skipped',
      expect.objectContaining({
        reason: 'duplicate_completed',
        toolName: 'orient',
      }),
    );
  });

  it('stops retrying the same failing call after the per-turn failure limit', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text', text: 'scratchpad backend unavailable' }],
      details: { isError: true },
    }));
    const scratchpad = makeTool(
      'scratchpad',
      execute,
      {
        concurrency: makeConcurrencyMeta('exclusive', {
          exclusivityKeyPolicy: 'category_tool_name',
          exclusivityKey: 'extended:scratchpad',
        }),
      },
    );
    const guard = createToolCallExecutionGuard();
    const telemetry = vi.fn();
    const options = {
      maxParallelToolCalls: 1,
      maxFailuresPerSignature: 2,
      guard,
      onTelemetry: telemetry,
    };

    await executeToolCallsWithScheduler(
      [scratchpad],
      makeAssistantMessage(['scratchpad']),
      undefined,
      { stream: { push: () => undefined } },
      options,
    );
    await executeToolCallsWithScheduler(
      [scratchpad],
      makeAssistantMessage(['scratchpad']),
      undefined,
      { stream: { push: () => undefined } },
      options,
    );
    const thirdResult = await executeToolCallsWithScheduler(
      [scratchpad],
      makeAssistantMessage(['scratchpad']),
      undefined,
      { stream: { push: () => undefined } },
      options,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect((thirdResult.toolResults[0] as ToolResultMessage).isError).toBe(true);
    expect((thirdResult.toolResults[0] as ToolResultMessage).content).toEqual([
      {
        type: 'text',
        text: 'Internal tool status: scratchpad is degraded for this action/input after 2 failed attempts this turn. Stop retrying it for now and notify the operator if it affects the conversation. This is not a user-facing message.',
      },
    ]);
    expect(telemetry).toHaveBeenCalledWith(
      'agent.tools.scheduler.skipped',
      expect.objectContaining({
        reason: 'tool_signature_degraded',
        toolName: 'scratchpad',
        failures: 2,
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
