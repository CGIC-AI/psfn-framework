import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { ToolRuntimeFacade } from './tool-runtime-facade.js';
import { createWorkerExecutionPolicy, SUBAGENT_WORKER_LANE } from '../worker-lanes.js';

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
  // pi-agent-core 0.73 replaced Agent.setTools() with assignment to
  // agent.state.tools; the mock records each assignment via setTools so the
  // existing call-style assertions keep working.
  const setTools = vi.fn();
  const agent = {
    setTools,
    state: {
      get tools(): unknown[] {
        return (setTools.mock.calls.at(-1)?.[0] as unknown[] | undefined) ?? [];
      },
      set tools(tools: unknown[]) {
        setTools(tools);
      },
    },
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
    // The retired media name can never re-enter the model-facing surface.
    expect(() => facade.registerTool(makeTool('media'), 'core')).toThrow(
      'core tool registration includes retired first-party tool aliases: media->generate_image',
    );
    expect(() => facade.registerTool(makeTool('selfie_create'), 'core')).not.toThrow();
  });

  it('presents social/expressive tools before admin and boundary tools', () => {
    const { facade, agent, correlation } = createFacade(null);
    facade.registerTool(makeTool('system'), 'core');
    facade.registerTool(makeTool('fs'), 'core');
    facade.registerTool(makeTool('memory'), 'core');
    facade.registerTool(makeTool('generate_image'), 'core');
    facade.registerTool(makeTool('contact'), 'core');
    facade.registerTool(makeTool('selfie_create'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-ordering-1',
      channelId: 'discord:general',
      channelType: 'discord',
      authorId: 'primary-user',
      authorName: 'Primary User',
      content: 'hey there',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    } as never, undefined, 'chat', correlation, { intent: null, skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual([
      'selfie_create',
      'generate_image',
      'contact',
      'memory',
      'fs',
      'system',
    ]);
  });

  it('rejects widened drift-guard aliases for concerns, north_star, and lifecycle', () => {
    const { facade } = createFacade(null);
    expect(() => facade.registerTool(makeTool('create_concern'), 'core')).toThrow(
      'core tool registration includes retired first-party tool aliases: create_concern->orient',
    );
    expect(() => facade.registerTool(makeTool('list_concerns'), 'core')).toThrow(
      'core tool registration includes retired first-party tool aliases: list_concerns->orient',
    );
    expect(() => facade.registerTool(makeTool('resolve_concern'), 'core')).toThrow(
      'core tool registration includes retired first-party tool aliases: resolve_concern->orient',
    );
    for (const alias of [
      'north_star_list',
      'north_star_create',
      'north_star_update',
      'north_star_delete',
      'north_star_reorder',
    ]) {
      expect(() => facade.registerTool(makeTool(alias), 'extended')).toThrow(
        `extended tool registration includes retired first-party tool aliases: ${alias}->north_star`,
      );
    }
    expect(() => facade.registerTool(makeTool('self_restart'), 'core')).toThrow(
      'core tool registration includes retired first-party tool aliases: self_restart->system',
    );
    expect(() => facade.registerTool(makeTool('self_rebuild'), 'core')).toThrow(
      'core tool registration includes retired first-party tool aliases: self_rebuild->system',
    );
  });

  it('keeps only the reflection allowlist of core tools active for maintenance turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade('reflection');
    facade.registerTool(makeTool('identity'), 'core');
    facade.registerTool(makeTool('system'), 'core');
    facade.registerTool(makeTool('self_status'), 'core');
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
    expect(tools.map(tool => tool.name)).toEqual(['contact', 'session', 'identity', 'self_status', 'system']);

    const skippedEvents = emitTelemetry.mock.calls
      .filter(([eventName]) => eventName === 'agent.tools.core_guardrail.skipped');
    expect(skippedEvents).toEqual(expect.arrayContaining([
      ['agent.tools.core_guardrail.skipped', expect.objectContaining({ toolName: 'subagent', taskKind: 'reflection' })],
      ['agent.tools.core_guardrail.skipped', expect.objectContaining({ toolName: 'analysis_workbench', taskKind: 'reflection' })],
    ]));
  });

  it('keeps expressive image tools available on heartbeat turns (psfn img2)', () => {
    const { facade, agent, correlation } = createFacade('heartbeat');
    facade.registerTool(makeTool('selfie_create'), 'core');
    facade.registerTool(makeTool('generate_image'), 'core');
    facade.registerTool(makeTool('subagent'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-hb-expressive',
      channelId: 'internal:heartbeat',
      channelType: 'api',
      authorId: 'runtime',
      authorName: 'Runtime',
      content: 'heartbeat',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, 'heartbeat', 'background', correlation, { intent: null, skipped: [] });

    const names = (agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>).map(t => t.name);
    // Expressive tools survive the heartbeat self-directed turn; non-allowlisted
    // core tools (subagent) are still dropped.
    expect(names).toContain('selfie_create');
    expect(names).toContain('generate_image');
    expect(names).not.toContain('subagent');
  });

  it('drops expressive image tools from silent reflection turns (psfn img2)', () => {
    const { facade, agent, correlation } = createFacade('reflection');
    facade.registerTool(makeTool('selfie_create'), 'core');
    facade.registerTool(makeTool('generate_image'), 'core');
    facade.registerTool(makeTool('self_status'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-refl-expressive',
      channelId: 'internal:reflection:test',
      channelType: 'api',
      authorId: 'runtime',
      authorName: 'Runtime',
      content: 'reflect',
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, 'reflection', 'background', correlation, { intent: null, skipped: [] });

    const names = (agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>).map(t => t.name);
    // Reflection is silent introspection; no outward image expression.
    expect(names).not.toContain('selfie_create');
    expect(names).not.toContain('generate_image');
    expect(names).toContain('self_status');
  });

  it('routes analysis_workbench away from non-worker parent turns', () => {
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
    expect(tools.map(tool => tool.name)).toEqual(['contact', 'session', 'identity', 'subagent', 'system']);
    expect(emitTelemetry).toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.objectContaining({
        toolName: 'analysis_workbench',
        reason: 'analysis_workbench_worker_context_required',
        recommendation: 'delegate_large_evidence_analysis_to_subagent_or_shard',
      }),
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
    expect(tools.map(tool => tool.name)).toEqual(['session', 'identity', 'system']);
    expect(emitTelemetry).toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.objectContaining({
        toolName: 'analysis_workbench',
        taskKind: 'maintenance',
        reason: 'maintenance_turn_allowlist',
      }),
    );
  });

  it('requires delegation for explicit large-evidence parent turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade(null);
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
    expect(tools.map(tool => tool.name)).toEqual(['session']);
    expect(emitTelemetry).toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.objectContaining({
        toolName: 'analysis_workbench',
        intent: 'memory',
        reason: 'analysis_workbench_worker_context_required',
      }),
    );
  });

  it('keeps analysis_workbench available inside worker contexts', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade(null);
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('analysis_workbench'), 'core');

    facade.applyActiveToolsToAgentForTurn({
      id: 'msg-worker-large-evidence-1',
      channelId: 'subagent:analysis',
      channelType: 'api',
      authorId: 'system:subagent-task',
      authorName: 'Subagent Task',
      content: 'Analyze this large transcript and evidence set.',
      routing: {
        workerExecution: createWorkerExecutionPolicy(SUBAGENT_WORKER_LANE),
      },
      timestamp: new Date('2026-04-23T12:00:00Z'),
    }, undefined, 'background', correlation, { intent: 'memory', skipped: [] });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual(['session', 'analysis_workbench']);
    expect(emitTelemetry).not.toHaveBeenCalledWith(
      'agent.tools.core_guardrail.skipped',
      expect.objectContaining({
        toolName: 'analysis_workbench',
        reason: 'analysis_workbench_worker_context_required',
      }),
    );
  });

  it('removes visual tools from audio-only satellite turns', () => {
    const { facade, agent, emitTelemetry, correlation } = createFacade(null);
    facade.registerTool(makeTool('session'), 'core');
    facade.registerTool(makeTool('generate_image'), 'core');
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
        toolName: 'generate_image',
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
    expect(denied.details).toMatchObject({
      isError: true,
      errorClass: 'permission_denied',
      retryHint: 'operator_escalation',
      retryable: false,
      companionMessage: expect.stringContaining('read-only introspection'),
    });
    expect((denied.details as any).rawDiagnostic).toContain('maintenance_turn_allowlist');
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
