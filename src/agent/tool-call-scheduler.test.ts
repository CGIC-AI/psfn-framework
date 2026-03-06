import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolResultMessage } from '@mariozechner/pi-ai';
import type { WirableTool } from './tool-wiring-validator.js';
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

describe('tool-call-scheduler', () => {
  it('runs sibling spawn_shard calls concurrently when bounded parallelism allows it', async () => {
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();
    const spawnShard = makeTool(
      'spawn_shard',
      async (toolCallId) => {
        starts.set(toolCallId, Date.now());
        await new Promise((resolve) => setTimeout(resolve, 25));
        ends.set(toolCallId, Date.now());
        return {
          content: [{ type: 'text', text: `done:${toolCallId}` }],
          details: {},
        };
      },
      { concurrency: { class: 'spawn_shard', maxParallel: 3 } },
    );

    const streamEvents: any[] = [];
    const result = await executeToolCallsWithScheduler(
      [spawnShard],
      makeAssistantMessage(['spawn_shard', 'spawn_shard', 'spawn_shard']),
      undefined,
      { stream: { push: (event) => { streamEvents.push(event); } } },
      { maxParallelToolCalls: 3 },
    );

    expect(result.toolResults).toHaveLength(3);
    const firstEnd = ends.get('call-1') as number;
    const secondStart = starts.get('call-2') as number;
    const thirdStart = starts.get('call-3') as number;
    expect(secondStart).toBeLessThan(firstEnd);
    expect(thirdStart).toBeLessThan(firstEnd);
    expect(streamEvents.filter(event => event.type === 'tool_execution_start')).toHaveLength(3);
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
      { concurrency: { class: 'exclusive', exclusivityKey: 'core:memory_write' } },
    );

    await executeToolCallsWithScheduler(
      [memoryWrite],
      makeAssistantMessage(['memory_write', 'memory_write']),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 8 },
    );

    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[1]).toBeGreaterThanOrEqual(ends[0] as number);
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
      { concurrency: { class: 'exclusive', exclusivityKey: 'extended:issue_show' } },
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
});
