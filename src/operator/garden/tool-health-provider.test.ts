import { describe, expect, it, vi } from 'vitest';
import { createGatewayAdminToolHealthProvider } from './tool-health-provider.js';

describe('Garden gateway tool health provider', () => {
  it('uses only the existing authenticated companion MCP release boundary', async () => {
    const mcpRelease = vi.fn(async () => ({
      serverId: 'notes',
      released: true as const,
    }));
    const provider = createGatewayAdminToolHealthProvider({
      runtimeHealth: vi.fn(async () => ({ checkedAt: 0, services: [] })),
      mcpRelease,
    });

    await expect(provider.releaseMcp?.('notes')).resolves.toEqual({
      released: true,
      serverId: 'notes',
    });
    expect(mcpRelease).toHaveBeenCalledWith('notes');
  });
});
