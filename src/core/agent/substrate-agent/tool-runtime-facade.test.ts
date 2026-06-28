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
  it('rejects high-risk retired first-party aliases at the model-facing registration boundary', () => {
    const { facade } = createFacade(null);
    expect(() => facade.registerTool(makeTool('session_new'), 'core')).toThrow(
      'core tool registration includes retired first-party tool aliases: session_new->session',
    );
    expect(() => facade.registerTool(makeTool('selfie_create'), 'extended')).not.toThrow();
  });

  it('keeps only the reflection allowlist of core tools active for maintenance turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade('reflection');
    facade.registerTool(makeTool('identity'), 'core');
    facade.registerTool(makeTool('system'), 'core');
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('contact'), 'core');
    facade.registerTool(makeTool('subagent'), 'core');
    facade.registerTool(makeTool('analysis_workbench'), 'core');

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
      ['agent.tools.core_guardrail.skipped', expect.objectContaining({ toolName: 'analysis_workbench', taskKind: 'reflection' })],
    ]));
  });

  it('leaves the core tool set unchanged for non-maintenance turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade(null);
    facade.registerTool(makeTool('identity'), 'core');
    facade.registerTool(makeTool('system'), 'core');
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('contact'), 'core');
    facade.registerTool(makeTool('subagent'), 'core');
    facade.registerTool(makeTool('analysis_workbench'), 'core');

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
    expect(tools.map(tool => tool.name)).toEqual(['analysis_workbench', 'contact', 'identity', 'session', 'subagent', 'system']);
    expect(emitTelemetry).not.toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.anything(),
    );
  });

  it('removes analysis_workbench from routine memory-intent concern turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade(null);
    facade.registerTool(makeTool('orient'), 'core');
    facade.registerTool(makeTool('memory'), 'core');
    facade.registerTool(makeTool('analysis_workbench'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-concern-1',
      channelId: 'api:routine-concern',
      channelType: 'api',
      authorId: 'user-1',
      authorName: 'User',
      content: 'Use orient to create_concern, list_concerns, resolve_concern, and list_concerns again.',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, undefined, 'chat', correlation, { intent: 'memory', skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual(['memory', 'orient']);
    expect(emitTelemetry).toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.objectContaining({
        toolName: 'analysis_workbench',
        intent: 'memory',
        reason: 'routine_intent_direct_tool_path',
      }),
    );
  });

  it('removes analysis_workbench from internal maintenance turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade('maintenance');
    facade.registerTool(makeTool('identity'), 'core');
    facade.registerTool(makeTool('system'), 'core');
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('analysis_workbench'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-maintenance-1',
      channelId: 'internal:maintenance',
      channelType: 'api',
      authorId: 'runtime',
      authorName: 'Maintenance',
      content: 'routine maintenance',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, 'maintenance', 'background', correlation, { intent: null, skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual(['identity', 'session', 'system']);
    expect(emitTelemetry).toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.objectContaining({
        toolName: 'analysis_workbench',
        taskKind: 'maintenance',
        reason: 'maintenance_turn_allowlist',
      }),
    );
  });

  it('keeps analysis_workbench available for explicit large-evidence turns', () => {
    const { facade, agent, correlation } = createFacade(null);
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('analysis_workbench'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-large-evidence-1',
      channelId: 'api:analysis',
      channelType: 'api',
      authorId: 'user-1',
      authorName: 'User',
      content: 'Analyze this large transcript and evidence set.',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, undefined, 'chat', correlation, { intent: 'memory', skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual(['analysis_workbench', 'session']);
  });

  it('removes visual tools from audio-only satellite turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade(null);
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('media'), 'core');
    facade.registerTool(makeTool('selfie_create'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-audio-satellite-1',
      channelId: 'satellite:voice-pi:kitchen',
      channelType: 'api',
      authorId: 'primary-user',
      authorName: 'Primary User',
      content: 'talk with me',
      routing: {
        source: 'satellite',
        satellite: {
          schemaVersion: 1,
          satelliteId: 'pi-voice',
          satelliteDisplayName: 'Kitchen Voice Pi',
          endpointId: 'wyoming-voice',
          endpointDisplayName: 'Wyoming Voice Endpoint',
          claimType: 'voice-pi',
          sessionId: 'kitchen',
          mobility: 'static',
          promptChannelType: 'voice_satellite',
          capabilities: {
            advertised: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech'],
            registryMax: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech'],
            effective: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech'],
            policyDenied: [],
          },
          telemetryScopes: ['presence'],
          auth: {
            mode: 'api_key',
            principalId: 'api-key-test',
            certBound: false,
          },
        },
      },
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, undefined, 'chat', correlation, { intent: null, skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual(['session']);
    expect(emitTelemetry).toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.objectContaining({
        toolName: 'media',
        satelliteId: 'pi-voice',
        reason: 'satellite_capability_denied',
      }),
    );
    expect(emitTelemetry).toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.objectContaining({
        toolName: 'selfie_create',
        satelliteId: 'pi-voice',
        reason: 'satellite_capability_denied',
      }),
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
