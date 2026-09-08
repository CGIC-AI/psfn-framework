import assert from "node:assert/strict";
import test from "node:test";

import { EidoverseMcplClient } from "./eidoverse-mcpl-client.js";
import type { EidoverseMcplConfig } from "./eidoverse-mcpl-config.js";
import { createEidoverseMcplWakeRuntime } from "./eidoverse-mcpl-runtime.js";
import { effectiveCapabilitiesForFeatureSets } from "./eidoverse-mcpl-wire.js";
import { EidoverseMcplDoor } from "../test-support/eidoverse-mcpl-door.js";

const TOKEN = "door-identity-token";
const FEATURE_SETS = ["eidoverse.world", "eidoverse.embodiment", "eidoverse.travel"];

function config(door: EidoverseMcplDoor, overrides: Partial<EidoverseMcplConfig> = {}): EidoverseMcplConfig {
  return {
    doorUrl: door.url,
    tokenRef: "EIDOVERSE_JOIN_TOKEN",
    worldName: "commons",
    agentName: "companion",
    featureSets: FEATURE_SETS,
    effectiveCapabilities: effectiveCapabilitiesForFeatureSets(FEATURE_SETS),
    catchupWake: false,
    reconnectBaseMs: 10,
    reconnectMaxMs: 40,
    reconnectMaxAttempts: 3,
    requestTimeoutMs: 1_000,
    handshakeTimeoutMs: 2_000,
    ambientSayDebounceMs: 50,
    ...overrides,
  };
}

const credential = async (): Promise<string> => TOKEN;

class RecordingTarget {
  readonly turns: string[] = [];

  async handleEidoverseAddressedUtterance(input: { userText: string }): Promise<string | null> {
    this.turns.push(input.userText);
    return null;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the handshake dials with the identity token and states the Hub's own grant", async () => {
  const door = await EidoverseMcplDoor.start({ world: "commons", tokens: [TOKEN] });
  const client = new EidoverseMcplClient(config(door), credential);
  try {
    await client.start();
    await door.waitForHandshake();
    assert.deepEqual(door.admittedTokens, [TOKEN], "the token rides in the dial URL");
    assert.deepEqual(door.enabledFeatureSets, [FEATURE_SETS]);
    assert.deepEqual(
      [...(door.grants[0] ?? [])].sort(),
      ["channels.incoming", "channels.lifecycle", "channels.publish", "channels.register", "tools"],
    );
    assert.equal(await client.look(), "A sunlit atrium.");
    await client.say("hello");
    assert.deepEqual(door.said, ["hello"]);
  } finally {
    await client.close();
    await door.close();
  }
});

test("a door that refuses the identity token yields no session", async () => {
  const door = await EidoverseMcplDoor.start({ world: "commons", tokens: ["a-different-token"] });
  const client = new EidoverseMcplClient(config(door), credential);
  try {
    await assert.rejects(() => client.start(), /connection failed/);
    assert.equal(door.refusedDials, 1);
  } finally {
    await client.close();
    await door.close();
  }
});

