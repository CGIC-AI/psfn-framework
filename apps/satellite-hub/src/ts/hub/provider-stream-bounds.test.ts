import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { ElevenLabsStream } from "./elevenlabs-stream.js";
import { DeepgramRealtimeSession } from "./deepgram-live.js";

async function* text(): AsyncGenerator<string> { yield "hello"; }

async function localWebSocket(handle: (socket: WebSocket) => void) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    connect: (_url: string, options: WebSocket.ClientOptions) => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, options),
    close: async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve()))); },
  };
}

test("ElevenLabs byte and frame bounds fail closed, release the context, and recover", async () => {
  let mode = "exact";
  const local = await localWebSocket(socket => socket.on("message", raw => {
    const input = JSON.parse(String(raw)) as { text?: string; context_id: string };
    if (input.text !== "hello") return;
    if (mode === "stall") return;
    if (mode === "frame") { socket.send("x".repeat(1025)); return; }
    for (const size of [4, mode === "over" ? 5 : 4]) {
      socket.send(JSON.stringify({ context_id: input.context_id, audio: Buffer.alloc(size, 1).toString("base64") }));
    }
    socket.send(JSON.stringify({ context_id: input.context_id, is_final: true }));
  }));
  const tts = new ElevenLabsStream("invented-key", "test-model", "test-voice", {
    maxAudioBytes: 8, maxFrameBytes: 1024, providerTimeoutMs: 100, maxProviderOperations: 1,
  }, local.connect);
  const collect = async (signal?: AbortSignal) => {
    const chunks: Buffer[] = [];
    for await (const chunk of tts.streamText(text(), { signal })) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  try {
    assert.equal((await collect()).length, 8);
    for (const invalid of ["over", "frame", "stall"]) {
      mode = invalid;
      await assert.rejects(collect(), error => error instanceof Error && !error.message.includes("invented-key"));
      mode = "exact";
      assert.equal((await collect()).length, 8, "a failed context must not retain quota");
    }
    mode = "stall";
    const controller = new AbortController();
    const pending = collect(controller.signal);
    setTimeout(() => controller.abort(new Error("PRIVATE cancellation message")), 10);
    await assert.rejects(pending, { message: "Hub TTS operation aborted" });
    mode = "exact";
    assert.equal((await collect()).length, 8);
  } finally { await tts.close(); await local.close(); }
});

test("Deepgram realtime bounds cumulative multibyte transcripts and receive frames", async () => {
  let mode = "exact";
  const local = await localWebSocket(socket => {
    setImmediate(() => {
      if (mode === "frame") { socket.send("x".repeat(513)); return; }
      for (const transcript of mode === "over" ? ["éé", "é"] : ["éé", "x"]) {
        socket.send(JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript }] } }));
      }
      socket.send(JSON.stringify({ type: "UtteranceEnd" }));
    });
  });
  try {
    for (const scenario of ["exact", "over", "frame", "exact"]) {
      mode = scenario;
      const transcripts: string[] = [];
      let settle: () => void = () => undefined;
      const done = new Promise<void>(resolve => { settle = resolve; });
      let errors = 0;
      const session = new DeepgramRealtimeSession("invented-key", 16000, {
        onUtterance: event => { transcripts.push(event.text); settle(); },
        onError: () => { errors++; settle(); },
      }, "nova-3", { maxQueuedBytes: 6, maxFrameBytes: 512 }, local.connect);
      try {
        await session.start();
        await done;
        if (scenario === "exact") { assert.deepEqual(transcripts, ["éé x"]); assert.equal(errors, 0); }
        else { assert.deepEqual(transcripts, []); assert.ok(errors > 0); }
      } finally { await session.close(); }
    }
  } finally { await local.close(); }
});
