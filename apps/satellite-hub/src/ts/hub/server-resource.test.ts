import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const token = "Resource_8bQ6ZcP4fV9mR2tY7aS3dG5hJ0kL1nW_uEoXiCvBN";

async function voxtaClient(port: number): Promise<{ socket: WebSocket; sessionId: string; configurationId: string }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/hub`, { headers: { Authorization: `Bearer ${token}` } });
  const frames: Record<string, unknown>[] = [];
  socket.on("message", raw => {
    for (const text of raw.toString().split("\x1e").filter(Boolean)) {
      const frame = JSON.parse(text) as { arguments?: Record<string, unknown>[] };
      frames.push(frame.arguments?.[0] ?? {});
    }
  });
  await once(socket, "open");
  for (const $type of ["authenticate", "startChat"]) socket.send(JSON.stringify({ type: 1, target: "SendMessage", arguments: [{ $type }] }));
  for (let attempt = 0; attempt < 100 && !frames.some(frame => frame.$type === "chatStarted"); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  const chat = frames.find(frame => frame.$type === "chatStarted");
  assert.ok(chat);
  const configuration = frames.find(frame => frame.$type === "configuration")!;
  return { socket, sessionId: String(chat.sessionId), configurationId: String((configuration.configurations as { id: string }[])[0]!.id) };
}

function streamingRequest(port: number, route: string, body: string | null, contentType = "application/json"): { request: http.ClientRequest; response: Promise<number> } {
  const request = http.request({ hostname: "127.0.0.1", port, path: route, method: "PUT", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": contentType, "Transfer-Encoding": "chunked",
  } });
  const response = new Promise<number>((resolve, reject) => {
    request.once("response", response => { response.resume(); resolve(response.statusCode!); });
    request.once("error", reject);
  });
  if (body === null) request.write("{"); else { request.write(body.slice(0, 10)); request.end(body.slice(10)); }
  return { request, response };
}

async function startHub(overrides: Record<string, string> = {}, limits: Record<string, number> = {}): Promise<{
  child: ChildProcess; port: number; root: string; close: () => Promise<void>;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-resource-"));
  const limitsPath = path.join(root, "limits.json");
  fs.writeFileSync(limitsPath, JSON.stringify({ schemaVersion: 1, limits }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../test-support/hub-resource-child.js", import.meta.url))], {
    cwd: root,
    env: { ...process.env, PSFN_API_BASE_URL: "http://127.0.0.1:1/v1", PSFN_API_KEY: "",
      HUB_TEXT_ONLY: "true", HUB_DEVELOPER_MODE: "true", REALTIME_VOICE_BIND_HOST: "127.0.0.1",
      REALTIME_VOICE_PORT: "0", HUB_DEVICE_REGISTRY_PATH: "", HUB_DEVICE_ASSERTION_ISSUER: "",
      HUB_DEVICE_ASSERTION_KID: "", HUB_DEVICE_ASSERTION_AUDIENCE: "", HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH: "",
      HUB_DEVICE_ASSERTION_TTL_SECONDS: "", PSFN_COMPANION_BASE_URL: "", HOME_ASSISTANT_ENABLED: "false",
      HUB_CONTROL_TOKEN: "", VOXTA_FACADE_ENABLED: "true", VOXTA_AUTH_TOKEN: token, VOXTA_STT_STREAM_ENABLED: "true",
      ARTIFACT_ROOT: path.join(root, "artifacts"), HUB_RESOURCE_LIMITS_PATH: limitsPath, ...overrides },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const listening = await Promise.race([
    once(child, "message").then(([message]) => message as { port: number }),
    once(child, "exit").then(() => { throw new Error("Hub exited before listening"); }),
  ]);
  return { child, port: listening.port, root, close: async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

for (const route of ["/", "/hub"]) {
  test(`malformed ${route} JSON closes its socket while the Hub process keeps serving`, async () => {
    const hub = await startHub();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${hub.port}${route}`, { headers: { Authorization: `Bearer ${token}` } });
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send("{");
      const [code] = await closed;
      assert.equal(code, 1008);
      assert.equal(hub.child.exitCode, null);
      assert.equal((await fetch(`http://127.0.0.1:${hub.port}/`)).status, 200);
    } finally { await hub.close(); }
  });
}

test("malformed percent-encoded Voxta paths fail the request without killing the Hub", async () => {
  const hub = await startHub();
  try {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/voxta/audio/%E0%A4.wav`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/`)).status, 200);
  } finally { await hub.close(); }
});