test("pushed channel traffic produces the Phase 1 wake decisions", async () => {
  const door = await EidoverseMcplDoor.start({ world: "commons", tokens: [TOKEN] });
  const client = new EidoverseMcplClient(config(door), credential);
  const target = new RecordingTarget();
  const wake = createEidoverseMcplWakeRuntime(target, { ambientSayDebounceMs: 50, catchupWake: false }, {
    logger: { warn: () => undefined },
  });
  client.setIncomingHandler((messages) => wake.deliver(messages));
  try {
    await client.start();
    await door.waitForHandshake();
    await door.registerChannel();
    assert.equal(client.currentWorldName(), "commons");

    await door.deliver([
      door.message({ text: "* Ada arrived in the world", tags: ["chat:ambient", "eidoverse:presence"] }),
      door.message({ text: "* Ada is no longer nearby", tags: ["chat:ambient", "eidoverse:depart"] }),
      door.message({
        text: "Ada: while you were away",
        tags: ["chat:mention", "chat:addressed", "eidoverse:catchup"],
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(target.turns, [], "presence, depart and replay must not start a turn");

    await door.deliver([
      door.message({
        text: "Ada: are you there?",
        tags: ["chat:mention", "chat:addressed"],
        author: { id: "ada", name: "Ada" },
      }),
      door.message({ text: "* Ada walked up to you", tags: ["chat:addressed", "eidoverse:approach"] }),
    ]);
    await waitFor(() => target.turns.length === 2, "two addressed wakes");
    assert.deepEqual(target.turns, ["Ada: are you there?", "* Ada walked up to you"]);
  } finally {
    await wake.close();
    await client.close();
    await door.close();
  }
});

test("catchup replay wakes only when the operator opts in", async () => {
  const door = await EidoverseMcplDoor.start({ world: "commons", tokens: [TOKEN] });
  const client = new EidoverseMcplClient(config(door, { catchupWake: true }), credential);
  const target = new RecordingTarget();
  const wake = createEidoverseMcplWakeRuntime(target, { ambientSayDebounceMs: 50, catchupWake: true }, {
    logger: { warn: () => undefined },
  });
  client.setIncomingHandler((messages) => wake.deliver(messages));
  try {
    await client.start();
    await door.waitForHandshake();
    await door.deliver([door.message({
      text: "Ada: while you were away",
      tags: ["chat:mention", "chat:addressed", "eidoverse:catchup"],
    })]);
    await waitFor(() => target.turns.length === 1, "the opted-in replay wake");
  } finally {
    await wake.close();
    await client.close();
    await door.close();
  }
});

test("a malformed frame is dropped and never becomes a wake", async () => {
  const door = await EidoverseMcplDoor.start({ world: "commons", tokens: [TOKEN] });
  const warnings: string[] = [];
  const client = new EidoverseMcplClient(config(door), credential, {
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
  });
  const target = new RecordingTarget();
  const wake = createEidoverseMcplWakeRuntime(target, { ambientSayDebounceMs: 50, catchupWake: false }, {
    logger: { warn: () => undefined },
  });
  client.setIncomingHandler((messages) => wake.deliver(messages));
  try {
    await client.start();
    await door.waitForHandshake();
    await door.deliver([{ channelId: "world:commons", messageId: "ev-x" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(target.turns, []);
    assert.equal(warnings.some((message) => message.includes("malformed incoming batch")), true);
  } finally {
    await wake.close();
    await client.close();
    await door.close();
  }
});

test("travel answers the door's PREPARE question while its own tool call is pending", async () => {
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    travelWorlds: ["annex"],
  });
  const client = new EidoverseMcplClient(config(door), credential);
  try {
    await client.start();
    await door.waitForHandshake();
    await door.registerChannel();
    const arrival = await client.travel("annex");
    assert.match(arrival, /^Arrived in "annex"/);
    assert.deepEqual(door.prepared, ["annex"], "the door asked before it moved the body");
    assert.deepEqual(door.preparedAccepted, [true], "self-initiated travel is always accepted");
    assert.equal(door.currentWorld(), "annex");
    assert.equal(client.currentWorldName(), "annex");
  } finally {
    await client.close();
    await door.close();
  }
});

test("a refused destination leaves the body where it was", async () => {
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    travelWorlds: ["annex"],
  });
  const client = new EidoverseMcplClient(config(door), credential);
  try {
    await client.start();
    await door.waitForHandshake();
    await door.registerChannel();
    await assert.rejects(() => client.travel("forbidden"), /travel request failed/);
    assert.equal(door.currentWorld(), "commons");
    assert.deepEqual(door.prepared, [], "a policy refusal never reaches the prepare phase");
  } finally {
    await client.close();
    await door.close();
  }
});

test("a door that never answers travel fails closed at the request timeout", async () => {
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    travelWorlds: ["annex"],
    travelDelayMs: 400,
  });
  const client = new EidoverseMcplClient(config(door, { requestTimeoutMs: 60 }), credential);
  try {
    await client.start();
    await door.waitForHandshake();
    await assert.rejects(() => client.travel("annex"), /travel request failed/);
  } finally {
    await client.close();
    await door.close();
  }
});

test("denying channels.lifecycle keeps the world and only costs the ability to leave", async () => {
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    travelWorlds: ["annex"],
  });
  const client = new EidoverseMcplClient(
    config(door, {
      featureSets: ["eidoverse.world", "eidoverse.embodiment"],
      effectiveCapabilities: ["channels.register", "channels.publish", "channels.incoming", "tools"],
    }),
    credential,
  );
  const target = new RecordingTarget();
  const wake = createEidoverseMcplWakeRuntime(target, { ambientSayDebounceMs: 50, catchupWake: false }, {
    logger: { warn: () => undefined },
  });
  client.setIncomingHandler((messages) => wake.deliver(messages));
  try {
    await client.start();
    await door.waitForHandshake();
    await door.registerChannel();
    await door.deliver([door.message({
      text: "Ada: still here?",
      tags: ["chat:mention", "chat:addressed"],
    })]);
    await waitFor(() => target.turns.length === 1, "an addressed wake without channels.lifecycle");
    await assert.rejects(() => client.travel("annex"), /travel request failed/);
    assert.equal(door.currentWorld(), "commons");
  } finally {
    await wake.close();
    await client.close();
    await door.close();
  }
});

test("a dropped connection reconnects within the bounded budget and re-states the grant", async () => {
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    dropAfterFirstPolicy: true,
  });
  const client = new EidoverseMcplClient(config(door), credential);
  try {
    await client.start();
    await waitFor(() => door.connections >= 2, "the reconnect dial");
    await door.waitForHandshake();
    assert.equal(door.grants.length >= 2, true, "the reconnected session re-states the grant");
    let looked: string | null = null;
    await waitFor(async () => {
      try {
        looked = await client.look();
        return true;
      } catch {
        return false;
      }
    }, "the reconnected session answering a tool call");
    assert.equal(looked, "A sunlit atrium.");
  } finally {
    await client.close();
    await door.close();
  }
});
