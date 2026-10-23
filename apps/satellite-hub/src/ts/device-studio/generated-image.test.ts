import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { boundedFalFetch, downloadGeneratedImage, downloadGeneratedImages } from "./generated-image.js";

test("generated image downloads enforce declared/chunked caps, dispose rejected bodies, and recover", async () => {
  let closed = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    response.once("close", () => closed++);
    const route = request.url ?? "";
    response.statusCode = route === "/error" ? 403 : 200;
    response.setHeader("Content-Type", route === "/type" ? "PRIVATE/provider-type" : "image/png");
    const size = route.includes("over") ? 9 : 8;
    if (route.includes("declared")) response.setHeader("Content-Length", size);
    response.flushHeaders();
    if (["/slow", "/error", "/type", "/over-declared"].includes(route)) { if (route !== "/over-declared") response.write("x"); return; }
    response.write(Buffer.alloc(4));
    setImmediate(() => response.end(Buffer.alloc(size - 4)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = (route: string, signal?: AbortSignal) => downloadGeneratedImage(`${base}/${route}`, 8, { timeoutMs: 30, signal });
  try {
    for (const framing of ["declared", "chunked"]) {
      assert.deepEqual(await read(framing), { packReady: true, dataUrl: `data:image/png;base64,${Buffer.alloc(8).toString("base64")}` });
      assert.deepEqual(await read(`over-${framing}`), { packReady: false, packIssue: "Generated image exceeds Device Studio pack review size limit" });
    }
    assert.deepEqual(await read("slow"), { packReady: false, packIssue: "Generated image download failed" });
    const controller = new AbortController();
    const pending = read("slow", controller.signal);
    await delay(5);
    controller.abort(new Error("PRIVATE cancellation"));
    assert.deepEqual(await pending, { packReady: false, packIssue: "Generated image download failed" });
    assert.deepEqual(await read("error"), { packReady: false, packIssue: "Generated image download failed (403)" });
    assert.deepEqual(await read("type"), { packReady: false, packIssue: "Generated image must be a PNG before packing" });
    assert.equal((await read("chunked")).packReady, true);
    for (let attempt = 0; attempt < 30 && closed < 9; attempt++) await delay(5);
    assert.equal(closed, 9);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("FAL SDK fetch bounds upload-control replies and suppresses upstream error bodies", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    if (request.url === "/error") { response.writeHead(403); response.write("PRIVATE credential response"); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(request.url === "/over" ? "x".repeat(65_537) : request.url === "/exact" ? JSON.stringify({ v: "x".repeat(65_528) }) : '{"upload_url":"https://example.test/upload"}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await boundedFalFetch(base)).json(), { upload_url: "https://example.test/upload" });
    assert.equal((await (await boundedFalFetch(`${base}/exact`)).json() as { v: string }).v.length, 65_528);
    await assert.rejects(boundedFalFetch(`${base}/over`), /rejected \(size\)/u);
    await assert.rejects(boundedFalFetch(`${base}/error`), { message: "FAL storage request failed (403)" });
    assert.equal((await boundedFalFetch(base)).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("generated image batches share one byte budget and never fetch after exhaustion", async () => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    request.resume(); requests++;
    response.setHeader("Content-Type", "image/png"); response.end(Buffer.alloc(8));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const images = await downloadGeneratedImages([{ url, width: 1 }, { url, width: 2 }], 8);
    assert.equal(images[0]?.packReady, true);
    assert.equal(images[0]?.width, 1);
    assert.equal(images[1]?.packReady, false);
    assert.equal(requests, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
