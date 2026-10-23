import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { ElevenLabsStream } from "./elevenlabs-stream.js";
import { DeepgramRealtimeSession } from "./deepgram-live.js";
import { HomeAssistantClient } from "./home-assistant/client.js";
import { EidoverseMcplClient, type EidoverseMcplSocket } from "./eidoverse-mcpl-client.js";
import type { EidoverseMcplConfig } from "./eidoverse-mcpl-config.js";
import type { HomeAssistantCallServiceInput } from "./home-assistant/contracts.js";

async function peer(handle: (socket: WebSocket) => void) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const clients: WebSocket[] = [];
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, clients,
    connect: (_url: string, options: WebSocket.ClientOptions) => {
      const client = new WebSocket(url, options); clients.push(client); return client;
    },
    close: async () => {
      for (const socket of [...clients, ...sockets.clients]) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve())));
    },
  };
}

async function collect(tts: ElevenLabsStream, text: AsyncIterable<string>, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tts.streamText(text, { signal })) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("ElevenLabs repeated cancelled 128 KiB turns cannot bypass a 1 KiB socket budget", async () => {
  const local = await peer(socket => socket.pause());
  const tts = new ElevenLabsStream("invented-key", "model", "voice", {
    maxBufferedBytes: 1024, maxProviderOperations: 1,
  }, local.connect);
  try {
    for (let turn = 0; turn < 50; turn++) {
      const controller = new AbortController();
      async function* text() { yield "x".repeat(128 * 1024); controller.abort(); }
      await assert.rejects(collect(tts, text(), controller.signal));
    }
    const buffered = local.clients.reduce((sum, socket) => sum + socket.bufferedAmount, 0);
    assert.ok(buffered <= 1024, `provider retained ${buffered} bytes after cancellation`);
  } finally { await tts.close(); await local.close(); }
});

interface SendControl {
  hold: boolean;
  fail: boolean;
  sent: Array<string | Buffer>;
  pending: Array<(error?: Error) => void>;
}
function control(): SendControl { return { hold: false, fail: false, sent: [], pending: [] }; }
function controlled(client: WebSocket, c: SendControl): WebSocket {
  const send = client.send.bind(client);
  client.send = ((data: string | Buffer, callback: (error?: Error) => void) => {
    c.sent.push(data);
    send(data, error => {
      if (c.fail) callback(new Error("PRIVATE provider callback"));
      else if (c.hold) c.pending.push(callback);
      else callback(error);
    });
  }) as WebSocket["send"];
  return client;
}
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "provider condition did not settle");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}


for (const capacity of ["bytes", "frames"]) {
  test(`ElevenLabs ${capacity} charges survive context cancellation until real send callbacks settle`, async () => {
    const local = await peer(socket => socket.pause());
    const c = control(); c.hold = true;
    const initial = { context_id: "x".repeat(40), text: " ", voice_settings: { stability: 0.35, similarity_boost: 0.7, speed: 1 } };
    const overhead = Buffer.byteLength(JSON.stringify(initial)) + Buffer.byteLength(JSON.stringify({ context_id: "x".repeat(40), text: "", flush: true }));
    const input = capacity === "bytes" ? "x".repeat(1024 - overhead) : "hello";
    const tts = new ElevenLabsStream("invented-key", "model", "voice", {
      maxBufferedBytes: 1024, maxQueuedMessages: capacity === "frames" ? 2 : 32,
    }, (url, options) => controlled(local.connect(url, options), c));
    const controller = new AbortController();
    async function* text() { yield input; await new Promise(() => undefined); }
    const pending = collect(tts, text(), controller.signal);
    const failed = assert.rejects(pending, error => error instanceof Error && !error.message.includes("PRIVATE"));
    try {
      await waitFor(() => c.sent.length === 2);
      if (capacity === "bytes") assert.equal(c.sent.reduce((sum, data) => sum + Buffer.byteLength(data), 0), 1024);
      controller.abort();
      await failed;
      // Cancellation's close_context is a third socket write; it cannot reset
      // either the accepted byte budget or callback-pending frame capacity.
      assert.equal(c.sent.length, 2);
      await waitFor(() => local.clients[0]!.readyState === WebSocket.CLOSED);
      for (const callback of c.pending) { callback(); callback(); }
    } finally { controller.abort(); await tts.close(); await local.close(); }
  });
}

