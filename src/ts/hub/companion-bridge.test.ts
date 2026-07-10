import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import WebSocket from "ws";

import type { CompanionBridgeConfig, HubConfig } from "../shared/env.js";
import type {
  HubToClientMessage,
  SatelliteCapabilities,
} from "../shared/protocol.js";
import type { AgentRuntimeAdapter } from "./agent-runtime.js";
import {
  CompanionBridge,
  CompanionRequestError,
  parseCompanionEventData,
  reconnectDelayMs,
  SseStreamParser,
  type CompanionEvent,
} from "./companion-bridge.js";
import type { PsfnChannelContext } from "./embodied-session.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { RealtimeHubServer } from "./server.js";
import type { ConversationMessage } from "./session-store.js";

const APPROVAL_CAPABILITIES: SatelliteCapabilities = {
  input: ["text"],
  output: ["text", "subtitle", "artifact", "tool_activity"],
  control: ["interrupt", "session_attach", "approvals"],
  safety: [],
};

const PLAIN_CAPABILITIES: SatelliteCapabilities = {
  input: ["text"],
  output: ["text", "subtitle"],
  control: ["interrupt", "session_attach"],
  safety: [],
};

const TEST_IDENTITY = {
  satelliteId: "hub-companion-test",
  endpointId: "companion-test",
  claimType: "text-only",
};

test("SseStreamParser reassembles events across chunk boundaries", () => {
  const parser = new SseStreamParser();
  const first = parser.push("event: companion\ndata: {\"a\":");
  assert.deepEqual(first, []);
  const second = parser.push("1}\n\nevent: other\ndata: x\n\n: comment\n\n");
  assert.deepEqual(second, [
    { event: "companion", data: "{\"a\":1}" },
    { event: "other", data: "x" },
  ]);
  const crlf = parser.push("event: companion\r\ndata: line1\r\ndata: line2\r\n\r\n");
  assert.deepEqual(crlf, [{ event: "companion", data: "line1\nline2" }]);
});

test("parseCompanionEventData projects payloads onto the wire contract and strips unknown fields", () => {
  const event = parseCompanionEventData(JSON.stringify({
    kind: "approval.requested",
    payload: {
      id: "appr-1",
      title: "Send message",
      requestedAt: "2026-07-09T00:00:00Z",
      expiresAt: "2026-07-09T00:05:00Z",
      redactedContext: "Wants to send an outbound message",
      status: "pending",
      rawTranscript: "should never leak",
    },
    sessionId: "session-1",
    emittedAt: "2026-07-09T00:00:00Z",
  }));

  assert.deepEqual(event, {
    kind: "approval.requested",
    payload: {
      id: "appr-1",
      title: "Send message",
      requestedAt: "2026-07-09T00:00:00Z",
      expiresAt: "2026-07-09T00:05:00Z",
      redactedContext: "Wants to send an outbound message",
      status: "pending",
    },
  });
});

test("parseCompanionEventData rejects invalid envelopes", () => {
  assert.throws(
    () => parseCompanionEventData(JSON.stringify({ kind: "unknown.kind", payload: {}, emittedAt: "now" })),
    /Unsupported companion event kind/,
  );
  assert.throws(
    () => parseCompanionEventData(JSON.stringify({ kind: "approval.requested", payload: "text", emittedAt: "now" })),
    /payload must be a JSON object/,
  );
  assert.throws(
    () => parseCompanionEventData(JSON.stringify({
      kind: "approval.requested",
      payload: { id: "a", title: "t", requestedAt: "r", redactedContext: "c", status: "approved" },
      emittedAt: "now",
    })),
    /status must be 'pending'/,
  );
  assert.throws(
    () => parseCompanionEventData(JSON.stringify({
      kind: "approval.resolved",
      payload: { id: "a", status: "cancelled", resolvedAt: "r" },
      emittedAt: "now",
    })),
    /status is invalid/,
  );
  assert.throws(
    () => parseCompanionEventData(JSON.stringify({
      kind: "tool.activity",
      payload: { id: "a", tool: "web_search", phase: "paused", timestamp: "t" },
      emittedAt: "now",
    })),
    /phase is invalid/,
  );
  assert.throws(
    () => parseCompanionEventData(JSON.stringify({
      kind: "artifact.created",
      payload: { id: "a", label: "l", mediaType: "image/png", provenance: "p", createdAt: "c", previewable: "yes" },
      emittedAt: "now",
    })),
    /previewable must be a boolean/,
  );
  assert.throws(
    () => parseCompanionEventData(JSON.stringify({
      kind: "artifact.created",
      payload: { id: "a", label: "l", mediaType: "image/png", provenance: "p", createdAt: "c", previewable: true },
    })),
    /emittedAt/,
  );
});

