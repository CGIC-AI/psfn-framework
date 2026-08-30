import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EidoverseMcpClient, type EidoverseMcpConfig } from "./eidoverse-mcp.js";
import {
  EidoversePendingPingsPoller,
  EidoverseWakeFilter,
  classifyPendingPingLine,
  type EidoversePingInput,
} from "./eidoverse-wake-filter.js";

const STUB_SERVER_PATH = fileURLToPath(
  new URL("../test-support/eidoverse-mcp-stub-server.js", import.meta.url),
);

const TABLE: ReadonlyArray<{
  kind: EidoversePingInput["kind"];
  pingLine: string;
  expected: "wake" | "suppress" | "debounce";
}> = [
  { kind: "mention", pingLine: "@ digi: come look at this", expected: "wake" },
  { kind: "whisper", pingLine: "@ digi whispers: psst", expected: "wake" },
  { kind: "approach", pingLine: "≈ digi walked up to you", expected: "wake" },
  {
    kind: "reach",
    pingLine: "≈ digi reaches toward your shoulder_l (right hand)",
    expected: "wake",
  },
  {
    kind: "touch",
    pingLine: "≈ digi touches your head_top (left hand)",
    expected: "wake",
  },
  { kind: "depart", pingLine: "≈ digi walked away", expected: "suppress" },
  { kind: "presence", pingLine: "digi entered the world", expected: "suppress" },
  { kind: "catchup", pingLine: "while away: @ digi: hello", expected: "suppress" },
  { kind: "digest", pingLine: "nearby activity: 3 movements", expected: "suppress" },
  { kind: "say", pingLine: "digi says: ambient hello", expected: "debounce" },
];

test("table-driven wake policy preserves original pingLine only for addressed kinds", async () => {
  const wakes: EidoversePingInput[] = [];
  const ambient: EidoversePingInput[] = [];
  const filter = new EidoverseWakeFilter(
    { ambientSayDebounceMs: 10 },
    {
      onWake: (ping) => { wakes.push(ping); },
      onAmbient: (ping) => { ambient.push(ping); },
    },
  );
  try {
    for (const row of TABLE) {
      assert.equal(filter.treatmentFor(row.kind), row.expected, row.kind);
      await filter.accept({ kind: row.kind, pingLine: row.pingLine });
    }
    assert.deepEqual(
      wakes.map(({ kind, pingLine }) => ({ kind, pingLine })),
      TABLE
        .filter((row) => row.expected === "wake")
        .map(({ kind, pingLine }) => ({ kind, pingLine })),
    );
    await waitFor(() => ambient.length === 1);
    assert.equal(ambient[0]?.pingLine, "digi says: ambient hello");
  } finally {
    filter.close();
  }
});

test("producer suggestedTreatment remains advisory and cannot purchase or suppress a wake", async () => {
  const wakes: string[] = [];
  const filter = new EidoverseWakeFilter(
    { ambientSayDebounceMs: 10 },
    { onWake: ({ pingLine }) => { wakes.push(pingLine); } },
  );
  try {
    await filter.accept({
      kind: "depart",
      pingLine: "≈ digi is no longer nearby",
      producerSuggestedTreatment: { behavior: "immediate" },
    });
    await filter.accept({
      kind: "mention",
      pingLine: "@ digi: still there?",
      producerSuggestedTreatment: { behavior: "mute" },
    });
    assert.deepEqual(wakes, ["@ digi: still there?"]);
  } finally {
    filter.close();
  }
});

test("ambient say uses Hub debounce policy and retains only the latest original line", async () => {
  const ambient: string[] = [];
  const filter = new EidoverseWakeFilter(
    { ambientSayDebounceMs: 15 },
    { onAmbient: ({ pingLine }) => { ambient.push(pingLine); } },
  );
  try {
    await filter.accept({ kind: "say", pingLine: "first ambient line" });
    await filter.accept({ kind: "say", pingLine: "latest ambient line" });
    await waitFor(() => ambient.length === 1);
    assert.deepEqual(ambient, ["latest ambient line"]);
  } finally {
    filter.close();
  }
});

test("plain-MCP classifier recognizes only literal ping-wire renderings", () => {
  const cases: ReadonlyArray<[string, EidoversePingInput["kind"] | null]> = [
    ["@ digi: come look at this", "mention"],
    ["@ digi whispers: psst", "whisper"],
    ["≈ digi walked up to you", "approach"],
    ["≈ digi walked away", "depart"],
    ["≈ digi is no longer nearby", "depart"],
    ["≈ digi reaches toward your shoulder_l (right hand)", "reach"],
    ["≈ digi touches your head_top (left hand)", "touch"],
    ["≈ digi did something unknown", null],
    ["presence: digi entered", null],
  ];
  for (const [pingLine, expected] of cases) {
    assert.equal(classifyPendingPingLine(pingLine), expected, pingLine);
  }
});

test("poll loop reads pending_pings, suppresses depart, and uses the configured interval", async () => {
  const polledLines = [
    "@ digi: come look at this",
    "@ digi whispers: psst",
    "≈ digi walked up to you",
    "≈ digi reaches toward your shoulder_l (right hand)",
    "≈ digi touches your head_top (left hand)",
    "≈ digi walked away",
    "presence: digi entered",
  ];
  let polls = 0;
  let observedDelayMs: number | undefined;
  const source = {
    pendingPings: async () => {
      polls += 1;
      return polledLines;
    },
  };
  const wakes: string[] = [];
  const filter = new EidoverseWakeFilter(
    { ambientSayDebounceMs: 10 },
    { onWake: ({ pingLine }) => { wakes.push(pingLine); } },
  );
  const poller = new EidoversePendingPingsPoller(
    source,
    filter,
    { pendingPingsPollIntervalMs: 37 },
    {
      delay: async (delayMs, signal) => {
        observedDelayMs = delayMs;
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  );
  poller.start();
  try {
    await waitFor(() => polls === 1 && observedDelayMs !== undefined);
    assert.equal(observedDelayMs, 37);
    assert.deepEqual(wakes, polledLines.slice(0, 5));
  } finally {
    await poller.close();
  }
  assert.equal(polls, 1);
});

test("poller composes with the real MCP client pending_pings wrapper", async () => {
  const config: EidoverseMcpConfig = {
    command: process.execPath,
    args: [STUB_SERVER_PATH, "wake-pings"],
    worldUrl: "ws://192.0.2.60:8787/world",
    tokenRef: "TEST_EIDOVERSE_JOIN_TOKEN",
    worldName: "atrium",
    agentName: "companion",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    reconnectMaxAttempts: 1,
    requestTimeoutMs: 1_000,
    pendingPingsPollIntervalMs: 1_000,
    ambientSayDebounceMs: 10_000,
  };
  const client = new EidoverseMcpClient(config, async () => "test-join-token");
  const wakes: string[] = [];
  const filter = new EidoverseWakeFilter(config, {
    onWake: ({ pingLine }) => { wakes.push(pingLine); },
  });
  const poller = new EidoversePendingPingsPoller(client, filter, config);
  await client.start();
  try {
    await poller.pollOnce();
    assert.deepEqual(wakes, [
      "@ digi: come look at this",
      "@ digi whispers: psst",
      "≈ digi walked up to you",
      "≈ digi reaches toward your shoulder_l (right hand)",
      "≈ digi touches your head_top (left hand)",
    ]);
  } finally {
    await poller.close();
    await client.close();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for wake-filter state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