test("transport frame admission enforces the configured byte limit before processing", async () => {
  const hub = await startHub({}, { maxFrameBytes: 128 });
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/hub`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ protocol: "json", version: 1 }).padEnd(128, " "));
    assert.equal((await once(socket, "message"))[0].toString(), "{}\x1e");
    const closed = Promise.race([once(socket, "close"), new Promise(resolve => setTimeout(() => { socket.terminate(); resolve([1006]); }, 500))]);
    socket.send(JSON.stringify({ protocol: "json", version: 1 }).padEnd(129, " "));
    assert.equal((await closed as [number])[0], 1009);
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/`)).status, 200);
  } finally { socket.terminate(); await hub.close(); }
});

test("HTTP streaming rejects oversized bodies and pending negotiation quotas recover", async () => {
  const hub = await startHub({}, { maxHttpBodyBytes: 32, maxPendingNegotiations: 2, negotiationTtlMs: 80 });
  try {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/configurations/chosen/services/TextToSpeech`, {
      method: "PUT", headers, body: JSON.stringify({ enabled: false }).padEnd(33, " "),
    });
    assert.equal(response.status, 413);
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/hub/negotiate`, {
      method: "POST", headers, body: "x".repeat(33),
    })).status, 413);
    const negotiate = () => fetch(`http://127.0.0.1:${hub.port}/hub/negotiate`, { method: "POST", headers });
    assert.equal((await negotiate()).status, 200);
    assert.equal((await negotiate()).status, 200);
    assert.equal((await negotiate()).status, 429);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await negotiate()).status, 200);
    assert.equal(fs.existsSync(path.join(hub.root, "artifacts")), false);
  } finally { await hub.close(); }
});

test("late realtime audio overflow has no provider or artifact effect and exact-limit input recovers", async () => {
  const hub = await startHub({}, { maxAudioBytes: 8, maxAudioDurationMs: 1000 });
  const sockets: WebSocket[] = [];
  try {
    const abusive = new WebSocket(`ws://127.0.0.1:${hub.port}/`); sockets.push(abusive);
    await once(abusive, "open");
    const closed = once(abusive, "close");
    for (const message of [{ type: "turn.start" }, { type: "audio", audio: Buffer.alloc(8).toString("base64") },
      { type: "audio", audio: Buffer.alloc(2).toString("base64") }, { type: "turn.end" }]) abusive.send(JSON.stringify(message));
    assert.equal((await closed)[0], 1008);
    const status = once(hub.child, "message"); hub.child.send("status");
    assert.equal((await status)[0].providerCalls, 0);
    assert.equal(fs.existsSync(path.join(hub.root, "artifacts")), false);

    const valid = new WebSocket(`ws://127.0.0.1:${hub.port}/`); sockets.push(valid);
    const messages: Record<string, unknown>[] = [];
    valid.on("message", raw => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await once(valid, "open");
    for (const message of [{ type: "turn.start" }, { type: "audio", audio: Buffer.alloc(8).toString("base64") }, { type: "turn.end" }]) valid.send(JSON.stringify(message));
    for (let attempt = 0; attempt < 100 && !messages.some(message => message.type === "message" && (message.data as { final?: boolean; role?: string })?.final && (message.data as { role?: string })?.role === "assistant"); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(messages.some(message => message.type === "message" && (message.data as { content?: string })?.content === "Valid reply"));
    const finalStatus = once(hub.child, "message"); hub.child.send("status");
    assert.equal((await finalStatus)[0].providerCalls, 2);
  } finally { for (const socket of sockets) socket.terminate(); await hub.close(); }
});

test("implicit PCM streams finish after bounded silence without requiring new client frames", async () => {
  const hub = await startHub({}, { maxAudioBytes: 64, maxAudioDurationMs: 1000, audioEndpointSilenceMs: 1 });
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/`);
  try {
    const messages: string[] = [];
    socket.on("message", raw => messages.push(raw.toString()));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "audio", audio: Buffer.alloc(32, 20).toString("base64") }));
    socket.send(JSON.stringify({ type: "audio", audio: Buffer.alloc(32).toString("base64") }));
    for (let attempt = 0; attempt < 100 && !messages.some(message => message.includes("Valid reply")); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(messages.some(message => message.includes("Valid reply")));
  } finally { socket.terminate(); await hub.close(); }
});

test("invalid SignalR schemas are isolated before provider admission", async () => {
  const hub = await startHub({}, { idleTimeoutMs: 100 });
  try {
    for (const frame of [{ type: [] }, { protocol: "xml", version: 1 }, { type: 1, target: "SendMessage", arguments: {} }]) {
      const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/hub`, { headers: { Authorization: `Bearer ${token}` } });
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send(JSON.stringify(frame));
      const [code, reason] = await closed;
      assert.equal(code, 1008);
      assert.match(reason.toString(), /Invalid SignalR/);
    }
    const status = once(hub.child, "message"); hub.child.send("status");
    assert.equal((await status)[0].providerCalls, 0);
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/`)).status, 200);
  } finally { await hub.close(); }
});

test("streamed HTTP exact limits, body deadlines and concurrent request quotas recover", async () => {
  const hub = await startHub({}, { maxHttpBodyBytes: 32, httpBodyTimeoutMs: 200, maxHttpRequests: 1 });
  const client = await voxtaClient(hub.port);
  try {
    const route = `/api/configurations/${client.configurationId}/services/TextToSpeech`;
    assert.equal(await streamingRequest(hub.port, route, '{"enabled":false}'.padEnd(32)).response, 200);
    assert.equal(await streamingRequest(hub.port, route, '{"enabled":false}'.padEnd(33)).response, 413);
    const abandoned = streamingRequest(hub.port, route, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/`)).status, 429);
    assert.equal(await abandoned.response, 408);
    assert.equal(await streamingRequest(hub.port, route, '{"enabled":false}'.padEnd(32)).response, 200);
    assert.equal(fs.existsSync(path.join(hub.root, "artifacts")), false);
  } finally { client.socket.terminate(); await hub.close(); }
});