test("parseCompanionEventData accepts upstream-mapped approval.resolved statuses", () => {
  for (const status of ["approved", "denied", "expired", "blocked"]) {
    const event = parseCompanionEventData(JSON.stringify({
      kind: "approval.resolved",
      payload: { id: "appr-1", status, resolvedAt: "2026-07-09T00:00:03Z" },
      channelId: "satellite.endpoint:companion-test:demo",
      emittedAt: "2026-07-09T00:00:03Z",
    }));
    assert.equal(event.kind, "approval.resolved");
    assert.equal((event.payload as { status: string }).status, status);
  }
});

test("companion bridge refuses to start without a complete registry identity", () => {
  assert.throws(
    () => new CompanionBridge(bridgeConfig("http://127.0.0.1:1", {
      identity: { satelliteId: "", endpointId: "companion-test", claimType: "text-only" },
    })),
    /complete satellite registry identity/,
  );
});

test("reconnectDelayMs backs off exponentially up to the cap", () => {
  const config = { reconnectBaseMs: 100, reconnectMaxMs: 1_000 };
  assert.equal(reconnectDelayMs(config, 1), 100);
  assert.equal(reconnectDelayMs(config, 2), 200);
  assert.equal(reconnectDelayMs(config, 3), 400);
  assert.equal(reconnectDelayMs(config, 10), 1_000);
});

test("companion bridge consumes SSE events and reconnects after stream loss", async () => {
  const backplane = new FakeBackplane();
  const baseUrl = await backplane.start();
  const bridge = new CompanionBridge(bridgeConfig(baseUrl));
  const received: CompanionEvent[] = [];
  bridge.addListener((event) => received.push(event));

  try {
    bridge.start();
    await waitFor(() => backplane.sseConnectionCount === 1, "first SSE connection");
    assert.equal(backplane.lastEventsAuthorization, "Bearer companion-key");
    assert.deepEqual(backplane.lastEventsQuery, TEST_IDENTITY);

    backplane.emit({
      kind: "tool.activity",
      payload: { id: "act-1", tool: "web_search", phase: "started", timestamp: "2026-07-09T00:00:00Z" },
      emittedAt: "2026-07-09T00:00:00Z",
    });
    await waitFor(() => received.length === 1, "first event delivery");

    backplane.endStreams();
    await waitFor(() => backplane.sseConnectionCount === 2, "SSE reconnect");

    backplane.emit({
      kind: "tool.activity",
      payload: { id: "act-2", tool: "web_search", phase: "completed", detail: "3 results", timestamp: "2026-07-09T00:00:01Z" },
      emittedAt: "2026-07-09T00:00:01Z",
    });
    await waitFor(() => received.length === 2, "post-reconnect event delivery");

    assert.deepEqual(received[1], {
      kind: "tool.activity",
      payload: { id: "act-2", tool: "web_search", phase: "completed", detail: "3 results", timestamp: "2026-07-09T00:00:01Z" },
    });
  } finally {
    await bridge.stop();
    await backplane.stop();
  }
});

