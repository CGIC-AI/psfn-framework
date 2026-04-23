import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { ToolRuntimeFacade } from './tool-runtime-facade.js';

function makeTool(name: string, execute = vi.fn(async () => ({
  content: [{ type: 'text', text: `${name} ok` }],
  details: {},
}))): AgentTool<any> {
  return {
    name,
    description: `${name} description`,
    parameters: {},
    execute,
  } as AgentTool<any>;
}

function createFacade(taskKind: string | null = null) {
  const agent = {
    setTools: vi.fn(),
  };
  const emitTelemetry = vi.fn();
  const activeTurnCorrelation = {
    turnId: 'turn-123',
    requestId: 'req-123',
    channelId: 'internal:reflection:test',
    callType: 'background' as const,
    purpose: 'agent.turn',
  };
  const facade = new ToolRuntimeFacade({
    config: {} as never,
    agent: agent as never,
    resolveCapabilityAccess: () => ({}) as never,
    withCapabilityGates: tools => tools,
    withCorrelationPurpose: (correlation, purpose) => ({ ...correlation, purpose }),
    withAdaptiveCorrelation: (correlation, purpose) => ({
      ...(correlation ? {
        turnId: correlation.turnId,
        requestId: correlation.requestId,
        channelId: correlation.channelId,
      } : {}),
      purpose,
    }),
    emitAdaptiveToolDecision: vi.fn(),
    emitTelemetry,
    resolveSessionChannelId: channelId => channelId,
    getActiveTurnCorrelation: () => activeTurnCorrelation,
    getActiveTurnTaskKind: () => taskKind,
    getActiveTurnIntent: () => null,
  });

  return {
    facade,
    agent,
    emitTelemetry,
    correlation: activeTurnCorrelation,
  };
}

describe('ToolRuntimeFacade maintenance core tool policy', () => {
  it('keeps only the reflection allowlist of core tools active for maintenance turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade('reflection');
    facade.registerTool(makeTool('identity'), 'core');
    facade.registerTool(makeTool('system'), 'core');
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('contact'), 'core');
    facade.registerTool(makeTool('subagent'), 'core');
    facade.registerTool(makeTool('think'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-1',
      channelId: 'internal:reflection:test',
      channelType: 'api',
      authorId: 'runtime',
      authorName: 'Runtime',
      content: 'reflect',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, 'reflection', 'background', correlation, { intent: null, skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual(['contact', 'identity', 'session', 'system']);

    const skippedEvents = emitTelemetry.mock.calls
      .filter(([eventName]) => eventName === 'agent.tools.core_guardrail.skipped');
    expect(skippedEvents).toEqual(expect.arrayContaining([
      ['agent.tools.core_guardrail.skipped', expect.objectContaining({ toolName: 'subagent', taskKind: 'reflection' })],
      ['agent.tools.core_guardrail.skipped', expect.objectContaining({ toolName: 'think', taskKind: 'reflection' })],
    ]));
  });

  it('leaves the core tool set unchanged for non-maintenance turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade(null);
    facade.registerTool(makeTool('identity'), 'core');
    facade.registerTool(makeTool('system'), 'core');
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('contact'), 'core');
    facade.registerTool(makeTool('subagent'), 'core');
    facade.registerTool(makeTool('think'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-2',
      channelId: 'ch-1',
      channelType: 'api',
      authorId: 'user-1',
      authorName: 'User',
      content: 'hello',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, undefined, 'chat', correlation, { intent: null, skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual(['contact', 'identity', 'session', 'subagent', 'system', 'think']);
    expect(emitTelemetry).not.toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.anything(),
    );
  });

  it('denies disallowed maintenance-turn core tool actions and emits audit telemetry', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text', text: 'identity ok' }],
      details: {},
    }));
    const { facade, agent, emitTelemetry, correlation } = createFacade('heartbeat');
    facade.registerTool(makeTool('identity', execute), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-3',
      channelId: 'internal:heartbeat',
      channelType: 'api',
      authorId: 'runtime',
      authorName: 'Heartbeat',
      content: 'tick',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, 'heartbeat', 'background', correlation, { intent: null, skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as AgentTool<any>[];
    const identityTool = tools.find(tool => tool.name === 'identity');
    expect(identityTool).toBeDefined();

    const denied = await identityTool!.execute('call-denied', {
      action: 'update_layer',
      layer_id: 'runtime.main',
      content: 'mutate',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(denied.details).toEqual({ isError: true });
    expect(denied.content[0]).toMatchObject({
      type: 'text',
    });
    expect((denied.content[0] as { text?: string }).text).toContain('read-only introspection');
    expect(emitTelemetry).toHaveBeenCalledWith(
      'agent.tools.core_guardrail.denied',
      expect.objectContaining({
        toolName: 'identity',
        taskKind: 'heartbeat',
        requestedAction: 'update_layer',
        reason: 'maintenance_turn_allowlist',
      }),
    );

    const allowed = await identityTool!.execute('call-allowed', {
      action: 'history',
      layer_id: 'runtime.main',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(allowed).toMatchObject({
      content: [{ type: 'text', text: 'identity ok' }],
    });
  });
});
