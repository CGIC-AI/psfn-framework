import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EidoverseEmbodiedSessionAdapter } from "./eidoverse-adapter.js";
import { EidoverseMcplClient } from "./eidoverse-mcpl-client.js";
import type { EidoverseMcplConfig } from "./eidoverse-mcpl-config.js";
import { createEidoverseMcplWakeRuntime } from "./eidoverse-mcpl-runtime.js";
import { effectiveCapabilitiesForFeatureSets } from "./eidoverse-mcpl-wire.js";
import {
  EidoverseSnapshotSource,
  loadEidoverseSnapshotConfig,
} from "./eidoverse-snapshot.js";
import {
  EmbodiedSessionRegistry,
  type PsfnChannelContext,
} from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { SessionStore } from "./session-store.js";
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

test("the grant states the feature sets the operator withheld, and travel is one of them", async () => {
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    travelWorlds: ["annex"],
  });
  const withheld = ["eidoverse.world", "eidoverse.embodiment"];
  const client = new EidoverseMcplClient(
    config(door, {
      featureSets: withheld,
      effectiveCapabilities: effectiveCapabilitiesForFeatureSets(withheld),
    }),
    credential,
  );
  try {
    await client.start();
    await door.waitForHandshake();
    assert.deepEqual(door.enabledFeatureSets, [withheld]);
    assert.deepEqual(
      door.disabledFeatureSets,
      [["eidoverse.travel", "eidoverse.typing"]],
      "every declared set the operator did not select is named as disabled",
    );
    // The door's own receipt now says the set is off, which the capability
    // grant alone could never express: travel's `uses` are a subset of the
    // paths presence and embodiment already need.
    assert.deepEqual(
      (door.receipts[0]?.unavailableFeatures as Array<{ featureSet: string }> | undefined)
        ?.map((entry) => entry.featureSet),
      ["eidoverse.travel", "eidoverse.typing"],
    );
    assert.equal(client.grantsTravel(), false);
    await assert.rejects(() => client.travel("annex"), /travel request failed/u);
    assert.deepEqual(door.toolCalls, [], "a withheld feature set never reaches the door");
    assert.deepEqual(door.prepared, []);
  } finally {
    await client.close();
    await door.close();
  }
});

test("the default selection keeps travel and disables only the cosmetic set", async () => {
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    travelWorlds: ["annex"],
  });
  const warnings: string[] = [];
  const client = new EidoverseMcplClient(config(door), credential, {
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
  });
  try {
    await client.start();
    await door.waitForHandshake();
    assert.deepEqual(door.enabledFeatureSets, [FEATURE_SETS]);
    assert.deepEqual(door.disabledFeatureSets, [["eidoverse.typing"]]);
    assert.equal(client.grantsTravel(), true);
    assert.equal(
      warnings.some((message) => message.includes("degraded")),
      false,
      "a set the operator withheld coming back unavailable is not drift",
    );
    assert.match(await client.travel("annex"), /Arrived in "annex"/u);
    assert.deepEqual(door.toolCalls, ["travel"]);
    assert.deepEqual(door.prepared, ["annex"]);
  } finally {
    await client.close();
    await door.close();
  }
});

test("a door that degrades a selected feature set is heard, named, and failed closed", async () => {
  // Mirror drift, the routine kind: upstream gives `eidoverse.travel` one more
  // capability than the Hub's hand-maintained table knows to grant. The door
  // reports it in the §6.7 receipt and disables the set.
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    travelWorlds: ["annex"],
    featureSetUses: {
      "eidoverse.world": [
        "channels.register",
        "channels.lifecycle",
        "channels.publish",
        "channels.incoming",
      ],
      "eidoverse.embodiment": ["tools"],
      "eidoverse.travel": ["channels.lifecycle", "tools", "channels.streaming"],
    },
  });
  const warnings: string[] = [];
  const client = new EidoverseMcplClient(config(door), credential, {
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
  });
  try {
    await client.start();
    await door.waitForHandshake();
    assert.deepEqual(
      warnings.filter((message) => message.includes("degraded")),
      ["Eidoverse MCPL feature sets degraded: eidoverse.travel [channels.streaming]"],
      "the drifted set is named, with no door prose",
    );
    assert.equal(client.grantsTravel(), false, "a degraded set takes its surface with it");
    await assert.rejects(() => client.travel("annex"), /travel request failed/u);
    assert.deepEqual(door.toolCalls, []);
    // Everything the door did NOT degrade keeps working.
    assert.equal(await client.look(), "A sunlit atrium.");
  } finally {
    await client.close();
    await door.close();
  }
});

