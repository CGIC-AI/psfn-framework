import { describe, expect, it, vi } from 'vitest';
import { registerMediaTool } from './runtime-wiring.js';

describe('media runtime wiring', () => {
  it('registers a single unified media tool with gateway requirements', () => {
    const registerTool = vi.fn();

    registerMediaTool(
      { registerTool },
      {
        create: vi.fn(),
        edit: vi.fn(),
      },
      {
        gatewayMode: true,
        reviewer: {
          analyze: vi.fn(),
        },
      },
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [tool, exposure] = registerTool.mock.calls[0] ?? [];
    expect(tool?.name).toBe('media');
    expect(exposure).toBe('extended');
    expect(tool?.wiringMeta?.requiredGatewayMethods).toEqual([
      'image.create',
      'image.edit',
      'web.fetch_binary',
    ]);
  });
});
