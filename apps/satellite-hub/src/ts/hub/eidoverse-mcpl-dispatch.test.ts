import assert from "node:assert/strict";
import test from "node:test";

import { createEidoverseMcplWakeRuntime } from "./eidoverse-mcpl-runtime.js";
import type { McplIncomingChannelMessage } from "./eidoverse-mcpl-wire.js";

const SECRET_LINE = "Quill: the vault code is in the attic";

function knock(messageId: string): McplIncomingChannelMessage {
  return {
    channelId: "world:commons",
    messageId,
    author: { id: "quill", name: "Quill" },
    timestamp: "2026-01-01T00:00:00.000Z",
    content: [{ type: "text", text: SECRET_LINE }],
    tags: ["chat:mention"],
  };
}

/** A target whose turns block until the test lets them finish. */
class GatedTarget {
  readonly started: string[] = [];
  private release: (() => void) | null = null;
  private gate: Promise<void>;

  constructor() {
    this.gate = new Promise<void>((resolve) => { this.release = resolve; });
  }

  async handleEidoverseAddressedUtterance(input: { utteranceId: string }): Promise<string | null> {
    this.started.push(input.utteranceId);
    await this.gate;
    return null;
  }

  open(): void {
    this.release?.();
  }
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the wake dispatch queue drops past its budget and accounts for it content-free", async () => {
  const warnings: string[] = [];
  const target = new GatedTarget();
  const wake = createEidoverseMcplWakeRuntime(
    target,
    { ambientSayDebounceMs: 50, catchupWake: false, wakeQueueLimit: 2 },
    { logger: { warn: (message) => warnings.push(message) } },
  );

  // The first batch leaves the queue as soon as it starts its turn, and that
  // turn then blocks: everything after it is backlog.
  wake.deliver([knock("m1")]);
  await settle();
  assert.deepEqual(target.started.length, 1, "the first batch starts its turn immediately");

  wake.deliver([knock("m2")]);
  wake.deliver([knock("m3")]);
  assert.deepEqual(wake.dropStats(), { droppedBatches: 0, droppedMessages: 0 });

  // The budget is full: two batches are waiting behind the blocked turn.
  wake.deliver([knock("m4"), knock("m5")]);
  wake.deliver([knock("m6")]);
  assert.deepEqual(
    wake.dropStats(),
    { droppedBatches: 2, droppedMessages: 3 },
    "drops are counted per batch and per message",
  );
  assert.deepEqual(
    warnings,
    ["Eidoverse MCPL wake dispatch queue is full (limit 2); dropped batches 1, dropped messages 2"],
    "one bounded line per overflow episode, carrying counts only",
  );
  assert.equal(
    warnings.every((message) => !message.includes(SECRET_LINE) && !message.includes("commons")),
    true,
    "drop accounting never carries world or message content",
  );

  target.open();
  await waitFor(() => target.started.length === 3, "the queued batches to run");
  assert.deepEqual(target.started.length, 3, "only the batches inside the budget started a turn");

  // The episode is over, so the queue accepts again and the next overflow gets
  // its own line rather than staying silent forever.
  wake.deliver([knock("m7")]);
  await waitFor(() => target.started.length === 4, "the batch delivered after the drain");
  assert.deepEqual(wake.dropStats(), { droppedBatches: 2, droppedMessages: 3 });
  await wake.close();
});

test("a wake runtime refuses a queue budget that could never accept a batch", () => {
  assert.throws(
    () => createEidoverseMcplWakeRuntime(
      new GatedTarget(),
      { ambientSayDebounceMs: 50, catchupWake: false, wakeQueueLimit: 0 },
    ),
    /wake queue limit must be a positive integer/,
  );
});
