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
          { name: 'generate', requiredCapabilities: ['external.web'] },
          { name: 'edit', requiredCapabilities: ['external.web'] },
          { name: 'analyze', requiredCapabilities: ['external.web'] },
        ],
        requiredParameters: ['action'],
        requiredCapabilities: ['external.web'],
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