test("companion bridge proxies approval decisions and surfaces backplane failures", async () => {
  const backplane = new FakeBackplane();
  const baseUrl = await backplane.start();
  const bridge = new CompanionBridge(bridgeConfig(baseUrl));

  try {
    backplane.approvalResponse = { status: 200, body: JSON.stringify({ id: "appr-1", status: "approved" }) };
    const result = await bridge.submitApprovalDecision({
      approvalId: "appr-1",
      decision: "approve",
      satelliteId: "sat-1",
      deviceId: "dev-1",
    });
    assert.deepEqual(result, { id: "appr-1", status: "approved" });
    assert.equal(backplane.approvalRequests.length, 1);
    assert.equal(backplane.approvalRequests[0]?.id, "appr-1");
    assert.equal(backplane.approvalRequests[0]?.authorization, "Bearer companion-key");
    assert.deepEqual(backplane.approvalRequests[0]?.body, {
      decision: "approve",
      satelliteId: "sat-1",
      deviceId: "dev-1",
    });

    const failureBodies: Record<number, string> = {
      403: JSON.stringify({ error: { message: "Unknown endpoint or missing scope", type: "forbidden" } }),
      404: JSON.stringify({ error: { message: "Approval not found", type: "not_found" } }),
      409: JSON.stringify({
        error: {
          message: "Approval already resolved",
          type: "conflict",
          details: { id: "appr-2", status: "expired" },
        },
      }),
    };
    for (const status of [403, 404, 409]) {
      backplane.approvalResponse = { status, body: failureBodies[status] ?? "{}" };
      await assert.rejects(
        bridge.submitApprovalDecision({
          approvalId: "appr-2",
          decision: "deny",
          satelliteId: "sat-1",
          deviceId: "dev-1",
        }),
        (error: unknown) => error instanceof CompanionRequestError && error.status === status,
      );
    }
  } finally {
    await bridge.stop();
    await backplane.stop();
  }
});

test("companion bridge enforces the artifact preview size cap and relays denials", async () => {
  const backplane = new FakeBackplane();
  const baseUrl = await backplane.start();
  const bridge = new CompanionBridge(bridgeConfig(baseUrl, { previewMaxBytes: 16 }));

  try {
    backplane.previewResponse = {
      status: 200,
      contentType: "image/png",
      body: Buffer.from("tiny-png-bytes"),
    };
    const preview = await bridge.fetchArtifactPreview("art-1");
    assert.equal(preview.mediaType, "image/png");
    assert.equal(Buffer.from(preview.dataBase64, "base64").toString("utf8"), "tiny-png-bytes");
    assert.deepEqual(backplane.lastPreviewQuery, TEST_IDENTITY);

    backplane.previewResponse = {
      status: 200,
      contentType: "image/png",
      body: Buffer.alloc(64, 1),
    };
    await assert.rejects(bridge.fetchArtifactPreview("art-2"), /size cap/);

    backplane.previewResponse = { status: 403, contentType: "application/json", body: Buffer.from("{\"error\":\"denied\"}") };
    await assert.rejects(
      bridge.fetchArtifactPreview("art-3"),
      (error: unknown) => error instanceof CompanionRequestError && error.status === 403,
    );

    backplane.previewResponse = { status: 404, contentType: "application/json", body: Buffer.from("{\"error\":\"missing\"}") };
    await assert.rejects(
      bridge.fetchArtifactPreview("art-4"),
      (error: unknown) => error instanceof CompanionRequestError && error.status === 404,
    );
  } finally {
    await bridge.stop();
    await backplane.stop();
  }
});

