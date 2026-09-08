import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { CompanionBrowserSpeech } from "./companion-browser-speech.js";
import type { StreamingTtsAdapter } from "./elevenlabs-stream.js";

function fixture(options: { hold?: Promise<void>; fail?: boolean } = {}) {
  const spoken: string[] = [];
  const signals: AbortSignal[] = [];
  const events: unknown[] = [];
  const tts: StreamingTtsAdapter = {
    async *streamText(text, { signal } = {}) {
      if (signal) signals.push(signal);
      for await (const content of text) spoken.push(content);
      if (options.fail) throw new Error("Synthetic provider error");
      yield Buffer.from("first audio");
      if (options.hold) {
        await options.hold;
        yield Buffer.from("late audio");
      }
    },
    async close() {},
  };
  const speech = new CompanionBrowserSpeech(tts, value => events.push(value));
  speech.observeGateway({ type: "session.ready", capabilities: ["audio_output"] });
  const submit = (requestId: string) => speech.observeBrowser({
    requestId, action: "companion.interact", resource: "conversation.interact",
  });
  const result = (requestId: string, content: string) => speech.observeGateway({
    type: "result", requestId, ok: true, result: { content },
  });
  const audio = (type: string, requestId = "microphone") => speech.observeGateway({ type, requestId });
  const start = () => {
    speech.observeBrowser({ type: "audio.start", requestId: "microphone" });
    audio("audio.ready");
  };
  const final = (content: string) => speech.observeGateway({ type: "event",
    event: { type: "message", data: { role: "assistant", final: true, content } } });
  const interrupt = () => speech.observeBrowser({ type: "audio.interrupt", requestId: "microphone" });
  const acknowledge = () => speech.observeGateway({ type: "event", event: { type: "action", data: "interrupt" } });
  return { speech, spoken, signals, events, submit, result, audio, start, final, interrupt, acknowledge };
}

test("an interrupted pending text reply cannot restart speech, while a new request can", async () => {
  const f = fixture();
  f.submit("old");
  f.speech.observeBrowser({ resource: "conversation.interrupt", requestId: "cancel", body: { interactionId: "old" } });
  f.submit("new");
  f.result("old", "Cancelled reply");
  f.result("new", "New reply");
  await setImmediate();
  assert.deepEqual(f.spoken, ["New reply"]);
  assert.deepEqual(f.events[0], { schemaVersion: 1, type: "event", event: { type: "action", data: "pause-audio" } });
});

test("replacing playback preserves other pending authorized text requests", async () => {
  const f = fixture();
  f.submit("first");
  f.submit("second");
  f.result("first", "First reply");
  await setImmediate();
  f.result("second", "Second reply");
  await setImmediate();
  assert.deepEqual(f.spoken, ["First reply", "Second reply"]);
});

test("voice final text speaks once within its stream turn and playback survives generation ending", async () => {
  const f = fixture();
  f.final("Uncorrelated reply");
  f.start();
  f.audio("audio.turn.started", "wrong-stream");
  f.final("Wrong stream reply");
  f.audio("audio.turn.started");
  f.final("Voice reply");
  f.final("Duplicate final");
  f.audio("audio.turn.ended");
  await setImmediate();
  assert.deepEqual(f.spoken, ["Voice reply"]);
  assert.equal(f.signals[0]?.aborted, false);
  assert.deepEqual(f.events.at(-1), { schemaVersion: 1, type: "event", event: { type: "text", data: "audio-end" } });
});

for (const acknowledgeFirst of [false, true]) {
  test(`interrupted voice finals stay cancelled across acknowledgement and turn end (ack first: ${acknowledgeFirst})`, async () => {
    const f = fixture();
    f.start();
    f.audio("audio.turn.started");
    f.interrupt();
    f.submit("after-interrupt");
    if (acknowledgeFirst) f.acknowledge();
    f.final("Cancelled voice reply");
    f.audio("audio.turn.ended");
    if (!acknowledgeFirst) f.acknowledge();
    f.final("Late cancelled reply");
    f.result("after-interrupt", "New text reply");
    await setImmediate();
    f.audio("audio.turn.started");
    f.final("Next voice reply");
    f.audio("audio.turn.ended");
    await setImmediate();
    assert.deepEqual(f.spoken, ["New text reply", "Next voice reply"]);
  });
}

test("turn events already in flight when interruption crosses the socket cannot restart speech", async () => {
  const f = fixture();
  f.start();
  f.interrupt();
  f.audio("audio.turn.started");
  f.final("Buffered old reply");
  f.audio("audio.turn.ended");
  f.acknowledge();
  f.audio("audio.turn.started");
  f.final("Fresh reply");
  await setImmediate();
  assert.deepEqual(f.spoken, ["Fresh reply"]);
});

test("interrupting an idle microphone leaves its next acknowledged turn available", async () => {
  const f = fixture();
  f.start();
  f.interrupt();
  f.acknowledge();
  f.audio("audio.turn.started");
  f.final("Next reply");
  await setImmediate();
  assert.deepEqual(f.spoken, ["Next reply"]);
});

test("stopping a microphone rejects its late final and a newly admitted stream can speak", async () => {
  const f = fixture();
  f.start();
  f.audio("audio.turn.started");
  f.speech.observeBrowser({ type: "audio.stop", requestId: "microphone" });
  f.final("Stopped reply");
  f.audio("audio.stopped");
  f.audio("audio.turn.started");
  f.final("Late stopped reply");
  f.start();
  f.audio("audio.turn.started");
  f.final("Fresh stream reply");
  await setImmediate();
  assert.deepEqual(f.spoken, ["Fresh stream reply"]);
});

test("canonical pause aborts synthesis and removes pending replies without emitting late chunks", async () => {
  let release!: () => void;
  const f = fixture({ hold: new Promise<void>(resolve => { release = resolve; }) });
  f.submit("playing");
  f.result("playing", "Playing reply");
  f.submit("pending");
  await setImmediate();
  f.speech.observeGateway({ type: "event", event: { type: "action", data: "pause-audio" } });
  const count = f.events.length;
  f.result("pending", "Pending reply");
  release();
  await setImmediate();
  assert.equal(f.signals[0]?.aborted, true);
  assert.equal(f.events.length, count);
  assert.deepEqual(f.spoken, ["Playing reply"]);
});

test("synthesis errors emit the canonical playback pause and a separate error event", async () => {
  const f = fixture({ fail: true });
  f.submit("failed");
  f.result("failed", "Reply remains in chat");
  await setImmediate();
  assert.deepEqual(f.events.slice(-2), [
    { schemaVersion: 1, type: "event", event: { type: "action", data: "pause-audio" } },
    { schemaVersion: 1, type: "event", event: { type: "error-event",
      data: { message: "Spoken reply unavailable; the reply remains in chat", scope: "speech" } } },
  ]);
});
