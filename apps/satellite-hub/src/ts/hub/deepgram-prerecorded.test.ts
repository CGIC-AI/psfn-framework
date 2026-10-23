import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { transcribePcmClip } from "./deepgram-prerecorded.js";

test("prerecorded STT bounds declared/chunked UTF-8 responses, timeout/cancel, and private errors", async () => {
  const payload = Buffer.from(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "é🙂" }] }] } }));
  let mode = "exact-declared";
  let closed = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    response.once("close", () => closed++);
    response.statusCode = mode === "error" ? 403 : 200;
    if (mode.includes("declared")) response.setHeader("Content-Length", payload.length + (mode.startsWith("over") ? 1 : 0));
    response.flushHeaders();
    if (mode === "over-declared") return;
    if (mode === "error") { response.write("PRIVATE upstream credentials and body"); return; }
    if (mode === "slow") { response.write("{"); return; }
    response.write(payload.subarray(0, payload.indexOf(Buffer.from("🙂")) + 1));
    response.end(Buffer.concat([payload.subarray(payload.indexOf(Buffer.from("🙂")) + 1), Buffer.from(mode.startsWith("over") ? " " : "")]));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (signal?: AbortSignal) => transcribePcmClip("invented-key", Buffer.alloc(2), signal, { maxHttpBodyBytes: payload.length, providerTimeoutMs: 60 }, endpoint);
  try {
    for (const framing of ["declared", "chunked"]) {
      mode = `exact-${framing}`;
      assert.equal((await call()).text, "é🙂");
      mode = `over-${framing}`;
      await assert.rejects(call(), /rejected \(size\)/u);
    }
    mode = "error";
    await assert.rejects(call(), { message: "Deepgram transcription failed (403)" });
    mode = "slow";
    await assert.rejects(call(), /rejected \(timeout\)/u);
    const controller = new AbortController();
    const pending = call(controller.signal);
    controller.abort(new Error("PRIVATE attacker cancellation"));
    await assert.rejects(pending, /rejected \(cancelled\)/u);
    mode = "exact-chunked";
    assert.equal((await call()).text, "é🙂");
    assert.ok(closed >= 6);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