test("hub relays companion events only to satellites that advertised the matching capability", async () => {
  const backplane = new FakeBackplane();
  const baseUrl = await backplane.start();
  const bridge = new CompanionBridge(bridgeConfig(baseUrl));
  const server = new RealtimeHubServer(testHubConfig(), {
    agent: new FakeAgent(),
    voxtaTts: null,
    voxtaStt: null,
    companion: bridge,
  });
  let capable: TestClient | null = null;
  let plain: TestClient | null = null;

  try {
    await server.start();
    await waitFor(() => backplane.sseConnectionCount >= 1, "bridge SSE connection");
    const port = (server.address() as AddressInfo).port;
    capable = await TestClient.connect(port, "companion-app", APPROVAL_CAPABILITIES);
    plain = await TestClient.connect(port, "plain-speaker", PLAIN_CAPABILITIES);

    backplane.emit({
      kind: "approval.requested",
      payload: {
        id: "appr-1",
        title: "Send outbound message",
        requestedAt: "2026-07-09T00:00:00Z",
        redactedContext: "Redacted summary only",
        status: "pending",
        secretTranscript: "must never reach satellites",
      },
      emittedAt: "2026-07-09T00:00:00Z",
    });
    backplane.emit({
      kind: "artifact.created",
      payload: {
        id: "art-1",
        label: "Generated sketch",
        mediaType: "image/png",
        provenance: "image_generation",
        createdAt: "2026-07-09T00:00:01Z",
        previewable: true,
      },
      emittedAt: "2026-07-09T00:00:01Z",
    });
    backplane.emit({
      kind: "tool.activity",
      payload: { id: "act-1", tool: "web_search", phase: "started", timestamp: "2026-07-09T00:00:02Z" },
      emittedAt: "2026-07-09T00:00:02Z",
    });

    const approvalMessage = await capable.waitForMessage("approval.requested");
    assert.deepEqual(approvalMessage, {
      type: "approval.requested",
      data: {
        id: "appr-1",
        title: "Send outbound message",
        requestedAt: "2026-07-09T00:00:00Z",
        redactedContext: "Redacted summary only",
        status: "pending",
      },
    });
    await capable.waitForMessage("artifact.created");
    await capable.waitForMessage("tool.activity");

    const leaked = plain.messages.filter((message) =>
      message.type === "approval.requested"
      || message.type === "artifact.created"
      || message.type === "tool.activity");
    assert.deepEqual(leaked, []);
  } finally {
    await capable?.close();
    await plain?.close();
    await server.close();
    await backplane.stop();
  }
});

test("hub rejects approval decisions from satellites without the approvals capability", async () => {
  const backplane = new FakeBackplane();
  const baseUrl = await backplane.start();
  const bridge = new CompanionBridge(bridgeConfig(baseUrl));
  const server = new RealtimeHubServer(testHubConfig(), {
    agent: new FakeAgent(),
    voxtaTts: null,
    voxtaStt: null,
    companion: bridge,
  });
  let client: TestClient | null = null;

  try {
    await server.start();
    const port = (server.address() as AddressInfo).port;
    client = await TestClient.connect(port, "plain-speaker", PLAIN_CAPABILITIES);

    client.send({ type: "approval.decision", id: "appr-1", decision: "approve" });
    const error = await client.waitForMessage("error-event");
    assert.match(
      (error as Extract<HubToClientMessage, { type: "error-event" }>).data.message,
      /did not advertise the approvals capability/,
    );
    assert.equal(backplane.approvalRequests.length, 0);
  } finally {
    await client?.close();
    await server.close();
    await backplane.stop();
  }
});