test("vision multipart file and body limits reject before artifact writes and accept exact bytes", async () => {
  const hub = await startHub({}, { maxVisionFileBytes: 8, maxVisionBodyBytes: 256 });
  const client = await voxtaClient(hub.port);
  const route = `http://127.0.0.1:${hub.port}/api/vision/requests/capture/send?sessionId=${client.sessionId}&source=Screen`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "multipart/form-data; boundary=test-boundary" };
  const multipart = (data: string): string => `--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="capture.png"\r\nContent-Type: image/png\r\n\r\n${data}\r\n--test-boundary--\r\n`;
  try {
    for (const body of [multipart("123456789"), multipart("12345678").padEnd(257)]) {
      assert.equal((await fetch(route, { method: "POST", headers, body })).status, 413);
      assert.equal(fs.existsSync(path.join(hub.root, "artifacts")), false);
    }
    assert.equal((await fetch(route, { method: "POST", headers, body: multipart("12345678").slice(0, -10) })).status, 400);
    assert.equal(fs.existsSync(path.join(hub.root, "artifacts")), false);
    assert.equal((await fetch(route, { method: "POST", headers, body: multipart("12345678") })).status, 200);
    const status = once(hub.child, "message"); hub.child.send("status");
    assert.equal((await status)[0].providerCalls, 0);
  } finally { client.socket.terminate(); await hub.close(); }
});

test("Voxta audio malformed specs, late overflow and duration expiry never reach STT", async () => {
  const hub = await startHub({}, { maxAudioBytes: 8, maxAudioDurationMs: 80 });
  const client = await voxtaClient(hub.port);
  const connect = (): WebSocket => new WebSocket(`ws://127.0.0.1:${hub.port}/ws/audio/input/stream?sessionId=${client.sessionId}`, { headers: { Authorization: `Bearer ${token}` } });
  const spec = { sampleRate: 16000, channels: 1, bitsPerSample: 16, bufferMilliseconds: 30, contentType: "audio/pcm" };
  try {
    for (const mode of ["spec", "bytes", "duration"]) {
      const socket = connect();
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send(JSON.stringify(mode === "spec" ? { ...spec, channels: 2 } : spec));
      if (mode === "bytes") { socket.send(Buffer.alloc(8)); socket.send(Buffer.alloc(2)); }
      assert.equal((await closed)[0], 1008);
    }
    const status = once(hub.child, "message"); hub.child.send("status");
    assert.equal((await status)[0].providerCalls, 0);
    const valid = connect(); await once(valid, "open");
    valid.send(JSON.stringify(spec)); valid.send(Buffer.alloc(8)); valid.close(1000);
    await once(valid, "close");
    const recovered = once(hub.child, "message"); hub.child.send("status");
    assert.equal((await recovered)[0].providerCalls, 1);
    assert.equal(fs.existsSync(path.join(hub.root, "artifacts")), false);
  } finally { client.socket.terminate(); await hub.close(); }
});

