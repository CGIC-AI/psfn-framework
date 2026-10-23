import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { HubResources, HubSocketFlow } from "./transport-resources.js";

/** A transport boundary whose terminal event and callbacks are independent. */
function connection(limits = {}) {
  const resources = new HubResources({ maxBufferedBytes: 32, maxAuthenticatedConnections: 1,
    idleTimeoutMs: 1000, authenticationTimeoutMs: 15, ...limits });
  const admission = resources.admitSocket(true)!;
  const callbacks: Array<(error?: Error) => void> = [];
  const frames: string[] = [];
  let terminations = 0;
  let cleanups = 0;
  let releases = 0;
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(_data: string | Buffer, callback: (error?: Error) => void) { frames.push("data"); callbacks.push(callback); },
    pong(_data: Buffer, _mask: boolean | undefined, callback: (error?: Error) => void) { frames.push("pong"); callbacks.push(callback); },
    close(_code?: number, _reason?: string | Buffer) {
      if (socket.readyState !== WebSocket.OPEN) return;
      frames.push("close"); socket.readyState = WebSocket.CLOSING;
    },
    terminate() { terminations++; socket.readyState = WebSocket.CLOSING; },
  });
  const flow = new HubSocketFlow(socket as unknown as WebSocket, resources.limits, true,
    () => { cleanups++; }, () => { releases++; admission.release(); });
  return { flow, socket, resources, callbacks, frames, terminations: () => terminations,
    cleanups: () => cleanups, releases: () => releases };
}

for (const failure of ["callback", "deadline", "overflow", "transport"] as const) {
  test(`${failure} cancels consumers but retains connection admission through terminal transport close`, async () => {
    const c = connection();
    const accepted = c.flow.send("pending");
    const failed = assert.rejects(accepted, /^Error: Hub output (?:send failed|timed out|buffer exceeded|is closed)$/u);
    if (failure === "callback") c.callbacks[0]!(new Error("PRIVATE transport failure"));
    if (failure === "deadline") await new Promise(resolve => setTimeout(resolve, 30));
    if (failure === "overflow") c.socket.emit("ping", Buffer.alloc(32));
    if (failure === "transport") c.socket.emit("error", new Error("PRIVATE transport failure"));
    await failed;
    assert.equal(c.cleanups(), 1); assert.equal(c.terminations(), 1);
    assert.equal(c.releases(), 0); assert.equal(c.resources.admitSocket(true), null);
    await assert.rejects(c.flow.send("later"), { message: "Hub output is closed" });
    c.callbacks[0]!(); c.callbacks[0]!(new Error("PRIVATE duplicate"));
    assert.equal(c.resources.admitSocket(true), null, "callback completion is not terminal transport ownership");
    c.socket.emit("close", 1006); c.socket.emit("close", 1006);
    assert.equal(c.releases(), 1);
    const fresh = c.resources.admitSocket(true); assert.ok(fresh); fresh.release();
  });
}

test("shutdown budgets its close frame and terminates a stalled handshake while holding admission", async () => {
  const c = connection();
  const pending = assert.rejects(c.flow.send("pending"), { message: "Hub output timed out" });
  c.socket.close(1001, "down"); c.socket.close(1001, "duplicate");
  assert.deepEqual(c.frames, ["data", "close"]);
  assert.equal(c.resources.admitSocket(true), null);
  await pending;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(c.terminations(), 1); assert.equal(c.releases(), 0);
  c.socket.emit("close", 1006); c.callbacks[0]!();
  assert.equal(c.releases(), 1); assert.equal(c.cleanups(), 1);
});

test("terminal peer close rejects pending sends once and stale callback errors cannot affect recovery", async () => {
  const c = connection();
  const failed = assert.rejects(c.flow.send("pending"), { message: "Hub output is closed" });
  c.socket.emit("close", 1000); await failed;
  c.callbacks[0]!(new Error("PRIVATE stale")); c.callbacks[0]!();
  assert.equal(c.terminations(), 0); assert.equal(c.releases(), 1);
  const fresh = c.resources.admitSocket(true); assert.ok(fresh); fresh.release();
});

test("graceful peer close echoes one close frame and releases admission only at terminal close", async () => {
  const c = connection();
  const sent = c.flow.send("accepted"); c.callbacks[0]!(); await sent;
  c.callbacks[0]!(new Error("PRIVATE stale completion"));
  c.socket.close(1000, "done"); c.socket.close(1000, "duplicate");
  assert.deepEqual(c.frames, ["data", "close"]);
  assert.equal(c.cleanups(), 1); assert.equal(c.releases(), 0);
  assert.equal(c.resources.admitSocket(true), null);
  c.socket.emit("close", 1000); c.socket.emit("close", 1000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(c.terminations(), 0, "terminal close cancels the handshake deadline");
  assert.equal(c.cleanups(), 1); assert.equal(c.releases(), 1);
  const fresh = c.resources.admitSocket(true); assert.ok(fresh); fresh.release();
});
