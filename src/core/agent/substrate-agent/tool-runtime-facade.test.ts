import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { ToolRuntimeFacade } from './tool-runtime-facade.js';
import { createWorkerExecutionPolicy, SUBAGENT_WORKER_LANE } from '../worker-lanes.js';
import {
  NO_CAPABILITY_REQUIREMENT,
  withCapabilityRequirement,
} from '../../../system/capabilities/requirements.js';
import { createIcpAutonomyCandidateSchedulerMessage } from '../../icp/candidate-scheduler-origin.js';
import type { IcpInitiationCandidate } from '../../icp/initiation-candidate.js';
import type { IcpInitiationPermit } from '../../../shared/contracts/icp-autonomy.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { listCanonicalToolSurfaces } from '../tool-surface/registry.js';
import { getCanonicalToolSurfaceDescription } from '../tool-surface/descriptions.js';

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

function createFacade(
  taskKind: string | null = null,
  grantedTokens: readonly string[] = ['external.companion'],
  configOverrides: Partial<SubstrateConfig> = {},
) {
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
    config: configOverrides as SubstrateConfig,
    agent: agent as never,
    resolveCapabilityAccess: () => ({
      getTier: () => grantedTokens.includes('external.companion') ? 'autonomous' : 'nursery',
      getGrantedTokens: () => new Set(grantedTokens),
      has: (token: string) => grantedTokens.includes(token),
    }) as never,
    withCapabilityGates: tools => tools,
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
    getActiveTurnCorrelation: () => activeTurnCorrelation,
    getActiveTurnTaskKind: () => taskKind,
  });

  return {
    facade,
    agent,
    emitTelemetry,
    correlation: activeTurnCorrelation,
    config: configOverrides,
  };
}

describe('ToolRuntimeFacade canonical descriptions', () => {
  it('uses the live registry description for every registered first-party surface', () => {
    const { facade } = createFacade();

    for (const surface of listCanonicalToolSurfaces()) {
      facade.registerTool(makeTool(surface.name), surface.exposure);
    }
    facade.registerTool(makeTool('third_party_probe'), 'extended');

    const catalog = facade.getToolCatalog();
    const registered = new Map(
      [...catalog.core, ...catalog.extended].map(tool => [tool.name, tool.description]),
    );
    for (const surface of listCanonicalToolSurfaces()) {
      expect(registered.get(surface.name), surface.name).toBe(surface.description);
    }
    expect(registered.get('third_party_probe')).toBe('third_party_probe description');
  });
});

function makeCandidateMessage() {
  const nowMs = Date.now();
  const candidate: IcpInitiationCandidate = {
    candidateId: '11111111-1111-4111-8111-111111111111',
    rootInitiationId: '22222222-2222-4222-8222-222222222222',
    localCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    peerContactId: 'peer-contact-b',
    peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    preferredChannel: 'dm',
    source: 'intention',
    provenanceRef: 'icp-prov:11111111-1111-4111-8111-111111111111',
    reasonSummary: 'Continue the approved private research task.',
    continuationTaskKind: 'research',
    createdAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    status: 'permitted',
    revision: 2,
  };
  const permit: IcpInitiationPermit = {
    permitId: '44444444-4444-4444-8444-444444444444',
    candidateId: candidate.candidateId,
    conversationId: '55555555-5555-4555-8555-555555555555',
    senderCompanionId: candidate.localCompanionId,
    recipientCompanionId: candidate.peerCompanionId,
    channelId: `companion-dm:${candidate.localCompanionId}:${candidate.peerCompanionId}`,
    provenanceRef: candidate.provenanceRef,
    issuedAtMs: nowMs - 500,
    expiresAtMs: nowMs + 60_000,
    status: 'issued',
    revision: 1,
  };
  return createIcpAutonomyCandidateSchedulerMessage({ candidate, permit });
}

