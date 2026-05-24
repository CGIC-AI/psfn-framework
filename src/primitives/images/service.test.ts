import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageService } from './service.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function binaryResponse(body: Uint8Array, contentType = 'image/png'): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
    },
  });
}

function createCompletedFalGenerationFetchMock(
  endpoint: string,
  requestId: string,
  assertBody: (body: Record<string, unknown>) => void,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `https://queue.fal.run/${endpoint}`) {
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      assertBody(body);
      return jsonResponse({
        status: 'COMPLETED',
        request_id: requestId,
        response_url: `https://queue.fal.run/${endpoint}/requests/${requestId}`,
      });
    }

    if (url === `https://queue.fal.run/${endpoint}/requests/${requestId}`) {
      return jsonResponse({
        images: [
          {
            url: `https://cdn.example.test/${requestId}.png`,
            content_type: 'image/png',
            file_name: `${requestId}.png`,
          },
        ],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ImageService', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('uses FAL by default when the provider succeeds', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.resolution).toBe('2K');
        expect(body.enable_safety_checker).toBe(false);
        expect(body.safety_tolerance).toBe('6');
        return jsonResponse({
          status: 'COMPLETED',
          request_id: 'fal-req-1',
          response_url: 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-req-1',
        });
      }

      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-req-1') {
        return jsonResponse({
          images: [
            {
              url: 'https://cdn.example.test/output.png',
              content_type: 'image/png',
              file_name: 'output.png',
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'a lighthouse at dusk',
    });

    expect(result).toEqual({
      provider: 'fal',
      mode: 'create',
      model: 'fal-ai/nano-banana-2',
      fallbackUsed: false,
      requestId: 'fal-req-1',
      images: [
        {
          url: 'https://cdn.example.test/output.png',
          contentType: 'image/png',
          fileName: 'output.png',
        },
      ],
    });
  });

  it('retries transient FAL fetch failures once before surfacing an image failure', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2') {
        if (fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl) === url).length === 1) {
          throw new TypeError('fetch failed');
        }
        return jsonResponse({
          status: 'COMPLETED',
          request_id: 'fal-retry-1',
          response_url: 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-retry-1',
        });
      }

      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-retry-1') {
        return jsonResponse({
          images: [
            {
              url: 'https://cdn.example.test/retry.png',
              content_type: 'image/png',
              file_name: 'retry.png',
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'a lighthouse at dusk',
    });

    expect(result.requestId).toBe('fal-retry-1');
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === 'https://queue.fal.run/fal-ai/nano-banana-2')).toHaveLength(2);
  });

  it('persists generated outputs into the companion images directory when companion storage is configured', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-image-service-'));
    tempDirs.push(companionDataDir);
    const imageBytes = Uint8Array.from([1, 2, 3, 4]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2') {
        expect(init?.method).toBe('POST');
        return jsonResponse({
          status: 'COMPLETED',
          request_id: 'fal-req-storage-1',
          response_url: 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-req-storage-1',
        });
      }

      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-req-storage-1') {
        return jsonResponse({
          images: [
            {
              url: 'https://cdn.example.test/output-storage.png',
              content_type: 'image/png',
              file_name: 'output-storage.png',
            },
          ],
        });
      }

      if (url === 'https://cdn.example.test/output-storage.png') {
        return binaryResponse(imageBytes);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
        companionDataDir,
        systemDataDir: join(companionDataDir, '..', 'system-data'),
      } as any,
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'a lighthouse at dusk',
    });

    expect(result.images[0]?.localPath).toBeTruthy();
    expect(existsSync(result.images[0]!.localPath!)).toBe(true);
    expect(readFileSync(result.images[0]!.localPath!)).toEqual(Buffer.from(imageBytes));
  });

  it('persists generated images under the personal files root when configured', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-image-companion-'));
    const personalFilesDir = mkdtempSync(join(tmpdir(), 'psfn-image-personal-'));
    tempDirs.push(companionDataDir, personalFilesDir);
    const imageBytes = Uint8Array.from([137, 80, 78, 71, 2]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2') {
        return jsonResponse({ request_id: 'fal-req-personal-1' });
      }
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-req-personal-1/status') {
        return jsonResponse({
          status: 'COMPLETED',
          response_url: 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-req-personal-1',
        });
      }
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2/requests/fal-req-personal-1') {
        return jsonResponse({
          images: [
            {
              url: 'https://cdn.example.test/output-personal.png',
              content_type: 'image/png',
              file_name: 'output-personal.png',
            },
          ],
        });
      }
      if (url === 'https://cdn.example.test/output-personal.png') {
        return binaryResponse(imageBytes);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
        companionDataDir,
        systemDataDir: join(companionDataDir, '..', 'system-data'),
      } as any,
      fetchMock as typeof fetch,
      { personalFilesDir },
    );

    const result = await service.create({
      prompt: 'a lighthouse at dusk',
    });

    expect(result.images[0]?.localPath).toContain(join(personalFilesDir, 'images'));
    expect(existsSync(result.images[0]!.localPath!)).toBe(true);
    expect(readFileSync(result.images[0]!.localPath!)).toEqual(Buffer.from(imageBytes));
  });

  it('maps Flux 2 generation options to the FAL payload', async () => {
    const fetchMock = createCompletedFalGenerationFetchMock(
      'fal-ai/flux-2',
      'fal-flux-2',
      (body) => {
        expect(body).toMatchObject({
          prompt: 'cinematic portrait in golden hour light',
          sync_mode: false,
          num_images: 2,
          seed: 7,
          output_format: 'jpeg',
          guidance_scale: 4,
          num_inference_steps: 28,
          acceleration: 'regular',
          enable_prompt_expansion: true,
          enable_safety_checker: false,
        });
        expect(body.image_size).toEqual({
          width: 1536,
          height: 1024,
        });
        expect(body).not.toHaveProperty('aspect_ratio');
      },
    );

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'cinematic portrait in golden hour light',
      model: 'fal-ai/flux-2',
      numImages: 2,
      width: 1536,
      height: 1024,
      outputFormat: 'jpeg',
      seed: 7,
      guidanceScale: 4,
      numInferenceSteps: 28,
      acceleration: 'regular',
      enablePromptExpansion: true,
    });

    expect(result.model).toBe('fal-ai/flux-2');
    expect(result.requestId).toBe('fal-flux-2');
  });

  it('maps Nano Banana Pro generation options to the FAL payload', async () => {
    const fetchMock = createCompletedFalGenerationFetchMock(
      'fal-ai/nano-banana-pro',
      'fal-nano-banana-pro',
      (body) => {
        expect(body).toMatchObject({
          prompt: 'high-fashion portrait with dramatic lighting',
          sync_mode: false,
          num_images: 1,
          output_format: 'png',
          enable_safety_checker: false,
          aspect_ratio: '4:5',
          resolution: '4K',
          safety_tolerance: '6',
        });
      },
    );

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'high-fashion portrait with dramatic lighting',
      model: 'fal-ai/nano-banana-pro',
      numImages: 1,
      aspectRatio: '4:5',
      resolution: '4K',
      outputFormat: 'png',
    });

    expect(result.model).toBe('fal-ai/nano-banana-pro');
    expect(result.requestId).toBe('fal-nano-banana-pro');
  });

  it('filters unsupported options from Flux 2 Pro generation payloads', async () => {
    const fetchMock = createCompletedFalGenerationFetchMock(
      'fal-ai/flux-2-pro',
      'fal-flux-2-pro',
      (body) => {
        expect(body).toMatchObject({
          prompt: 'editorial product shot on marble',
          sync_mode: false,
          seed: 11,
          output_format: 'png',
          enable_safety_checker: true,
          image_size: 'landscape_16_9',
        });
        expect(body).not.toHaveProperty('guidance_scale');
        expect(body).not.toHaveProperty('num_inference_steps');
        expect(body).not.toHaveProperty('acceleration');
        expect(body).not.toHaveProperty('enable_prompt_expansion');
      },
    );

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'editorial product shot on marble',
      model: 'fal-ai/flux-2-pro',
      aspectRatio: '16:9',
      outputFormat: 'png',
      seed: 11,
      guidanceScale: 5,
      numInferenceSteps: 20,
      acceleration: 'regular',
      enablePromptExpansion: true,
      enableSafetyChecker: true,
    });

    expect(result.model).toBe('fal-ai/flux-2-pro');
    expect(result.requestId).toBe('fal-flux-2-pro');
  });

  it('maps Z-Image Base generation options to the FAL payload', async () => {
    const fetchMock = createCompletedFalGenerationFetchMock(
      'fal-ai/z-image/base',
      'fal-z-image-base',
      (body) => {
        expect(body).toMatchObject({
          prompt: 'minimal poster with bold geometric forms',
          sync_mode: false,
          num_images: 1,
          guidance_scale: 6,
          num_inference_steps: 24,
          acceleration: 'regular',
          negative_prompt: 'text, watermark',
          enable_safety_checker: false,
          image_size: 'square_hd',
        });
      },
    );

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'minimal poster with bold geometric forms',
      model: 'fal-ai/z-image/base',
      numImages: 1,
      aspectRatio: '1:1',
      guidanceScale: 6,
      numInferenceSteps: 24,
      acceleration: 'regular',
      negativePrompt: 'text, watermark',
    });

    expect(result.model).toBe('fal-ai/z-image/base');
    expect(result.requestId).toBe('fal-z-image-base');
  });

  it('maps Qwen Image 2 generation options to the FAL payload', async () => {
    const fetchMock = createCompletedFalGenerationFetchMock(
      'fal-ai/qwen-image-2/text-to-image',
      'fal-qwen-image-2',
      (body) => {
        expect(body).toMatchObject({
          prompt: 'clean anime-style character sheet',
          sync_mode: false,
          num_images: 3,
          seed: 19,
          output_format: 'png',
          enable_prompt_expansion: true,
          enable_safety_checker: true,
          negative_prompt: 'blurry, low detail',
          image_size: 'portrait_4_3',
        });
        expect(body).not.toHaveProperty('guidance_scale');
        expect(body).not.toHaveProperty('num_inference_steps');
        expect(body).not.toHaveProperty('use_turbo');
      },
    );

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'clean anime-style character sheet',
      model: 'fal-ai/qwen-image-2/text-to-image',
      numImages: 3,
      aspectRatio: '3:4',
      outputFormat: 'png',
      seed: 19,
      negativePrompt: 'blurry, low detail',
      enablePromptExpansion: true,
      enableSafetyChecker: true,
      guidanceScale: 8,
      numInferenceSteps: 30,
      useTurbo: true,
    });

    expect(result.model).toBe('fal-ai/qwen-image-2/text-to-image');
    expect(result.requestId).toBe('fal-qwen-image-2');
  });

  it('maps Grok Imagine generation options to the FAL payload', async () => {
    const fetchMock = createCompletedFalGenerationFetchMock(
      'xai/grok-imagine-image',
      'fal-grok-imagine',
      (body) => {
        expect(body).toMatchObject({
          prompt: 'surreal fashion editorial with chrome accents',
          sync_mode: false,
          num_images: 1,
          output_format: 'webp',
          aspect_ratio: '9:16',
        });
        expect(body).not.toHaveProperty('image_size');
        expect(body).not.toHaveProperty('enable_safety_checker');
      },
    );

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.create({
      prompt: 'surreal fashion editorial with chrome accents',
      model: 'xai/grok-imagine-image',
      numImages: 1,
      aspectRatio: '9:16',
      outputFormat: 'webp',
    });

    expect(result.model).toBe('xai/grok-imagine-image');
    expect(result.requestId).toBe('fal-grok-imagine');
  });

  it('defaults FAL nano-banana edits to 2K resolution', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2/edit') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.resolution).toBe('2K');
        expect(body).not.toHaveProperty('enable_safety_checker');
        expect(body.safety_tolerance).toBe('6');
        expect(body.limit_generations).toBe(true);
        expect(body.image_urls).toEqual(['https://example.test/source.png']);
        return jsonResponse({
          status: 'COMPLETED',
          request_id: 'fal-edit-req-1',
          response_url: 'https://queue.fal.run/fal-ai/nano-banana-2/edit/requests/fal-edit-req-1',
        });
      }

      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2/edit/requests/fal-edit-req-1') {
        return jsonResponse({
          images: [
            {
              url: 'https://cdn.example.test/edited.png',
              content_type: 'image/png',
              file_name: 'edited.png',
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.edit({
      prompt: 'turn this into a sunset selfie',
      imageUrls: ['https://example.test/source.png'],
    });

    expect(result).toEqual({
      provider: 'fal',
      mode: 'edit',
      model: 'fal-ai/nano-banana-2/edit',
      fallbackUsed: false,
      requestId: 'fal-edit-req-1',
      images: [
        {
          url: 'https://cdn.example.test/edited.png',
          contentType: 'image/png',
          fileName: 'edited.png',
        },
      ],
    });
  });

  it('does not send nano-banana edit fields to GPT image edits', async () => {
    const fetchMock = createCompletedFalGenerationFetchMock(
      'fal-ai/gpt-image-1.5/edit',
      'fal-gpt-edit-1',
      (body) => {
        expect(body).toEqual({
          prompt: 'add a blue scarf',
          image_urls: ['https://example.test/source.png'],
          sync_mode: false,
          image_size: '1024x1024',
          background: 'auto',
          input_fidelity: 'high',
          output_format: 'png',
          mask_image_url: 'https://example.test/mask.png',
          num_images: 1,
        });
      },
    );

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
      },
      fetchMock as typeof fetch,
    );

    const result = await service.edit({
      prompt: 'add a blue scarf',
      imageUrls: ['https://example.test/source.png'],
      model: 'fal-ai/gpt-image-1.5/edit',
      imageSize: '1024x1024',
      background: 'auto',
      inputFidelity: 'high',
      outputFormat: 'png',
      maskImageUrl: 'https://example.test/mask.png',
      numImages: 1,
      seed: 123,
      aspectRatio: '1:1',
      resolution: '2K',
    });

    expect(result.model).toBe('fal-ai/gpt-image-1.5/edit');
    expect(result.requestId).toBe('fal-gpt-edit-1');
  });

  it('falls back to a configured ComfyUI create workflow on FAL content-policy failures', async () => {
    vi.useFakeTimers();

    let comfyPromptBody: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2') {
        return jsonResponse(
          { error: 'content policy violation' },
          { status: 422 },
        );
      }

      if (url === 'https://comfy.example.test/prompt') {
        comfyPromptBody = String(init?.body ?? '');
        return jsonResponse({ prompt_id: 'comfy-1' });
      }

      if (url === 'https://comfy.example.test/history/comfy-1') {
        return jsonResponse({
          'comfy-1': {
            status: {
              status_str: 'success',
              completed: true,
            },
            outputs: {
              '9': {
                images: [
                  {
                    filename: 'fallback.png',
                    subfolder: '',
                    type: 'output',
                  },
                ],
              },
            },
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        falApiKey: 'fal-key',
        comfyUiBaseUrl: 'https://comfy.example.test',
        imageWorkflows: {
          comfyUi: {
            create: {
              workflow: {
                '1': {
                  class_type: 'PromptEcho',
                  inputs: {
                    text: '{{prompt}}',
                  },
                },
              },
            },
          },
        },
      },
      fetchMock as typeof fetch,
    );

    const resultPromise = service.create({
      prompt: 'forbidden lighthouse',
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(comfyPromptBody).toContain('forbidden lighthouse');
    expect(result).toEqual({
      provider: 'comfyui',
      mode: 'create',
      model: 'configured:create',
      fallbackUsed: true,
      fallbackReason: 'fal_content_policy_422',
      requestId: 'comfy-1',
      images: [
        {
          url: 'https://comfy.example.test/view?filename=fallback.png&subfolder=&type=output',
          fileName: 'fallback.png',
        },
      ],
    });
  });

  it('renders configured ComfyUI edit workflows with uploaded input images', async () => {
    vi.useFakeTimers();

    let submitBody = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === 'https://example.test/input.png') {
        return binaryResponse(new Uint8Array([1, 2, 3, 4]));
      }

      if (url === 'https://comfy.example.test/upload/image') {
        return jsonResponse({
          name: 'uploaded-input.png',
          subfolder: '',
          type: 'input',
        });
      }

      if (url === 'https://comfy.example.test/prompt') {
        submitBody = String(init?.body ?? '');
        return jsonResponse({ prompt_id: 'comfy-edit-1' });
      }

      if (url === 'https://comfy.example.test/history/comfy-edit-1') {
        return jsonResponse({
          'comfy-edit-1': {
            status: {
              status_str: 'success',
              completed: true,
            },
            outputs: {
              '4': {
                images: [
                  {
                    filename: 'edited.png',
                    subfolder: '',
                    type: 'output',
                  },
                ],
              },
            },
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        comfyUiBaseUrl: 'https://comfy.example.test',
        webFetchDnsResolver: vi.fn(async () => ({ address: '93.184.216.34', family: 4 })),
        imageWorkflows: {
          comfyUi: {
            edit: {
              workflow: {
                '1': {
                  class_type: 'LoadImage',
                  inputs: {
                    image: '{{input_image_1}}',
                  },
                },
                '2': {
                  class_type: 'TextEncode',
                  inputs: {
                    text: '{{prompt}}',
                    width: '{{width}}',
                    height: '{{height}}',
                    resolution: '{{resolution}}',
                  },
                },
              },
            },
          },
        },
      },
      fetchMock as typeof fetch,
    );

    const resultPromise = service.edit({
      provider: 'comfyui',
      prompt: 'turn the chair blue',
      imageUrls: ['https://example.test/input.png'],
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(submitBody).toContain('uploaded-input.png');
    expect(submitBody).toContain('turn the chair blue');
    expect(submitBody).toContain('"width":2048');
    expect(submitBody).toContain('"height":2048');
    expect(submitBody).toContain('"resolution":"2K"');
    expect(result.provider).toBe('comfyui');
    expect(result.images[0]?.url).toBe(
      'https://comfy.example.test/view?filename=edited.png&subfolder=&type=output',
    );
  });

  it('blocks ComfyUI remote image downloads that resolve to private IPs before fetching', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be called for a blocked private IP');
    });

    const service = new ImageService(
      {
        comfyUiBaseUrl: 'https://comfy.example.test',
        imageWorkflows: {
          comfyUi: {
            edit: {
              workflow: {
                '1': {
                  class_type: 'LoadImage',
                  inputs: {
                    image: '{{input_image_1}}',
                  },
                },
              },
            },
          },
        },
        webFetchDnsResolver: vi.fn(async () => ({ address: '127.0.0.1', family: 4 })),
      },
      fetchMock as typeof fetch,
    );

    await expect(service.edit({
      provider: 'comfyui',
      prompt: 'turn the chair blue',
      imageUrls: ['https://example.test/input.png'],
    })).rejects.toThrow('DNS resolved example.test to private IP 127.0.0.1');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks ComfyUI remote image redirects to private IPs', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://example.test/input.png') {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://127.0.0.1/blocked.png',
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        comfyUiBaseUrl: 'https://comfy.example.test',
        imageWorkflows: {
          comfyUi: {
            edit: {
              workflow: {
                '1': {
                  class_type: 'LoadImage',
                  inputs: {
                    image: '{{input_image_1}}',
                  },
                },
              },
            },
          },
        },
        webFetchDnsResolver: vi.fn(async (hostname: string) => {
          if (hostname === 'example.test') {
            return { address: '93.184.216.34', family: 4 };
          }
          return { address: '127.0.0.1', family: 4 };
        }),
      },
      fetchMock as typeof fetch,
    );

    await expect(service.edit({
      provider: 'comfyui',
      prompt: 'turn the chair blue',
      imageUrls: ['https://example.test/input.png'],
    })).rejects.toThrow('URL blocked: Private IP 127.0.0.1 blocked');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized ComfyUI remote image downloads before buffering the body', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://example.test/input.png') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': '99999999',
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        comfyUiBaseUrl: 'https://comfy.example.test',
        imageWorkflows: {
          comfyUi: {
            edit: {
              workflow: {
                '1': {
                  class_type: 'LoadImage',
                  inputs: {
                    image: '{{input_image_1}}',
                  },
                },
              },
            },
          },
        },
        webFetchDnsResolver: vi.fn(async () => ({ address: '93.184.216.34', family: 4 })),
      },
      fetchMock as typeof fetch,
    );

    await expect(service.edit({
      provider: 'comfyui',
      prompt: 'turn the chair blue',
      imageUrls: ['https://example.test/input.png'],
    })).rejects.toThrow('Remote image fetch exceeded 8388608 bytes (99999999 reported)');
  });

  it('rejects ComfyUI remote image downloads with non-image content types', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://example.test/input.png') {
        return new Response('<html>not an image</html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const service = new ImageService(
      {
        comfyUiBaseUrl: 'https://comfy.example.test',
        imageWorkflows: {
          comfyUi: {
            edit: {
              workflow: {
                '1': {
                  class_type: 'LoadImage',
                  inputs: {
                    image: '{{input_image_1}}',
                  },
                },
              },
            },
          },
        },
        webFetchDnsResolver: vi.fn(async () => ({ address: '93.184.216.34', family: 4 })),
      },
      fetchMock as typeof fetch,
    );

    await expect(service.edit({
      provider: 'comfyui',
      prompt: 'turn the chair blue',
      imageUrls: ['https://example.test/input.png'],
    })).rejects.toThrow('Remote image fetch returned non-image content type text/html');
  });
});
