import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import type { HomeAssistantConfig, HubControlConfig } from "../../shared/env.js";
import { HomeAssistantClient } from "./client.js";
import { HomeAssistantControlServer } from "./control-server.js";

const CONTROL_TOKEN = "hub-control-test-token";

test("HomeAssistantClient authenticates, hydrates state, subscribes, and calls a service", async () => {
  const mock = await MockHomeAssistant.start();
  const client = new HomeAssistantClient(configFor(mock.baseUrl));
  client.start();
  try {
    await waitFor(() => client.health().status === "ready");
    assert.equal(client.health().haVersion, "2026.7.0");
    assert.equal(client.getStates(["light.office"])[0]?.state, "off");

    mock.emitState("light.office", "on", { brightness: 128 });
    await waitFor(() => client.getStates(["light.office"])[0]?.state === "on");

    const result = await client.callService({
      requestId: "request-1",
      domain: "light",
      service: "turn_off",
      entityIds: ["light.office"],
    });
    assert.equal(result.contextId, "ha-context-1");
    assert.equal(mock.serviceCallCount, 1);
  } finally {
    await client.close();
    await mock.close();
  }
});

test("private control server authenticates, validates, and deduplicates service calls", async () => {
  const mock = await MockHomeAssistant.start();
  const client = new HomeAssistantClient(configFor(mock.baseUrl));
  const controlConfig: HubControlConfig = {
    bindHost: "127.0.0.1",
    port: 0,
    token: CONTROL_TOKEN,
    maxBodyBytes: 4096,
  };
  const control = new HomeAssistantControlServer(controlConfig, client);
  client.start();
  await control.start();
  try {
    await waitFor(() => client.health().status === "ready");
    const address = control.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/internal/v1/home-assistant/health`);
    assert.equal(unauthorized.status, 401);

    const states = await post(baseUrl, "/internal/v1/home-assistant/states", {
      entityIds: ["light.office"],
    });
    assert.equal(states.status, 200);
    assert.equal((await states.json() as { states: Array<{ state: string }> }).states[0]?.state, "off");

    const body = {
      requestId: "autonomy:office:1",
      domain: "light",
      service: "turn_on",
      entityIds: ["light.office"],
      data: { brightness_pct: 20, transition: 2 },
    };
    const first = await post(baseUrl, "/internal/v1/home-assistant/call-service", body);
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { replayed: boolean }).replayed, false);
    const replay = await post(baseUrl, "/internal/v1/home-assistant/call-service", body);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
    assert.equal(mock.serviceCallCount, 1);

    const conflict = await post(baseUrl, "/internal/v1/home-assistant/call-service", {
      ...body,
      service: "turn_off",
    });
    assert.equal(conflict.status, 409);
    assert.equal(mock.serviceCallCount, 1);

    const denied = await post(baseUrl, "/internal/v1/home-assistant/call-service", {
      requestId: "dangerous:1",
      domain: "lock",
      service: "turn_on",
      entityIds: ["lock.front_door"],
    });
    assert.equal(denied.status, 400);
    assert.equal(mock.serviceCallCount, 1);
  } finally {
    await control.close();
    await client.close();
    await mock.close();
  }
});

function configFor(baseUrl: string): HomeAssistantConfig {
  return {
    baseUrl,
    token: "ha-test-token",
    reconnectBaseMs: 10,
    reconnectMaxMs: 50,
    requestTimeoutMs: 1_000,
  };
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONTROL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class MockHomeAssistant {
  readonly baseUrl: string;
  serviceCallCount = 0;
  private activeSocket: WebSocket | null = null;

  private constructor(
    private readonly httpServer: http.Server,
    private readonly wsServer: WebSocketServer,
    address: AddressInfo,
  ) {
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  static async start(): Promise<MockHomeAssistant> {
    const httpServer = http.createServer();
    const wsServer = new WebSocketServer({ server: httpServer, path: "/api/websocket" });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const mock = new MockHomeAssistant(httpServer, wsServer, httpServer.address() as AddressInfo);
    wsServer.on("connection", (socket) => mock.handleConnection(socket));
    return mock;
  }

  emitState(entityId: string, state: string, attributes: Record<string, unknown>): void {
    this.activeSocket?.send(JSON.stringify({
      id: 2,
      type: "event",
      event: {
        event_type: "state_changed",
        data: {
          entity_id: entityId,
          old_state: null,
          new_state: stateRecord(entityId, state, attributes),
        },
      },
    }));
  }

  async close(): Promise<void> {
    for (const client of this.wsServer.clients) client.terminate();
    await new Promise<void>((resolve) => this.wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  private handleConnection(socket: WebSocket): void {
    this.activeSocket = socket;
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.7.0" }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth") {
        assert.equal(message.access_token, "ha-test-token");
        socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.7.0" }));
        return;
      }
      const id = message.id as number;
      if (message.type === "get_states") {
        socket.send(JSON.stringify({
          id,
          type: "result",
          success: true,
          result: [stateRecord("light.office", "off", { friendly_name: "Office Light" })],
        }));
        return;
      }
      if (message.type === "subscribe_events") {
        socket.send(JSON.stringify({ id, type: "result", success: true, result: null }));
        return;
      }
      if (message.type === "call_service") {
        this.serviceCallCount += 1;
        socket.send(JSON.stringify({
          id,
          type: "result",
          success: true,
          result: { context: { id: "ha-context-1" }, response: null },
        }));
      }
    });
  }
}

function stateRecord(entityId: string, state: string, attributes: Record<string, unknown>): Record<string, unknown> {
  return {
    entity_id: entityId,
    state,
    attributes,
    last_changed: "2026-07-10T00:00:00Z",
    last_updated: "2026-07-10T00:00:00Z",
  };
}
