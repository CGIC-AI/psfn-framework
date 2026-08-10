import assert from "node:assert/strict";
import test from "node:test";

import {
  FalImageProvider,
  FalImageProviderError,
  type FalImageGenerationResult,
} from "./fal-provider.js";

test("FAL text-to-image request uses direct REST URL, key header, and JSON body", async () => {
  const secret = "fal-test-secret";
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  let capturedBody: Record<string, unknown> = {};

  const provider = new FalImageProvider({
    apiKey: secret,
    now: () => new Date("2026-05-11T12:00:00.000Z"),
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        request_id: "req-text",
        images: [
          {
            url: "https://cdn.example.test/sprite.png",
            width: 512,
            height: 512,
            content_type: "image/png",
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await provider.generateTextToImage({
    modelId: "fal-ai/test-text-model",
    prompt: "sprite face, neutral expression",
    seed: 42,
    options: {
      image_size: "square_hd",
      num_images: 1,
    },
    provenance: {
      source: "test-fixture",
      label: "unit test",
    },
  });

  assert.equal(capturedUrl, "https://fal.run/fal-ai/test-text-model");
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Key ${secret}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(capturedBody, {
    image_size: "square_hd",
    num_images: 1,
    prompt: "sprite face, neutral expression",
    seed: 42,
  });
  assert.deepEqual(result, {
    provider: "fal",
    modelId: "fal-ai/test-text-model",
    generatedAt: "2026-05-11T12:00:00.000Z",
    prompt: "sprite face, neutral expression",
    seed: 42,
    options: {
      image_size: "square_hd",
      num_images: 1,
    },
    requestId: "req-text",
    images: [
      {
        url: "https://cdn.example.test/sprite.png",
        width: 512,
        height: 512,
        contentType: "image/png",
      },
    ],
    provenance: {
      source: "test-fixture",
      label: "unit test",
    },
    source: {
      mode: "text-to-image",
    },
  } satisfies FalImageGenerationResult);
  assert(!JSON.stringify(result).includes(secret));
});

test("FAL image-to-image request serializes source image URLs without leaking the key", async () => {
  const secret = "fal-image-secret";
  let capturedBody: Record<string, unknown> = {};

  const provider = new FalImageProvider({
    apiKey: secret,
    modelIds: {
      "image-to-image": "fal-ai/test-edit-model",
    },
    fetch: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Response.json({
        requestId: "req-image",
        images: [
          "https://cdn.example.test/generated-a.webp",
          {
            url: "https://cdn.example.test/generated-b.webp",
            width: 640,
            height: 480,
            contentType: "image/webp",
          },
        ],
      });
    },
  });

  const result = await provider.generateImageToImage({
    prompt: "convert source into a pixel sprite sheet",
    imageUrls: [
      "https://assets.example.test/source-a.png",
      "https://assets.example.test/source-b.png",
    ],
    options: {
      strength: 0.65,
    },
  });

  assert.deepEqual(capturedBody, {
    strength: 0.65,
    prompt: "convert source into a pixel sprite sheet",
    image_urls: [
      "https://assets.example.test/source-a.png",
      "https://assets.example.test/source-b.png",
    ],
  });
  assert.equal(result.modelId, "fal-ai/test-edit-model");
  assert.equal(result.requestId, "req-image");
  assert.deepEqual(result.images, [
    { url: "https://cdn.example.test/generated-a.webp" },
    {
      url: "https://cdn.example.test/generated-b.webp",
      width: 640,
      height: 480,
      contentType: "image/webp",
    },
  ]);
  assert.deepEqual(result.source, {
    mode: "image-to-image",
    imageUrls: [
      "https://assets.example.test/source-a.png",
      "https://assets.example.test/source-b.png",
    ],
  });
  assert(!JSON.stringify(result).includes(secret));
});

test("FAL edit request sends image_urls array and supports top-level image response", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};

  const provider = new FalImageProvider({
    apiKey: "fal-edit-secret",
    modelIds: {
      edit: "/fal-ai/test-inpaint-model",
    },
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Response.json({
        image: {
          href: "https://cdn.example.test/edited.png",
          content_type: "image/png",
        },
      }, {
        headers: { "x-fal-request-id": "req-edit" },
      });
    },
  });

  const result = await provider.editImage({
    prompt: "make the eyes happy",
    imageUrl: "https://assets.example.test/source.png",
  });

  assert.equal(capturedUrl, "https://fal.run/fal-ai/test-inpaint-model");
  assert.deepEqual(capturedBody, {
    prompt: "make the eyes happy",
    image_urls: ["https://assets.example.test/source.png"],
  });
  assert.equal(result.requestId, "req-edit");
  assert.deepEqual(result.images, [
    {
      url: "https://cdn.example.test/edited.png",
      contentType: "image/png",
    },
  ]);
});

test("FAL provider reads the runtime FAL_KEY environment variable", async () => {
  const originalFalKey = process.env.FAL_KEY;
  const secret = "fal-env-secret";
  process.env.FAL_KEY = secret;
  let capturedHeaders: Record<string, string> = {};

  const provider = new FalImageProvider({
    fetch: async (_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Response.json({
        images: ["https://cdn.example.test/env.png"],
      });
    },
  });

  try {
    const result = await provider.generateTextToImage({
      modelId: "fal-ai/test-model",
      prompt: "sprite",
    });

    assert.equal(capturedHeaders.Authorization, `Key ${secret}`);
    assert(!JSON.stringify(result).includes(secret));
  } finally {
    if (originalFalKey === undefined) {
      delete process.env.FAL_KEY;
    } else {
      process.env.FAL_KEY = originalFalKey;
    }
  }
});

test("FAL provider fails clearly when FAL_KEY is missing", async () => {
  const originalFalKey = process.env.FAL_KEY;
  delete process.env.FAL_KEY;

  const provider = new FalImageProvider({
    fetch: async () => {
      throw new Error("fetch should not run without a key");
    },
  });

  try {
    await assert.rejects(
      provider.generateTextToImage({
        modelId: "fal-ai/test-model",
        prompt: "sprite",
      }),
      (error: unknown) => {
        assert(error instanceof FalImageProviderError);
        assert.equal(error.message, "FAL_KEY is required for FAL image generation");
        return true;
      },
    );
  } finally {
    if (originalFalKey === undefined) {
      delete process.env.FAL_KEY;
    } else {
      process.env.FAL_KEY = originalFalKey;
    }
  }
});

test("FAL HTTP errors are sanitized before throwing or stringifying", async () => {
  const secret = "fal-http-secret";
  const provider = new FalImageProvider({
    apiKey: secret,
    fetch: async () => new Response(`upstream echoed ${secret} and Authorization: Key ${secret}`, {
      status: 503,
      statusText: "Service Unavailable",
    }),
  });

  await assert.rejects(
    provider.generateTextToImage({
      modelId: "fal-ai/test-model",
      prompt: "sprite",
    }),
    (error: unknown) => {
      assert(error instanceof FalImageProviderError);
      assert.equal(error.status, 503);
      assert(error.message.includes("FAL image generation failed (503 Service Unavailable)"));
      assert(!error.message.includes(secret));
      assert(!JSON.stringify(error).includes(secret));
      assert(JSON.stringify(error).includes("[redacted]"));
      return true;
    },
  );
});