test("authenticated connection and SignalR batch quotas release after idle and rejected input", async () => {
  const hub = await startHub({}, { maxAuthenticatedConnections: 1, idleTimeoutMs: 80, maxQueuedMessages: 2 });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/hub`, { headers: { Authorization: `Bearer ${token}` } });
    await once(socket, "open");
    const status = await new Promise<number>((resolve, reject) => {
      const denied = new WebSocket(`ws://127.0.0.1:${hub.port}/hub`, { headers: { Authorization: `Bearer ${token}` } });
      denied.once("unexpected-response", (_request, response) => { response.resume(); denied.terminate(); resolve(response.statusCode!); });
      denied.once("error", () => undefined); denied.once("open", () => { denied.terminate(); reject(new Error("Quota bypass")); });
    });
    assert.equal(status, 429);
    assert.equal((await once(socket, "close"))[0], 1008);
    const valid = new WebSocket(`ws://127.0.0.1:${hub.port}/hub`, { headers: { Authorization: `Bearer ${token}` } });
    await once(valid, "open");
    const messages = once(valid, "message");
    valid.send('{"protocol":"json","version":1}\x1e{"type":6}\x1e');
    assert.equal((await messages)[0].toString(), "{}\x1e");
    const closed = once(valid, "close");
    valid.send('{"type":6}\x1e{"type":6}\x1e{"type":6}\x1e');
    assert.equal((await closed)[0], 1008);
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/`)).status, 200);
  } finally { await hub.close(); }
});

test("queued bytes and output buffering accept exact limits and recover after overflow", async () => {
  const hub = await startHub({}, { maxQueuedBytes: 128, maxBufferedBytes: 3 });
  const open = async (): Promise<WebSocket> => {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/hub`, { headers: { Authorization: `Bearer ${token}` } });
    await once(socket, "open"); return socket;
  };
  const handshake = async (socket: WebSocket): Promise<void> => {
    const message = once(socket, "message");
    socket.send('{"protocol":"json","version":1}'.padEnd(128));
    assert.equal((await message)[0].toString(), "{}\x1e");
  };
  try {
    const queued = await open(); await handshake(queued);
    const queueClosed = once(queued, "close");
    queued.send('{"type":6}'.padEnd(129));
    const [queueCode, queueReason] = await queueClosed;
    assert.equal(queueCode, 1008); assert.match(queueReason.toString(), /queue/);
    const buffered = await open(); await handshake(buffered);
    const outputClosed = once(buffered, "close");
    buffered.send('{"type":1,"target":"SendMessage","arguments":[{"$type":"authenticate"}]}');
    const [outputCode, outputReason] = await outputClosed;
    assert.equal(outputCode, 1008); assert.match(outputReason.toString(), /buffer/);
    const recovered = await open(); await handshake(recovered); recovered.terminate();
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/`)).status, 200);
  } finally { await hub.close(); }
});

test("large declared negotiation bodies never allocate their advertised size", async () => {
  const hub = await startHub({}, { maxHttpBodyBytes: 32 });
  const status = async (): Promise<{ rss: number; providerCalls: number }> => {
    const message = once(hub.child, "message"); hub.child.send("status"); return (await message)[0];
  };
  try {
    const before = await status();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const code = await new Promise<number>((resolve, reject) => {
        const request = http.request({ hostname: "127.0.0.1", port: hub.port, path: "/hub/negotiate", method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Length": String(1024 * 1024 * 1024) } });
        request.once("response", response => { response.resume(); resolve(response.statusCode!); });
        request.once("error", reject); request.end();
      });
      assert.equal(code, 413);
    }
    const after = await status();
    assert.ok(after.rss - before.rss < 64 * 1024 * 1024);
    assert.equal(after.providerCalls, 0);
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/`)).status, 200);
  } finally { await hub.close(); }
});