test("hub proxies approval decisions with satellite attribution and relays failures", async () => {
  const backplane = new FakeBackplane();
  const baseUrl = await backplane.start();
  const bridge = new CompanionBridge(bridgeConfig(baseUrl));
  const server = new RealtimeHubServer(testHubConfig(), {
    agent: new FakeAgent(),
    voxtaTts: null,
    voxtaStt: null,
    companion: bridge,
  });
  let client: TestClient | null = null;

  try {
    await server.start();
    await waitFor(() => backplane.sseConnectionCount >= 1, "bridge SSE connection");
    const port = (server.address() as AddressInfo).port;
    client = await TestClient.connect(port, "companion-app", APPROVAL_CAPABILITIES);

    backplane.approvalResponse = { status: 200, body: JSON.stringify({ id: "appr-1", status: "approved" }) };
    client.send({ type: "approval.decision", id: "appr-1", decision: "approve" });
    await waitFor(() => backplane.approvalRequests.length === 1, "approval decision proxying");
    assert.deepEqual(backplane.approvalRequests[0]?.body, {
      decision: "approve",
      satelliteId: "companion-app",
      deviceId: "companion-app-device",
    });

    backplane.emit({
      kind: "approval.resolved",
      payload: { id: "appr-1", status: "approved", resolvedAt: "2026-07-09T00:00:03Z" },
      emittedAt: "2026-07-09T00:00:03Z",
    });
    const resolved = await client.waitForMessage("approval.resolved");
    assert.deepEqual(resolved, {
      type: "approval.resolved",
      data: { id: "appr-1", status: "approved", resolvedAt: "2026-07-09T00:00:03Z" },
    });

    for (const status of [403, 404, 409]) {
      backplane.approvalResponse = {
        status,
        body: status === 409
          ? JSON.stringify({
            error: {
              message: "Approval already resolved",
              type: "conflict",
              details: { id: `appr-${status}`, status: "expired" },
            },
          })
          : JSON.stringify({ error: { message: "refused", type: "forbidden" } }),
      };
      client.clearMessages();
      client.send({ type: "approval.decision", id: `appr-${status}`, decision: "deny" });
      const error = await client.waitForMessage("error-event");
      assert.match(
        (error as Extract<HubToClientMessage, { type: "error-event" }>).data.message,
        new RegExp(`\\(${status}\\)`),
      );
    }
  } finally {
    await client?.close();
    await server.close();
    await backplane.stop();
  }
});

test("hub serves artifact previews to capable satellites and fails closed otherwise", async () => {
  const backplane = new FakeBackplane();
  const baseUrl = await backplane.start();
  const bridge = new CompanionBridge(bridgeConfig(baseUrl, { previewMaxBytes: 32 }));
  const server = new RealtimeHubServer(testHubConfig(), {
    agent: new FakeAgent(),
    voxtaTts: null,
    voxtaStt: null,
    companion: bridge,
  });
  let capable: TestClient | null = null;
  let plain: TestClient | null = null;

  try {
    await server.start();
    const port = (server.address() as AddressInfo).port;
    capable = await TestClient.connect(port, "companion-app", APPROVAL_CAPABILITIES);
    plain = await TestClient.connect(port, "plain-speaker", PLAIN_CAPABILITIES);

    backplane.previewResponse = {
      status: 200,
      contentType: "image/png",
      body: Buffer.from("png-preview-bytes"),
    };
    capable.send({ type: "artifact.preview", requestId: "req-1", artifactId: "art-1" });
    const result = await capable.waitForMessage("artifact.preview.result");
    assert.deepEqual(result, {
      type: "artifact.preview.result",
      requestId: "req-1",
      artifactId: "art-1",
      mediaType: "image/png",
      data: Buffer.from("png-preview-bytes").toString("base64"),
    });

    backplane.previewResponse = { status: 403, contentType: "application/json", body: Buffer.from("{\"error\":\"denied\"}") };
    capable.send({ type: "artifact.preview", requestId: "req-2", artifactId: "art-2" });
    const denied = await capable.waitForMessage("artifact.preview.error");
    assert.match(
      (denied as Extract<HubToClientMessage, { type: "artifact.preview.error" }>).message,
      /\(403\)/,
    );

    backplane.previewResponse = { status: 200, contentType: "image/png", body: Buffer.alloc(128, 1) };
    capable.clearMessages();
    capable.send({ type: "artifact.preview", requestId: "req-3", artifactId: "art-3" });
    const tooLarge = await capable.waitForMessage("artifact.preview.error");
    assert.match(
      (tooLarge as Extract<HubToClientMessage, { type: "artifact.preview.error" }>).message,
      /size cap/,
    );

    plain.send({ type: "artifact.preview", requestId: "req-4", artifactId: "art-1" });
    const noCapability = await plain.waitForMessage("artifact.preview.error");
    assert.match(
      (noCapability as Extract<HubToClientMessage, { type: "artifact.preview.error" }>).message,
      /did not advertise the artifact capability/,
    );
  } finally {
    await capable?.close();
    await plain?.close();
    await server.close();
    await backplane.stop();
  }
});

