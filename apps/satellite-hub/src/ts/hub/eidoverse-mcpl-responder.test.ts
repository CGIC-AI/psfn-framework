import assert from "node:assert/strict";
import test from "node:test";

import {
  EidoverseMcplClient,
  type EidoverseMcplSocket,
} from "./eidoverse-mcpl-client.js";
import type { EidoverseMcplConfig } from "./eidoverse-mcpl-config.js";
import { EidoverseMcplResponder } from "./eidoverse-mcpl-responder.js";
import {
  effectiveCapabilitiesForFeatureSets,
  type JsonRpcRequestFrame,
} from "./eidoverse-mcpl-wire.js";

function request(method: string, params?: unknown): JsonRpcRequestFrame {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

const ANNEX = {
  id: "world:annex",
  type: "world",
  label: "eidoverse — annex",
  direction: "bidirectional",
  address: { world: "annex" },
  initiallyOpen: true,
  metadata: { epoch: 2 },
};

const COMMONS = {
  id: "world:commons",
  type: "world",
  label: "eidoverse — commons",
  direction: "bidirectional",
  address: { world: "commons" },
  initiallyOpen: true,
  metadata: { epoch: 1 },
};

test("the door's channel registration is accepted itemized and recorded", () => {
  const responder = new EidoverseMcplResponder();
  const answer = responder.handle(request("channels/register", { channels: [COMMONS] }));
  assert.deepEqual(answer.result, { results: [{ id: "world:commons", accepted: true }] });
  assert.deepEqual(responder.channelIds(), ["world:commons"]);
  assert.equal(responder.currentChannelId(), "world:commons");
  assert.equal(responder.currentWorldName(), "commons");
});

test("the travel PREPARE question is always answered yes", () => {
  const responder = new EidoverseMcplResponder();
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  const prepare = responder.handle(request("channels/changed", {
    added: [{ ...COMMONS, id: "world:annex", address: { world: "annex" }, metadata: { epoch: 2 } }],
  }));
  assert.deepEqual(prepare.result, { results: [{ id: "world:annex", accepted: true }] });
  assert.equal(
    responder.currentWorldName(),
    "annex",
    "the prepared world becomes current so a later publish targets the right channel",
  );
});

test("a PREPARE that only removes retires the old channel", () => {
  const responder = new EidoverseMcplResponder();
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  const removal = responder.handle(request("channels/changed", { removed: ["world:commons"] }));
  assert.deepEqual(removal.result, { results: [] });
  assert.deepEqual(responder.channelIds(), []);
  assert.equal(responder.currentChannelId(), null);
});

test("the COMMIT notification promotes the prepared world and retires the one left", () => {
  const responder = new EidoverseMcplResponder();
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  responder.handle(request("channels/changed", { added: [ANNEX] }));
  assert.deepEqual(
    responder.channelIds(),
    ["world:commons"],
    "a proposal is not committed state until the door says the transition happened",
  );

  // The door names only what it retires: the world it moved to was the
  // PREPARE's own descriptor.
  responder.commit({ removed: ["world:commons"] });
  assert.deepEqual(responder.channelIds(), ["world:annex"]);
  assert.equal(responder.currentChannelId(), "world:annex");
  assert.equal(responder.currentWorldName(), "annex");
});

test("a proposal the door never commits is superseded, never accumulated", () => {
  const responder = new EidoverseMcplResponder();
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  // A travel whose door-side move failed after the host said yes.
  responder.handle(request("channels/changed", { added: [ANNEX] }));
  const attic = { ...COMMONS, id: "world:attic", address: { world: "attic" } };
  responder.handle(request("channels/changed", { added: [attic] }));
  responder.commit({ removed: ["world:commons"] });
  assert.deepEqual(
    responder.channelIds(),
    ["world:attic"],
    "only the transition that actually committed is tracked",
  );
  assert.equal(responder.currentWorldName(), "attic");
});

test("a COMMIT that retires everything leaves no world tracked", () => {
  const responder = new EidoverseMcplResponder();
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  responder.commit({ removed: ["world:commons"] });
  assert.deepEqual(responder.channelIds(), []);
  assert.equal(responder.currentChannelId(), null);
  assert.equal(responder.currentWorldName(), null);
});

test("a COMMIT can update a tracked descriptor and add one the door invented", () => {
  const responder = new EidoverseMcplResponder();
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  responder.commit({
    updated: [{ ...COMMONS, metadata: { epoch: 9 } }],
    added: [ANNEX],
    removed: ["world:unknown"],
  });
  assert.deepEqual(responder.channelIds(), ["world:commons", "world:annex"]);
  assert.deepEqual(
    responder.handle(request("channels/list", {})).result,
    { channels: [{ ...COMMONS, metadata: { epoch: 9 } }, ANNEX] },
  );
  assert.equal(responder.currentWorldName(), "annex");
});

test("a malformed COMMIT is dropped content-free and changes nothing", () => {
  const warnings: string[] = [];
  const responder = new EidoverseMcplResponder({ warn: (message) => warnings.push(message) });
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  responder.commit({ removed: ["world:commons", 7] });
  responder.commit({ added: [{ nope: "world:annex" }] });
  responder.commit("not a record");
  assert.deepEqual(
    responder.channelIds(),
    ["world:commons"],
    "a half-applied belief is worse than the one the hub already held",
  );
  assert.equal(warnings.length, 3);
  assert.equal(
    warnings.every((message) => !message.includes("commons") && !message.includes("nope")),
    true,
    "commit refusal logs stay content-free",
  );
});

test("channels/list answers with the channels this host actually accepted", () => {
  const responder = new EidoverseMcplResponder();
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  assert.deepEqual(responder.handle(request("channels/list", {})).result, { channels: [COMMONS] });
});

test("malformed and unknown inbound requests fail closed", () => {
  const warnings: string[] = [];
  const responder = new EidoverseMcplResponder({ warn: (message) => warnings.push(message) });
  assert.equal(responder.handle(request("channels/register", { channels: "nope" })).error?.code, -32_602);
  assert.equal(responder.handle(request("channels/register", { channels: [{}] })).error?.code, -32_602);
  assert.equal(responder.handle(request("channels/changed", { removed: [7] })).error?.code, -32_602);
  assert.equal(responder.handle(request("inference/request", {})).error?.code, -32_601);
  assert.deepEqual(responder.channelIds(), [], "a refused request must not register anything");
  assert.equal(
    warnings.every((message) => !message.includes("nope")),
    true,
    "refusal logs stay content-free",
  );
});

/**
 * A door made of one socket. It answers the handshake and then writes frames
 * on demand, so a test can drive the client's read loop — including the
 * notification form the responder only ever sees through it — without a port.
 */
class ScriptedDoorSocket implements EidoverseMcplSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly openHandlers: Array<() => void> = [];
  private readonly messageHandlers: Array<(data: string) => void> = [];

  constructor() {
    setTimeout(() => {
      for (const handler of this.openHandlers) handler();
    }, 0);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    const id = frame.id;
    if (typeof frame.method !== "string" || id === undefined) return;
    if (frame.method === "initialize") {
      this.answer(id, { protocolVersion: "2024-11-05", capabilities: {} });
      return;
    }
    if (frame.method === "featureSets/update") {
      this.answer(id, { accepted: true, unavailableFeatures: [] });
      return;
    }
    if (frame.method === "channels/list") this.answer(id, { channels: [COMMONS] });
  }

  close(): void {}

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(): void {}

  onError(): void {}

  /** Write one door-to-host Request onto the wire. */
  emitRequest(id: number, method: string, params: unknown): void {
    this.emit({ jsonrpc: "2.0", id, method, params });
  }

  /** Write one door-to-host Notification onto the wire. */
  emitNotification(method: string, params: unknown): void {
    this.emit({ jsonrpc: "2.0", method, params });
  }

  /** The host's answer to the request carrying this id, if it wrote one. */
  answerTo(id: number): Record<string, unknown> | undefined {
    return this.sent.find((frame) => frame.id === id && frame.method === undefined);
  }

  private emit(frame: Record<string, unknown>): void {
    for (const handler of this.messageHandlers) handler(JSON.stringify(frame));
  }

  private answer(id: unknown, result: unknown): void {
    setTimeout(() => this.emit({ jsonrpc: "2.0", id, result }), 0);
  }
}

