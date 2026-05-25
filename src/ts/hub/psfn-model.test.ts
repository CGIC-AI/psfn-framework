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
