import { fromAny } from '@total-typescript/shoehorn';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import type { AdaptiveToolRuntimeState } from '../adaptive-tools-telemetry.js';
import { createToolSearchTool, createToolsetTool } from './adaptive-tools-runtime.js';

function capabilityAccess(granted: readonly CapabilityToken[] = []) {
  const tokens = new Set(granted);
  return {
    getTier: () => 'custom' as const,
    getGrantedTokens: () => tokens,
    has: (token: CapabilityToken) => tokens.has(token),
  };
}

function actionTool(name: string, description: string, actions: readonly string[]) {
  return {
    name,
    description,
    parameters: fromAny(Type.Object({
      action: Type.Union(actions.map(action => Type.Literal(action))),
    })),
    execute: vi.fn(),
  };
}

const sessionTool = actionTool(
  'session',
  'Inspect and manage conversation sessions. Use search for prior conversation text.',
  ['list', 'search'],
);
const imageTool = actionTool(
  'generate_image',
  'Generate, edit, or analyze an image. Provide a complete visual prompt for generation.',
  ['generate', 'edit', 'analyze'],
);
const notifyTool = actionTool(
  'notify',
  'Send an external notification. Use brief for an operator-facing summary.',
  ['brief', 'send'],
);

function runtimeState(overrides: Partial<AdaptiveToolRuntimeState> = {}): AdaptiveToolRuntimeState {
  return {
    generatedAt: 1,
    coreTools: ['session'],
    extendedTools: ['generate_image'],
    promotedToolsConfigured: [],
    promotedToolsActive: [],
    promotedToolsSkipped: [],
    activeTools: [
      { toolName: 'session', source: 'core' },
      { toolName: 'generate_image', source: 'extended' },
    ],
    lastSnapshot: null,
    ...overrides,
  };
}

describe('createToolSearchTool', () => {
  it('returns long-form documentation for core and extended tools without changing callability', async () => {
    const emitTelemetry = vi.fn();
    const toolSearch = createToolSearchTool({
      getCoreTools: () => fromAny([sessionTool]),
      getExtendedTools: () => fromAny([imageTool]),
      getToolHealthStatusByName: () => new Map([['generate_image', 'degraded']]),
      resolveCapabilityAccess: () => capabilityAccess(),
      emitTelemetry,
    });

    const result = await (fromAny(toolSearch)).execute('search-1', {
      query: 'image prompt',
      limit: 5,
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload).toMatchObject({
      documentationOnly: true,
      callabilityChanged: false,
      totalMatches: 1,
    });
    expect(payload.tools[0]).toMatchObject({
      name: 'generate_image',
      scope: 'extended',
      capabilityStatus: 'authorized',
      healthStatus: 'degraded',
    });
    expect(payload.tools[0].parameters).toMatchObject({
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          anyOf: [
            { const: 'generate' },
            { const: 'edit' },
            { const: 'analyze' },
          ],
        },
      },
    });
    expect(emitTelemetry).toHaveBeenCalledWith('agent.tools.documentation_search', expect.objectContaining({
      matchedTools: ['generate_image'],
      totalMatches: 1,
    }));
  });

  it('documents capability denial without granting or loading the tool', async () => {
    const access = capabilityAccess(['identity.read']);
    const before = [...access.getGrantedTokens()];
    const toolSearch = createToolSearchTool({
      getCoreTools: () => [],
      getExtendedTools: () => fromAny([notifyTool]),
      getToolHealthStatusByName: () => new Map(),
      resolveCapabilityAccess: () => access,
      emitTelemetry: vi.fn(),
    });

    const result = await (fromAny(toolSearch)).execute('search-2', { query: 'notify' });
    const match = result.details?.toolSearch?.matches?.[0];

    expect(match).toMatchObject({
      name: 'notify',
      scope: 'extended',
      capabilityStatus: 'denied',
      missingTokens: ['external.web', 'external.discord', 'external.email'],
    });
    expect([...access.getGrantedTokens()]).toEqual(before);
  });

  it('never returns retired first-party aliases', async () => {
    const retired = {
      name: 'image_create',
      description: 'Retired image helper.',
      parameters: Type.Object({}),
      execute: vi.fn(),
    };
    const toolSearch = createToolSearchTool({
      getCoreTools: () => [],
      getExtendedTools: () => fromAny([imageTool, retired]),
      getToolHealthStatusByName: () => new Map(),
      resolveCapabilityAccess: () => capabilityAccess(),
      emitTelemetry: vi.fn(),
    });

    const result = await (fromAny(toolSearch)).execute('search-3', { limit: 20 });
    expect(result.details?.toolSearch?.matches.map((match: { name: string }) => match.name))
      .toEqual(['generate_image']);
  });
});