test("hub without a companion bridge fails closed for approvals and previews", async () => {
  const server = new RealtimeHubServer(testHubConfig(), {
    agent: new FakeAgent(),
    voxtaTts: null,
    voxtaStt: null,
    companion: null,
  });
  let client: TestClient | null = null;

  try {
    await server.start();
    const port = (server.address() as AddressInfo).port;
    client = await TestClient.connect(port, "companion-app", APPROVAL_CAPABILITIES);

    client.send({ type: "approval.decision", id: "appr-1", decision: "approve" });
    const decisionError = await client.waitForMessage("error-event");
    assert.match(
      (decisionError as Extract<HubToClientMessage, { type: "error-event" }>).data.message,
      /Companion bridge is not configured/,
    );

    client.send({ type: "artifact.preview", requestId: "req-1", artifactId: "art-1" });
    const previewError = await client.waitForMessage("artifact.preview.error");
    assert.match(
      (previewError as Extract<HubToClientMessage, { type: "artifact.preview.error" }>).message,
      /Companion bridge is not configured/,
    );
  } finally {
    await client?.close();
    await server.close();
  }
});

class FakeAgent implements AgentRuntimeAdapter {
  async *streamReply(_input: {
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
  }): AsyncGenerator<string, string, void> {
    yield "ok";
    return "ok";
  }

  async close(): Promise<void> {}
}

class TestClient {
  readonly messages: HubToClientMessage[] = [];

