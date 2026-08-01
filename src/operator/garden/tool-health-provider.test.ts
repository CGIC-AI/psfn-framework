import { describe, expect, it, vi } from 'vitest';
import { createGatewayAdminToolHealthProvider } from './tool-health-provider.js';

describe('Garden gateway tool health provider', () => {
  it('uses only the existing authenticated companion MCP release boundary', async () => {
    const mcpExecute = vi.fn(async () => ({
      action: 'release' as const,
      serverId: 'notes',
      released: true as const,
    }));
    const provider = createGatewayAdminToolHealthProvider({
      runtimeHealth: vi.fn(async () => ({ checkedAt: 0, services: [] })),
      mcpExecute,
    });

    await expect(provider.releaseMcp?.('notes')).resolves.toEqual({
      released: true,
      serverId: 'notes',
    });
    expect(mcpExecute).toHaveBeenCalledWith(
      { action: 'release', serverId: 'notes' },
      { effectiveSensitivity: 'public' },
    );
  });
});
