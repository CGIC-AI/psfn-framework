import { describe, expect, it, vi } from 'vitest';
import type { ShardManager } from './manager.js';
import { createSpawnShardTool } from './tools.js';
import { runWithRequestContext } from '../llm/request-context.js';

describe('createSpawnShardTool', () => {
  it('returns a bounded subagent launch envelope in details', async () => {
    const spawn = vi.fn(async () => ({
      shardId: 'shard-123',
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
    const tool = createSpawnShardTool({ spawn } as unknown as ShardManager);

    await runWithRequestContext(
      {
        channelId: 'api:launch-context',
        requestId: 'req-1',
        turnId: 'turn-1',
        embodimentContext: {
          kind: 'embodiment',
          embodimentId: 'display',
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

        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
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
            },
          },
        }));

        expect(result.details).toEqual({
          boundedSubagent: {
            kind: 'bounded_subagent_launch',
            toolName: 'spawn_shard',
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
                  siteId: 'ha-main',
                  satelliteId: 'kitchen',
                },
              },
            },
            result: {
              shardId: 'shard-123',
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
        });
      },
    );
  });
});