  private constructor(
    private readonly socket: WebSocket,
  ) {
    socket.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)) as HubToClientMessage);
    });
  }

  static async connect(
    port: number,
    satelliteId: string,
    capabilities: SatelliteCapabilities,
  ): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const client = new TestClient(socket);
    client.send({
      type: "hello",
      deviceId: `${satelliteId}-device`,
      deviceName: `${satelliteId} device`,
      sessionId: `companion-test:${satelliteId}`,
      satelliteId,
      satelliteName: satelliteId,
      capabilities,
    });
    await client.waitForMessage("hello.ack");
    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  clearMessages(): void {
    this.messages.length = 0;
  }

  async waitForMessage(type: HubToClientMessage["type"]): Promise<HubToClientMessage> {
    await waitFor(() => this.messages.some((message) => message.type === type), `message ${type}`);
    const found = this.messages.find((message) => message.type === type);
    assert.ok(found);
    return found;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

class FakeBackplane {
  approvalResponse: { status: number; body: string } = {
    status: 200,
    body: JSON.stringify({ id: "appr-1", status: "approved" }),
  };
  previewResponse: { status: number; contentType?: string; body: Buffer } = {
    status: 404,
    contentType: "application/json",
    body: Buffer.from("{\"error\":\"not found\"}"),
  };
  readonly approvalRequests: Array<{ id: string; authorization?: string; body: unknown }> = [];
  readonly previewRequests: string[] = [];
  sseConnectionCount = 0;
  lastEventsAuthorization: string | undefined;
  lastEventsQuery: Record<string, string> | undefined;
  lastPreviewQuery: Record<string, string> | undefined;

  private readonly server: http.Server;
  private readonly sseResponses = new Set<http.ServerResponse>();

  constructor() {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        response.statusCode = 500;
        response.end(String(error));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  emit(envelope: unknown): void {
    const frame = `event: companion\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const response of this.sseResponses) {
      response.write(frame);
    }
  }

  endStreams(): void {
    for (const response of this.sseResponses) {
      response.end();
    }
    this.sseResponses.clear();
  }

  async stop(): Promise<void> {
    this.endStreams();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/companion/events") {
      if (!hasIdentityQuery(url)) {
        this.rejectMissingIdentity(response);
        return;
      }
      this.sseConnectionCount += 1;
      this.lastEventsAuthorization = request.headers.authorization;
      this.lastEventsQuery = identityQueryOf(url);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      this.sseResponses.add(response);
      request.on("close", () => {
        this.sseResponses.delete(response);
      });
      return;
    }
    const approvalMatch = url.pathname.match(/^\/companion\/approvals\/([^/]+)$/);
    if (request.method === "POST" && approvalMatch?.[1]) {
      const body = await readBody(request);
      this.approvalRequests.push({
        id: decodeURIComponent(approvalMatch[1]),
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.writeHead(this.approvalResponse.status, { "Content-Type": "application/json" });
      response.end(this.approvalResponse.body);
      return;
    }
    const previewMatch = url.pathname.match(/^\/companion\/artifacts\/([^/]+)\/preview$/);
    if (request.method === "GET" && previewMatch?.[1]) {
      if (!hasIdentityQuery(url)) {
        this.rejectMissingIdentity(response);
        return;
      }
      this.previewRequests.push(decodeURIComponent(previewMatch[1]));
      this.lastPreviewQuery = identityQueryOf(url);
      response.writeHead(this.previewResponse.status, {
        ...(this.previewResponse.contentType ? { "Content-Type": this.previewResponse.contentType } : {}),
        "Content-Length": String(this.previewResponse.body.byteLength),
      });
      response.end(this.previewResponse.body);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end("{\"error\":\"unknown route\"}");
  }

  private rejectMissingIdentity(response: http.ServerResponse): void {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      error: { message: "Missing satellite registry identity query", type: "forbidden" },
    }));
  }
}

function hasIdentityQuery(url: URL): boolean {
  return Boolean(
    url.searchParams.get("satelliteId")
    && url.searchParams.get("endpointId")
    && url.searchParams.get("claimType"),
  );
}

function identityQueryOf(url: URL): Record<string, string> {
  return {
    satelliteId: url.searchParams.get("satelliteId") ?? "",
    endpointId: url.searchParams.get("endpointId") ?? "",
    claimType: url.searchParams.get("claimType") ?? "",
  };
}

function bridgeConfig(baseUrl: string, overrides: Partial<CompanionBridgeConfig> = {}): CompanionBridgeConfig {
  return {
    baseUrl,
    apiKey: "companion-key",
    identity: { ...TEST_IDENTITY },
    previewMaxBytes: 1_048_576,
    reconnectBaseMs: 10,
    reconnectMaxMs: 40,
    ...overrides,
  };
}

function testHubConfig(): HubConfig {
  const satelliteClaim = normalizeSatelliteClaimConfig({
    capabilityProfile: "text-only",
    satelliteId: "hub-companion-test",
    endpointId: "companion-test",
    displayName: "Companion Test Endpoint",
  });
  return {
    agentRuntime: "psfn",
    textOnlyMode: true,
    bindHost: "127.0.0.1",
    port: 0,
    deepgramApiKey: null,
    elevenlabsApiKey: null,
    elevenlabsVoiceId: null,
    elevenlabsModelId: "eleven_flash_v2_5",
    artifactsRoot: ".artifacts/test-companion",
    psfn: {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test",
      model: "psfn",
      channelType: satelliteClaim.channelType,
      satelliteClaim,
    },
    hermes: null,
    companion: null,
    voxta: {
      enabled: false,
      satelliteId: "voxta-vam",
      satelliteName: "Voxta VaM",
      sessionId: null,
      chatId: null,
      assistantId: "psfn-assistant",
      assistantName: "PSFN",
      userId: "voxta-user",
      userName: "User",
      appLabel: "PSFN Satellite Hub",
      clientVersion: "1.2.1",
      publicBaseUrl: null,
      audioFolder: null,
      sttStreamEnabled: false,
      visionCaptureTimeoutMs: 1_500,
      actionAllowlist: [],
    },
    sessionTtlSeconds: 300,
  };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
