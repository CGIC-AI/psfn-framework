import { describe, expect, it, vi } from 'vitest';
import { registerImageTools } from './runtime-wiring.js';

describe('image runtime wiring', () => {
  it('registers selfie_create and generate_image as core tools with gateway requirements', () => {
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

    expect(registerTool).toHaveBeenCalledTimes(2);

    const calls = new Map(
      registerTool.mock.calls.map(([tool, exposure]) => [tool.name, { tool, exposure }]),
    );

    // Both image tools are part of the default core stack (top-level, always
    // active) — not extended tools hidden behind toolset activation.
    expect(calls.get('generate_image')?.exposure).toBe('core');
    expect(calls.get('generate_image')?.tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'image.create',
      'image.edit',
      'web.fetch_binary',
    ]);
    expect(calls.get('selfie_create')?.exposure).toBe('core');
    expect(calls.get('selfie_create')?.tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'image.create',
      'image.edit',
      'web.fetch_binary',
    ]);
    // The selfie tool registers before generic generation.
    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      'selfie_create',
      'generate_image',
    ]);
    // The retired names never register.
    expect(calls.get('media')).toBeUndefined();
    expect(calls.get('image_create')).toBeUndefined();
    expect(calls.get('image_edit')).toBeUndefined();
    expect(calls.get('image_analyze')).toBeUndefined();
  });
});