function scriptedConfig(): EidoverseMcplConfig {
  const featureSets = ["eidoverse.world", "eidoverse.embodiment", "eidoverse.travel"];
  return {
    doorUrl: "wss://door.example.invalid/mcpl",
    tokenRef: "EIDOVERSE_JOIN_TOKEN",
    worldName: "commons",
    agentName: "companion",
    featureSets,
    effectiveCapabilities: effectiveCapabilitiesForFeatureSets(featureSets),
    catchupWake: false,
    wakeQueueLimit: 4,
    reconnectBaseMs: 10,
    reconnectMaxMs: 40,
    reconnectMaxAttempts: 1,
    requestTimeoutMs: 1_000,
    handshakeTimeoutMs: 2_000,
    ambientSayDebounceMs: 50,
  };
}

test("the door's COMMIT notification reaches the responder through the client", async () => {
  const socket = new ScriptedDoorSocket();
  const client = new EidoverseMcplClient(scriptedConfig(), async () => "door-token", {
    connect: () => socket,
    logger: { info: () => undefined, warn: () => undefined },
  });
  try {
    await client.start();
    assert.equal(client.currentWorldName(), null, "no channel is tracked until the door registers one");

    socket.emitRequest(101, "channels/register", { channels: [COMMONS] });
    assert.equal(client.currentWorldName(), "commons");

    // PREPARE, then the COMMIT the client used to drop on the floor.
    socket.emitRequest(102, "channels/changed", { added: [ANNEX] });
    socket.emitNotification("channels/changed", { removed: ["world:commons"] });

    socket.emitRequest(103, "channels/list", {});
    assert.deepEqual(
      socket.answerTo(103)?.result,
      { channels: [ANNEX] },
      "the world the body left must not be answered for after the door retired it",
    );
    assert.equal(client.currentWorldName(), "annex");
  } finally {
    await client.close();
  }
});