describe('ToolRuntimeFacade maintenance core tool policy', () => {
  it('makes an unpinned extended tool callable on the first ordinary turn', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text', text: 'extended result' }],
      details: {},
    }));
    const { facade, correlation } = createFacade();
    facade.registerTool(makeTool('ordinary_core'), 'core');
    facade.registerTool(makeTool('extended_probe', execute), 'extended');
    const message = {
      id: 'first-turn-extended',
      channelId: 'api:first-turn',
      channelType: 'api',
      authorId: 'primary-user',
      authorName: 'Primary User',
      content: 'run the extended probe',
      timestamp: new Date('2026-07-15T10:00:00Z'),
    } as never;
    const turnCorrelation = {
      ...correlation,
      requestId: message.id,
      channelId: message.channelId,
      callType: 'chat' as const,
    };

    await facade.runWithTurnToolContext(message, async () => {
      facade.applyActiveToolsToAgentForTurn(
        message,
        undefined,
        'chat',
        turnCorrelation,
        { intent: null },
      );
      const tool = facade.getActiveTurnTools().find(candidate => candidate.name === 'extended_probe');
      expect(tool).toBeDefined();
      await tool!.execute('first-turn-call', {});
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(facade.getPromotedExtendedTools()).toEqual([]);
  });

  it('isolates candidate notify from an overlapping ordinary turn without an agent-global grant', async () => {
    const { facade, agent } = createFacade();
    facade.registerTool(withCapabilityRequirement(
      makeTool('notify'),
      'external.companion',
    ), 'extended');
    facade.registerTool(makeTool('ordinary_core'), 'core');
    const candidateMessage = makeCandidateMessage();
    const ordinaryMessage = {
      id: 'discord-message-1',
      channelId: 'discord:general',
      channelType: 'discord',
      authorId: 'operator-1',
      authorName: 'Operator',
      content: 'ordinary overlapping turn',
      timestamp: new Date(),
    } as never;
    let releaseCandidate!: () => void;
    let candidateEntered!: () => void;
    const entered = new Promise<void>((resolve) => { candidateEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseCandidate = resolve; });

    const candidateRun = facade.runWithIcpAutonomyCandidateNotifyScope(candidateMessage, async () => {
      facade.applyActiveToolsToAgentForTurn(
        candidateMessage,
        'research',
        'background',
        {
          turnId: 'turn-candidate',
          requestId: 'request-candidate',
          channelId: candidateMessage.channelId,
          callType: 'background',
          purpose: 'agent.turn',
        },
        { intent: 'ops' },
      );
      expect(facade.getActiveTurnTools().map(tool => tool.name)).toContain('notify');
      candidateEntered();
      await release;
      expect(facade.getActiveTurnTools().map(tool => tool.name)).toContain('notify');
    });
    await entered;

    await facade.runWithTurnToolContext(ordinaryMessage, async () => {
      facade.applyActiveToolsToAgentForTurn(
        ordinaryMessage,
        undefined,
        'chat',
        {
          turnId: 'turn-ordinary',
          requestId: 'request-ordinary',
          channelId: ordinaryMessage.channelId,
          callType: 'chat',
          purpose: 'agent.turn',
        },
        { intent: null },
      );
      expect(facade.getActiveTurnTools().map(tool => tool.name)).toEqual([
        'notify',
        'ordinary_core',
      ]);
    });

    expect(agent.setTools).not.toHaveBeenCalled();
    releaseCandidate();
    await candidateRun;
    expect(facade.getAdaptiveToolRuntimeState().activeTools).toContainEqual(
      expect.objectContaining({ toolName: 'notify', source: 'extended' }),
    );
  });

  it('rechecks the exact candidate turn request context when notify executes', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'queued' }], details: {} }));
    const grantedTokens = ['external.companion'];
    const { facade } = createFacade(null, grantedTokens);
    facade.registerTool(withCapabilityRequirement(
      makeTool('notify', execute),
      'external.companion',
    ), 'extended');
    const message = makeCandidateMessage();
    await facade.runWithIcpAutonomyCandidateNotifyScope(message, async () => {
      const correlation = {
        turnId: 'turn-candidate',
        requestId: 'request-candidate',
        channelId: message.channelId,
        callType: 'background' as const,
        purpose: 'agent.turn',
      };
      facade.applyActiveToolsToAgentForTurn(
        message,
        'research',
        'background',
        correlation,
        { intent: 'ops' },
      );
      const notify = facade.getActiveTurnTools().find(tool => tool.name === 'notify')!;
      const params = {
        action: 'send',
        target_kind: 'companion',
        contact_id: 'peer-contact-b',
        initiation_permit: '44444444-4444-4444-8444-444444444444',
      };

      const denied = await runWithRequestContext({
        ...correlation,
        requestId: 'request-forged',
      }, () => notify.execute('call-forged', params));
      expect(denied).toMatchObject({ details: { isError: true } });
      expect(execute).not.toHaveBeenCalled();

      await runWithRequestContext(correlation, () => notify.execute('call-exact', params));
      expect(execute).toHaveBeenCalledOnce();

      grantedTokens.length = 0;
      const revoked = await runWithRequestContext(
        correlation,
        () => notify.execute('call-revoked', params),
      );
      expect(revoked).toMatchObject({ details: { isError: true } });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  it('keeps catalog, tool_search, toolset describe, and direct calls inside the companion lane', async () => {
    const externalDispatch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'external dispatched' }],
      details: {},
    }));
    const { facade } = createFacade(null, [
      'external.companion',
      'external.discord',
      'external.email',
      'external.web',
    ]);
    facade.registerTool(withCapabilityRequirement(
      makeTool('notify', externalDispatch),
      params => params.target_kind === 'companion' ? 'external.companion' : 'external.web',
    ), 'extended');
    const message = makeCandidateMessage();

    await facade.runWithIcpAutonomyCandidateNotifyScope(message, async () => {
      const correlation = {
        turnId: 'turn-candidate-catalog',
        requestId: 'request-candidate-catalog',
        channelId: message.channelId,
        callType: 'background' as const,
        purpose: 'agent.turn',
      };
      facade.applyActiveToolsToAgentForTurn(
        message,
        'research',
        'background',
        correlation,
        { intent: 'ops' },
      );

      const catalogNotify = facade.getToolCatalog().extended.find(tool => tool.name === 'notify')!;
      expect(Object.keys((catalogNotify.parameters as any).properties).sort()).toEqual([
        'action',
        'contact_id',
        'initiation_permit',
        'target_kind',
      ]);
      const candidateDescription = getCanonicalToolSurfaceDescription('notify', 'companion_candidate');
      expect(catalogNotify.description).toBe(candidateDescription);

      const searchResult = await facade.createToolSearchTool().execute(
        'call-search-notify',
        { query: 'notify' },
      );
      const searchMatch = (searchResult.details as {
        toolSearch?: { matches?: Array<{ description?: string }> };
      }).toolSearch?.matches?.[0];
      expect(searchMatch?.description).toBe(candidateDescription);

      const describeResult = await facade.createToolsetTool().execute(
        'call-describe-notify',
        { action: 'describe', tool: 'notify' },
      );
      const describedPayload = JSON.parse(describeResult.content[0]?.text ?? '{}') as {
        tools?: Array<{
          description?: string;
          schema?: { actions?: Array<{ name?: string }>; requiredParameters?: string[] };
        }>;
      };
      expect(describedPayload.tools?.[0]?.description).toBe(candidateDescription);
      expect(describedPayload.tools?.[0]?.schema?.actions?.map(action => action.name)).toEqual(['send']);
      expect(describedPayload.tools?.[0]?.schema?.requiredParameters).toEqual([
        'action',
        'target_kind',
        'contact_id',
        'initiation_permit',
      ]);

      const activeNotify = facade.getActiveTurnTools().find(tool => tool.name === 'notify')!;
      for (const params of [
        {
          action: 'send',
          target_kind: 'external',
          message: 'escape',
          delivery_channel: 'discord',
          delivery_target: 'operator-channel',
        },
        { action: 'brief', message: 'escape' },
        {
          action: 'approval_request',
          approval_id: 'approval-1',
          approval_method: 'runtime.restart',
          approval_action: 'restart',
          approval_scope: 'system',
          approval_reason: 'escape',
        },
      ]) {
        const result = await runWithRequestContext(
          correlation,
          () => activeNotify.execute('call-candidate-escape', params),
        );
        expect(result).toMatchObject({ details: { isError: true } });
      }
      expect(externalDispatch).not.toHaveBeenCalled();
    });
  });

  it('exposes exactly candidate notify and blocks pinned, builtin, and toolset escape paths', async () => {
    const notifyDispatch = vi.fn(async () => ({ content: [{ type: 'text', text: 'notify sent' }], details: {} }));
    const webDispatch = vi.fn(async () => ({ content: [{ type: 'text', text: 'web sent' }], details: {} }));
    const discordDispatch = vi.fn(async () => ({ content: [{ type: 'text', text: 'discord sent' }], details: {} }));
    const emailDispatch = vi.fn(async () => ({ content: [{ type: 'text', text: 'email sent' }], details: {} }));
    const builtinExecute = vi.fn(async () => ({ content: [{ type: 'text', text: 'builtin ran' }], details: {} }));
    const persistPromotedExtendedTools = vi.fn();
    const config: Partial<SubstrateConfig> = {
      promotedExtendedTools: ['discord_send'],
      runtimeHooks: { persistPromotedExtendedTools } as never,
    };
    const { facade, agent } = createFacade(null, [
      'external.companion',
      'external.discord',
      'external.email',
      'external.web',
    ], config);
    const toolset = facade.createToolsetTool();
    const builtin = withCapabilityRequirement(makeTool('builtin_plugin', builtinExecute), NO_CAPABILITY_REQUIREMENT);
    const notify = withCapabilityRequirement(makeTool('notify', notifyDispatch), 'external.companion');
    const externalWeb = withCapabilityRequirement(makeTool('external_web', webDispatch), 'external.web');
    const discord = withCapabilityRequirement(makeTool('discord_send', discordDispatch), 'external.discord');
    const email = withCapabilityRequirement(makeTool('email_send', emailDispatch), 'external.email');
    facade.registerTool(toolset, 'core');
    facade.registerTool(builtin, 'core');
    facade.registerTool(notify, 'extended');
    facade.registerTool(externalWeb, 'extended');
    facade.registerTool(discord, 'extended');
    facade.registerTool(email, 'extended');
    const captured = Object.fromEntries([
      ...facade.getToolCatalog().core,
      ...facade.getToolCatalog().extended,
    ].map(tool => [tool.name, tool] as const));
    const before = {
      promoted: [...facade.getPromotedExtendedTools()],
      agentTools: (agent.state.tools as Array<{ name: string }>).map(tool => tool.name),
      lastSnapshot: facade.getAdaptiveToolRuntimeState().lastSnapshot,
    };
    const message = makeCandidateMessage();
    const correlation = {
      turnId: 'turn-candidate-exact-surface',
      requestId: 'request-candidate-exact-surface',
      channelId: message.channelId,
      callType: 'background' as const,
      purpose: 'agent.turn',
    };

    await facade.runWithIcpAutonomyCandidateNotifyScope(message, async () => {
      facade.applyActiveToolsToAgentForTurn(
        message,
        'research',
        'background',
        correlation,
        { intent: 'ops' },
      );

      expect(facade.getActiveTurnTools().map(tool => tool.name)).toEqual(['notify']);
      expect([
        ...facade.getToolCatalog().core,
        ...facade.getToolCatalog().extended,
      ].map(tool => tool.name)).toEqual(['notify']);
      expect(facade.getToolCatalogSnapshot().tools.map(tool => tool.name)).toEqual(['notify']);
      expect(facade.getAdaptiveToolRuntimeState()).toMatchObject({
        coreTools: [],
        extendedTools: ['notify'],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        activeTools: [{ toolName: 'notify', source: 'extended' }],
      });

      const search = await facade.createToolSearchTool().execute('candidate-search', { query: 'external notify' });
      expect(JSON.stringify(search)).toContain('notify');
      expect(JSON.stringify(search)).not.toMatch(/external_web|discord_send|email_send|builtin_plugin/);
      const describeNotify = await facade.createToolsetTool().execute(
        'candidate-describe-notify',
        { action: 'describe', tool: 'notify' },
      );
      expect(JSON.stringify(describeNotify)).toContain('initiation_permit');
      const describeWeb = await facade.createToolsetTool().execute(
        'candidate-describe-web',
        { action: 'describe', tool: 'external_web' },
      );
      expect(JSON.stringify(describeWeb)).not.toContain('external_web description');

      const manipulatedToolset = facade.createToolsetTool();
      for (const params of [
        { action: 'list' },
        { action: 'suggest', intent: 'use external web' },
        { action: 'pin', tool: 'email_send' },
        { action: 'unpin', tool: 'discord_send' },
      ]) {
        const result = await manipulatedToolset.execute('candidate-toolset-escape', params);
        expect(result).toMatchObject({ details: { isError: true } });
      }
      await expect(captured.toolset!.execute(
        'candidate-captured-toolset-escape',
        { action: 'pin', tool: 'external_web' },
      )).resolves.toMatchObject({ details: { isError: true } });
      expect(facade.addPromotedExtendedTool('email_send')).toMatchObject({
        ok: false,
        changed: false,
        errorCode: 'capability_denied',
      });
      expect(facade.setPromotedExtendedTools(['email_send'])).toEqual([]);
      expect(facade.persistPromotedExtendedTools(['email_send']))
        .toContain('cannot mutate or widen');

      for (const [name, params] of [
        ['builtin_plugin', {}],
        ['external_web', { action: 'dispatch' }],
        ['discord_send', { action: 'send' }],
        ['email_send', { action: 'send' }],
        ['notify', {
          action: 'send',
          target_kind: 'companion',
          contact_id: 'peer-contact-b',
          initiation_permit: '44444444-4444-4444-8444-444444444444',
        }],
      ] as const) {
        const result = await runWithRequestContext(
          correlation,
          () => captured[name]!.execute(`candidate-direct-${name}`, params),
        );
        expect(result).toMatchObject({ details: { isError: true } });
      }
    });

    expect(notifyDispatch).not.toHaveBeenCalled();
    expect(webDispatch).not.toHaveBeenCalled();
    expect(discordDispatch).not.toHaveBeenCalled();
    expect(emailDispatch).not.toHaveBeenCalled();
    expect(builtinExecute).not.toHaveBeenCalled();
    expect(persistPromotedExtendedTools).not.toHaveBeenCalled();
    expect({
      promoted: [...facade.getPromotedExtendedTools()],
      agentTools: (agent.state.tools as Array<{ name: string }>).map(tool => tool.name),
      lastSnapshot: facade.getAdaptiveToolRuntimeState().lastSnapshot,
    }).toEqual(before);
    expect(facade.getActiveTurnTools().map(tool => tool.name)).not.toContain('notify');
  });

  it('refuses trusted candidate scope when live capability policy denies the tool', async () => {
    const { facade } = createFacade(null, []);
    facade.registerTool(withCapabilityRequirement(
      makeTool('notify'),
      'external.companion',
    ), 'extended');

    await expect(facade.runWithIcpAutonomyCandidateNotifyScope(
      makeCandidateMessage(),
      async () => undefined,
    )).rejects.toThrow('not capability authorized');
    expect(facade.getActiveTurnTools()).toEqual([]);
  });

  it('clears cancelled candidate scopes without leaving an exact-surface grant behind', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'queued' }], details: {} }));
    const { facade } = createFacade();
    facade.registerTool(withCapabilityRequirement(
      makeTool('notify', execute),
      'external.companion',
    ), 'extended');
    const message = makeCandidateMessage();
    const correlation = {
      turnId: 'turn-live-overlay',
      requestId: 'request-live-overlay',
      channelId: message.channelId,
      callType: 'background' as const,
      purpose: 'agent.turn',
    };

    await expect(facade.runWithIcpAutonomyCandidateNotifyScope(message, async () => {
      facade.applyActiveToolsToAgentForTurn(
        message,
        'research',
        'background',
        correlation,
        { intent: 'ops' },
      );
      expect(facade.getActiveTurnTools().map(tool => tool.name)).toEqual(['notify']);
      expect(execute).not.toHaveBeenCalled();
      throw new DOMException('candidate cancelled', 'AbortError');
    })).rejects.toThrow('candidate cancelled');

    expect(facade.getActiveTurnTools().map(tool => tool.name)).not.toContain('notify');
    expect(facade.getAdaptiveToolRuntimeState().activeTools).toContainEqual(
      expect.objectContaining({ toolName: 'notify', source: 'extended' }),
    );
  });

  it('rejects candidate notify execution inherited by detached work after scope cleanup', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'queued' }], details: {} }));
    const { facade } = createFacade();
    facade.registerTool(withCapabilityRequirement(
      makeTool('notify', execute),
      'external.companion',
    ), 'extended');
    const message = makeCandidateMessage();
    const correlation = {
      turnId: 'turn-detached-candidate-notify',
      requestId: 'request-detached-candidate-notify',
      channelId: message.channelId,
      callType: 'background' as const,
      purpose: 'agent.turn',
    };
    let releaseDetached!: () => void;
    const detachedRelease = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedResult!: Promise<unknown>;

    await facade.runWithIcpAutonomyCandidateNotifyScope(message, async () => {
      facade.applyActiveToolsToAgentForTurn(
        message,
        'research',
        'background',
        correlation,
        { intent: 'ops' },
      );
      const notify = facade.getActiveTurnTools().find(tool => tool.name === 'notify')!;
      detachedResult = (async () => {
        await detachedRelease;
        const result = await runWithRequestContext(correlation, () => notify.execute(
          'call-detached-candidate-notify',
          {
            action: 'send',
            target_kind: 'companion',
            contact_id: 'peer-contact-b',
            initiation_permit: '44444444-4444-4444-8444-444444444444',
          },
        ));
        return {
          activeToolNames: facade.getActiveTurnTools().map(tool => tool.name),
          catalogToolNames: [
            ...facade.getToolCatalog().core,
            ...facade.getToolCatalog().extended,
          ].map(tool => tool.name),
          result,
        };
      })();
    });

    releaseDetached();
    await expect(detachedResult).resolves.toMatchObject({
      activeToolNames: [],
      catalogToolNames: [],
      result: { details: { isError: true } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails startup validation for an unclassified executable tool', () => {
    const { facade } = createFacade(null);
    facade.registerTool(makeTool('unclassified_plugin_tool'), 'extended');

    expect(() => facade.validateToolWiring('gateway')).toThrow(
      'Tool "unclassified_plugin_tool" has no declared capability policy',
    );
  });

  it('accepts an explicitly reviewed no-capability policy', () => {
    const { facade } = createFacade(null);
    const tool = withCapabilityRequirement(
      makeTool('reviewed_unrestricted_tool'),
      NO_CAPABILITY_REQUIREMENT,
    );
    facade.registerTool(tool, 'extended');

    expect(() => facade.validateToolWiring('gateway')).not.toThrow();
  });

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
    } as never, undefined, 'chat', correlation, { intent: null });

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
    }, 'reflection', 'background', correlation, { intent: null });

    const tools = agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>;
    expect(tools.map(tool => tool.name)).toEqual(['contact', 'session', 'identity', 'self_status', 'system']);

    const skippedEvents = emitTelemetry.mock.calls
      .filter(([eventName]) => eventName === 'agent.tools.core_guardrail.skipped');
    expect(skippedEvents).toEqual(expect.arrayContaining([
      ['agent.tools.core_guardrail.skipped', expect.objectContaining({ toolName: 'subagent', taskKind: 'reflection' })],
      ['agent.tools.core_guardrail.skipped', expect.objectContaining({ toolName: 'analysis_workbench', taskKind: 'reflection' })],
    ]));
  });

  it.each(['heartbeat', 'reflection', 'maintenance'] as const)(
    'applies the explicit maintenance allowlist to authorized core and extended tools on %s turns',
    (taskKind) => {
      const grantedTokens = [
        'external.companion',
        'external.discord',
        'external.email',
        'external.web',
        'git.read',
        'git.write',
        'issue.read',
        'issue.write',
        'issue.close',
        'repl.execute',
        'world.read',
        'world.control',
      ];
      const { facade, agent, emitTelemetry, correlation } = createFacade(taskKind, grantedTokens);
      facade.registerTool(makeTool('identity'), 'core');
      facade.registerTool(makeTool('self_status'), 'core');
      for (const toolName of ['repo', 'shell', 'beads', 'notify', 'world']) {
        facade.registerTool(makeTool(toolName), 'extended');
      }

      facade.applyActiveToolsToAgentForTurn({
        id: `msg-${taskKind}-source-agnostic`,
        channelId: `internal:${taskKind}`,
        channelType: 'api',
        authorId: 'runtime',
        authorName: 'Runtime',
        content: taskKind,
        timestamp: new Date('2026-07-15T11:00:00Z'),
      }, taskKind, 'background', correlation, { intent: 'ops' });

      const activeNames = (agent.setTools.mock.calls.at(-1)?.[0] as Array<{ name: string }>)
        .map(tool => tool.name);
      expect(activeNames).toEqual(expect.arrayContaining(['identity', 'self_status']));
      expect(activeNames).not.toEqual(expect.arrayContaining(['repo', 'shell', 'beads', 'notify', 'world']));

      const snapshot = emitTelemetry.mock.calls.find(
        ([eventName]) => eventName === 'agent.tools.adaptive.snapshot',
      )?.[1];
      expect(snapshot).toMatchObject({
        tools: expect.arrayContaining([
          { toolName: 'identity', source: 'core' },
          { toolName: 'self_status', source: 'core' },
        ]),
        counts: { core: 2, extended: 0, total: 2 },
      });

      const skipped = emitTelemetry.mock.calls
        .filter(([eventName]) => eventName === 'agent.tools.core_guardrail.skipped')
        .map(([, payload]) => payload);
      for (const toolName of ['repo', 'shell', 'beads', 'notify', 'world']) {
        expect(skipped).toContainEqual(expect.objectContaining({
          toolName,
          source: 'extended',
          taskKind,
          reason: 'maintenance_turn_allowlist',
        }));
      }
    },
  );

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
    }, 'heartbeat', 'background', correlation, { intent: null });

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
    }, 'reflection', 'background', correlation, { intent: null });

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
    }, undefined, 'chat', correlation, { intent: null });

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
    }, undefined, 'chat', correlation, { intent: 'memory' });

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
    }, 'maintenance', 'background', correlation, { intent: null });

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
    }, undefined, 'chat', correlation, { intent: 'memory' });

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
    }, undefined, 'background', correlation, { intent: 'memory' });

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
    }, undefined, 'chat', correlation, { intent: null });

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
    }, 'heartbeat', 'background', correlation, { intent: null });

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
