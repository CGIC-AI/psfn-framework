import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import type { HomeAssistantConfig, HubControlConfig } from "../../shared/env.js";
import { HomeAssistantClient } from "./client.js";
import { HomeAssistantControlServer } from "./control-server.js";
import {
  createHubDeviceRegistryAuthority,
  type HubDeviceRegistry,
} from "../device-registry.js";

const CONTROL_TOKEN = "hub-control-test-token";
const DEVICE_TOKEN = "office-device-test-token";
const DEVICE_REGISTRY: HubDeviceRegistry = {
  schemaVersion: 1,
  devices: [{
    deviceId: "office-device",
    deviceName: "Office Device",
    satelliteId: "office",
    satelliteName: "Office",
    endpointId: "office-device",
    claimType: "room-satellite",
    credentialSha256: createHash("sha256").update(DEVICE_TOKEN).digest("hex"),
    enrollmentVersion: 1,
    enrollmentAssurance: "device_credential",
    enrollmentStatus: "active",
    companionId: "11111111-1111-4111-8111-111111111111",
    placeId: "office",
    maxCapabilities: { input: [], output: [], control: [], safety: ["local_only"] },
    homeAssistantEntityIds: ["light.office", "fan.main_bedroom"],
  }],
};
const DEVICE_REGISTRY_AUTHORITY = createHubDeviceRegistryAuthority(() => DEVICE_REGISTRY);

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
  assert.throws(
    () => new HomeAssistantControlServer(
      { ...controlConfig, token: DEVICE_TOKEN },
      client,
      DEVICE_REGISTRY_AUTHORITY,
    ),
    /must not match a registered device credential/,
  );
  const control = new HomeAssistantControlServer(controlConfig, client, DEVICE_REGISTRY_AUTHORITY);
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
    }, DEVICE_TOKEN);
    assert.equal(states.status, 200);
    assert.equal((await states.json() as { states: Array<{ state: string }> }).states[0]?.state, "off");

    const gatewayStates = await post(baseUrl, "/internal/v1/home-assistant/states", { entityIds: [] });
    assert.equal(gatewayStates.status, 200);
    assert.equal((await gatewayStates.json() as { states: Array<{ entity_id: string }> }).states[0]?.entity_id, "light.office");

    const body = {
      requestId: "autonomy:office:1",
      domain: "light",
      service: "turn_on",
      entityIds: ["light.office"],
      data: { brightness_pct: 20, transition: 2 },
    };
    const first = await post(baseUrl, "/internal/v1/home-assistant/call-service", body, DEVICE_TOKEN);
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { replayed: boolean }).replayed, false);
    const replay = await post(baseUrl, "/internal/v1/home-assistant/call-service", body, DEVICE_TOKEN);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
    assert.equal(mock.serviceCallCount, 1);

    const conflict = await post(baseUrl, "/internal/v1/home-assistant/call-service", {
      ...body,
      service: "turn_off",
    }, DEVICE_TOKEN);
    assert.equal(conflict.status, 409);
    assert.equal(mock.serviceCallCount, 1);

    const fan = await post(baseUrl, "/internal/v1/home-assistant/call-service", {
      requestId: "human:bedroom-fan:1",
      domain: "fan",
      service: "set_percentage",
      entityIds: ["fan.main_bedroom"],
      data: { percentage: 50 },
    }, DEVICE_TOKEN);
    assert.equal(fan.status, 200);
    assert.equal(mock.serviceCallCount, 2);

    const outsideRoom = await post(baseUrl, "/internal/v1/home-assistant/states", {
      entityIds: ["light.kitchen"],
    }, DEVICE_TOKEN);
    assert.equal(outsideRoom.status, 403);

    const sharedTokenCanControlRegisteredEntity = await post(
      baseUrl,
      "/internal/v1/home-assistant/call-service",
      { ...body, requestId: "gateway:office:1" },
    );
    assert.equal(sharedTokenCanControlRegisteredEntity.status, 200);
    assert.equal(mock.serviceCallCount, 3);

    const sharedTokenCannotEscapeRegistry = await post(baseUrl, "/internal/v1/home-assistant/states", {
      entityIds: ["light.kitchen"],
    });
    assert.equal(sharedTokenCannotEscapeRegistry.status, 403);

    const invalidFanService = await post(baseUrl, "/internal/v1/home-assistant/call-service", {
      requestId: "invalid:light-percentage:1",
      domain: "light",
      service: "set_percentage",
      entityIds: ["light.office"],
      data: { percentage: 50 },
    }, DEVICE_TOKEN);
    assert.equal(invalidFanService.status, 400);
    assert.equal(mock.serviceCallCount, 3);

    const denied = await post(baseUrl, "/internal/v1/home-assistant/call-service", {
      requestId: "dangerous:1",
      domain: "lock",
      service: "turn_on",
      entityIds: ["lock.front_door"],
    }, DEVICE_TOKEN);
    assert.equal(denied.status, 400);
    assert.equal(mock.serviceCallCount, 3);
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

async function post(baseUrl: string, path: string, body: unknown, token = CONTROL_TOKEN): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
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
          result: [
            stateRecord("light.office", "off", { friendly_name: "Office Light" }),
            stateRecord("fan.main_bedroom", "off", { friendly_name: "Bedroom Fan", percentage: 0 }),
          ],
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
