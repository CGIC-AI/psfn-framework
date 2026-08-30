import assert from "node:assert/strict";
import fs from "node:fs";
import { createPrivateKey } from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PsfnChannelContext } from "./embodied-session.js";
import { PsfnModelAdapter, type PsfnReplyTelemetry } from "./psfn-model.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import type { PsfnRuntimeConfig } from "../shared/env.js";
import { createHubDeviceAssertionIssuer } from "./device-assertion.js";
import {
  createHubDeviceRegistryAuthority,
  type HubDeviceIdentity,
  type HubDeviceRegistry,
} from "./device-registry.js";

const HUB_ASSERTION_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIBxi3MoZ6dMittBNv2g0RvbmOi9PJuzu5IVCwAL2tIbN", "base64"),
  format: "der",
  type: "pkcs8",
}).export({ format: "pem", type: "pkcs8" }).toString();

const TEST_REPLY_BUDGETS = {
  voiceReplyDeadlineMs: 8_000,
  voiceAttemptTimeoutMs: 6_000,
  textReplyDeadlineMs: 80_000,
  textAttemptTimeoutMs: 75_000,
} as const;

function buildRuntimeConfig(overrides: Partial<PsfnRuntimeConfig> = {}): PsfnRuntimeConfig {
  const satelliteClaim = normalizeSatelliteClaimConfig({
    capabilityProfile: "voxta-avatar",
    satelliteId: "voxta-vam",
    endpointId: "voxta-vam",
    displayName: "Voxta VaM",
  });
  return {
    baseUrl: "http://psfn.test",
    model: "psfn",
    apiKey: "secret",
    channelType: satelliteClaim.channelType,
    satelliteClaim,
    ...TEST_REPLY_BUDGETS,
    ...overrides,
  };
}

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const EMPTY_COMPLETION = '{"choices":[{"message":{"role":"assistant","content":""}}]}';

const AUTHENTICATED_DEVICE = {
  deviceId: "office-device",
  deviceName: "Office Device",
  satelliteId: "office",
  satelliteName: "Office",
  endpointId: "office-device",
  claimType: "room-satellite",
  credentialSha256: "0".repeat(64),
  enrollmentVersion: 7,
  enrollmentAssurance: "device_credential",
  enrollmentStatus: "active",
  companionId: "11111111-1111-4111-8111-111111111111",
  placeId: "office",
  maxCapabilities: { input: ["text"], output: ["text"], control: [], safety: ["local_only"] },
  homeAssistantEntityIds: [],
} satisfies HubDeviceIdentity;

function authenticatedAssertionRuntime(overrides: Partial<PsfnRuntimeConfig> = {}): PsfnRuntimeConfig {
  return buildRuntimeConfig({
    deviceAssertionIssuer: createHubDeviceAssertionIssuer({
      issuer: "psfn-satellite-hub",
      kid: "hub-2026-07",
      audience: "https://fleet.example.test",
      privateKeyPem: HUB_ASSERTION_PRIVATE_KEY,
      ttlSeconds: 30,
    }),
    ...overrides,
  });
}

function authenticatedChannel(): PsfnChannelContext {
  return {
    sessionId: "realtime:office-device:session",
    channelType: "satellite.endpoint",
    channelId: "satellite.endpoint:office",
    sourceSatelliteId: "office",
    sourceSatelliteName: "Office",
    deviceAuthority: AUTHENTICATED_DEVICE,
    activeSatellites: [],
  };
}

