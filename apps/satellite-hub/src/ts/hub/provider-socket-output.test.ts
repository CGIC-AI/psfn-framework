import assert from "node:assert/strict";
import test from "node:test";
import { ProviderSocketOutput } from "./provider-socket-output.js";
import { resolveHubResourceLimits } from "./transport-resources.js";

function output(overrides = {}) {
  const callbacks: Array<(error?: Error) => void> = [];
  const errors: string[] = [];
  const sent: Array<string | Buffer> = [];
  let terminated = 0;
  const socket = {
    bufferedAmount: 0,
    send(data: string | Buffer, callback: (error?: Error) => void) { sent.push(data); callbacks.push(callback); },
    terminate() { terminated++; },
  };
  const sender = new ProviderSocketOutput(socket, resolveHubResourceLimits({ maxBufferedBytes: 8, maxQueuedMessages: 2, ...overrides }),
    error => errors.push(error.message));
  return { sender, socket, callbacks, errors, sent, terminated: () => terminated };
}

test("provider output admits exact UTF-8 bytes without double charging native writes and rejects one over before enqueue", () => {
  const o = output();
  o.sender.send("éé");
  o.socket.bufferedAmount = 4;
  o.sender.send(Buffer.alloc(4));
  assert.equal(o.sent.length, 2);
  assert.throws(() => o.sender.send("x"), { message: "Hub provider output buffer exceeded" });
  assert.equal(o.sent.length, 2);
  assert.equal(o.terminated(), 1);
  assert.equal(o.errors.length, 1);
  o.callbacks[0]!(); o.callbacks[0]!(); o.sender.closed(); o.callbacks[1]!();
  assert.throws(() => o.sender.send("x"), /closed/u);
});

test("native bytes independent of callbacks and individual frames obey exact capacity", () => {
  const o = output({ maxFrameBytes: 4 });
  o.socket.bufferedAmount = 4;
  o.sender.send("1234");
  o.socket.bufferedAmount = 8;
  assert.throws(() => o.sender.send("x"), /buffer exceeded/u);
  const frame = output({ maxFrameBytes: 4 });
  assert.throws(() => frame.sender.send("12345"), /buffer exceeded/u);
  assert.equal(frame.sent.length, 0);
  frame.sender.closed(); o.sender.closed();
});

test("callback-pending frame capacity survives callback replay and releases only completed writes", () => {
  const o = output();
  o.sender.send(""); o.sender.send("");
  o.callbacks[0]!(); o.callbacks[0]!();
  o.sender.send("");
  assert.throws(() => o.sender.send(""), /buffer exceeded/u);
  assert.equal(o.sent.length, 3);
  o.sender.closed();
});

test("callback failure, thrown send, terminal close and timeout fail once without private error text", async () => {
  const o = output();
  o.sender.send("x"); o.callbacks[0]!(new Error("PRIVATE provider failure"));
  o.callbacks[0]!(new Error("PRIVATE duplicate"));
  assert.deepEqual(o.errors, ["Hub provider output send failed"]);
  assert.equal(o.terminated(), 1);
  o.sender.closed();
  const thrown = output();
  thrown.socket.send = () => { throw new Error("PRIVATE synchronous failure"); };
  assert.throws(() => thrown.sender.send("x"), { message: "Hub provider output send failed" });
  thrown.sender.closed();
  const closed = output(); closed.sender.send("x"); closed.sender.closed(); closed.callbacks[0]!();
  assert.throws(() => closed.sender.send("x"), /closed/u);
  const timed = output({ providerTimeoutMs: 10 }); timed.sender.send("x");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(timed.errors, ["Hub provider output timed out"]);
  timed.sender.closed();
  const recovered = output(); recovered.sender.send("12345678"); assert.equal(recovered.sent.length, 1); recovered.sender.closed();
});

test("broken connector teardown and failure callbacks cannot escape or retain admission", () => {
  const sender = new ProviderSocketOutput({ bufferedAmount: 0, send() { throw new Error("PRIVATE"); },
    terminate() { throw new Error("PRIVATE teardown"); } }, resolveHubResourceLimits(), () => { throw new Error("PRIVATE callback"); });
  assert.throws(() => sender.send("x"), { message: "Hub provider output send failed" });
  assert.throws(() => sender.send("x"), { message: "Hub provider output is closed" });
});
