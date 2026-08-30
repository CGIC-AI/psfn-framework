import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createEidoverseProductionWakeLifecycle,
  createEidoverseWakeRuntime,
} from "./eidoverse-wake-runtime.js";

const MENTION = "@ unknown-visitor: Are you there?";

test("production wake runtime routes one addressed ping without inventing speech or ambient turns", async () => {
  const calls: Array<{ utteranceId: string; userText: string }> = [];
  const warnings: string[] = [];
  const runtime = createEidoverseWakeRuntime(
    {
      pendingPings: async () => [
        "unknown-visitor entered the world",
        "while away: @ unknown-visitor: hello",
        "unknown-visitor says: ambient hello",
        MENTION,
      ],
    },
    {
      handleEidoverseAddressedUtterance: async (input) => {
        calls.push(input);
        return "Hello visitor.";
      },
    },
    { ambientSayDebounceMs: 10, pendingPingsPollIntervalMs: 1_000 },
    { logger: { warn: (message) => warnings.push(message) } },
  );

  try {
    await runtime.pollOnce();

    const digest = createHash("sha256")
      .update("mention", "utf8")
      .update("\0")
      .update(MENTION, "utf8")
      .digest("hex");
    assert.deepEqual(calls, [{
      utteranceId: `eidoverse-pending:1:${digest}`,
      userText: MENTION,
    }]);
    assert.deepEqual(warnings, []);
  } finally {
    await runtime.close();
  }
});

test("production wake runtime sanitizes turn failures and continues without retrying", async () => {
  const warnings: string[] = [];
  let calls = 0;
  const runtime = createEidoverseWakeRuntime(
    { pendingPings: async () => [MENTION] },
    {
      handleEidoverseAddressedUtterance: async () => {
        calls += 1;
        throw new Error("secret visitor payload");
      },
    },
    { ambientSayDebounceMs: 10, pendingPingsPollIntervalMs: 1_000 },
    { logger: { warn: (message) => warnings.push(message) } },
  );

  try {
    await runtime.pollOnce();
    assert.equal(calls, 1);
    assert.deepEqual(warnings, ["Eidoverse wake turn failed"]);
    assert.doesNotMatch(warnings.join("\n"), /secret visitor payload/);
  } finally {
    await runtime.close();
  }
});

test("production wake runtime sanitizes pending_pings failures", async () => {
  const warnings: string[] = [];
  let signalWaiting: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { signalWaiting = resolve; });
  const runtime = createEidoverseWakeRuntime(
    { pendingPings: async () => { throw new Error("secret MCP failure"); } },
    { handleEidoverseAddressedUtterance: async () => null },
    { ambientSayDebounceMs: 10, pendingPingsPollIntervalMs: 37 },
    {
      logger: { warn: (message) => warnings.push(message) },
      delay: async (_delayMs, signal) => {
        signalWaiting?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  );

  runtime.start();
  await waiting;
  await runtime.close();

  assert.deepEqual(warnings, ["Eidoverse pending_pings poll failed"]);
  assert.doesNotMatch(warnings.join("\n"), /secret MCP failure/);
});

test("production wake runtime start and close own the polling lifecycle", async () => {
  const events: string[] = [];
  let signalPolled: (() => void) | undefined;
  let signalWaiting: (() => void) | undefined;
  const polled = new Promise<void>((resolve) => { signalPolled = resolve; });
  const waiting = new Promise<void>((resolve) => { signalWaiting = resolve; });
  const runtime = createEidoverseWakeRuntime(
    {
      pendingPings: async () => {
        events.push("poll");
        signalPolled?.();
        return [];
      },
    },
    { handleEidoverseAddressedUtterance: async () => null },
    { ambientSayDebounceMs: 10, pendingPingsPollIntervalMs: 37 },
    {
      delay: async (delayMs, signal) => {
        events.push(`wait:${delayMs}`);
        signalWaiting?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            events.push("stopped");
            resolve();
          }, { once: true });
        });
      },
    },
  );

  runtime.start();
  await polled;
  await waiting;
  await runtime.close();

  assert.deepEqual(events, ["poll", "wait:37", "stopped"]);
});

test("production lifecycle waits for MCP and server readiness and stops polling before teardown", async () => {
  const events: string[] = [];
  let signalPolled: (() => void) | undefined;
  let signalWaiting: (() => void) | undefined;
  const polled = new Promise<void>((resolve) => { signalPolled = resolve; });
  const waiting = new Promise<void>((resolve) => { signalWaiting = resolve; });
  const mcp = {
    start: async () => { events.push("mcp:start"); },
    close: async () => { events.push("mcp:close"); },
    pendingPings: async () => {
      events.push("poll");
      signalPolled?.();
      return [];
    },
  };
  const server = {
    start: async () => { events.push("server:start"); },
    close: async () => { events.push("server:close"); },
    handleEidoverseAddressedUtterance: async () => null,
  };
  const lifecycle = createEidoverseProductionWakeLifecycle(
    mcp,
    server,
    { ambientSayDebounceMs: 10, pendingPingsPollIntervalMs: 37 },
    {
      delay: async (_delayMs, signal) => {
        events.push("poll:waiting");
        signalWaiting?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            events.push("poll:stopped");
            resolve();
          }, { once: true });
        });
      },
    },
  );

  await lifecycle.start();
  await polled;
  await waiting;
  assert.deepEqual(events, ["mcp:start", "server:start", "poll", "poll:waiting"]);

  await lifecycle.close();
  assert.deepEqual(events, [
    "mcp:start",
    "server:start",
    "poll",
    "poll:waiting",
    "poll:stopped",
    "mcp:close",
    "server:close",
  ]);
});