test("closed audio sockets retain their quota until deferred STT settles", async () => {
  const hub = await startHub({ HUB_TEST_DEFER_VOXTA_STT: "true" }, { maxAuthenticatedConnections: 2 });
  const client = await voxtaClient(hub.port);
  const route = `ws://127.0.0.1:${hub.port}/ws/audio/input/stream?sessionId=${client.sessionId}`;
  try {
    const first = new WebSocket(route, { headers: { Authorization: `Bearer ${token}` } });
    await once(first, "open");
    first.send(JSON.stringify({ sampleRate: 16000, channels: 1, bitsPerSample: 16, bufferMilliseconds: 30, contentType: "audio/pcm" }));
    first.send(Buffer.alloc(8)); first.close(1000); await once(first, "close");
    const blocked = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(route, { headers: { Authorization: `Bearer ${token}` } });
      socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.once("error", () => undefined);
      socket.once("open", () => { socket.terminate(); reject(new Error("Closed-socket STT escaped its quota")); });
    });
    assert.equal(blocked, 429);
    hub.child.send("releaseStt");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = once(hub.child, "message"); hub.child.send("status");
      if ((await status)[0].pendingProviders === 0) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const recovered = new WebSocket(route, { headers: { Authorization: `Bearer ${token}` } });
    await once(recovered, "open"); recovered.terminate();
  } finally { client.socket.terminate(); hub.child.send("releaseStt"); await hub.close(); }
});

test("continuous Pi PCM remains healthy while an accepted utterance waits for slow STT", async () => {
  const hub = await startHub({ HUB_TEST_DEFER_REALTIME_STT: "true" }, { maxQueuedMessages: 4, maxAudioBytes: 2048, audioEndpointSilenceMs: 1 });
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/`);
  try {
    const messages: string[] = [];
    socket.on("message", raw => messages.push(raw.toString()));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "audio", audio: Buffer.alloc(32, 20).toString("base64") }));
    socket.send(JSON.stringify({ type: "audio", audio: Buffer.alloc(32).toString("base64") }));
    for (let sample = 0; sample < 12; sample += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "audio", audio: Buffer.alloc(640).toString("base64") }));
    }
    assert.equal(socket.readyState, WebSocket.OPEN);
    const waiting = once(hub.child, "message"); hub.child.send("status");
    assert.equal((await waiting)[0].pendingProviders, 1);
    hub.child.send("releaseStt");
    for (let attempt = 0; attempt < 100 && !messages.some(message => message.includes("Valid reply")); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(messages.some(message => message.includes("Valid reply")));
    const status = once(hub.child, "message"); hub.child.send("status");
    const counts = (await status)[0];
    assert.equal(counts.pendingProviders, 0);
    assert.equal(counts.acceptedPcmBytes, 64);
  } finally { socket.terminate(); hub.child.send("releaseStt"); await hub.close(); }
});

test("post-close provider deadlines release quotas and shutdown aborts pending work", async () => {
  const hub = await startHub({ HUB_TEST_DEFER_VOXTA_STT: "true" }, { maxAuthenticatedConnections: 2, maxProviderOperations: 1, providerTimeoutMs: 100 });
  const client = await voxtaClient(hub.port);
  const begin = async (): Promise<void> => {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/audio/input/stream?sessionId=${client.sessionId}`, { headers: { Authorization: `Bearer ${token}` } });
    await once(socket, "open");
    socket.send(JSON.stringify({ sampleRate: 16000, channels: 1, bitsPerSample: 16, bufferMilliseconds: 30, contentType: "audio/pcm" }));
    socket.send(Buffer.alloc(8)); socket.close(1000); await once(socket, "close");
  };
  try {
    await begin();
    await new Promise(resolve => setTimeout(resolve, 150));
    const status = once(hub.child, "message"); hub.child.send("status");
    assert.equal((await status)[0].pendingProviders, 0);
    await begin();
    const exited = once(hub.child, "exit"); hub.child.kill("SIGTERM");
    assert.equal((await exited)[0], 0);
  } finally { client.socket.terminate(); await hub.close(); }
});

