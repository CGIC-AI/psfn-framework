import { describe, expect, it, vi } from 'vitest';
import { registerImageTools } from './runtime-wiring.js';

describe('media runtime wiring', () => {
  it('registers image tools with gateway requirements', () => {
    const registerTool = vi.fn();

    registerImageTools(
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

    expect(registerTool).toHaveBeenCalledTimes(5);

    const calls = new Map(
      registerTool.mock.calls.map(([tool, exposure]) => [tool.name, { tool, exposure }]),
    );

    expect(calls.get('media')?.exposure).toBe('extended');
    expect(calls.get('media')?.tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'image.create',
      'image.edit',
      'web.fetch_binary',
    ]);
    expect(calls.get('image_create')?.exposure).toBe('extended');
    expect(calls.get('selfie_create')?.tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'image.create',
      'web.fetch_binary',
    ]);
    expect(calls.get('image_edit')?.tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'image.edit',
      'web.fetch_binary',
    ]);
    expect(calls.get('image_analyze')?.tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'web.fetch_binary',
    ]);
  });
});