for (const capacity of ["bytes", "frames"]) {
  test(`Deepgram audio exact ${capacity} capacity rejects the next write and a fresh stream recovers`, async () => {
    const local = await peer(socket => socket.pause());
    const c = control(); c.hold = true;
    const errors: string[] = [];
    const transcripts: string[] = [];
    const session = new DeepgramRealtimeSession("invented-key", 16000, {
      onError: error => errors.push(error.message), onUtterance: event => transcripts.push(event.text),
    }, "nova-3", { maxBufferedBytes: 1024, maxQueuedMessages: capacity === "frames" ? 1 : 32 },
    (url, options) => controlled(local.connect(url, options), c));
    try {
      await session.start();
      session.sendAudio(Buffer.alloc(capacity === "bytes" ? 1024 : 1));
      assert.equal(c.sent.length, 1);
      assert.throws(() => session.sendAudio(Buffer.alloc(1)), /buffer exceeded/u);
      assert.equal(c.sent.length, 1);
      assert.deepEqual(transcripts, []);
      assert.deepEqual(errors, ["Hub provider output buffer exceeded"]);
      await once(local.clients[0]!, "close");
      for (const callback of c.pending) callback();
      c.hold = false; await session.start(); session.sendAudio(Buffer.alloc(1024));
      assert.equal(c.sent.length, 2);
    } finally { await session.close(); await local.close(); }
  });
}

test("Deepgram keepalive frames use the same callback-pending admission and failure is content-free", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const local = await peer(socket => socket.pause());
  const c = control(); c.hold = true;
  const errors: string[] = [];
  const session = new DeepgramRealtimeSession("invented-key", 16000, { onError: error => errors.push(error.message) },
    "nova-3", { maxBufferedBytes: 20 }, (url, options) => controlled(local.connect(url, options), c));
  try {
    await session.start();
    t.mock.timers.tick(8000);
    assert.equal(String(c.sent[0]), '{"type":"KeepAlive"}');
    t.mock.timers.tick(8000);
    assert.equal(c.sent.length, 1);
    assert.deepEqual(errors, ["Hub provider output buffer exceeded"]);
  } finally { await session.close(); await local.close(); t.mock.timers.reset(); }
});

function haConfig(url: string) {
  return { baseUrl: url.replace("ws:", "http:"), token: "invented-token", reconnectBaseMs: 10, reconnectMaxMs: 20, requestTimeoutMs: 100 };
}
const service: HomeAssistantCallServiceInput = { requestId: "test", domain: "light", service: "turn_on", entityIds: ["light.test"] };
async function homePeer() {
  const servers: WebSocket[] = [];
  const local = await peer(socket => {
    servers.push(socket);
    socket.send(JSON.stringify({ type: "auth_required" }));
    socket.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "auth") socket.send(JSON.stringify({ type: "auth_ok" }));
      else socket.send(JSON.stringify({ id: frame.id, type: "result", success: true, result: frame.type === "get_states" ? [] : {} }));
    });
  });
  return { ...local, servers };
}
for (const capacity of ["bytes", "frames", "callback", "timeout", "close", "shutdown"]) {
  test(`Home Assistant ${capacity} output failure releases pending commands and reconnects`, async () => {
    const local = await homePeer(); const c = control();
    const client = new HomeAssistantClient(haConfig(local.url), (url, options) => controlled(local.connect(url, options), c), {
      maxBufferedBytes: 1024, maxQueuedMessages: capacity === "frames" ? 1 : 32, providerTimeoutMs: 30,
    });
    client.start();
    try {
      await waitFor(() => client.health().status === "ready");
      local.servers[0]!.pause(); c.hold = true; c.sent.length = 0;
      const dataSize = 1024 - Buffer.byteLength(JSON.stringify({ id: 3, type: "call_service", domain: "light", service: "turn_on", target: { entity_id: ["light.test"] }, service_data: { text: "" } }));
      const input = capacity === "bytes" ? { ...service, data: { text: "x".repeat(dataSize) } } : service;
      c.fail = capacity === "callback";
      const first = client.callService(input);
      const failed = assert.rejects(first, error => error instanceof Error && !error.message.includes("PRIVATE"));
      if (capacity === "bytes" || capacity === "frames") {
        assert.equal(c.sent.length, 1);
        if (capacity === "bytes") assert.equal(Buffer.byteLength(c.sent[0]!), 1024);
        await assert.rejects(client.callService(service));
        assert.equal(c.sent.length, 1);
      } else if (capacity === "close") local.servers[0]!.terminate();
      else if (capacity === "shutdown") await client.close();
      await failed;
      c.hold = false; c.fail = false;
      for (const callback of c.pending) { callback(); callback(); }
      if (capacity === "shutdown") client.start();
      await waitFor(() => client.health().status === "ready" && local.clients.length >= 2);
      await client.callService(service);
      assert.ok(local.clients.every(socket => socket.bufferedAmount <= 1024));
    } finally { await client.close(); await local.close(); }
  });
}

