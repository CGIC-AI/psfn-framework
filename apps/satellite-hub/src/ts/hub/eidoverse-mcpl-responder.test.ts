import assert from "node:assert/strict";
import test from "node:test";

import { EidoverseMcplResponder } from "./eidoverse-mcpl-responder.js";
import type { JsonRpcRequestFrame } from "./eidoverse-mcpl-wire.js";

function request(method: string, params?: unknown): JsonRpcRequestFrame {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

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

test("the commit notification's removals retire the old channel", () => {
  const responder = new EidoverseMcplResponder();
  responder.handle(request("channels/register", { channels: [COMMONS] }));
  const removal = responder.handle(request("channels/changed", { removed: ["world:commons"] }));
  assert.deepEqual(removal.result, { results: [] });
  assert.deepEqual(responder.channelIds(), []);
  assert.equal(responder.currentChannelId(), null);
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
