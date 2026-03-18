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

afterEach(() => {
  vi.useRealTimers();
});

describe('ImageService', () => {
  it('uses FAL by default when the provider succeeds', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2') {
        expect(init?.method).toBe('POST');
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
    expect(result.provider).toBe('comfyui');
    expect(result.images[0]?.url).toBe(
      'https://comfy.example.test/view?filename=edited.png&subfolder=&type=output',
    );
  });
});
