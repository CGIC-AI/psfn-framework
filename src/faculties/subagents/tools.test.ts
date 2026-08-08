import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { createSubagentTool } from './tools.js';
import type { SubagentControlPort } from './port.js';
import { resolveToolRequiredCapabilities } from '../../system/capabilities/requirements.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';

function parseText(result: Awaited<ReturnType<ReturnType<typeof createSubagentTool>['execute']>>): unknown {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

function resultText(result: Awaited<ReturnType<ReturnType<typeof createSubagentTool>['execute']>>): string {
  return result.content.map(entry => entry.text).join('');
}

function createPort(): SubagentControlPort {
  return {
    portFamily: 'subagent',
    execute: vi.fn(),
    spawn: vi.fn(async () => ({
      subagentId: 'subagent-1',
      name: 'inspect',
      task: 'inspect runtime state',
      workerLane: 'subagent',
      channelId: 'subagent:subagent-1',
      lifecycleState: 'queued',
      stateReason: 'execution_requested',
      createdAt: 100,
      capabilities: ['general'],
      requiredCapabilities: [],
    })),
    message: vi.fn(async () => ({
      task: {
        subagentId: 'subagent-1',
        name: 'inspect',
        task: 'inspect runtime state',
        workerLane: 'subagent',
        channelId: 'subagent:subagent-1',
        lifecycleState: 'running',
        stateReason: 'agent_initialized',
        createdAt: 100,
        startedAt: 120,
        capabilities: ['general'],
        requiredCapabilities: [],
      },
      transcript: [],
      transcriptMessageCount: 1,
      transcriptTruncated: false,
      artifacts: [],
      resume: {
        channelId: 'subagent:subagent-1',
        lifecycleState: 'running',
        resumable: true,
        transcriptAvailable: true,
        transcriptMessageCount: 1,
        transcriptTruncated: false,
      },
    })),
    wait: vi.fn(async () => ({
      subagentId: 'subagent-1',
      name: 'inspect',
      content: 'done',
      model: 'mock-model',
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 50,
      turns: 1,
      workerLane: 'subagent',
      lifecycleState: 'completed',
      outcome: 'completed',
      completionHandoff: { status: 'delivered' },
      stateReason: 'completed',
      capabilities: ['general'],
      requiredCapabilities: [],
    })),
    cancel: vi.fn(async () => ({
      subagentId: 'subagent-1',
      name: 'inspect',
      content: '',
      model: '',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 10,
      turns: 0,
      workerLane: 'subagent',
      lifecycleState: 'cancelled',
      outcome: 'cancelled',
      completionHandoff: { status: 'delivered' },
      stateReason: 'cancel_requested',
      failureReason: 'operator_cancelled',
      partial: {
        remainingBudget: { remainingTurns: 0 },
        latestCheckpoint: {
          content: '',
          turnsCompleted: 0,
          model: '',
          capturedAt: 110,
        },
      },
      capabilities: ['general'],
      requiredCapabilities: [],
    })),
    getRuntimeSnapshot: vi.fn(() => ({
      generatedAt: 100,
      activeCount: 1,
      activeTasks: [],
      recentTasks: [],
    })),
    getRuntimeTaskDetail: vi.fn(() => ({
      view: {
        task: {
          subagentId: 'subagent-1',
          name: 'inspect',
          task: 'inspect runtime state',
          workerLane: 'subagent',
          channelId: 'subagent:subagent-1',
          lifecycleState: 'completed',
          stateReason: 'completed',
          createdAt: 100,
          finishedAt: 150,
          capabilities: ['general'],
          requiredCapabilities: [],
        },
        transcript: [],
        transcriptMessageCount: 2,
        transcriptTruncated: false,
        artifacts: [],
        resume: {
          channelId: 'subagent:subagent-1',
          lifecycleState: 'completed',
          resumable: false,
          transcriptAvailable: true,
          transcriptMessageCount: 2,
          transcriptTruncated: false,
        },
      },
      result: {
        subagentId: 'subagent-1',
        name: 'inspect',
        content: 'done',
        model: 'mock-model',
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 50,
        turns: 1,
        workerLane: 'subagent',
        lifecycleState: 'completed',
        outcome: 'completed',
        completionHandoff: { status: 'delivered' },
        stateReason: 'completed',
        capabilities: ['general'],
        requiredCapabilities: [],
      },
    })),
  };
}

describe('createSubagentTool', () => {
  it('advertises sixteen turns for background-model worker tasks', () => {
    const tool = createSubagentTool(createPort());

    expect((fromAny(tool.parameters)).properties.max_turns.maximum).toBe(16);
    expect((fromAny(tool.parameters)).properties).not.toHaveProperty('toolset');
    expect(tool.description).not.toContain('toolset');
    expect(tool.description).toBe(CANONICAL_TOOL_SURFACE_DESCRIPTIONS.subagent);
  });

  it('routes spawn requests through the bounded subagent control surface', async () => {
    const port = createPort();
    const tool = createSubagentTool(port);

    const result = await tool.execute('call-1', {
      action: 'spawn',
      name: 'inspect',
      task: 'inspect runtime state',
      max_turns: 2,
    });

    expect(port.spawn).toHaveBeenCalledWith(expect.objectContaining({
      name: 'inspect',
      task: 'inspect runtime state',
      maxTurns: 2,
    }));
    expect(parseText(result)).toMatchObject({
      action: 'spawn',
      surface: 'subagent',
      semantics: 'bounded_worker',
      subagent_id: 'subagent-1',
      subagentId: 'subagent-1',
      next_action: {
        action: 'wait',
        subagent_id: 'subagent-1',
      },
      task: {
        subagentId: 'subagent-1',
        lifecycleState: 'queued',
      },
    });
  });

  it('threads a requested role through the spawn surface (7ym.2)', async () => {
    const port = createPort();
    const tool = createSubagentTool(port);

    await tool.execute('call-role', {
      action: 'spawn',
      name: 'inspect',
      task: 'inspect runtime state',
      role: '  researcher  ',
    });

    expect(port.spawn).toHaveBeenCalledWith(expect.objectContaining({ role: 'researcher' }));
  });

  it('omits role from the spawn request when none is provided (7ym.2)', async () => {
    const port = createPort();
    const tool = createSubagentTool(port);

    await tool.execute('call-no-role', {
      action: 'spawn',
      name: 'inspect',
      task: 'inspect runtime state',
    });

    expect((port.spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty('role');
  });

  it('exposes role as an optional parameter on the spawn schema (7ym.2)', () => {
    const tool = createSubagentTool(createPort());
    const parameterSchema = tool.parameters as { properties: Record<string, unknown> };
    expect(parameterSchema.properties).toHaveProperty('role');
  });

  it('does not expose memory-write elevation on the model-facing spawn surface (c7d)', async () => {
    const port = createPort();
    const tool = createSubagentTool(port);

    const parameterSchema = tool.parameters as { properties: Record<string, unknown> };
    expect(parameterSchema.properties).not.toHaveProperty('memory_write_elevation_reason');
    const untrustedModelInput = {
      action: 'spawn' as const,
      name: 'untrusted-request',
      task: 'attempt to self-authorize elevated memory writes',
      memory_write_elevation_reason: '  sleeptime emotional-memory maintenance  ',
    };
    await tool.execute('call-1', untrustedModelInput);
    expect(port.spawn).toHaveBeenCalledOnce();
    expect((port.spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty('memoryWriteElevation');
  });

  it('returns detailed status for a specific bounded worker and a snapshot otherwise', async () => {
    const port = createPort();
    const tool = createSubagentTool(port);

    const detail = await tool.execute('call-detail', {
      action: 'status',
      subagent_id: 'subagent-1',
      transcript_limit: 4,
    });
    const snapshot = await tool.execute('call-snapshot', {
      action: 'status',
      task_limit: 3,
      transcript_limit: 2,
    });

    expect(port.getRuntimeTaskDetail).toHaveBeenCalledWith('subagent-1', { transcriptLimit: 4 });
    expect(port.getRuntimeSnapshot).toHaveBeenCalledWith({ taskLimit: 3, transcriptLimit: 2 });
    expect(parseText(detail)).toMatchObject({
      action: 'status',
      detail: {
        result: {
          subagentId: 'subagent-1',
        },
      },
    });
    expect(parseText(snapshot)).toMatchObject({
      action: 'status',
      snapshot: {
        activeCount: 1,
      },
    });
  });

  it('surfaces wait and cancel results on the same semantic tool', async () => {
    const port = createPort();
    const tool = createSubagentTool(port);

    const waited = await tool.execute('call-wait', { action: 'wait', subagent_id: 'subagent-1' });
    const cancelled = await tool.execute('call-cancel', {
      action: 'cancel',
      subagent_id: 'subagent-1',
      reason: 'operator_cancelled',
    });

    expect(port.wait).toHaveBeenCalledWith('subagent-1');
    expect(port.cancel).toHaveBeenCalledWith('subagent-1', 'operator_cancelled');
    expect(parseText(waited)).toMatchObject({
      action: 'wait',
      result: {
        lifecycleState: 'completed',
      },
    });
    expect(parseText(cancelled)).toMatchObject({
      action: 'cancel',
      result: {
        lifecycleState: 'cancelled',
      },
    });
    expect(waited.details.isError).toBeUndefined();
    expect(cancelled.details.isError).toBeUndefined();
  });

  it.each(['blocked', 'cancelled', 'budget_limited'] as const)(
    'marks a terminal %s wait as a tool error while preserving the worker payload',
    async (outcome) => {
      const port = createPort();
      vi.mocked(port.wait).mockResolvedValueOnce({
        subagentId: 'subagent-1',
        name: 'inspect',
        content: 'partial evidence',
        model: 'mock-model',
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 50,
        turns: 1,
        workerLane: 'subagent',
        lifecycleState: outcome === 'cancelled' ? 'cancelled' : 'failed',
        outcome,
        completionHandoff: { status: 'delivered' },
        stateReason: `worker_${outcome}`,
        failureReason: `worker stopped: ${outcome}`,
        partial: {
          remainingBudget: { remainingTurns: 1 },
          latestCheckpoint: {
            content: 'partial evidence',
            turnsCompleted: 1,
            model: 'mock-model',
            capturedAt: 150,
          },
        },
        capabilities: ['general'],
        requiredCapabilities: [],
      });
      const tool = createSubagentTool(port);

      const waited = await tool.execute('call-wait-terminal', {
        action: 'wait',
        subagent_id: 'subagent-1',
      });

      expect(waited.details).toMatchObject({ isError: true });
      expect(parseText(waited)).toMatchObject({
        action: 'wait',
        result: {
          outcome,
          content: 'partial evidence',
          failureReason: `worker stopped: ${outcome}`,
          partial: {
            latestCheckpoint: { content: 'partial evidence' },
          },
        },
      });
    },
  );

  it('infers a wait target when exactly one bounded worker task is visible', async () => {
    const port = createPort();
    const detail = port.getRuntimeTaskDetail('subagent-1');
    expect(detail).not.toBeNull();
    vi.mocked(port.getRuntimeSnapshot).mockReturnValueOnce({
      generatedAt: 200,
      activeCount: 0,
      activeTasks: [],
      recentTasks: [detail!.view],
    });
    const tool = createSubagentTool(port);

    const waited = await tool.execute('call-wait', { action: 'wait' });

    expect(port.wait).toHaveBeenCalledWith('subagent-1');
    expect(parseText(waited)).toMatchObject({
      action: 'wait',
      result: {
        lifecycleState: 'completed',
      },
    });
  });

  it('uses shard.spawn for mutating subagent control actions and identity.read for read-only actions', () => {
    const tool = createSubagentTool(createPort());

    expect(resolveToolRequiredCapabilities(tool, { action: 'spawn' })).toEqual(['shard.spawn']);
    expect(resolveToolRequiredCapabilities(tool, { action: 'message' })).toEqual(['shard.spawn']);
    expect(resolveToolRequiredCapabilities(tool, { action: 'cancel' })).toEqual(['shard.spawn']);
    expect(resolveToolRequiredCapabilities(tool, { action: 'status' })).toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(tool, { action: 'wait' })).toEqual(['identity.read']);
  });

  it('returns minimal valid JSON examples for missing spawn and message arguments', async () => {
    const tool = createSubagentTool(createPort());

    const missingSpawnName = await tool.execute('call-missing-spawn-name', {
      action: 'spawn',
      task: 'inspect runtime state',
    });
    const missingMessageText = await tool.execute('call-missing-message-text', {
      action: 'message',
      subagent_id: 'subagent-1',
    });
    const missingMessageId = await tool.execute('call-missing-message-id', {
      action: 'message',
      message: 'please continue',
    });

    expect(resultText(missingSpawnName)).toContain('Missing required field "name"');
    expect(resultText(missingSpawnName)).toContain('{"action":"spawn","name":"short-label","task":"bounded task to run"}');
    expect(resultText(missingMessageText)).toContain('Missing required field "message"');
    expect(resultText(missingMessageText)).toContain('{"action":"message","subagent_id":"subagent-1","message":"follow-up instruction"}');
    expect(resultText(missingMessageId)).toContain('Missing required field "subagent_id"');
    expect(resultText(missingMessageId)).toContain('Use the id returned by action=spawn or action=status');
  });
});
