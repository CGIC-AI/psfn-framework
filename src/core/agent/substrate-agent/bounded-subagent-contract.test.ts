import { describe, expect, it } from 'vitest';
import {
  buildBoundedSubagentLaunchEnvelope,
  createBoundedSubagentLaunchPort,
  createSubagentExecutionPort,
  isBoundedSubagentLaunchToolName,
  MAX_BOUNDED_SUBAGENT_LAUNCH_TURNS,
  normalizeBoundedSubagentLaunchRequest,
} from './bounded-subagent-contract.js';

describe('bounded subagent contract', () => {
  it('normalizes launch requests and builds a structured envelope', () => {
    const request = normalizeBoundedSubagentLaunchRequest({
      name: '  research  ',
      task: '  explore an idea  ',
      systemPrompt: '  use care  ',
      maxTurns: 3,
      capabilities: ['general', 'general', 'analysis'],
      requiredCapabilities: ['must-read', 'must-read', 'fast'],
      sourceContext: {
        channelId: '  api:source  ',
        requestId: '  req-1  ',
        turnId: '  turn-1  ',
        embodimentContext: {
          kind: 'embodiment',
          embodimentId: '  display  ',
          companionId: '  companion-test  ',
          siteId: '  ha-main  ',
          satelliteId: '  kitchen  ',
          channelId: '  api:wyoming:ha-main:display  ',
        },
      },
    });

    expect(request).toEqual({
      name: 'research',
      task: 'explore an idea',
      systemPrompt: 'use care',
      maxTurns: 3,
      capabilities: ['general', 'analysis'],
      requiredCapabilities: ['must-read', 'fast'],
      sourceContext: {
        channelId: 'api:source',
        requestId: 'req-1',
        turnId: 'turn-1',
        embodimentContext: {
          kind: 'embodiment',
          embodimentId: 'display',
          companionId: 'companion-test',
          siteId: 'ha-main',
          satelliteId: 'kitchen',
          channelId: 'api:wyoming:ha-main:display',
        },
      },
    });
    expect(isBoundedSubagentLaunchToolName('spawn_subagent')).toBe(true);
    expect(isBoundedSubagentLaunchToolName('load_tools')).toBe(false);

    expect(buildBoundedSubagentLaunchEnvelope(
      request,
      {
        subagentId: 'subagent-1',
        content: 'ok',
        model: 'mock-model',
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 33,
        turns: 2,
      },
      {
        stateReason: 'completed',
      },
    )).toEqual({
      kind: 'bounded_subagent_launch',
      toolName: 'spawn_subagent',
      request,
      result: {
        subagentId: 'subagent-1',
        content: 'ok',
        model: 'mock-model',
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 33,
        turns: 2,
      },
      diagnostics: {
        stateReason: 'completed',
      },
    });
  });

  it('fails closed on invalid launch inputs', () => {
    expect(() => normalizeBoundedSubagentLaunchRequest({
      name: '   ',
      task: 'task',
    })).toThrow('non-empty name');
    expect(() => normalizeBoundedSubagentLaunchRequest({
      name: 'name',
      task: 'task',
      maxTurns: 0,
    })).toThrow(`maxTurns must be an integer between 1 and ${MAX_BOUNDED_SUBAGENT_LAUNCH_TURNS}`);
    expect(normalizeBoundedSubagentLaunchRequest({
      name: 'name',
      task: 'task',
      maxTurns: MAX_BOUNDED_SUBAGENT_LAUNCH_TURNS,
    }).maxTurns).toBe(MAX_BOUNDED_SUBAGENT_LAUNCH_TURNS);
    expect(() => normalizeBoundedSubagentLaunchRequest({
      name: 'name',
      task: 'task',
      sourceContext: {
        channelId: 'api:source',
        embodimentContext: {
          kind: 'embodiment',
          embodimentId: '   ',
          companionId: 'companion-test',
        } as any,
      },
    })).toThrow('non-empty sourceContext.embodimentContext.embodimentId');
  });

  it('adapts between bounded launch and subagent execution ports', async () => {
    const summary = {
      subagentId: 'subagent-1',
      name: 'research',
      content: 'ok',
      model: 'mock-model',
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 33,
      turns: 2,
      lifecycleState: 'ready' as const,
      health: 'healthy' as const,
      stateReason: 'completed',
      capabilities: ['general'],
      requiredCapabilities: ['analysis'],
    };
    const request = normalizeBoundedSubagentLaunchRequest({
      name: 'research',
      task: 'explore',
    });
    const launchPort = createBoundedSubagentLaunchPort({
      executeSubagent: async () => summary,
    });
    const executionPort = createSubagentExecutionPort({
      launchBoundedSubagent: async () => summary,
    });

    await expect(launchPort.launchBoundedSubagent(request)).resolves.toEqual(summary);
    await expect(executionPort.executeSubagent(request)).resolves.toEqual(summary);
  });
});
