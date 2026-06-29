import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { createToolSearchTool, createToolsetTool } from './adaptive-tools-runtime.js';

describe('createToolSearchTool', () => {
  it('includes compact health markers in tool_search results', async () => {
    const toolSearch = createToolSearchTool({
      getExtendedTools: () => [
        {
          name: 'generate_image',
          description: 'Generate a new image.',
          parameters: {} as any,
          execute: vi.fn(),
        } as any,
        {
          name: 'notify',
          description: 'Send a lightweight notification.',
          parameters: {} as any,
          execute: vi.fn(),
        } as any,
      ],
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: ['generate_image', 'notify'],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        promotedToolsSkipped: [],
        loadedExtendedTools: [],
        activeTools: [],
        lastSnapshot: null,
      }),
      getToolHealthStatusByName: () => new Map<string, 'unavailable' | 'degraded'>([
        ['generate_image', 'unavailable'],
        ['notify', 'degraded'],
      ]),
      classifyExtendedToolForTurn: () => 'overlay',
      resolveCapabilityAccess: () => ({
        getTier: () => 'autonomous',
        getGrantedTokens: () => new Set(['external.web']),
        has: () => true,
      }),
      emitTelemetry: () => undefined,
    });

    const result = await (toolSearch as any).execute('tool-search-1', { limit: 5 });
    const text = result.content?.[0]?.text as string;

    expect(text).toContain('generate_image (x) [available, overlay]');
    expect(text).toContain('notify (!) [available, overlay]');
  });

  it('marks blocked extended tools as capability_denied in tool_search results', async () => {
    const toolSearch = createToolSearchTool({
      getExtendedTools: () => [
        {
          name: 'notify',
          description: 'Send a lightweight notification.',
          parameters: {} as any,
          execute: vi.fn(),
        } as any,
      ],
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: ['notify'],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        promotedToolsSkipped: [],
        loadedExtendedTools: [],
        activeTools: [],
        lastSnapshot: null,
      }),
      getToolHealthStatusByName: () => new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      resolveCapabilityAccess: () => ({
        getTier: () => 'nursery',
        getGrantedTokens: () => new Set(['identity.read']),
        has: () => false,
      }),
      emitTelemetry: () => undefined,
    });

    const result = await (toolSearch as any).execute('tool-search-2', { query: 'notify', limit: 5 });
    const text = result.content?.[0]?.text as string;
    const match = result.details?.toolSearch?.matches?.[0];

    expect(text).toContain('capability_denied');
    expect(text).toContain('missing: external.web, external.discord, external.email');
    expect(match).toMatchObject({
      name: 'notify',
      status: 'capability_denied',
      missingTokens: ['external.web', 'external.discord', 'external.email'],
    });
  });

  it('filters retired first-party aliases from tool_search results', async () => {
    const toolSearch = createToolSearchTool({
      getExtendedTools: () => [
        {
          name: 'media',
          description: 'Generate, edit, or analyze media.',
          parameters: {} as any,
          execute: vi.fn(),
        } as any,
        {
          name: 'image_create',
          description: 'Retired direct image helper.',
          parameters: {} as any,
          execute: vi.fn(),
        } as any,
      ],
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: ['media', 'image_create'],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        promotedToolsSkipped: [],
        loadedExtendedTools: [],
        activeTools: [],
        lastSnapshot: null,
      }),
      getToolHealthStatusByName: () => new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      resolveCapabilityAccess: () => ({
        getTier: () => 'autonomous',
        getGrantedTokens: () => new Set(['external.web']),
        has: () => true,
      }),
      emitTelemetry: () => undefined,
    });

    const result = await (toolSearch as any).execute('tool-search-3', { limit: 5 });
    const text = result.content?.[0]?.text as string;

    expect(text).toContain('media');
    expect(text).not.toContain('image_create');
    expect(result.details?.toolSearch?.matches.map((match: { name: string }) => match.name)).toEqual(['media']);
  });
});