test("Home Assistant authentication is bounded before token enqueue", async () => {
  const local = await homePeer(); const c = control();
  const client = new HomeAssistantClient({ ...haConfig(local.url), token: "x".repeat(1024), reconnectBaseMs: 10000 },
    (url, options) => controlled(local.connect(url, options), c), { maxBufferedBytes: 1024 });
  client.start();
  try { await waitFor(() => local.clients[0]?.readyState === WebSocket.CLOSED); assert.deepEqual(c.sent, []); }
  finally { await client.close(); await local.close(); }
});

const mcplConfig = (url: string): EidoverseMcplConfig => ({
  doorUrl: url, tokenRef: "INVENTED_TOKEN", worldName: "commons", agentName: "companion", featureSets: [], effectiveCapabilities: [],
  catchupWake: false, wakeQueueLimit: 4, reconnectBaseMs: 10, reconnectMaxMs: 20, reconnectMaxAttempts: 3,
  requestTimeoutMs: 100, handshakeTimeoutMs: 1000, ambientSayDebounceMs: 50,
});
function mcplSocket(socket: WebSocket): EidoverseMcplSocket {
  return { get bufferedAmount() { return socket.bufferedAmount; }, send: (data, callback) => socket.send(data, callback),
    pong: (data, callback) => socket.pong(data, undefined, callback), onPing: handler => { socket.on("ping", handler); },
    close: () => socket.terminate(), onOpen: handler => { socket.on("open", handler); },
    onClose: handler => { socket.on("close", handler); }, onError: handler => { socket.on("error", handler); },
    onMessage: handler => { socket.on("message", raw => handler(String(raw))); } };
}
async function mcplPeer() {
  const servers: WebSocket[] = [];
  const local = await peer(socket => {
    servers.push(socket);
    socket.on("message", raw => {
      const frame = JSON.parse(String(raw)); if (frame.id === undefined) return;
      const result = frame.method === "channels/list" ? { channels: [{ id: "world:commons", address: { world: "commons" } }] }
        : frame.method === "featureSets/update" ? { accepted: true, unavailableFeatures: [] }
        : frame.method === "tools/call" ? { content: [{ type: "text", text: "said" }] } : {};
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    });
  });
  return { ...local, servers };
}
for (const capacity of ["bytes", "frames", "callback", "timeout", "close", "shutdown"]) {
  test(`MCPL ${capacity} output failure terminates pending requests and a fresh session recovers`, async () => {
    const local = await mcplPeer(); const c = control();
    const client = new EidoverseMcplClient(mcplConfig(local.url), async () => "invented-credential", {
      connect: url => mcplSocket(controlled(local.connect(url, { autoPong: false }), c)),
      limits: { maxBufferedBytes: 1024, maxQueuedMessages: capacity === "frames" ? 2 : 32, providerTimeoutMs: 30 },
    });
    try {
      await client.start(); local.servers[0]!.pause(); c.hold = true; c.sent.length = 0;
      c.fail = capacity === "callback";
      const text = "x".repeat(capacity === "bytes" ? 1024 - Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "say", arguments: { text: "" } } })) : 1);
      const first = client.say(text); const failed = assert.rejects(first);
      if (capacity === "bytes" || capacity === "frames") {
        assert.equal(c.sent.length, 1);
        if (capacity === "bytes") assert.equal(Buffer.byteLength(c.sent[0]!), 1024);
        const extra = capacity === "frames" ? assert.rejects(client.say("y")) : Promise.resolve();
        await assert.rejects(client.say("x")); await extra;
        assert.equal(c.sent.length, capacity === "frames" ? 2 : 1);
      } else if (capacity === "close") local.servers[0]!.terminate();
      else if (capacity === "shutdown") await client.close();
      await failed;
      c.hold = false; c.fail = false; for (const callback of c.pending) { callback(); callback(); }
      if (capacity === "shutdown") await client.start();
      await waitFor(async () => {
        if (local.clients.length < 2) return false;
        try { await client.say("recovered"); return true; } catch { return false; }
      });
      assert.ok(local.clients.every(socket => socket.bufferedAmount <= 1024));
    } finally { await client.close(); await local.close(); }
  });
}