function authenticatedRegistryAuthority() {
  return createHubDeviceRegistryAuthority(() => ({
    schemaVersion: 1,
    devices: [AUTHENTICATED_DEVICE],
  }));
}

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
    ...TEST_REPLY_BUDGETS,
  });
  const channel: PsfnChannelContext = {
    sessionId: "thin-shell:demo",
    channelType: "satellite.endpoint",
    channelId: "satellite.endpoint:thin-shell:demo",
    sourceSatelliteId: "thin-shell",
    sourceSatelliteName: "Thin Shell",
    placeId: "demo-place",
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
      inputMode: "text",
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
    assert.equal("max_tokens" in capturedBody, false);
    assert.equal(capturedBody.system_prompt_mode, "default");
    assert.equal("system_prompt" in capturedBody, false);
    assert.equal(capturedBody.response_style, "concise");
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
      placeId: "demo-place",
      activeSatellites: channel.activeSatellites,
      satelliteClaim: bodyClaim,
    };
    assert.deepEqual(capturedBody.channel_metadata, expectedChannelMetadata);
    assert.deepEqual(JSON.parse(capturedHeaders["X-PSFN-Channel-Metadata"] || "{}"), expectedChannelMetadata);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("psfn model adapter mints a fresh Hub assertion only from authenticated device authority", async () => {
  const originalFetch = globalThis.fetch;
  const capturedHeaders: Array<Record<string, string>> = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedHeaders.push(init?.headers as Record<string, string>);
    return jsonResponse('{"choices":[{"message":{"role":"assistant","content":"ok"}}]}');
  };
  const runtime = buildRuntimeConfig({
    deviceAssertionIssuer: createHubDeviceAssertionIssuer({
      issuer: "psfn-satellite-hub",
      kid: "hub-2026-07",
      audience: "https://fleet.example.test",
      privateKeyPem: HUB_ASSERTION_PRIVATE_KEY,
      ttlSeconds: 30,
    }),
  });
  const channel: PsfnChannelContext = {
    sessionId: "realtime:office-device:session",
    channelType: "satellite.endpoint",
    channelId: "satellite.endpoint:office",
    sourceSatelliteId: "office",
    sourceSatelliteName: "Office",
    deviceAuthority: {
      deviceId: "office-device",
      enrollmentVersion: 7,
      enrollmentAssurance: "device_credential",
      enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111",
      placeId: "office",
    },
    activeSatellites: [],
  };
  const adapter = new PsfnModelAdapter(runtime, undefined, authenticatedRegistryAuthority());
  try {
    await drainReply(adapter, {
      inputMode: "text", userText: "first", conversationId: channel.sessionId, channel,
    });
    await drainReply(adapter, {
      inputMode: "text", userText: "second", conversationId: channel.sessionId, channel,
    });
    const first = capturedHeaders[0]?.["X-PSFN-Hub-Device-Assertion"];
    const second = capturedHeaders[1]?.["X-PSFN-Hub-Device-Assertion"];
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first, second, "each Framework request must get a unique replay id");
    const claims = JSON.parse(Buffer.from(first.split(".")[1]!, "base64url").toString("utf8"));
    assert.deepEqual({
      deviceId: claims.device_id,
      companionId: claims.companion_id,
      placeId: claims.place_id,
    }, {
      deviceId: "office-device",
      companionId: "11111111-1111-4111-8111-111111111111",
      placeId: "office",
    });
    assert.equal(JSON.stringify(capturedHeaders).includes("PRIVATE KEY"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated recovery retries reuse one exact Hub assertion for one logical turn", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetryBase = process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS;
  process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS = "1";
  const scenarios = ["agent_busy", "empty", "timeout"] as const;

  try {
    for (const scenario of scenarios) {
      const assertions: string[] = [];
      let calls = 0;
      globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        const headers = init?.headers as Record<string, string>;
        assertions.push(headers["X-PSFN-Hub-Device-Assertion"] ?? "");
        if (calls > 1) {
          return jsonResponse('{"choices":[{"message":{"role":"assistant","content":"Recovered"}}]}');
        }
        if (scenario === "agent_busy") {
          return new Response(
            '{"error":{"message":"Agent is already processing another prompt","type":"agent_busy"}}',
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
        if (scenario === "empty") return jsonResponse(EMPTY_COMPLETION);
        return await delayedResponse(
          200,
          '{"choices":[{"message":{"role":"assistant","content":"Too late"}}]}',
          init?.signal,
        );
      };
      const adapter = new PsfnModelAdapter(
        authenticatedAssertionRuntime({
          textReplyDeadlineMs: 250,
          textAttemptTimeoutMs: 25,
        }),
        undefined,
        authenticatedRegistryAuthority(),
      );
      await drainReply(adapter, {
        inputMode: "text",
        userText: `recover ${scenario}`,
        conversationId: authenticatedChannel().sessionId,
        channel: authenticatedChannel(),
      });
      assert.equal(calls, 2, `${scenario} must make exactly one recovery request`);
      assert.equal(assertions.length, 2);
      assert.ok(assertions[0]);
      assert.equal(assertions[1], assertions[0], `${scenario} must reuse identical assertion bytes`);
    }
  } finally {
    if (originalRetryBase === undefined) delete process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS;
    else process.env.PSFN_AGENT_BUSY_RETRY_BASE_MS = originalRetryBase;
    globalThis.fetch = originalFetch;
  }
});

test("authenticated recovery retries byte-identical request bytes after a consumed transport loss", async () => {
  const originalFetch = globalThis.fetch;
  const assertions: string[] = [];
  const bodies: string[] = [];
  let calls = 0;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const headers = init?.headers as Record<string, string>;
    assertions.push(headers["X-PSFN-Hub-Device-Assertion"] ?? "");
    bodies.push(String(init?.body ?? ""));
    if (calls === 1) {
      throw new TypeError("fetch failed after Framework consumed the request");
    }
    return jsonResponse('{"choices":[{"message":{"role":"assistant","content":"Recovered"}}]}');
  };

  const adapter = new PsfnModelAdapter(
    authenticatedAssertionRuntime({ textReplyDeadlineMs: 250, textAttemptTimeoutMs: 100 }),
    undefined,
    authenticatedRegistryAuthority(),
  );

  try {
    await drainReply(adapter, {
      inputMode: "text",
      userText: "recover the consumed request",
      conversationId: authenticatedChannel().sessionId,
      channel: authenticatedChannel(),
    });
    assert.equal(calls, 2);
    assert.ok(assertions[0]);
    assert.equal(assertions[1], assertions[0], "the replay must reuse exact assertion bytes");
    assert.equal(bodies[1], bodies[0], "the replay must reuse the exact request body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unauthenticated transport loss does not retry without replay protection", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError("fetch failed without an authenticated replay assertion");
    }
    return jsonResponse('{"choices":[{"message":{"role":"assistant","content":"must not recover"}}]}');
  };
  const adapter = new PsfnModelAdapter(
    buildRuntimeConfig({ textReplyDeadlineMs: 250, textAttemptTimeoutMs: 100 }),
  );

  try {
    await assert.rejects(
      drainReply(adapter, {
        inputMode: "text",
        userText: "do not replay me",
        conversationId: "unauthenticated-transport-loss",
      }),
      /without an authenticated replay assertion/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated recovery retries an ECONNRESET-equivalent transport loss", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("socket closed after write"), { code: "ECONNRESET" });
    }
    return jsonResponse('{"choices":[{"message":{"role":"assistant","content":"Recovered"}}]}');
  };

  const adapter = new PsfnModelAdapter(
    authenticatedAssertionRuntime({ textReplyDeadlineMs: 250, textAttemptTimeoutMs: 100 }),
    undefined,
    authenticatedRegistryAuthority(),
  );

  try {
    await drainReply(adapter, {
      inputMode: "text",
      userText: "recover the reset request",
      conversationId: authenticatedChannel().sessionId,
      channel: authenticatedChannel(),
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated recovery does not retry deterministic auth denials or arbitrary exceptions", async () => {
  const originalFetch = globalThis.fetch;
  const scenarios: Array<{
    name: string;
    respond: () => Promise<Response>;
    expectedError: RegExp;
  }> = [
    {
      name: "auth denial",
      respond: async () => new Response('{"error":"denied"}', { status: 401 }),
      expectedError: /failed \(401\).*denied/,
    },
    {
      name: "arbitrary exception",
      respond: async () => { throw new RangeError("not a transport failure"); },
      expectedError: /not a transport failure/,
    },
  ];

  try {
    for (const scenario of scenarios) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return await scenario.respond();
      };
      const adapter = new PsfnModelAdapter(
        authenticatedAssertionRuntime({ textReplyDeadlineMs: 250, textAttemptTimeoutMs: 100 }),
        undefined,
        authenticatedRegistryAuthority(),
      );
      await assert.rejects(
        drainReply(adapter, {
          inputMode: "text",
          userText: scenario.name,
          conversationId: authenticatedChannel().sessionId,
          channel: authenticatedChannel(),
        }),
        scenario.expectedError,
      );
      assert.equal(calls, 1, `${scenario.name} must not retry`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated recovery does not retry a known 401 whose body read loses transport", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 401,
        text: async () => { throw new TypeError("terminated while reading the denied response"); },
      } as unknown as Response;
    }
    return jsonResponse('{"choices":[{"message":{"role":"assistant","content":"must not recover"}}]}');
  };
  const adapter = new PsfnModelAdapter(
    authenticatedAssertionRuntime({ textReplyDeadlineMs: 250, textAttemptTimeoutMs: 100 }),
    undefined,
    authenticatedRegistryAuthority(),
  );

  try {
    await assert.rejects(
      drainReply(adapter, {
        inputMode: "text",
        userText: "do not replay a denied request",
        conversationId: authenticatedChannel().sessionId,
        channel: authenticatedChannel(),
      }),
      /401/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated recovery fences a device whose enrollment version changes between attempts", async () => {
  const originalFetch = globalThis.fetch;
  let registry: HubDeviceRegistry = { schemaVersion: 1, devices: [AUTHENTICATED_DEVICE] };
  const authority = createHubDeviceRegistryAuthority(() => registry);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    registry = {
      schemaVersion: 1,
      devices: [{ ...AUTHENTICATED_DEVICE, enrollmentVersion: 8 }],
    };
    return jsonResponse(EMPTY_COMPLETION);
  };
  const adapter = new PsfnModelAdapter(
    authenticatedAssertionRuntime({ textReplyDeadlineMs: 250, textAttemptTimeoutMs: 100 }),
    undefined,
    authority,
  );

  try {
    await assert.rejects(
      drainReply(adapter, {
        inputMode: "text",
        userText: "must not retry after version bump",
        conversationId: authenticatedChannel().sessionId,
        channel: authenticatedChannel(),
      }),
      /enrollment version changed/,
    );
    assert.equal(calls, 1, "no request may leave after the authority version changes");
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
    ...TEST_REPLY_BUDGETS,
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
      inputMode: "voice",
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

test("psfn model adapter injects retained VaM context into the active user turn", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};
  let capturedHeaders: Record<string, string> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
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
    ...TEST_REPLY_BUDGETS,
  });
  const channel: PsfnChannelContext = {
    sessionId: "voxta-session",
    channelType: "satellite.endpoint",
    channelId: "satellite.endpoint:voxta-session",
    sourceSatelliteId: "voxta-vam",
    sourceSatelliteName: "Voxta VaM",
    activeSatellites: [],
    contextNotes: [{
      key: "VaM/Slot2",
      text: "The scene view shows Companion's body and surroundings — use what you see.",
    }],
  };

  try {
    for await (const _chunk of adapter.streamReply({
      inputMode: "voice",
      userText: "can you see?",
      conversationId: "voxta-session",
      history: [{ role: "user", content: "can you see?" }],
      channel,
    })) {
      // drain generator
    }

    assert.deepEqual(capturedBody.messages, [{
      role: "user",
      content: "Current embodiment context:\n- [VaM/Slot2] The scene view shows Companion's body and surroundings — use what you see.\n\nUser turn:\ncan you see?",
    }]);
    const channelMetadata = capturedBody.channel_metadata as Record<string, unknown>;
    assert.deepEqual(channelMetadata.contextNotes, [{
      key: "VaM/Slot2",
      text: "The scene view shows Companion's body and surroundings — use what you see.",
    }]);
    const metadataHeader = capturedHeaders["X-PSFN-Channel-Metadata"] || "";
    assert.equal([...metadataHeader].every((char) => (char.codePointAt(0) ?? 0) <= 0xff), true);
    assert.deepEqual(JSON.parse(metadataHeader).contextNotes, [{
      key: "VaM/Slot2",
      text: "The scene view shows Companion's body and surroundings - use what you see.",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("psfn model adapter recovers from an empty primary response within the reply deadline", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(EMPTY_COMPLETION);
    }
    return jsonResponse('{"choices":[{"message":{"role":"assistant","content":"Recovered reply"}}]}');
  };

  const telemetry: PsfnReplyTelemetry[] = [];
  const adapter = new PsfnModelAdapter(
    buildRuntimeConfig({ voiceReplyDeadlineMs: 2_000, voiceAttemptTimeoutMs: 1_000 }),
    (record) => telemetry.push(record),
  );

  try {
    const startedAt = Date.now();
    const chunks: string[] = [];
    for await (const chunk of adapter.streamReply({
      inputMode: "voice",
      userText: "hello",
      conversationId: "voxta-session",
      history: [],
    })) {
      chunks.push(chunk);
    }
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(chunks, ["Recovered reply"]);
    assert.equal(calls, 2);
    assert.ok(elapsedMs < 2_000, `recovery must land within the reply deadline (was ${elapsedMs} ms)`);

    // Telemetry records BOTH attempts and only ever a character count for the
    // accepted content, never the discarded delta text.
    assert.equal(telemetry.length, 1);
    const record = telemetry[0]!;
    assert.equal(record.outcome, "recovered");
    assert.deepEqual(record.attempts.map((a) => a.status), ["empty", "ok"]);
    assert.equal(record.attempts[1]!.chars, "Recovered reply".length);
    assert.equal(JSON.stringify(record).includes("Recovered reply"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("typed replies can complete after the voice deadline but within the text deadline", async () => {
  const originalFetch = globalThis.fetch;
  const timeoutOverrides: Partial<PsfnRuntimeConfig> = {
    voiceReplyDeadlineMs: 15,
    voiceAttemptTimeoutMs: 10,
    textReplyDeadlineMs: 200,
    textAttemptTimeoutMs: 150,
  };

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) =>
    await delayedResponse(
      40,
      '{"choices":[{"message":{"role":"assistant","content":"Typed reply survived"}}]}',
      init?.signal,
    );

  const telemetry: PsfnReplyTelemetry[] = [];
  const adapter = new PsfnModelAdapter(buildRuntimeConfig(timeoutOverrides), (record) => telemetry.push(record));

  try {
    const chunks: string[] = [];
    const input = {
      inputMode: "text" as const,
      userText: "take the time you need",
      conversationId: "typed-session",
      history: [],
    };
    for await (const chunk of adapter.streamReply(input)) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, ["Typed reply survived"]);
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0]!.inputMode, "text");
    assert.equal(telemetry[0]!.deadlineMs, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voice replies still time out on the tight voice budget", async () => {
  const originalFetch = globalThis.fetch;
  const telemetry: PsfnReplyTelemetry[] = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) =>
    await delayedResponse(
      40,
      '{"choices":[{"message":{"role":"assistant","content":"Too late for voice"}}]}',
      init?.signal,
    );

  const adapter = new PsfnModelAdapter(
    buildRuntimeConfig({
      voiceReplyDeadlineMs: 15,
      voiceAttemptTimeoutMs: 10,
      textReplyDeadlineMs: 200,
      textAttemptTimeoutMs: 150,
    }),
    (record) => telemetry.push(record),
  );

  try {
    await assert.rejects(
      (async () => {
        for await (const _chunk of adapter.streamReply({
          inputMode: "voice",
          userText: "answer immediately",
          conversationId: "voice-session",
          history: [],
        })) {
          // drain
        }
      })(),
      /did not produce assistant content within 15 ms/,
    );
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0]!.inputMode, "voice");
    assert.deepEqual(telemetry[0]!.attempts.map((attempt) => attempt.status), ["timeout", "timeout"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("psfn model adapter fails repeated empty text responses before the typed client budget", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(EMPTY_COMPLETION);
  };

  const telemetry: PsfnReplyTelemetry[] = [];
  const adapter = new PsfnModelAdapter(
    buildRuntimeConfig({ textReplyDeadlineMs: 300, textAttemptTimeoutMs: 150 }),
    (record) => telemetry.push(record),
  );

  try {
    const startedAt = Date.now();
    await assert.rejects(
      (async () => {
        for await (const _chunk of adapter.streamReply({
          inputMode: "text",
          userText: "hello",
          conversationId: "voxta-session",
          history: [],
        })) {
          // drain
        }
      })(),
      /did not produce assistant content within 300 ms/,
    );
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 2_000, `failure must be bounded by the reply deadline (was ${elapsedMs} ms)`);
    assert.equal(calls, 2);
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0]!.inputMode, "text");
    assert.equal(telemetry[0]!.outcome, "failed");
    assert.deepEqual(telemetry[0]!.attempts.map((a) => a.status), ["empty", "empty"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("psfn model adapter cancels an in-flight fallback on client disconnect and accepts the next turn", async () => {
  const originalFetch = globalThis.fetch;
  let sawAbortedSignal = false;
  let hungCalls = 0;
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });

  const telemetry: PsfnReplyTelemetry[] = [];
  const adapter = new PsfnModelAdapter(buildRuntimeConfig(), (record) => telemetry.push(record));

  try {
    // First turn: the framework request hangs until the client disconnects.
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      hungCalls += 1;
      markRequestStarted();
      const signal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = (): void => {
          sawAbortedSignal = true;
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    };

    const controller = new AbortController();
    const drain = (async () => {
      for await (const _chunk of adapter.streamReply({
        inputMode: "text",
        userText: "are you there?",
        conversationId: "voxta-session",
        history: [],
        signal: controller.signal,
      })) {
        // drain
      }
    })();

    // Abort only after the request has reached the in-flight state.
    await requestStarted;
    controller.abort(new DOMException("client disconnect", "AbortError"));

    await assert.rejects(drain);
    assert.equal(sawAbortedSignal, true, "the in-flight request must observe the abort");
    assert.equal(hungCalls, 1);
    assert.equal(telemetry.at(-1)!.outcome, "cancelled");

    // Next turn: the channel accepts a fresh request without any process restart.
    globalThis.fetch = async () =>
      jsonResponse('{"choices":[{"message":{"role":"assistant","content":"Next turn works"}}]}');

    const chunks: string[] = [];
    for await (const chunk of adapter.streamReply({
      inputMode: "text",
      userText: "hello again",
      conversationId: "voxta-session",
      history: [],
    })) {
      chunks.push(chunk);
    }
    assert.deepEqual(chunks, ["Next turn works"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mTLS transport aborts stalled response bodies on deadline and external cancellation", async () => {
  const certificateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psfn-mtls-timeout-"));
  const certPath = path.join(certificateRoot, "test-cert.pem");
  const keyPath = path.join(certificateRoot, "test-key.pem");
  fs.writeFileSync(certPath, TEST_TLS_CERTIFICATE);
  fs.writeFileSync(keyPath, TEST_TLS_PRIVATE_KEY);

  let requestCount = 0;
  let closedResponseCount = 0;
  const server = https.createServer({
    key: TEST_TLS_PRIVATE_KEY,
    cert: TEST_TLS_CERTIFICATE,
    ca: TEST_TLS_CERTIFICATE,
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => {
    requestCount += 1;
    request.resume();
    response.once("close", () => {
      closedResponseCount += 1;
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    response.write('{"choices":[{"message":{"role":"assistant","content":"');
    // Intentionally never complete the JSON body. Cancellation must destroy
    // this response stream after headers, not merely abort before headers.
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const runtime = buildRuntimeConfig({
    baseUrl: `https://127.0.0.1:${address.port}`,
    voiceReplyDeadlineMs: 60,
    voiceAttemptTimeoutMs: 30,
    textReplyDeadlineMs: 200,
    textAttemptTimeoutMs: 150,
  });
  runtime.satelliteClaim = {
    ...runtime.satelliteClaim,
    tls: { certPath, keyPath, caPath: certPath },
  };
  const adapter = new PsfnModelAdapter(runtime, () => {});

  try {
    await assert.rejects(
      drainReply(adapter, {
        inputMode: "voice",
        userText: "deadline",
        conversationId: "mtls-deadline",
        history: [],
      }),
      /did not produce assistant content within 60 ms/,
    );
    await waitForCondition(() => requestCount === 2 && closedResponseCount === 2);

    const controller = new AbortController();
    const cancelledReply = drainReply(adapter, {
      inputMode: "text",
      userText: "external cancel",
      conversationId: "mtls-external-cancel",
      history: [],
      signal: controller.signal,
    });
    await waitForCondition(() => requestCount === 3);
    controller.abort(new DOMException("test external cancellation", "AbortError"));
    await assert.rejects(cancelledReply, (error: unknown) => (
      error instanceof Error
      && error.name === "AbortError"
      && error.message === "test external cancellation"
    ));
    await waitForCondition(() => closedResponseCount === 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(certificateRoot, { recursive: true, force: true });
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
    ...TEST_REPLY_BUDGETS,
  });

  try {
    const chunks: string[] = [];
    for await (const chunk of adapter.streamReply({
      inputMode: "voice",
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

function delayedResponse(delayMs: number, body: string, signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(jsonResponse(body));
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function drainReply(
  adapter: PsfnModelAdapter,
  input: Parameters<PsfnModelAdapter["streamReply"]>[0],
): Promise<void> {
  for await (const _chunk of adapter.streamReply(input)) {
    // drain
  }
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for condition");
}

const TEST_TLS_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUfT/pEOJZABz3h2of3OMWkCcd3wcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcxNTEzMDA0NFoXDTM2MDcx
MjEzMDA0NFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAyLpEARFLGQhc5XoPsdup2VpXf+h5CEL75ld6F1FYblDd
bozJtd275QNDSeb5FiugegClvz6Ft6/BhRVSeAZdrw2GnvSO6xYhM+QXEcLZE+/7
xfSbBBrRe78X2K0vI8xpCdInrvawyZ3QWckmVH6Ws10io3z7/vPH36PtHVFGC0ia
yCeo/BHyRcA+WspNRXklSu1kwt9mu5z5XK6i8YmtzUJ5n719x8METgJ1Knv8+76P
pHvWYstgp1r7R1lrXWtCXGucGOHUV6xZSdkK6whRsra+Ro5bciXv4vDA0S/bwKZt
sWIEc1lZ6ShRf3v4or4unKnYNsmvMJKb/2qEmkAd7QIDAQABo28wbTAdBgNVHQ4E
FgQU57Bd2sp7KFi7YhVwwwySvMNpPT4wHwYDVR0jBBgwFoAU57Bd2sp7KFi7YhVw
wwySvMNpPT4wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAMP/BgeFXVShwMViRgn3oPxHQrj0dcV7
D8pLjV6tb6WW9ct4KK+ZIRgoWoSUmJl8qYvlD6YGBVWQRocYLfUvRaC0LzrdSI6K
rwtIRbtJIV4wLholaGYbh5mCvfFuPnOVmZCXei0hm23c/T+MWMvqY24JOlC111g7
vz7xJ/QYNmgwRClZld5iSQiK9OIebMqbNpQrQK+MiML0NYZzUcjgA+fgwWv8Uxbz
6NcwgByhiZgcELxTiH91NIiitz4WrQMKCMVvN91kk9t1gY6jtbaPJhsaB5rPlzeq
UB6LjoWKfuaJ3JCaLXOlrGHxgGySAL4EhmtKJJyy6Leuzit63Jekmug=
-----END CERTIFICATE-----`;

const TEST_TLS_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDIukQBEUsZCFzl
eg+x26nZWld/6HkIQvvmV3oXUVhuUN1ujMm13bvlA0NJ5vkWK6B6AKW/PoW3r8GF
FVJ4Bl2vDYae9I7rFiEz5BcRwtkT7/vF9JsEGtF7vxfYrS8jzGkJ0ieu9rDJndBZ
ySZUfpazXSKjfPv+88ffo+0dUUYLSJrIJ6j8EfJFwD5ayk1FeSVK7WTC32a7nPlc
rqLxia3NQnmfvX3HwwROAnUqe/z7vo+ke9Ziy2CnWvtHWWtda0Jca5wY4dRXrFlJ
2QrrCFGytr5GjltyJe/i8MDRL9vApm2xYgRzWVnpKFF/e/iivi6cqdg2ya8wkpv/
aoSaQB3tAgMBAAECggEAAM1t1CtDh5gW9vvj8CwWo73Ot74wLa5G34beABXdKqO8
HuMFM2rtg17d9/+qY0JNY+94uij/09oqBeQt7jjoSvjc3unPYHU4MMLqrLGAuKmu
8f2mWP/acoozCDS5CYWZreZfLj3iOwwcdx9svc27wH/Q0aKAR2amF+jJ2+IlS4o+
8zXCP0qGbzZoOQZbM0n5/az1vHBnBlUokj0lL8y2nsqoknUvT2JdNEffzSIKk2AO
X4NLNMIKG5rKq59MeuG9WZozg4PWoDe+h88+jcoMc7rk7U6yaAwq7+rcCfXrgfjx
+26BGEOQKyQOS0PFsN8BpEoZABWjym685+2h8fcowQKBgQDxuDvjN2hlmOnBxcNQ
qyXy8hILyuLk48kTI4/42W+fO4yXQOh2DmN5fmBfEpL3nZ/xV5U4DL+YfTn+SOWV
+lPMEvGWe5POMkm4YfV4pIgOAWd12owK761ykz9KPrhG+KglvCJzNFDpqecTI8jA
3MRhpXjTLzkKLw9UM3FQy+PgiQKBgQDUlhFuwfQTxWuOuZdgnRVdremaC2Sah4bN
aEwsGidTcyXlMCs94rrQiDpvAJ0XhopYXtBrefVwksbTjSOcifYDodqkLoxrtaJi
zrRQxuOxWA4nAOVH9ylcAblSmF6yMwgYsGBGPG+WpKdqA7JIu4YAdngQk6RO81Ee
G5HA5q+RRQKBgEMKx0l497KeG8+Ly2VXYtokO88bgZzcdMujJG5v2F7AxHi7Hv6H
dR2gaJhV7X9SL6dflFqMZqOjr+8QRuU3HgDPDEShl9gr6HiEavIAKGBCEXEFoavy
2BecMYSlKrU8iF6W9LMhQoPchOOxHCAp2yn+HCnuwhJKBSVkczxmoJiJAoGBAJsa
gs2UpUhnmfogXtoWwif/Y5kJBvXYO/pSRoFG87pnIRb+9g3JBxRu0HN8tyEbAIVJ
aDeCXBkuffKL35eu8Nfll2iCreFIPJpqxhTJiAc0f97lQGQpaPvAJj6k/TJ3GUkq
JpQYNDJtH9ixqbp3V2WvChrOHeuci2q0Irvjk+UhAoGAHmz7vz3/2vnUCl/rIubE
Xd3JhHpN1z6fUlJ7JiS8CEMqUivXu1jP4HRMGTJ0LN/zzDxiYzPcGhXJNJztpJ6f
qr60QKLGS7zUfVl5Ruc3j49A3P9sSwfpn/WaarnEEkIuowpfR5b030mT1NehYkv1
6zqit3QdaW+hsr73CJymx8U=
-----END PRIVATE KEY-----`;