describe('createToolsetTool', () => {
  function createBaseToolset(overrides: Partial<Parameters<typeof createToolsetTool>[0]> = {}) {
    return createToolsetTool({
      getCoreTools: () => [{
        name: 'session',
        description: 'Canonical session surface.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('list'),
            Type.Literal('new'),
          ]),
        }) as any,
        execute: vi.fn(),
      }] as any,
      getExtendedTools: () => [{
        name: 'media',
        description: 'Generate, edit, or analyze media.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('generate'),
            Type.Literal('edit'),
            Type.Literal('analyze'),
          ]),
          prompt: Type.Optional(Type.String()),
        }) as any,
        execute: vi.fn(),
      }],
      getExtendedToolAutoloadPolicy: () => null,
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset', 'session'],
        extendedTools: ['media'],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        promotedToolsSkipped: [],
        loadedExtendedTools: [],
        activeTools: [],
        lastSnapshot: null,
      }),
      resolveCapabilityAccess: () => ({
        getTier: () => 'autonomous',
        getGrantedTokens: () => new Set(['identity.read', 'identity.write.runtime', 'external.web']),
        has: () => true,
      }),
      getActiveTurnCorrelation: () => null,
      getActiveTurnTaskKind: () => null,
      getActiveTurnIntent: () => null,
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => [],
      setPromotedExtendedTools: () => [],
      persistPromotedExtendedTools: () => null,
      addPromotedExtendedTool: () => ({
        ok: true,
        changed: false,
        promotedTools: [],
        message: 'noop',
      }),
      removePromotedExtendedTool: () => ({
        ok: true,
        changed: false,
        promotedTools: [],
        message: 'noop',
      }),
      applyActiveToolsToAgent: () => undefined,
      activateExtendedTools: () => ({
        requestedTools: [],
        activatedTools: [],
        alreadyActiveTools: [],
        missingTools: [],
      }),
      resolveSessionChannelId: (channelId: string) => channelId,
      withAdaptiveCorrelation: () => ({}),
      emitAdaptiveToolDecision: () => undefined,
      emitTelemetry: () => undefined,
      ...overrides,
    } as any);
  }

  function createActionTool(name: string, description: string, actions: readonly string[]) {
    return {
      name,
      description,
      parameters: Type.Object({
        action: Type.Union(actions.map(action => Type.Literal(action))),
      }) as any,
      execute: vi.fn(),
    };
  }

  function createRuntimeState(input: {
    coreTools: readonly string[];
    extendedTools?: readonly string[];
    activeTools: Array<{ toolName: string; source: 'core' | 'extended_loaded' }>;
  }) {
    return {
      generatedAt: 1,
      coreTools: [...input.coreTools],
      extendedTools: [...(input.extendedTools ?? [])],
      promotedToolsConfigured: [],
      promotedToolsActive: [],
      promotedToolsSkipped: [],
      loadedExtendedTools: [],
      activeTools: [...input.activeTools],
      lastSnapshot: null,
    };
  }

  it('describes list-first activation and required tools array', () => {
    const toolset = createBaseToolset();

    expect(toolset.description).toContain('Use action=list to see valid extended tool names');
    expect(toolset.description).toContain('action=suggest with intent');
    expect(toolset.description).toContain('action=activate requires tools as an array');
    expect((toolset as any).parameters.properties.tools.description).toContain('Tool names to activate');
  });

  it('suggests distinct session, web, and filesystem actions for confusing search/read intents', async () => {
    const coreTools = [
      createActionTool(
        'session',
        'Unified session continuity surface for list/search/grep/new/resume/wake_return and focus workflow actions.',
        ['list', 'new', 'resume', 'search', 'grep', 'wake_return', 'start_focus', 'complete_focus'],
      ),
      createActionTool(
        'web',
        'Unified web primitive for direct remote page work and lightweight web research discovery.',
        ['fetch', 'browse', 'search'],
      ),
      createActionTool(
        'fs',
        'Unified filesystem primitive for personal-file inspection and safe mutation.',
        ['list', 'read', 'search', 'write', 'edit'],
      ),
    ];
    const toolset = createBaseToolset({
      getCoreTools: () => coreTools as any,
      getExtendedTools: () => [],
      getAdaptiveToolRuntimeState: () => createRuntimeState({
        coreTools: ['toolset', 'session', 'web', 'fs'],
        activeTools: [
          { toolName: 'toolset', source: 'core' },
          { toolName: 'session', source: 'core' },
          { toolName: 'web', source: 'core' },
          { toolName: 'fs', source: 'core' },
        ],
      }) as any,
    });
    const suggest = async (intent: string) => {
      const result = await (toolset as any).execute('toolset-suggest', {
        action: 'suggest',
        intent,
        limit: 3,
      });
      return JSON.parse(result.content?.[0]?.text as string);
    };

    expect((await suggest('search our previous conversation transcript about backups')).recommendations[0])
      .toMatchObject({ toolName: 'session', action: 'search', availabilityStatus: 'active' });
    expect((await suggest('search the web for latest NVMe kernel notes')).recommendations[0])
      .toMatchObject({ toolName: 'web', action: 'search', availabilityStatus: 'active' });
    expect((await suggest('read the local file purrsephone/notes.md from the workspace')).recommendations[0])
      .toMatchObject({ toolName: 'fs', action: 'read', availabilityStatus: 'active' });
  });

  it('returns no confident suggestion for unrelated intents', async () => {
    const toolset = createBaseToolset({
      getCoreTools: () => [
        createActionTool('session', 'Session transcript surface.', ['search']),
        createActionTool('web', 'Web retrieval surface.', ['search']),
      ] as any,
      getExtendedTools: () => [],
      getAdaptiveToolRuntimeState: () => createRuntimeState({
        coreTools: ['toolset', 'session', 'web'],
        activeTools: [
          { toolName: 'toolset', source: 'core' },
          { toolName: 'session', source: 'core' },
          { toolName: 'web', source: 'core' },
        ],
      }) as any,
    });

    const result = await (toolset as any).execute('toolset-suggest-none', {
      action: 'suggest',
      intent: 'make the mood less uneven without choosing an operation',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload).toMatchObject({
      action: 'suggest',
      total: 0,
      recommendations: [],
      advisoryOnly: true,
    });
    expect(payload.message).toContain('No confident tool suggestion');
  });

  it('marks capability-gated suggestions without activating or granting tools', async () => {
    const activateExtendedTools = vi.fn();
    const applyActiveToolsToAgent = vi.fn();
    const addPromotedExtendedTool = vi.fn();
    const removePromotedExtendedTool = vi.fn();
    const setPromotedExtendedTools = vi.fn();
    const persistPromotedExtendedTools = vi.fn();
    const grantedTokens = new Set(['identity.read']);
    const runtimeState = createRuntimeState({
      coreTools: ['toolset'],
      extendedTools: ['notify'],
      activeTools: [{ toolName: 'toolset', source: 'core' }],
    });
    const beforeState = JSON.stringify(runtimeState);
    const toolset = createBaseToolset({
      getCoreTools: () => [],
      getExtendedTools: () => [{
        name: 'notify',
        description: 'Notify the operator through an external channel.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('brief'),
            Type.Literal('send'),
          ]),
        }) as any,
        execute: vi.fn(),
      }],
      getAdaptiveToolRuntimeState: () => runtimeState as any,
      resolveCapabilityAccess: () => ({
        getTier: () => 'custom',
        getGrantedTokens: () => grantedTokens,
        has: (token) => grantedTokens.has(token),
      }),
      activateExtendedTools,
      applyActiveToolsToAgent,
      addPromotedExtendedTool,
      removePromotedExtendedTool,
      setPromotedExtendedTools,
      persistPromotedExtendedTools,
    } as any);

    const result = await (toolset as any).execute('toolset-suggest-gated', {
      action: 'suggest',
      intent: 'notify the operator',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload.recommendations[0]).toMatchObject({
      toolName: 'notify',
      availabilityStatus: 'capability_denied',
      missingTokens: ['external.web', 'external.discord', 'external.email'],
    });
    expect(payload.recommendations[0].availabilityNote).toContain('missing: external.web');
    expect(activateExtendedTools).not.toHaveBeenCalled();
    expect(applyActiveToolsToAgent).not.toHaveBeenCalled();
    expect(addPromotedExtendedTool).not.toHaveBeenCalled();
    expect(removePromotedExtendedTool).not.toHaveBeenCalled();
    expect(setPromotedExtendedTools).not.toHaveBeenCalled();
    expect(persistPromotedExtendedTools).not.toHaveBeenCalled();
    expect([...grantedTokens]).toEqual(['identity.read']);
    expect(JSON.stringify(runtimeState)).toBe(beforeState);
  });

  it('reports inactive extended tools as advisory activation candidates without mutating active tools', async () => {
    const activateExtendedTools = vi.fn();
    const runtimeState = createRuntimeState({
      coreTools: ['toolset'],
      extendedTools: ['media'],
      activeTools: [{ toolName: 'toolset', source: 'core' }],
    });
    const toolset = createBaseToolset({
      getCoreTools: () => [],
      getExtendedTools: () => [{
        name: 'media',
        description: 'Generate, edit, or analyze media and images.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('generate'),
            Type.Literal('edit'),
            Type.Literal('analyze'),
          ]),
        }) as any,
        execute: vi.fn(),
      }],
      getAdaptiveToolRuntimeState: () => runtimeState as any,
      activateExtendedTools,
    });

    const result = await (toolset as any).execute('toolset-suggest-activation-note', {
      action: 'suggest',
      intent: 'generate an image',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload.recommendations[0]).toMatchObject({
      toolName: 'media',
      action: 'generate',
      availabilityStatus: 'requires_activation',
    });
    expect(payload.recommendations[0].availabilityNote).toContain('activate it with toolset action="activate"');
    expect(activateExtendedTools).not.toHaveBeenCalled();
    expect(runtimeState.activeTools).toEqual([{ toolName: 'toolset', source: 'core' }]);
  });

  it('describes canonical tool actions and runtime metadata without creating extra tool names', async () => {
    const toolset = createBaseToolset();

    const result = await (toolset as any).execute('toolset-describe-1', {
      action: 'describe',
      tool: 'media',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0]).toMatchObject({
      name: 'media',
      scope: 'extended',
      schema: {
        actions: [
          { name: 'generate', requiredCapabilities: [] },
          { name: 'edit', requiredCapabilities: [] },
          { name: 'analyze', requiredCapabilities: [] },
        ],
        requiredParameters: ['action'],
        requiredCapabilities: [],
        reversibility: 'irreversible',
        bundleMembership: expect.arrayContaining(['extended', 'toolset.managed', 'domain:media']),
      },
    });
  });

  it('filters retired aliases from toolset list and activation payloads', async () => {
    const activateExtendedTools = vi.fn((toolNames: readonly string[]) => ({
      requestedTools: [...toolNames],
      activatedTools: [...toolNames],
      alreadyActiveTools: [],
      missingTools: [],
    }));
    const toolset = createBaseToolset({
      getExtendedTools: () => [
        {
          name: 'media',
          description: 'Generate, edit, or analyze media.',
          parameters: {} as any,
          execute: vi.fn(),
        },
        {
          name: 'image_create',
          description: 'Retired direct image helper.',
          parameters: {} as any,
          execute: vi.fn(),
        },
      ] as any,
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: ['media', 'image_create'],
        promotedToolsConfigured: ['media', 'image_create'],
        promotedToolsActive: ['media', 'image_create'],
        promotedToolsSkipped: [],
        loadedExtendedTools: [
          { toolName: 'media', source: 'extended_loaded', activatedAt: 1, lastActivatedAt: 1 },
          { toolName: 'image_create', source: 'extended_loaded', activatedAt: 1, lastActivatedAt: 1 },
        ],
        activeTools: [
          { toolName: 'media', source: 'extended_loaded' },
          { toolName: 'image_create', source: 'extended_loaded' },
        ],
        lastSnapshot: null,
      }),
      activateExtendedTools,
    });

    const listResult = await (toolset as any).execute('toolset-list-1', { action: 'list' });
    const listPayload = JSON.parse(listResult.content?.[0]?.text as string);
    expect(JSON.stringify(listPayload)).not.toContain('image_create');
    expect(listPayload.availableExtendedTools).toEqual(['media']);
    expect(listPayload.pinnedTools).toEqual(['media']);

    const activateResult = await (toolset as any).execute('toolset-activate-retired-1', {
      action: 'activate',
      tools: ['image_create'],
    });
    expect(activateExtendedTools).not.toHaveBeenCalled();
    expect(activateResult.details?.isError).toBe(true);
    expect(activateResult.content?.[0]?.text).not.toContain('image_create');
  });

  it('explains the required tools array when activate is called without tool names', async () => {
    const toolset = createBaseToolset();

    const result = await (toolset as any).execute('toolset-activate-missing-tools', {
      action: 'activate',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(result.details?.isError).toBe(true);
    expect(payload).toMatchObject({
      action: 'activate',
      requiredField: 'tools',
      minimalValidJson: { action: 'activate', tools: ['media'] },
      availableTools: ['media'],
    });
    expect(payload.message).toContain('Missing required field "tools" for action="activate"');
    expect(payload.message).toContain('Provide a non-empty tools array');
    expect(payload.message).toContain('Minimal valid JSON: {"action":"activate","tools":["media"]}');
    expect(payload.message).toContain('Use {"action":"list"} to see valid extended tool names');
    expect(payload.message).toContain('do not repeat activate without tools');
  });

  it('accepts object-form tool names for activate requests', async () => {
    const activateExtendedTools = vi.fn((toolNames: readonly string[]) => ({
      requestedTools: [...toolNames],
      activatedTools: [...toolNames],
      alreadyActiveTools: [],
      missingTools: [],
    }));
    const toolset = createToolsetTool({
      getExtendedTools: () => [{
        name: 'media',
        description: 'Generate, edit, or analyze media.',
        parameters: {} as any,
        execute: vi.fn(),
      }],
      getExtendedToolAutoloadPolicy: () => null,
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: ['media'],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        promotedToolsSkipped: [],
        loadedExtendedTools: [],
        activeTools: [],
        lastSnapshot: null,
      }),
      resolveCapabilityAccess: () => ({
        getTier: () => 'autonomous',
        getGrantedTokens: () => new Set(['identity.read', 'identity.write.runtime', 'external.web']),
        has: () => true,
      }),
      getActiveTurnCorrelation: () => null,
      getActiveTurnTaskKind: () => null,
      getActiveTurnIntent: () => null,
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => [],
      setPromotedExtendedTools: () => [],
      persistPromotedExtendedTools: () => null,
      addPromotedExtendedTool: () => ({
        ok: true,
        changed: false,
        promotedTools: [],
        message: 'noop',
      }),
      removePromotedExtendedTool: () => ({
        ok: true,
        changed: false,
        promotedTools: [],
        message: 'noop',
      }),
      applyActiveToolsToAgent: () => undefined,
      activateExtendedTools,
      resolveSessionChannelId: (channelId: string) => channelId,
      withAdaptiveCorrelation: () => ({}),
      emitAdaptiveToolDecision: () => undefined,
      emitTelemetry: () => undefined,
    } as any);

    const params = {
      action: 'activate',
      tools: [{ name: 'media' }],
    };

    expect(Value.Check((toolset as any).parameters, params)).toBe(true);

    const result = await (toolset as any).execute('toolset-activate-1', params);
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(activateExtendedTools).toHaveBeenCalledWith(['media'], expect.any(Object));
    expect(payload.requestedTools).toEqual(['media']);
    expect(payload.activatedTools).toEqual(['media']);
  });
});