test("a refused or unreadable policy receipt degrades every selected feature set", async () => {
  for (const testCase of [
    {
      label: "refused",
      receipt: { accepted: false, fallback: "mcp-only", reason: "policy refused" },
      warning: "Eidoverse MCPL door refused the feature-set policy; every selected set is degraded",
    },
    {
      label: "unreadable",
      receipt: { ok: "sure" },
      warning: "Eidoverse MCPL feature-set receipt was unreadable; every selected set is degraded",
    },
  ]) {
    const door = await EidoverseMcplDoor.start({
      world: "commons",
      tokens: [TOKEN],
      travelWorlds: ["annex"],
      policyReceipt: testCase.receipt,
    });
    const warnings: string[] = [];
    const client = new EidoverseMcplClient(config(door), credential, {
      logger: { info: () => undefined, warn: (message) => warnings.push(message) },
    });
    try {
      await client.start();
      await door.waitForHandshake();
      assert.equal(
        warnings.includes(testCase.warning),
        true,
        `${testCase.label} receipts are reported once, content-free`,
      );
      assert.equal(client.grantsTravel(), false);
      await assert.rejects(() => client.travel("annex"), /travel request failed/u);
      assert.deepEqual(door.toolCalls, []);
    } finally {
      await client.close();
      await door.close();
    }
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
      door.message({ text: "* Quill arrived in the world", tags: ["chat:ambient", "eidoverse:presence"] }),
      door.message({ text: "* Quill is no longer nearby", tags: ["chat:ambient", "eidoverse:depart"] }),
      door.message({
        text: "Quill: while you were away",
        tags: ["chat:mention", "chat:addressed", "eidoverse:catchup"],
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(target.turns, [], "presence, depart and replay must not start a turn");

    await door.deliver([
      door.message({
        text: "Quill: are you there?",
        tags: ["chat:mention", "chat:addressed"],
        author: { id: "quill", name: "Quill" },
      }),
      door.message({ text: "* Quill walked up to you", tags: ["chat:addressed", "eidoverse:approach"] }),
    ]);
    await waitFor(() => target.turns.length === 2, "two addressed wakes");
    assert.deepEqual(target.turns, ["Quill: are you there?", "* Quill walked up to you"]);
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
      text: "Quill: while you were away",
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
      text: "Quill: still here?",
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

// ── First-person vision on the MCPL transport ──
// The renderer is the world's own HTTP surface, so the door double serves it on
// the same listener the door dials. That is what makes the derived origin real
// here: the Hub is handed only the credential-free door URL and has to reach
// the renderer from it.

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

class VisionAgent implements FrameworkAgentAdapter {
  readonly calls: Array<Parameters<FrameworkAgentAdapter["streamReply"]>[0]> = [];

  async *streamReply(
    input: Parameters<FrameworkAgentAdapter["streamReply"]>[0],
  ): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "ok";
    return "ok";
  }

  async close(): Promise<void> {}
}

interface McplVisionTurn {
  channel: PsfnChannelContext | undefined;
  door: EidoverseMcplDoor;
  warnings: string[];
  baseUrl: string;
}

/**
 * One full MCPL turn with vision wired the way `main.ts` wires it: the door
 * config is the only world address the snapshot path is given, and every
 * logger on the path shares one warning sink so a leaked token would show up.
 */
async function mcplVisionTurn(
  t: { after(fn: () => void): void },
  snap?: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  travelTo?: string,
): Promise<McplVisionTurn> {
  const door = await EidoverseMcplDoor.start({
    world: "commons",
    tokens: [TOKEN],
    travelWorlds: ["annex"],
    ...(snap ? { snap } : {}),
  });
  const doorConfig = config(door);
  const snapshotConfig = loadEidoverseSnapshotConfig({
    transport: "mcpl",
    agentName: doorConfig.agentName,
    doorUrl: doorConfig.doorUrl,
  }, {
    EIDOVERSE_SNAPSHOT_ENABLED: "true",
    EIDOVERSE_SNAPSHOT_TIMEOUT_MS: "1000",
    EIDOVERSE_SNAPSHOT_MAX_BYTES: "4096",
  });
  assert.notEqual(snapshotConfig, null, "an enabled MCPL hub must resolve a snapshot origin");
  const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidoverse-mcpl-vision-"));
  t.after(() => { fs.rmSync(artifactsRoot, { recursive: true, force: true }); });

  const warnings: string[] = [];
  const warn = (message: string): void => { warnings.push(message); };
  const client = new EidoverseMcplClient(doorConfig, credential, { logger: { info: warn, warn } });
  const agent = new VisionAgent();
  const adapter = new EidoverseEmbodiedSessionAdapter({
    worldName: doorConfig.worldName,
    agentName: doorConfig.agentName,
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: null,
  }, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent,
    look: client,
    say: client,
    travel: client,
    snapshot: new EidoverseSnapshotSource(snapshotConfig!, {
      artifactsRoot,
      logger: { warn },
    }),
    logger: { warn },
  });
  const wake = createEidoverseMcplWakeRuntime({
    handleEidoverseAddressedUtterance: async (input) => adapter.handleAddressedUtterance(input),
  }, { ambientSayDebounceMs: 50, catchupWake: false }, { logger: { warn } });
  client.setIncomingHandler((messages) => wake.deliver(messages));
  try {
    await client.start();
    await door.waitForHandshake();
    await door.registerChannel();
    adapter.connect();
    if (travelTo) {
      const outcome = await adapter.travelTo(travelTo);
      assert.equal(outcome.accepted, true, "the door must admit the travel this turn follows");
    }
    await door.deliver([
      door.message({
        text: "Quill: what do you see?",
        tags: ["chat:mention", "chat:addressed"],
        author: { id: "quill", name: "Quill" },
      }),
    ]);
    await waitFor(() => agent.calls.length > 0, "the MCPL turn to reach the agent");
  } finally {
    await wake.close();
    adapter.disconnect();
    await client.close();
    await door.close();
  }
  return {
    channel: agent.calls.at(-1)?.channel,
    door,
    warnings,
    baseUrl: snapshotConfig?.baseUrl ?? "",
  };
}

test("an MCPL turn carries a first-person frame from the origin derived from the door", async (t) => {
  const turn = await mcplVisionTurn(t, (_request, response) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.length });
    response.end(PNG_BYTES);
  });

  assert.equal(turn.baseUrl.startsWith("http://127.0.0.1:"), true, "ws://host/mcpl yields http://host");
  assert.deepEqual(turn.door.snapRequests, ["/snap?world=commons&follow=companion&view=first"]);
  assert.equal(turn.channel?.visionCaptures?.length, 1);
  assert.equal(turn.channel?.visionCaptureImages?.length, 1);
  assert.equal(
    turn.channel?.visionCaptureImages?.[0]?.dataBase64,
    PNG_BYTES.toString("base64"),
    "the frame the renderer served is the frame the turn carries",
  );
  assert.equal(
    (turn.channel?.contextNotes ?? []).some((note) => note.key === "eidoverse.look"),
    true,
    "the text look tier is unchanged by vision",
  );
});