describe('createToolsetTool', () => {
  function createToolset(overrides: Partial<Parameters<typeof createToolsetTool>[0]> = {}) {
    return createToolsetTool({
      getCoreTools: () => fromAny([sessionTool]),
      getExtendedTools: () => fromAny([imageTool]),
      getAdaptiveToolRuntimeState: () => runtimeState(),
      resolveCapabilityAccess: () => capabilityAccess([
        'identity.read',
        'identity.write.runtime',
      ]),
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => [],
      setPromotedExtendedTools: next => [...next],
      persistPromotedExtendedTools: async () => null,
      addPromotedExtendedTool: async toolName => ({
        ok: true,
        changed: true,
        promotedTools: [toolName],
        message: `Pinned ${toolName}.`,
      }),
      removePromotedExtendedTool: async () => ({
        ok: true,
        changed: true,
        promotedTools: [],
        message: 'Unpinned.',
      }),
      applyActiveToolsToAgent: vi.fn(),
      ...overrides,
    });
  }

  it('has no activation action or activation-shaped parameters', () => {
    const toolset = createToolset();

    expect(toolset.description).toContain('already callable without activation');
    expect(Value.Check((fromAny(toolset)).parameters, { action: 'activate', tools: ['generate_image'] }))
      .toBe(false);
    expect(Value.Check((fromAny(toolset)).parameters, { action: 'pin', tool: 'generate_image' }))
      .toBe(true);
    expect((fromAny(toolset)).parameters.properties.tools).toBeUndefined();
  });

  it('lists unpinned extended tools as directly callable', async () => {
    const toolset = createToolset();
    const result = await (fromAny(toolset)).execute('list-1', { action: 'list' });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload).toMatchObject({
      action: 'list',
      allRegisteredToolsCallableWithoutActivation: true,
      pinnedToolOrder: [],
      appliedPinnedToolOrder: [],
    });
    expect(payload.activeTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'session', source: 'core' }),
      expect.objectContaining({ toolName: 'generate_image', source: 'extended' }),
    ]));
    expect(payload.nextStep).toContain('pin/unpin changes ordering only');
  });

  it('suggests an active extended tool without mutating state', async () => {
    const state = runtimeState();
    const addPromotedExtendedTool = vi.fn();
    const applyActiveToolsToAgent = vi.fn();
    const toolset = createToolset({
      getAdaptiveToolRuntimeState: () => state,
      addPromotedExtendedTool,
      applyActiveToolsToAgent,
    });

    const result = await (fromAny(toolset)).execute('suggest-1', {
      action: 'suggest',
      intent: 'generate a new image',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload.recommendations[0]).toMatchObject({
      toolName: 'generate_image',
      action: 'generate',
      availabilityStatus: 'active',
    });
    expect(payload.nextStep).toContain('Call the chosen authorized tool directly');
    expect(addPromotedExtendedTool).not.toHaveBeenCalled();
    expect(applyActiveToolsToAgent).not.toHaveBeenCalled();
    expect(state.activeTools).toEqual(runtimeState().activeTools);
  });

  it('never suggests a capability-denied tool the surface cannot call (bead s3o4)', async () => {
    const access = capabilityAccess(['identity.read']);
    const toolset = createToolset({
      getCoreTools: () => [],
      getExtendedTools: () => fromAny([notifyTool]),
      getAdaptiveToolRuntimeState: () => runtimeState({
        coreTools: [],
        extendedTools: ['notify'],
        activeTools: [{ toolName: 'notify', source: 'extended' }],
      }),
      resolveCapabilityAccess: () => access,
    });

    const result = await (fromAny(toolset)).execute('suggest-2', {
      action: 'suggest',
      intent: 'notify the operator',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    // The tool matches the intent but is not callable for this tier — it must
    // not be advertised. suggestion ⊆ callable catalog.
    expect(payload.recommendations).toEqual([]);
    expect(payload.recommendations.every((r: { availabilityStatus: string }) => r.availabilityStatus === 'active')).toBe(true);
    expect([...access.getGrantedTokens()]).toEqual(['identity.read']);
  });

  it('does not suggest analysis_workbench when repl.execute is denied (bead s3o4)', async () => {
    const workbench = actionTool(
      'analysis_workbench',
      'Run a sandboxed analysis REPL to explore data and execute code.',
      ['execute'],
    );
    const access = capabilityAccess(['identity.read']);
    const toolset = createToolset({
      // Registered as a core tool but repl.execute is absent for this tier, so
      // it is capability-denied and must not be suggested as directly callable.
      getCoreTools: () => fromAny([workbench]),
      getExtendedTools: () => [],
      getAdaptiveToolRuntimeState: () => runtimeState({
        coreTools: ['analysis_workbench'],
        extendedTools: [],
        activeTools: [{ toolName: 'analysis_workbench', source: 'core' }],
      }),
      resolveCapabilityAccess: () => access,
    });

    const result = await (fromAny(toolset)).execute('suggest-workbench', {
      action: 'suggest',
      intent: 'execute code in a sandbox to analyze data',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload.recommendations.map((r: { toolName: string }) => r.toolName)).not.toContain('analysis_workbench');
  });

  it('describes canonical actions and identifies lookup as documentation-only', async () => {
    const toolset = createToolset();
    const result = await (fromAny(toolset)).execute('describe-1', {
      action: 'describe',
      tool: 'generate_image',
    });
    const payload = JSON.parse(result.content?.[0]?.text as string);

    expect(payload).toMatchObject({
      action: 'describe',
      total: 1,
      callabilityChanged: false,
    });
    expect(payload.tools[0]).toMatchObject({
      name: 'generate_image',
      scope: 'extended',
      schema: {
        actions: [
          { name: 'generate', requiredCapabilities: [] },
          { name: 'edit', requiredCapabilities: [] },
          { name: 'analyze', requiredCapabilities: [] },
        ],
        bundleMembership: expect.arrayContaining(['extended', 'toolset.extended', 'domain:media']),
      },
    });
  });

  it('pins and unpins presentation order without an availability result', async () => {
    const addPromotedExtendedTool = vi.fn(async toolName => ({
      ok: true,
      changed: true,
      promotedTools: [toolName],
      message: 'Pinned.',
    }));
    const removePromotedExtendedTool = vi.fn(async () => ({
      ok: true,
      changed: true,
      promotedTools: [],
      message: 'Unpinned.',
    }));
    const toolset = createToolset({ addPromotedExtendedTool, removePromotedExtendedTool });

    const pin = await (fromAny(toolset)).execute('pin-1', {
      action: 'pin',
      tool: 'generate_image',
    });
    const unpin = await (fromAny(toolset)).execute('unpin-1', {
      action: 'unpin',
      tool: 'generate_image',
    });

    expect(JSON.parse(pin.content?.[0]?.text as string)).toMatchObject({
      action: 'pin',
      orderingOnly: true,
      pinnedToolOrder: ['generate_image'],
    });
    expect(JSON.parse(unpin.content?.[0]?.text as string)).toMatchObject({
      action: 'unpin',
      orderingOnly: true,
      pinnedToolOrder: [],
    });
    expect(addPromotedExtendedTool).toHaveBeenCalledWith('generate_image');
    expect(removePromotedExtendedTool).toHaveBeenCalledWith('generate_image');
  });

  it('rejects retired aliases as ordering pins and names the canonical replacement on describe', async () => {
    const addPromotedExtendedTool = vi.fn();
    const toolset = createToolset({ addPromotedExtendedTool });

    const pin = await (fromAny(toolset)).execute('pin-retired', {
      action: 'pin',
      tool: 'media',
    });
    const describe = await (fromAny(toolset)).execute('describe-retired', {
      action: 'describe',
      tool: 'media',
    });

    expect(pin.details?.isError).toBe(true);
    expect(addPromotedExtendedTool).not.toHaveBeenCalled();
    expect(JSON.parse(describe.content?.[0]?.text as string).message).toContain('generate_image');
  });
});
