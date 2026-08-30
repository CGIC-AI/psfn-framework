import assert from "node:assert/strict";
import test from "node:test";

import { EidoverseEmbodiedSessionAdapter } from "./eidoverse-adapter.js";
import { parseEidoversePlaceMap } from "./eidoverse-place-map.js";
import {
  EidoversePendingPingsPoller,
  EidoverseWakeFilter,
} from "./eidoverse-wake-filter.js";
import { EmbodiedSessionRegistry } from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { SessionStore } from "./session-store.js";

type ReplyInput = Parameters<FrameworkAgentAdapter["streamReply"]>[0];

class FakeAgent implements FrameworkAgentAdapter {
  readonly calls: ReplyInput[] = [];

  async *streamReply(input: ReplyInput): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "Hello ";
    yield "visitor.";
    return "Hello visitor.";
  }

  async close(): Promise<void> {}
}

class FakeMcp {
  readonly spoken: string[] = [];
  lookCalls = 0;
  pending = ["@ unknown-visitor: Are you there?"];

  async look(): Promise<string> {
    this.lookCalls += 1;
    return "An unfamiliar visitor is nearby.";
  }

  async say(text: string): Promise<void> {
    this.spoken.push(text);
  }

  async pendingPings(): Promise<readonly string[]> {
    return this.pending;
  }
}

test("offline visitor path wakes once, speaks once, and invents neither contact nor place authority", async () => {
  const agent = new FakeAgent();
  const mcp = new FakeMcp();
  const adapter = new EidoverseEmbodiedSessionAdapter({
    worldName: "unmapped-visitor-world",
    agentName: "Purrsephone",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: parseEidoversePlaceMap({
      schemaVersion: 1,
      worlds: {
        "known-world": { placeId: "eidoverse:known-world" },
      },
    }),
  }, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent,
    look: mcp,
    say: mcp,
  });
  const filter = new EidoverseWakeFilter(
    { ambientSayDebounceMs: 10 },
    {
      onWake: async ({ pingLine }) => {
        await adapter.handleAddressedUtterance({
          utteranceId: `ping-${agent.calls.length + 1}`,
          userText: pingLine,
        });
      },
    },
  );
  const poller = new EidoversePendingPingsPoller(
    mcp,
    filter,
    { pendingPingsPollIntervalMs: 1_000 },
  );

  adapter.connect();
  try {
    await filter.accept({ kind: "presence", pingLine: "unknown-visitor entered the world" });
    await filter.accept({ kind: "catchup", pingLine: "while away: @ unknown-visitor: hello" });
    assert.equal(agent.calls.length, 0, "presence and catchup must not start a turn");

    await poller.pollOnce();

    assert.equal(agent.calls.length, 1, "one mention must start exactly one turn");
    assert.equal(agent.calls[0]?.userText, "@ unknown-visitor: Are you there?");
    assert.equal(mcp.lookCalls, 1);
    assert.deepEqual(mcp.spoken, ["Hello visitor."], "the completed reply must publish through MCP say once");
    assert.equal("contactId" in (agent.calls[0]?.channel ?? {}), false,
      "an unknown visitor must not become an asserted or auto-created contact");
    assert.equal("placeId" in (agent.calls[0]?.channel ?? {}), false,
      "an unmapped world must not receive a fabricated place ID");

    adapter.disconnect();
    await assert.rejects(() => poller.pollOnce(), /not connected/);
    assert.equal(agent.calls.length, 1, "a disconnected adapter must not start another turn");
    assert.deepEqual(mcp.spoken, ["Hello visitor."], "disconnect must not fabricate another reply");
  } finally {
    adapter.disconnect();
    filter.close();
  }
});
