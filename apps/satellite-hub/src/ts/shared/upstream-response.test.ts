import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fetchUpstream, readUpstreamText, upstreamChunks, UpstreamResponseError, Utf8ByteBudget } from "./upstream-response.js";
import { HubResources } from "../hub/transport-resources.js";

for (const transport of ["fetch", "incoming"] as const) {
  test(`${transport}: declared and chunked byte limits, UTF-8, disposal, and recovery`, async () => {
    let closed = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      response.on("close", () => closed++);
      const url = request.url ?? "";
      const size = url.includes("over") ? 9 : 8;
      if (url.includes("declared")) response.setHeader("Content-Length", size);
      response.flushHeaders();
      if (url.includes("slow")) { response.write("x"); return; }
      response.write(Buffer.from("éé"));
      setImmediate(() => response.end("x".repeat(size - 4)));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = async (path: string) => transport === "fetch" ? fetch(`${base}/${path}`)
      : new Promise<http.IncomingMessage>((resolve, reject) => http.get(`${base}/${path}`, resolve).on("error", reject));
    try {
      for (const framing of ["declared", "chunked"]) {
        assert.equal(await readUpstreamText(await response(framing), { maxBytes: 8, timeoutMs: 1000 }), "ééxxxx");
        await assert.rejects(readUpstreamText(await response(`${framing}-over`), { maxBytes: 8, timeoutMs: 1000 }), /rejected \(size\)/u);
      }
      await assert.rejects(readUpstreamText(await response("slow"), { maxBytes: 8, timeoutMs: 30 }), /rejected \(timeout\)/u);
      const controller = new AbortController();
      const pending = readUpstreamText(await response("slow"), { maxBytes: 8, timeoutMs: 1000, signal: controller.signal });
      controller.abort(new Error("PRIVATE cancellation detail"));
      await assert.rejects(pending, /rejected \(cancelled\)/u);
      const stream = upstreamChunks(await response("slow"), { maxBytes: 8, timeoutMs: 1000 });
      assert.equal((await stream.next()).done, false);
      await stream.return(undefined);
      assert.equal(await readUpstreamText(await response("declared"), { maxBytes: 8, timeoutMs: 1000 }), "ééxxxx");
      for (let attempt = 0; attempt < 30 && closed < 8; attempt++) await delay(5);
      assert.equal(closed, 8, "overflow, timeout, cancellation, and abandoned iterators close their bodies");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test("declared overflow rejects before acquiring or reading the body", async () => {
  let reads = 0;
  let cancels = 0;
  const response = new Response(new ReadableStream({ start() {}, pull() { reads++; }, cancel() { cancels++; } }, { highWaterMark: 0 }), { headers: { "Content-Length": "9" } });
  await assert.rejects(readUpstreamText(response, { maxBytes: 8, timeoutMs: 100 }), /size/u);
  assert.equal(reads, 0);
  assert.equal(cancels, 1);
});

test("provider cancellation and timeout release quota before the next valid call", async () => {
  const resources = new HubResources({ maxProviderOperations: 1, providerTimeoutMs: 30 });
  const server = http.createServer((request, response) => { request.resume(); if (request.url === "/headers") return; response.writeHead(200); response.write("x"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(fetchUpstream(`${url}/headers`, {}, 30), /rejected \(timeout\)/u);
    await assert.rejects(resources.runProvider(async signal => readUpstreamText(await fetchUpstream(url, { signal }, 1000), { maxBytes: 8, timeoutMs: 1000, signal })));
    await delay(10);
    assert.equal(resources.providerAvailable(), true);
    assert.equal(await resources.runProvider(async () => "recovered"), "recovered");
  } finally {
    await resources.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("UTF-8 retained budget handles split surrogate pairs and many tiny deltas in linear time", () => {
  const pair = new Utf8ByteBudget(4);
  pair.append("\ud83d"); pair.append("\ude42");
  assert.throws(() => pair.append("x"), UpstreamResponseError);
  const start = performance.now();
  const budget = new Utf8ByteBudget(200_000);
  for (let i = 0; i < 200_000; i++) budget.append("x");
  assert.throws(() => budget.append("x"), UpstreamResponseError);
  assert.ok(performance.now() - start < 1000, "tiny deltas must not rescan retained text");
});
