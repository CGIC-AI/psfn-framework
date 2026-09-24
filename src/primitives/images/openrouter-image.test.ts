import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeImageModelRegistry } from '../../system/settings/schema-image-model-registry.js';
import { OpenRouterImageError, resolveOpenRouterImageTarget } from './openrouter-image.js';
import { ImageService, type ImageProviderAttempt } from './service.js';
import type { ImageRuntimeConfig } from './types.js';

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');
const IMAGE_MODEL = 'vendor/image-model-1';
const EDIT_MODEL = 'vendor/image-edit-model-1';

function config(overrides: Partial<ImageRuntimeConfig> = {}): ImageRuntimeConfig {
  return {
    modelRegistry: {
      imageModels: normalizeImageModelRegistry([
        { id: 'or-create', provider: 'openrouter', model: IMAGE_MODEL, modes: ['create'], primary: true },
        { id: 'or-edit', provider: 'openrouter', model: EDIT_MODEL, modes: ['edit'], primary: true },
      ], 'imageModels'),
    },
    providerRegistry: {
      schemaVersion: 1,
      providers: [{
        id: 'openrouter',
        type: 'openrouter',
        enabled: true,
        apiBaseUrl: 'https://openrouter.example.test/api/v1/',
        apiKeyRef: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
      }],
    },
    ...overrides,
  };
}

let dir: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('OpenRouter image provider', () => {
  it('resolves the model from models.json and the credential from providers.json only', () => {
    expect(() => resolveOpenRouterImageTarget(config(), 'create', {}))
      .toThrow(expect.objectContaining({ code: 'IMAGE_PROVIDER_CREDENTIAL_MISSING' }) as Error);
    expect(resolveOpenRouterImageTarget(config(), 'edit', { OPENROUTER_API_KEY: 'test-key' })).toEqual({
      modelId: 'or-edit',
      model: EDIT_MODEL,
      endpoint: 'https://openrouter.example.test/api/v1/images',
      apiKey: 'test-key',
    });
    expect(() => resolveOpenRouterImageTarget(config({ modelRegistry: {} }), 'create', { OPENROUTER_API_KEY: 'k' }))
      .toThrow(expect.objectContaining({ code: 'IMAGE_MODEL_NOT_CONFIGURED' }) as Error);
    const disabled = config();
    disabled.providerRegistry!.providers[0]!.enabled = false;
    expect(() => resolveOpenRouterImageTarget(disabled, 'create', { OPENROUTER_API_KEY: 'k' }))
      .toThrow(expect.objectContaining({ code: 'IMAGE_PROVIDER_NOT_CONFIGURED' }) as Error);
  });

  it('generates, stores inline output once, and records the attempt without a key in the payload', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    dir = mkdtempSync(join(tmpdir(), 'openrouter-image-'));
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({ model: IMAGE_MODEL, prompt: 'a lighthouse', aspect_ratio: '16:9' });
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-openrouter-key');
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64, media_type: 'image/png' }] }), { status: 200 });
    });
    const attempts: ImageProviderAttempt[] = [];
    const service = new ImageService(config(), fetchImpl as unknown as typeof fetch, {
      generatedImagesDir: dir,
      onProviderAttempt: attempt => { attempts.push(attempt); },
    });
    const result = await service.create({ prompt: 'a lighthouse', provider: 'openrouter', aspectRatio: '16:9' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://openrouter.example.test/api/v1/images');
    expect(result).toMatchObject({ provider: 'openrouter', mode: 'create', model: IMAGE_MODEL, fallbackUsed: false });
    const image = result.images[0]!;
    expect(image.url.startsWith('file://')).toBe(true);
    expect(readFileSync(image.localPath!, 'utf8')).toBe('fake-png-bytes');
    const sidecar = readFileSync(`${image.localPath!}.image-meta.json`, 'utf8');
    expect(sidecar).not.toContain(PNG_BASE64);
    expect(existsSync(fileURLToPath(image.url))).toBe(true);
    expect(attempts).toMatchObject([{ provider: 'openrouter', model: IMAGE_MODEL, status: 'success' }]);
  });

  it('edits with input references and rejects Fal catalog models instead of falling back', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe(EDIT_MODEL);
      expect(body.input_references).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64, media_type: 'image/webp' }] }), { status: 200 });
    });
    const service = new ImageService(config(), fetchImpl as unknown as typeof fetch);
    await expect(service.edit({
      prompt: 'same me at the beach', imageUrls: ['data:image/png;base64,AAAA'], provider: 'openrouter',
    })).resolves.toMatchObject({ provider: 'openrouter', mode: 'edit' });

    await expect(service.edit({
      prompt: 'x', imageUrls: ['data:image/png;base64,AAAA'], provider: 'openrouter', model: 'fal-ai/nano-banana-2/edit',
    })).rejects.toMatchObject({ code: 'IMAGE_MODEL_NOT_SUPPORTED' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fails typed without the credential and never spends another provider', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('FAL_API_KEY', 'fal-key-present');
    const fetchImpl = vi.fn();
    const service = new ImageService(config(), fetchImpl as unknown as typeof fetch);
    const error = await service.create({ prompt: 'x', provider: 'openrouter' }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OpenRouterImageError);
    expect((error as OpenRouterImageError).code).toBe('IMAGE_PROVIDER_CREDENTIAL_MISSING');
    expect(fetchImpl).not.toHaveBeenCalled();

    // Settings-selected openrouter behaves identically; auto never picks it.
    const viaSettings = new ImageService(config({ imageProvider: 'openrouter' }), fetchImpl as unknown as typeof fetch);
    await expect(viaSettings.create({ prompt: 'x' })).rejects.toMatchObject({ code: 'IMAGE_PROVIDER_CREDENTIAL_MISSING' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed provider output', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'k');
    const service = new ImageService(config(), (async () => new Response(
      JSON.stringify({ data: [{ b64_json: 'not base64!', media_type: 'image/png' }] }),
      { status: 200 },
    )) as unknown as typeof fetch);
    await expect(service.create({ prompt: 'x', provider: 'openrouter' }))
      .rejects.toMatchObject({ code: 'IMAGE_PROVIDER_RESPONSE_INVALID' });
  });
});

describe('models.json imageModels contract', () => {
  it('rejects unknown keys, bad slugs, and duplicate primaries', () => {
    const base = { id: 'a', provider: 'openrouter', model: IMAGE_MODEL, modes: ['create'], primary: true };
    expect(() => normalizeImageModelRegistry([{ ...base, apiKey: 'x' }], 'imageModels')).toThrow(/unknown key/u);
    expect(() => normalizeImageModelRegistry([{ ...base, model: 'no-slash' }], 'imageModels')).toThrow(/slug/u);
    expect(() => normalizeImageModelRegistry([{ ...base, modes: ['video'] }], 'imageModels')).toThrow(/modes/u);
    expect(() => normalizeImageModelRegistry([base, { ...base, id: 'b' }], 'imageModels')).toThrow(/already has a primary/u);
  });
});

describe('shipped models.json seed', () => {
  it('documents an OpenRouter image model that survives registry normalization', async () => {
    const { readFileSync: read } = await import('node:fs');
    const { normalizeCanonicalModelRegistry } = await import('../../system/settings/schema-model-registry.js');
    const seed = JSON.parse(read(new URL('../../../config/models.seed.json', import.meta.url), 'utf8')) as unknown;
    expect(normalizeCanonicalModelRegistry(seed).imageModels).toEqual([{
      id: 'openrouter-image',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-image',
      modes: ['create', 'edit'],
      primary: true,
    }]);
  });
});