test("MCPL initialized notification and inbound response writes share frame admission", async () => {
  const local = await mcplPeer(); const c = control(); c.hold = true;
  const client = new EidoverseMcplClient(mcplConfig(local.url), async () => "invented-credential", {
    connect: url => mcplSocket(controlled(local.connect(url, { autoPong: false }), c)), limits: { maxBufferedBytes: 1024, maxQueuedMessages: 1 },
  });
  try {
    await assert.rejects(client.start());
    assert.equal(c.sent.length, 1, "initialized cannot enqueue while initialize callback is pending");
  } finally { await client.close(); await local.close(); }
});

test("MCPL response overflow cannot dispatch an incoming wake", async () => {
  const local = await mcplPeer(); const c = control();
  const client = new EidoverseMcplClient(mcplConfig(local.url), async () => "invented-credential", {
    connect: url => mcplSocket(controlled(local.connect(url, { autoPong: false }), c)), limits: { maxBufferedBytes: 1024 },
  });
  let wakes = 0; client.setIncomingHandler(() => { wakes++; });
  try {
    await client.start(); c.sent.length = 0;
    const closed = once(local.clients[0]!, "close");
    local.servers[0]!.send(JSON.stringify({ jsonrpc: "2.0", id: "incoming", method: "channels/incoming", params: {
      messages: Array.from({ length: 100 }, (_, i) => ({ channelId: "world:commons", messageId: `message-${i}`, content: [] })),
    } }));
    await closed;
    assert.equal(c.sent.length, 0); assert.equal(wakes, 0);
  } finally { await client.close(); await local.close(); }
});

test("ElevenLabs real ping flood uses pong frames at exact byte capacity and fails one over before enqueue", async () => {
  const servers: WebSocket[] = [];
  const local = await peer(socket => {
    servers.push(socket);
    socket.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.text === "recovered") socket.send(JSON.stringify({ context_id: frame.context_id, audio: "AQ==", is_final: true }));
    });
  });
  const c = control();
  const pongs: Buffer[] = [];
  const tts = new ElevenLabsStream("invented-key", "model", "voice", { maxBufferedBytes: 1024 }, (url, options) => {
    const socket = controlled(local.connect(url, options), c);
    const pong = socket.pong.bind(socket);
    socket.pong = ((data: Buffer, _mask: boolean | undefined, callback: (error?: Error) => void) => {
      pongs.push(data);
      pong(data, undefined, error => { if (c.hold) c.pending.push(callback); else callback(error); });
    }) as WebSocket["pong"];
    return socket;
  });
  async function* stall() { await new Promise(() => undefined); yield "unused"; }
  const pending = assert.rejects(collect(tts, stall()));
  try {
    await waitFor(() => c.sent.length === 1);
    // Wait for the startup callback before filling the independent pong budget.
    await new Promise(resolve => setImmediate(resolve));
    servers[0]!.pause(); c.hold = true;
    for (let i = 0; i < 8; i++) servers[0]!.ping(Buffer.alloc(125));
    servers[0]!.ping(Buffer.alloc(24));
    await waitFor(() => pongs.length === 9);
    assert.equal(pongs.reduce((sum, data) => sum + data.length, 0), 1024);
    assert.equal(c.sent.length, 1, "ping replies must be control frames rather than data messages");
    servers[0]!.ping(Buffer.alloc(1));
    await pending;
    assert.equal(pongs.length, 9);
    c.hold = false; for (const callback of c.pending) callback();
    async function* text() { yield "recovered"; }
    assert.equal((await collect(tts, text())).length, 1);
  } finally { await tts.close(); await local.close(); }
});

