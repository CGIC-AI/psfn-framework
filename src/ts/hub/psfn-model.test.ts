import assert from "node:assert/strict";
import test from "node:test";

import type { PsfnChannelContext } from "./embodied-session.js";
import { PsfnModelAdapter } from "./psfn-model.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";

test("psfn model adapter sends embodied hub channel headers", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(
      '{"choices":[{"message":{"role":"assistant","content":"Hello"}}]}',
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const satelliteClaim = normalizeSatelliteClaimConfig({
    capabilityProfile: "text-only",
    satelliteId: "hub-thin-shell",
    endpointId: "thin-shell",
    displayName: "Thin Shell Endpoint",
  });
  const adapter = new PsfnModelAdapter({
    baseUrl: "http://psfn.test",
    model: "psfn",
    apiKey: "secret",
    channelType: satelliteClaim.channelType,
    satelliteClaim,
  });
  const channel: PsfnChannelContext = {
    sessionId: "thin-shell:demo",
    channelType: "satellite.endpoint",
    channelId: "satellite.endpoint:thin-shell:demo",
    sourceSatelliteId: "thin-shell",
    sourceSatelliteName: "Thin Shell",
    activeSatellites: [
      {
        id: "thin-shell",
        name: "Thin Shell",
        transport: "websocket",
        capabilities: {
          input: ["text"],
          output: ["text", "subtitle"],
          control: ["interrupt"],
          safety: [],
        },
      },
    ],
  };

  try {
    const chunks = [];
    for await (const chunk of adapter.streamReply({
      userText: "hello",
      conversationId: "thin-shell:demo",
      history: [],
      channel,
    })) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, ["Hello"]);
    assert.equal(capturedHeaders.Authorization, "Bearer secret");
    assert.equal(capturedHeaders["X-PSFN-Channel-Type"], "satellite.endpoint");
    assert.equal(capturedHeaders["X-PSFN-Channel-ID"], "satellite.endpoint:thin-shell:demo");
    assert.equal(capturedHeaders["X-PSFN-Satellite-Claim-Type"], "text-only");
    assert.equal(capturedHeaders["X-PSFN-Satellite-ID"], "hub-thin-shell");
    assert.equal(capturedHeaders["X-PSFN-Satellite-Endpoint-ID"], "thin-shell");
    assert.equal(capturedHeaders["X-PSFN-Satellite-Session-ID"], "thin-shell:demo");
    assert.equal(capturedHeaders["X-PSFN-Satellite-Thread-ID"], "thin-shell:demo");
    assert.equal(capturedHeaders["X-PSFN-Satellite-Capabilities"], "text");
    assert.equal(capturedHeaders["X-PSFN-Satellite-Name"], "Thin Shell");
    assert.equal(capturedBody.user, "thin-shell:demo");
    assert.equal(capturedBody.stream, false);
    assert.deepEqual(capturedBody.messages, [{ role: "user", content: "hello" }]);
    const bodyClaim = capturedBody.satellite_claim as Record<string, unknown>;
    assert.equal(bodyClaim.protocolVersion, "satellite-claim.v1");
    assert.deepEqual(bodyClaim.claim, {
      namespace: "satellite.endpoint",
      type: "text-only",
      satelliteId: "hub-thin-shell",
      endpointId: "thin-shell",
      sessionId: "thin-shell:demo",
      threadId: "thin-shell:demo",
      channelId: "satellite.endpoint:thin-shell:demo",
      deviceClass: "text",
      displayName: "Thin Shell Endpoint",
      locationMode: "static",
    });
    assert.deepEqual(JSON.parse(capturedHeaders["X-PSFN-Satellite-Claim"] || "{}"), bodyClaim);
    const expectedChannelMetadata = {
      sessionId: "thin-shell:demo",
      sourceSatelliteId: "thin-shell",
      sourceSatelliteName: "Thin Shell",
      activeSatellites: channel.activeSatellites,
      satelliteClaim: bodyClaim,
    };
    assert.deepEqual(capturedBody.channel_metadata, expectedChannelMetadata);
    assert.deepEqual(JSON.parse(capturedHeaders["X-PSFN-Channel-Metadata"] || "{}"), expectedChannelMetadata);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("psfn model adapter sends VaM vision captures as inline image blocks", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(
      '{"choices":[{"message":{"role":"assistant","content":"I see it."}}]}',
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const satelliteClaim = normalizeSatelliteClaimConfig({
    capabilityProfile: "voxta-avatar",
    satelliteId: "voxta-vam",
    endpointId: "voxta-vam",
    displayName: "Voxta VaM",
  });
  const adapter = new PsfnModelAdapter({
    baseUrl: "http://psfn.test",
    model: "psfn",
    apiKey: "secret",
    channelType: satelliteClaim.channelType,
    satelliteClaim,
  });
  const channel: PsfnChannelContext = {
    sessionId: "voxta-session",
    channelType: "satellite.endpoint",
    channelId: "satellite.endpoint:voxta-session",
    sourceSatelliteId: "voxta-vam",
    sourceSatelliteName: "Voxta VaM",
    activeSatellites: [
      {
        id: "voxta-vam",
        name: "Voxta VaM",
        transport: "websocket",
        capabilities: {
          input: ["text", "vision_upload"],
          output: ["text", "subtitle", "local_file_audio", "animation", "action", "expression"],
          control: ["interrupt", "presence", "session_attach"],
          safety: ["action_allowlist", "local_only"],
        },
      },
    ],
    visionCaptures: [{
      requestId: "vision-1",
      sessionId: "voxta-session",
      source: "Screen",
      label: "virtamate",
      mimeType: "image/jpeg",
      filePath: "/tmp/voxta.jpg",
      bytes: 4,
      capturedAt: "2026-05-25T00:00:00.000Z",
    }],
    visionCaptureImages: [{
      requestId: "vision-1",
      sessionId: "voxta-session",
      source: "Screen",
      label: "virtamate",
      mimeType: "image/jpeg",
      filePath: "/tmp/voxta.jpg",
      bytes: 4,
      capturedAt: "2026-05-25T00:00:00.000Z",
      dataBase64: "YWJjZA==",
    }],
  };

  try {
    for await (const _chunk of adapter.streamReply({
      userText: "what do you see?",
      conversationId: "voxta-session",
      history: [{ role: "user", content: "what do you see?" }],
      channel,
    })) {
      // drain generator
    }

    const messages = capturedBody.messages as Array<{ role: string; content: unknown }>;
    assert.deepEqual(messages, [{
      role: "user",
      content: [
        { type: "text", text: "what do you see?" },
        {
          type: "image",
          data: "YWJjZA==",
          mimeType: "image/jpeg",
          name: "virtamate-screen.jpg",
        },
      ],
    }]);
    assert.deepEqual(
      JSON.stringify(capturedBody.channel_metadata).includes("YWJjZA=="),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("psfn model adapter retries transient agent_busy responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetryBase = process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS;
  let calls = 0;

  process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS = "1";
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        '{"error":{"message":"Agent is already processing another prompt","type":"agent_busy"}}',
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      '{"choices":[{"message":{"role":"assistant","content":"Ready now"}}]}',
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const satelliteClaim = normalizeSatelliteClaimConfig({
    capabilityProfile: "voxta-avatar",
    satelliteId: "voxta-vam",
    endpointId: "voxta-vam",
    displayName: "Voxta VaM",
  });
  const adapter = new PsfnModelAdapter({
    baseUrl: "http://psfn.test",
    model: "psfn",
    apiKey: "secret",
    channelType: satelliteClaim.channelType,
    satelliteClaim,
  });

  try {
    const chunks: string[] = [];
    for await (const chunk of adapter.streamReply({
      userText: "hello",
      conversationId: "voxta-session",
      history: [],
    })) {
      chunks.push(chunk);
    }
    assert.deepEqual(chunks, ["Ready now"]);
    assert.equal(calls, 2);
  } finally {
    if (originalRetryBase === undefined) {
      delete process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS;
    } else {
      process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS = originalRetryBase;
    }
    globalThis.fetch = originalFetch;
  }
});
