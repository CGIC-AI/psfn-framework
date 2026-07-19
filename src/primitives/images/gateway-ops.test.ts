import { describe, expect, it, vi } from 'vitest';
import { GatewayImageOps } from './gateway-ops.js';

describe('GatewayImageOps', () => {
  it('carries per-companion settings defaults across create and edit RPC calls', async () => {
    const gateway = {
      imageCreate: vi.fn(async () => ({
        provider: 'fal' as const,
        mode: 'create' as const,
        fallbackUsed: false,
        images: [],
      })),
      imageEdit: vi.fn(async () => ({
        provider: 'fal' as const,
        mode: 'edit' as const,
        fallbackUsed: false,
        images: [],
      })),
    };
    const ops = new GatewayImageOps(gateway, () => ({
      provider: 'fal',
      createModel: 'fal-ai/nano-banana-2',
      editModel: 'xai/grok-imagine-image/quality/edit',
    }));

    await ops.create({ prompt: 'create' });
    await ops.edit({ prompt: 'edit', imageUrls: ['https://images.example.test/source.png'] });

    expect(gateway.imageCreate).toHaveBeenCalledWith(expect.objectContaining({
      settingsDefaults: {
        provider: 'fal',
        model: 'fal-ai/nano-banana-2',
      },
    }));
    expect(gateway.imageEdit).toHaveBeenCalledWith(expect.objectContaining({
      settingsDefaults: {
        provider: 'fal',
        model: 'xai/grok-imagine-image/quality/edit',
      },
    }));
  });

  it('keeps explicit call selections separate from settings defaults', async () => {
    const gateway = {
      imageCreate: vi.fn(async () => ({
        provider: 'fal' as const,
        mode: 'create' as const,
        fallbackUsed: false,
        images: [],
      })),
      imageEdit: vi.fn(),
    };
    const ops = new GatewayImageOps(gateway, () => ({
      provider: 'comfyui',
      createModel: 'fal-ai/nano-banana-2',
    }));

    await ops.create({
      prompt: 'explicit',
      provider: 'fal',
      model: 'xai/grok-imagine-image',
    });

    expect(gateway.imageCreate).toHaveBeenCalledWith({
      prompt: 'explicit',
      provider: 'fal',
      model: 'xai/grok-imagine-image',
      settingsDefaults: {
        provider: 'comfyui',
        model: 'fal-ai/nano-banana-2',
      },
    });
  });

  it('resolves settings defaults for every request instead of retaining a startup snapshot', async () => {
    const gateway = {
      imageCreate: vi.fn(async () => ({
        provider: 'fal' as const,
        mode: 'create' as const,
        fallbackUsed: false,
        images: [],
      })),
      imageEdit: vi.fn(),
    };
    let provider: 'fal' | 'comfyui' = 'fal';
    const ops = new GatewayImageOps(gateway, () => ({
      provider,
      createModel: 'xai/grok-imagine-image',
    }));

    await ops.create({ prompt: 'before Garden save' });
    provider = 'comfyui';
    await ops.create({ prompt: 'after Garden save' });

    expect(gateway.imageCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      settingsDefaults: expect.objectContaining({ provider: 'fal' }),
    }));
    expect(gateway.imageCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      settingsDefaults: expect.objectContaining({ provider: 'comfyui' }),
    }));
  });

  it('preserves a tool-call settings snapshot without resolving a second time', async () => {
    const gateway = {
      imageCreate: vi.fn(async () => ({
        provider: 'fal' as const,
        mode: 'create' as const,
        fallbackUsed: false,
        images: [],
      })),
      imageEdit: vi.fn(),
    };
    const resolver = vi.fn(() => ({ provider: 'comfyui' as const }));
    const ops = new GatewayImageOps(gateway, resolver);

    await ops.create({
      prompt: 'snapshot',
      settingsDefaults: { provider: 'fal' },
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(gateway.imageCreate).toHaveBeenCalledWith(expect.objectContaining({
      settingsDefaults: { provider: 'fal' },
    }));
  });
});