for (const failure of ["callback", "timeout", "close", "shutdown"]) {
  test(`ElevenLabs ${failure} releases socket writes and a new connection returns audio`, async () => {
    const servers: WebSocket[] = [];
    const local = await peer(socket => {
      servers.push(socket);
      socket.on("message", raw => {
        const frame = JSON.parse(String(raw));
        if (frame.text === "recovered") socket.send(JSON.stringify({ context_id: frame.context_id, audio: "AQ==", is_final: true }));
      });
    });
    const c = control(); c.hold = true;
    const tts = new ElevenLabsStream("invented-key", "model", "voice", { maxBufferedBytes: 1024, providerTimeoutMs: 50 },
      (url, options) => controlled(local.connect(url, options), c));
    async function* stall() { yield "waiting"; await new Promise(() => undefined); }
    try {
      const pending = assert.rejects(collect(tts, stall()), error => error instanceof Error && !error.message.includes("PRIVATE"));
      await waitFor(() => c.pending.length >= 2);
      servers[0]!.pause();
      if (failure === "callback") c.pending[0]!(new Error("PRIVATE old callback"));
      else if (failure === "close") servers[0]!.terminate();
      else if (failure === "shutdown") await tts.close();
      await pending;
      await waitFor(() => local.clients[0]!.readyState === WebSocket.CLOSED);
      c.hold = false;
      async function* recovered() { yield "recovered"; }
      const next = collect(tts, recovered());
      for (const callback of c.pending) { callback(); callback(new Error("PRIVATE stale callback")); }
      assert.equal((await next).length, 1);
      assert.ok(local.clients.every(socket => socket.bufferedAmount <= 1024));
    } finally { await tts.close(); await local.close(); }
  });
  test(`Deepgram ${failure} cannot retain old transcript or damage the next connection`, async () => {
    const servers: WebSocket[] = [];
    const local = await peer(socket => { servers.push(socket); socket.pause(); });
    const c = control(); c.hold = true;
    const errors: string[] = []; const transcripts: string[] = [];
    const session = new DeepgramRealtimeSession("invented-key", 16000, { onError: error => errors.push(error.message),
      onUtterance: event => transcripts.push(event.text) }, "nova-3", { maxBufferedBytes: 1024, providerTimeoutMs: 30 },
    (url, options) => controlled(local.connect(url, options), c));
    try {
      await session.start(); session.sendAudio(Buffer.alloc(1024));
      await waitFor(() => c.pending.length === 1);
      const closed = once(local.clients[0]!, "close");
      if (failure === "callback") c.pending[0]!(new Error("PRIVATE provider callback"));
      else if (failure === "close") servers[0]!.terminate();
      else if (failure === "shutdown") await session.close();
      await closed;
      assert.deepEqual(transcripts, []); assert.ok(errors.every(message => !message.includes("PRIVATE")));
      c.hold = false; await session.start();
      for (const callback of c.pending) { callback(); callback(new Error("PRIVATE old callback")); }
      session.sendAudio(Buffer.alloc(1024));
      assert.equal(c.sent.length, 2);
    } finally { await session.close(); await local.close(); }
  });
}