test("abort-ignoring provider work remains charged after timeout and shutdown has a hard bound", async () => {
  const hub = await startHub({ HUB_TEST_DEFER_VOXTA_STT: "true", HUB_TEST_IGNORE_PROVIDER_ABORT: "true" },
    { maxAuthenticatedConnections: 2, maxProviderOperations: 1, providerTimeoutMs: 80, authenticationTimeoutMs: 80 });
  const client = await voxtaClient(hub.port);
  const route = `ws://127.0.0.1:${hub.port}/ws/audio/input/stream?sessionId=${client.sessionId}`;
  const begin = async (): Promise<void> => {
    const socket = new WebSocket(route, { headers: { Authorization: `Bearer ${token}` } }); await once(socket, "open");
    socket.send(JSON.stringify({ sampleRate: 16000, channels: 1, bitsPerSample: 16, bufferMilliseconds: 30, contentType: "audio/pcm" }));
    socket.send(Buffer.alloc(8)); socket.close(1000); await once(socket, "close");
  };
  const status = async (): Promise<{ pendingProviders: number; providerCalls: number }> => {
    const result = once(hub.child, "message"); hub.child.send("status"); return (await result)[0];
  };
  try {
    await begin(); await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal((await status()).pendingProviders, 1);
    const denied = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(route, { headers: { Authorization: `Bearer ${token}` } });
      socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.once("error", () => undefined); socket.once("open", () => { socket.terminate(); reject(new Error("Detached provider quota bypass")); });
    });
    assert.equal(denied, 429); assert.equal((await status()).providerCalls, 1);
    hub.child.send("releaseStt");
    for (let attempt = 0; attempt < 100 && (await status()).pendingProviders; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    await begin(); assert.equal((await status()).pendingProviders, 1);
    const started = Date.now(); const exited = once(hub.child, "exit"); hub.child.kill("SIGTERM");
    assert.equal((await exited)[0], 1);
    assert.ok(Date.now() - started < 1000);
  } finally { client.socket.terminate(); await hub.close(); }
});

test("interrupt aborts pending STT without a transcript artifact and the next utterance recovers", async () => {
  const hub = await startHub({ HUB_TEST_DEFER_REALTIME_STT: "true" }, { maxProviderOperations: 1 });
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/`);
  const messages: string[] = []; socket.on("message", raw => messages.push(raw.toString()));
  const status = async (): Promise<{ pendingProviders: number; providerCalls: number; providerAborts: number }> => {
    const result = once(hub.child, "message"); hub.child.send("status"); return (await result)[0];
  };
  const utterance = (): void => {
    for (const message of [{ type: "turn.start" }, { type: "audio", audio: "AQACAAMA" }, { type: "turn.end" }]) socket.send(JSON.stringify(message));
  };
  try {
    await once(socket, "open"); utterance();
    for (let attempt = 0; attempt < 100 && !(await status()).pendingProviders; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await status()).pendingProviders, 1);
    const interruptedAt = Date.now();
    socket.send('{"type":"interrupt"}');
    for (let attempt = 0; attempt < 40 && !messages.some(message => message.includes("assistant.interrupted")); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(messages.some(message => message.includes("assistant.interrupted")));
    assert.ok(Date.now() - interruptedAt < 250);
    assert.equal((await status()).pendingProviders, 0);
    assert.equal((await status()).providerAborts, 1);
    assert.ok(!messages.some(message => /Valid transcript|Valid reply/.test(message)));
    assert.equal(fs.existsSync(path.join(hub.root, "artifacts")), false);
    utterance();
    for (let attempt = 0; attempt < 100 && !(await status()).pendingProviders; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    hub.child.send("releaseStt");
    for (let attempt = 0; attempt < 100 && !messages.some(message => message.includes("Valid reply")); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(messages.some(message => message.includes("Valid reply")));
  } finally { socket.terminate(); hub.child.send("releaseStt"); await hub.close(); }
});

test("a throwing subsystem cannot prevent real socket, HTTP, and provider shutdown", async () => {
  const hub = await startHub({ HUB_TEST_DEFER_REALTIME_STT: "true", HUB_TEST_AGENT_CLOSE_FAIL: "true" }, { authenticationTimeoutMs: 80 });
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/`);
  try {
    await once(socket, "open");
    for (const message of [{ type: "turn.start" }, { type: "audio", audio: "AQACAA==" }, { type: "turn.end" }]) socket.send(JSON.stringify(message));
    for (let attempt = 0; attempt < 100; attempt++) {
      const pending = once(hub.child, "message"); hub.child.send("status");
      if ((await pending)[0].pendingProviders === 1) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const closed = once(socket, "close"); const result = once(hub.child, "message"); hub.child.send("closeServer");
    const state = (await result)[0];
    assert.equal(state.type, "closed"); assert.equal(state.outcome, "failed");
    assert.equal(state.address, null); assert.equal(state.pendingProviders, 0); assert.equal(state.providerAborts, 1);
    assert.equal((await closed)[0], 1001);
    await assert.rejects(fetch(`http://127.0.0.1:${hub.port}/`));
  } finally { socket.terminate(); await hub.close(); }
});
