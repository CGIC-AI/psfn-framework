import { describe, expect, it, vi } from 'vitest';
import type { SubagentExecutionPort } from '../../core/agent/substrate-agent/bounded-subagent-contract.js';
import { createBoundedSubagentLaunchTool } from './tools.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';

describe('createBoundedSubagentLaunchTool', () => {
  it('advertises sixteen turns for background-model worker tasks', () => {
    const tool = createBoundedSubagentLaunchTool({ executeSubagent: vi.fn() } as unknown as SubagentExecutionPort);

    expect((tool.parameters as any).properties.maxTurns.maximum).toBe(16);
  });

  it('returns a bounded subagent launch envelope in details', async () => {
    const executeSubagent = vi.fn(async () => ({
      subagentId: 'subagent-123',
      name: 'research',
      content: 'result text',
      model: 'mock-model',
      inputTokens: 12,
      outputTokens: 8,
      durationMs: 44,
      turns: 2,
      lifecycleState: 'ready' as const,
      health: 'healthy' as const,
      stateReason: 'completed',
      capabilities: ['general'],
      requiredCapabilities: ['must-read'],
    }));
    const tool = createBoundedSubagentLaunchTool({ executeSubagent } as unknown as SubagentExecutionPort);

    await runWithRequestContext(
      {
        channelId: 'api:launch-context',
        requestId: 'req-1',
        turnId: 'turn-1',
        embodimentContext: {
          kind: 'embodiment',
          embodimentId: 'display',
          companionId: 'companion-test',
          siteId: 'ha-main',
          satelliteId: 'kitchen',
        },
      },
      async () => {
        const result = await tool.execute('call-1', {
          name: '  research  ',
          task: '  explore  ',
          systemPrompt: '  prompt  ',
          maxTurns: 3,
          capabilities: ['general', 'general', 'analysis'],
          requiredCapabilities: ['must-read', 'must-read'],
        });

        expect(executeSubagent).toHaveBeenCalledWith(expect.objectContaining({
          name: 'research',
          task: 'explore',
          systemPrompt: 'prompt',
          maxTurns: 3,
          capabilities: ['general', 'analysis'],
          requiredCapabilities: ['must-read'],
          sourceContext: {
            channelId: 'api:launch-context',
            requestId: 'req-1',
            turnId: 'turn-1',
            embodimentContext: {
              kind: 'embodiment',
              embodimentId: 'display',
              siteId: 'ha-main',
              satelliteId: 'kitchen',
              companionId: 'companion-test',
            },
          },
        }));

        expect(result.details).toEqual({
          boundedSubagent: {
            kind: 'bounded_subagent_launch',
            toolName: 'spawn_subagent',
            request: {
              name: 'research',
              task: 'explore',
              systemPrompt: 'prompt',
              maxTurns: 3,
              capabilities: ['general', 'analysis'],
              requiredCapabilities: ['must-read'],
              sourceContext: {
                channelId: 'api:launch-context',
                requestId: 'req-1',
                turnId: 'turn-1',
                embodimentContext: {
                  kind: 'embodiment',
                  embodimentId: 'display',
                  companionId: 'companion-test',
                  siteId: 'ha-main',
                  satelliteId: 'kitchen',
                },
              },
            },
            result: {
              subagentId: 'subagent-123',
              content: 'result text',
              model: 'mock-model',
              inputTokens: 12,
              outputTokens: 8,
              durationMs: 44,
              turns: 2,
            },
            diagnostics: {
              stateReason: 'completed',
            },
          },
          mutationWorkflow: 'artifact_return_only',
          artifactReturn: null,
        });
        const text = result.content.map((entry: any) => entry.text).join('');
        expect(text).not.toContain('result text');
        expect(text).toContain('do not forward raw worker text directly to a partner');
      },
    );
  });
});
