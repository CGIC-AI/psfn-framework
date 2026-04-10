import { describe, expect, it, vi } from 'vitest';
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
          name: 'notify_operator',
          description: 'Send a lightweight notification.',
          parameters: {} as any,
          execute: vi.fn(),
        } as any,
      ],
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: ['notify_operator'],
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

    const result = await (toolSearch as any).execute('tool-search-2', { query: 'notify_operator', limit: 5 });
    const text = result.content?.[0]?.text as string;
    const match = result.details?.toolSearch?.matches?.[0];

    expect(text).toContain('capability_denied');
    expect(text).toContain('missing: external.web');
    expect(match).toMatchObject({
      name: 'notify_operator',
      status: 'capability_denied',
      missingTokens: ['external.web'],
    });
  });
});

describe('createToolsetTool', () => {
  it('accepts object-form tool names for activate requests', async () => {
    const activateExtendedTools = vi.fn((toolNames: readonly string[]) => ({
      requestedTools: [...toolNames],
      activatedTools: [...toolNames],
      alreadyActiveTools: [],
      missingTools: [],
    }));
    const toolset = createToolsetTool({
      getExtendedTools: () => [{
        name: 'image_edit',
        description: 'Edit an image.',
        parameters: {} as any,
        execute: vi.fn(),
      }],
      getExtendedToolAutoloadPolicy: () => null,
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: ['image_edit'],
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
      tools: [{ name: 'image_edit' }],
    };

    expect(Value.Check((toolset as any).parameters, params)).toBe(true);

    const result = await (toolset as any).execute('toolset-activate-1', params);
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(activateExtendedTools).toHaveBeenCalledWith(['image_edit'], expect.any(Object));
    expect(payload.requestedTools).toEqual(['image_edit']);
    expect(payload.activatedTools).toEqual(['image_edit']);
  });
});
