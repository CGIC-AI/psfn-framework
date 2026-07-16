import { describe, expect, it, vi } from 'vitest';
import { FalImageClient } from './fal.js';
import { ComfyUiImageClient } from './comfyui.js';
import type { ImageRuntimeConfig } from './types.js';

// Wiring proofs (bead zet.7): operator-set image polling settings must reach
// the live poll loops. ImageService passes its ImageRuntimeConfig into
// FalImageClient (service.ts) and ComfyUiImageClient already receives it;
// the gateway passes the full SubstrateConfig as the ImageRuntimeConfig
// (privileged-core.ts `imageConfig: input.config`), so the same-named
// SubstrateConfig fields flow through structurally.

describe('FalImageClient — polling settings wiring (zet.7)', () => {
  it('resolves operator-set timeout and poll interval from runtime config', () => {
    const client = new FalImageClient('key', fetch, {
      imageFalTimeoutMs: 42_000,
      imageFalPollIntervalMs: 250,
    });
    expect(client.timeoutMs).toBe(42_000);
    expect(client.pollIntervalMs).toBe(250);
  });

  it('preserves compiled defaults exactly when unset', () => {
    const client = new FalImageClient('key');
    expect(client.timeoutMs).toBe(300_000);
    expect(client.pollIntervalMs).toBe(1_500);
  });

  it('times out queue polling at the operator-set cap (behavior proof)', async () => {
    // Submit returns a queued request; every status poll stays IN_PROGRESS.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          status: 'IN_QUEUE',
          request_id: 'req-1',
          status_url: 'https://queue.fal.run/fal-ai/test-model/requests/req-1/status',
        }), { headers: { 'content-type': 'application/json' } });
      }
      void input;
      return new Response(JSON.stringify({ status: 'IN_PROGRESS' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new FalImageClient('key', fetchImpl, {
      imageFalTimeoutMs: 30,
      imageFalPollIntervalMs: 1,
    });

    await expect(client.create({ prompt: 'a cat' })).rejects.toThrow(
      /timed out after 30ms/,
    );
  });
});

describe('ComfyUiImageClient — polling settings wiring (zet.7)', () => {
  const workflows = { comfyUi: {} };

  it('resolves operator-set timeout and poll interval from runtime config', () => {
    const config: ImageRuntimeConfig = {
      imageComfyTimeoutMs: 55_000,
      imageComfyPollIntervalMs: 500,
    };
    const client = new ComfyUiImageClient('http://127.0.0.1:8188', workflows, config);
    expect(client.timeoutMs).toBe(55_000);
    expect(client.pollIntervalMs).toBe(500);
  });

  it('preserves compiled defaults exactly when unset', () => {
    const client = new ComfyUiImageClient('http://127.0.0.1:8188', workflows, {});
    expect(client.timeoutMs).toBe(180_000);
    expect(client.pollIntervalMs).toBe(1_500);
  });
});
