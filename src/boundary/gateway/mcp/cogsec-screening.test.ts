import { describe, expect, it, vi } from 'vitest';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import { createMcpCogSecScreeningPort } from './cogsec-screening.js';

function screeningService(): IntakeScreeningService {
  return {
    mode: 'enforce',
    screen: vi.fn(async (text) => ({
      effectiveText: text === 'dynamic' ? '[safe dynamic]' : text,
      withheld: false,
    })) as IntakeScreeningService['screen'],
    screenSync: vi.fn() as IntakeScreeningService['screenSync'],
  };
}

describe('MCP CogSec screening adapter', () => {
  it('classifies server metadata and changing tool output through distinct intake classes', async () => {
    const screening = screeningService();
    const port = createMcpCogSecScreeningPort(companionId => (
      companionId === 'example-person' ? screening : null
    ));

    await expect(port.screenStaticMetadata({
      companionId: 'example-person',
      serverId: 'notes',
      sha256: 'abc123',
      text: 'metadata',
    })).resolves.toEqual({ effectiveText: 'metadata', withheld: false });
    await expect(port.screenDynamicOutput({
      companionId: 'example-person',
      serverId: 'notes',
      toolName: 'search_notes',
      text: 'dynamic',
    })).resolves.toEqual({ effectiveText: '[safe dynamic]', withheld: false });

    expect(screening.screen).toHaveBeenNthCalledWith(1, 'metadata', {
      sourceClass: 'mcp_tool_description',
      origin: { ref: 'mcp:notes:metadata:abc123' },
      scope: 'strict',
    });
    expect(screening.screen).toHaveBeenNthCalledWith(2, 'dynamic', {
      sourceClass: 'tool_output',
      origin: { ref: 'mcp:notes:tool:search_notes' },
      scope: 'strict',
    });
  });
});
