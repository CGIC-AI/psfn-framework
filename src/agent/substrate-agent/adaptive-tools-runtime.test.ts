import { describe, expect, it, vi } from 'vitest';
import { createToolSearchTool } from './adaptive-tools-runtime.js';

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
      emitTelemetry: () => undefined,
    });

    const result = await (toolSearch as any).execute('tool-search-1', { limit: 5 });
    const text = result.content?.[0]?.text as string;

    expect(text).toContain('generate_image (x) [available, overlay]');
    expect(text).toContain('notify (!) [available, overlay]');
  });
});
