import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMcplIncomingMessage,
  descriptorWorldName,
  effectiveCapabilitiesForFeatureSets,
  extractSingleToolText,
  hostManifestForCapabilities,
  incomingMessageText,
  parseJsonRpcFrame,
  type McplIncomingChannelMessage,
} from "./eidoverse-mcpl-wire.js";

function message(tags: string[], text = "Quill: hello"): McplIncomingChannelMessage {
  return {
    channelId: "world:commons",
    messageId: "ev-1",
    author: { id: "quill", name: "Quill" },
    timestamp: "2026-09-08T00:00:00.000Z",
    content: [{ type: "text", text }],
    tags,
  };
}

const SUPPRESS_CATCHUP = { catchupKeepsAddressing: false };

test("the door's own tag sets classify into the Phase 1 wake vocabulary", () => {
  assert.equal(
    classifyMcplIncomingMessage(message(["chat:mention", "chat:addressed"]), SUPPRESS_CATCHUP),
    "mention",
  );
  assert.equal(
    classifyMcplIncomingMessage(
      message(["chat:dm", "chat:private", "chat:addressed", "eidoverse:whisper"]),
      SUPPRESS_CATCHUP,
    ),
    "whisper",
  );
  assert.equal(
    classifyMcplIncomingMessage(
      message(["chat:addressed", "eidoverse:approach"], "* Quill walked up to you"),
      SUPPRESS_CATCHUP,
    ),
    "approach",
  );
  assert.equal(
    classifyMcplIncomingMessage(message(["chat:addressed", "eidoverse:reach"]), SUPPRESS_CATCHUP),
    "reach",
  );
  assert.equal(
    classifyMcplIncomingMessage(message(["chat:addressed", "eidoverse:touch"]), SUPPRESS_CATCHUP),
    "touch",
  );
  assert.equal(
    classifyMcplIncomingMessage(message(["chat:ambient", "eidoverse:depart"]), SUPPRESS_CATCHUP),
    "depart",
  );
  assert.equal(
    classifyMcplIncomingMessage(message(["chat:ambient", "eidoverse:presence"]), SUPPRESS_CATCHUP),
    "presence",
  );
  assert.equal(
    classifyMcplIncomingMessage(
      message(["chat:ambient", "eidoverse:activity-digest"]),
      SUPPRESS_CATCHUP,
    ),
    "digest",
  );
  assert.equal(
    classifyMcplIncomingMessage(message(["chat:ambient", "chat:from-agent"]), SUPPRESS_CATCHUP),
    "say",
  );
});

test("untagged and unrecognized traffic is never promoted into a wake", () => {
  assert.equal(classifyMcplIncomingMessage(message([]), SUPPRESS_CATCHUP), null);
  assert.equal(classifyMcplIncomingMessage(message(["discord:role-mention"]), SUPPRESS_CATCHUP), null);
});

test("replayed mentions are catchup by default and keep their addressing only on request", () => {
  const replay = message(["chat:mention", "chat:addressed", "eidoverse:catchup"]);
  assert.equal(
    classifyMcplIncomingMessage(replay, { catchupKeepsAddressing: false }),
    "catchup",
    "the default must let the wake table suppress a reconnect's replayed mentions",
  );
  assert.equal(
    classifyMcplIncomingMessage(replay, { catchupKeepsAddressing: true }),
    "mention",
    "an operator who opts in gets the original addressing back",
  );
});

test("the grant is derived from selected feature sets and nothing else", () => {
  assert.deepEqual(
    effectiveCapabilitiesForFeatureSets(["eidoverse.world", "eidoverse.embodiment", "eidoverse.travel"]).sort(),
    ["channels.incoming", "channels.lifecycle", "channels.publish", "channels.register", "tools"],
  );
  assert.deepEqual(
    effectiveCapabilitiesForFeatureSets(["eidoverse.embodiment"]),
    ["tools"],
    "a narrow selection must not pick up channel authority",
  );
  assert.deepEqual(
    effectiveCapabilitiesForFeatureSets(["not.a.feature.set"]),
    [],
    "an unknown feature set contributes nothing rather than widening the grant",
  );
});

test("typing is never bundled with world presence", () => {
  const grant = effectiveCapabilitiesForFeatureSets(["eidoverse.world", "eidoverse.travel"]);
  assert.equal(grant.includes("channels.streaming"), false);
  assert.equal(grant.includes("channels.incoming"), true, "refusing typing must not cost the world");
  assert.equal(hostManifestForCapabilities(grant).channels.typing, false);
  assert.equal(hostManifestForCapabilities(grant).channels.incoming, true);
});

test("the host manifest advertises exactly what was granted", () => {
  const manifest = hostManifestForCapabilities(effectiveCapabilitiesForFeatureSets(["eidoverse.embodiment"]));
  assert.equal(manifest.version, "0.5");
  assert.equal(manifest.pushEvents, false);
  assert.deepEqual(manifest.channels, {
    register: false,
    lifecycle: false,
    publish: false,
    incoming: false,
    streaming: false,
    acknowledge: false,
    typing: false,
  });
});

test("malformed frames parse to null instead of a guess", () => {
  assert.equal(parseJsonRpcFrame("not json"), null);
  assert.equal(parseJsonRpcFrame(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "x" })), null);
  assert.equal(parseJsonRpcFrame(JSON.stringify({ jsonrpc: "2.0", id: 1 })), null);
  const request = parseJsonRpcFrame(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "channels/register" }));
  assert.equal(request?.kind, "request");
  const notification = parseJsonRpcFrame(JSON.stringify({ jsonrpc: "2.0", method: "channels/changed" }));
  assert.equal(notification?.kind, "notification");
  const response = parseJsonRpcFrame(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { ok: true } }));
  assert.equal(response?.kind, "response");
});

test("a tool result that is an error or not a single text block is refused", () => {
  assert.equal(extractSingleToolText({ content: [{ type: "text", text: "said" }] }), "said");
  assert.throws(() => extractSingleToolText({ content: [{ type: "text", text: "no" }], isError: true }));
  assert.throws(() => extractSingleToolText({ content: [] }));
  assert.throws(() => extractSingleToolText({ content: [{ type: "image", data: "" }] }));
});

test("world names come from the descriptor address, falling back to the channel id", () => {
  assert.equal(descriptorWorldName({ id: "world:annex", address: { world: "annex" } }), "annex");
  assert.equal(descriptorWorldName({ id: "world:annex" }), "annex");
  assert.equal(descriptorWorldName({ id: "something-else" }), null);
});

test("every text block of a delivery joins into the ping line", () => {
  assert.equal(incomingMessageText(message(["chat:mention"], "Quill: hello")), "Quill: hello");
  assert.equal(incomingMessageText({ ...message(["chat:mention"]), content: [] }), "");
});