test("vision follows the body into the world it travelled to", async (t) => {
  // The boot world is `commons`; the door serves `/snap` per world and the
  // avatar is present in exactly one of them, so a capture still naming the
  // boot world would 404 for the rest of the process's life.
  const turn = await mcplVisionTurn(t, (_request, response) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.length });
    response.end(PNG_BYTES);
  }, "annex");

  assert.deepEqual(turn.door.prepared, ["annex"], "the door moved the body");
  assert.deepEqual(
    turn.door.snapRequests,
    ["/snap?world=annex&follow=companion&view=first"],
    "the capture follows the live world, not the boot world",
  );
  assert.equal(turn.channel?.visionCaptureImages?.length, 1);
});

test("an MCPL turn with no renderer attached degrades to its text look notes", async (t) => {
  const turn = await mcplVisionTurn(t);

  assert.deepEqual(turn.door.snapRequests, ["/snap?world=commons&follow=companion&view=first"]);
  assert.equal(turn.channel?.visionCaptures, undefined, "no renderer means no vision seam");
  assert.equal(turn.channel?.visionCaptureImages, undefined);
  assert.equal(
    (turn.channel?.contextNotes ?? []).some((note) => note.key === "eidoverse.look"),
    true,
    "the turn still happens on the text tier",
  );
  assert.equal(
    turn.warnings.some((message) => message.includes("Eidoverse snapshot is unavailable")),
    true,
    "an absent renderer says so exactly once, without an address",
  );
  // This is the case that guarantees a log line exists at all, so it is the
  // one that can prove the warning path never prints the identity token.
  assert.equal(
    turn.warnings.every((message) => !message.includes(TOKEN)),
    true,
    `no log line may carry the identity token: ${turn.warnings.join(" | ")}`,
  );
});

test("the identity token reaches neither the derived origin, the snapshot request, nor a log line", async (t) => {
  const turn = await mcplVisionTurn(t, (_request, response) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.length });
    response.end(PNG_BYTES);
  });

  assert.equal(turn.baseUrl.includes(TOKEN), false, "the derived origin never carries the dial token");
  assert.equal(
    turn.door.snapRequests.every((url) => !url.includes(TOKEN) && !url.includes("token")),
    true,
    "the renderer is asked for a frame, not authenticated with the world credential",
  );
  assert.equal(
    turn.warnings.every((message) => !message.includes(TOKEN)),
    true,
    `no log line may carry the identity token: ${turn.warnings.join(" | ")}`,
  );
});
