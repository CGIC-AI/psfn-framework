import { describe, expect, it } from 'vitest';
import {
  buildBoundedSubagentLaunchEnvelope,
  isBoundedSubagentLaunchToolName,
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
      },
    });
    expect(isBoundedSubagentLaunchToolName('spawn_shard')).toBe(true);
    expect(isBoundedSubagentLaunchToolName('load_tools')).toBe(false);

    expect(buildBoundedSubagentLaunchEnvelope(
      request,
      {
        shardId: 'shard-1',
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
      toolName: 'spawn_shard',
      request,
      result: {
        shardId: 'shard-1',
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
    })).toThrow('maxTurns must be an integer between 1 and 8');
  });
});
