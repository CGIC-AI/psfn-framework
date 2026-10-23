import assert from "node:assert/strict";
import test from "node:test";
import { SocketOutput } from "./socket-output.js";
import { resolveHubResourceLimits } from "./transport-resources.js";
import { awaitWithAbort } from "../shared/abort.js";

function output(overrides = {}, serverFrameHeaders = false) {
  const callbacks: Array<(error?: Error) => void> = [];
  const frames: Array<{ type: string; data: string | Buffer }> = [];
  const errors: string[] = [];
  let terminations = 0;
  const socket = {
    bufferedAmount: 0,
    send(data: string | Buffer, callback: (error?: Error) => void) { frames.push({ type: "data", data }); callbacks.push(callback); },
    pong(data: Buffer, _mask: boolean | undefined, callback: (error?: Error) => void) { frames.push({ type: "pong", data }); callbacks.push(callback); },
    close(code?: number, reason?: string | Buffer) { frames.push({ type: "close", data: `${code ?? ""}${reason ?? ""}` }); },
    terminate() { terminations++; },
  };
  const sender = new SocketOutput(socket, resolveHubResourceLimits({ maxFrameBytes: 8, maxBufferedBytes: 8,
    maxQueuedMessages: 3, providerTimeoutMs: 15, ...overrides }), error => errors.push(error.message), "Hub", serverFrameHeaders);
  return { sender, socket, frames, callbacks, errors, terminations: () => terminations };
}

test("data, binary and actual pong frames share exact UTF-8 byte capacity", () => {
  const o = output();
  o.sender.send("éé"); o.socket.bufferedAmount = 4;
  o.sender.send(Buffer.alloc(2)); o.sender.pong(Buffer.alloc(2));
  assert.deepEqual(o.frames.map(frame => frame.type), ["data", "data", "pong"]);
  assert.throws(() => o.sender.pong(Buffer.alloc(1)), { message: "Hub output buffer exceeded" });
  assert.equal(o.frames.length, 3); assert.equal(o.terminations(), 1);
  o.sender.closed(); for (const callback of o.callbacks) { callback(); callback(new Error("PRIVATE stale")); }
  assert.deepEqual(o.errors, ["Hub output buffer exceeded"]);
});

test("native output and per-frame capacity are admitted before any control write", () => {
  const o = output({ maxFrameBytes: 4 });
  o.socket.bufferedAmount = 4; o.sender.pong(Buffer.alloc(4));
  o.socket.bufferedAmount = 8;
  assert.throws(() => o.sender.send("x"), /buffer exceeded/u);
  assert.equal(o.frames.length, 1); o.sender.closed();
  const frame = output({ maxFrameBytes: 4 });
  assert.throws(() => frame.sender.pong(Buffer.alloc(5)), /buffer exceeded/u);
  assert.equal(frame.frames.length, 0); frame.sender.closed();
});

test("zero-byte data and pong callbacks share frame capacity and replay cannot free another frame", () => {
  const o = output({ maxQueuedMessages: 2 });
  o.sender.send(""); o.sender.pong(Buffer.alloc(0));
  o.callbacks[0]!(); o.callbacks[0]!(); o.sender.pong(Buffer.alloc(0));
  assert.throws(() => o.sender.send(""), /buffer exceeded/u);
  assert.equal(o.frames.length, 3); o.sender.closed();
});

test("consumer cancellation leaves a callback-pending data write charged against pongs", async () => {
  const o = output(); const controller = new AbortController();
  const accepted = o.sender.sendAndWait("12345678");
  const detached = assert.rejects(awaitWithAbort(accepted, controller.signal));
  controller.abort(); await detached;
  assert.throws(() => o.sender.pong(Buffer.alloc(1)), /buffer exceeded/u);
  await assert.rejects(accepted, { message: "Hub output buffer exceeded" });
  assert.equal(o.frames.length, 1); o.sender.closed(); o.callbacks[0]!();
});

for (const failure of ["callback", "throw", "timeout", "close"] as const) {
  test(`${failure} settles all send waiters once with content-free errors and fences stale callbacks`, async () => {
    const o = output();
    const first = o.sender.sendAndWait("first");
    const rejected = assert.rejects(first, /^Error: Hub output (?:send failed|timed out|is closed)$/u);
    if (failure === "callback") o.callbacks[0]!(new Error("PRIVATE callback"));
    if (failure === "throw") {
      o.socket.pong = () => { throw new Error("PRIVATE throw"); };
      assert.throws(() => o.sender.pong(Buffer.alloc(1)), { message: "Hub output send failed" });
    }
    if (failure === "timeout") await new Promise(resolve => setTimeout(resolve, 30));
    if (failure === "close") o.sender.closed();
    await rejected;
    o.callbacks[0]!(new Error("PRIVATE stale")); o.sender.closed(); o.callbacks[0]!();
    assert.equal(o.terminations(), failure === "close" ? 0 : 1);
    assert.equal(o.errors.length, failure === "close" ? 0 : 1);
    assert.throws(() => o.sender.send("x"), { message: "Hub output is closed" });
    const fresh = output(); fresh.sender.send("12345678"); fresh.callbacks[0]!(); fresh.sender.closed();
  });
}

test("close control output consumes the remaining bytes and cannot bypass frame admission", () => {
  const o = output();
  o.sender.send("1234"); o.sender.close(1000, "ok");
  assert.deepEqual(o.frames.map(frame => frame.type), ["data", "close"]);
  assert.throws(() => o.sender.send(""), /is closed/u);
  o.sender.close(1000, "duplicate"); assert.equal(o.frames.length, 2); o.sender.closed();
  const full = output(); full.sender.send("12345678");
  assert.throws(() => full.sender.close(1000), /buffer exceeded/u);
  assert.equal(full.frames.length, 1); full.sender.closed();
});

for (const [payload, capacity] of [[125, 127], [126, 130], [65_535, 65_539], [65_536, 65_546]] as const) {
  test(`listener native frame projection admits exact ${capacity} wire bytes and rejects one fewer`, () => {
    const exact = output({ maxFrameBytes: payload, maxBufferedBytes: capacity }, true);
    exact.sender.send(Buffer.alloc(payload));
    assert.equal(exact.frames.length, 1); exact.sender.closed();
    const over = output({ maxFrameBytes: payload, maxBufferedBytes: capacity - 1 }, true);
    assert.throws(() => over.sender.send(Buffer.alloc(payload)), /buffer exceeded/u);
    assert.equal(over.frames.length, 0); over.sender.closed();
  });
}

test("listener native backlog includes the next header before enqueue without doubling callback payload", () => {
  const exact = output({}, true);
  exact.sender.send("1234"); exact.socket.bufferedAmount = 4;
  exact.sender.pong(Buffer.alloc(2));
  assert.deepEqual(exact.frames.map(frame => frame.type), ["data", "pong"]);
  exact.sender.closed();
  const over = output({}, true);
  over.socket.bufferedAmount = 5;
  assert.throws(() => over.sender.pong(Buffer.alloc(2)), /buffer exceeded/u);
  assert.equal(over.frames.length, 0); over.sender.closed();
});
