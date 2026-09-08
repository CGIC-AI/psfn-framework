import type { StreamingTtsAdapter } from "./elevenlabs-stream.js";
import { abortableAsyncIterable } from "../shared/abort.js";
import { sanitizeSpokenText } from "../shared/text.js";

/** Only final companion text already authorized by the gateway enters TTS. */
export class CompanionBrowserSpeech {
  private controller: AbortController | null = null;
  private capable = false;
  private readonly turns = new Set<string>();
  private audio: { requestId: string; ready: boolean; active: boolean; cancelled: boolean;
    stopping: boolean; pendingInterrupts: number } | null = null;

  constructor(private readonly tts: StreamingTtsAdapter | null,
    private readonly send: (value: unknown) => void) {}

  observeBrowser(value: Record<string, unknown>): void {
    if (typeof value.requestId === "string"
      && ["conversation.interact", "conversation.touch", "conversation.audio"].includes(String(value.resource))) {
      this.turns.add(value.requestId);
    }
    if (value.type === "audio.start" && typeof value.requestId === "string") {
      this.audio = { requestId: value.requestId, ready: false, active: false,
        cancelled: false, stopping: false, pendingInterrupts: 0 };
    }
    const audio = this.audio;
    if (audio && audio.requestId === value.requestId) {
      if (value.type === "audio.interrupt") audio.pendingInterrupts += 1;
      if (value.type === "audio.stop") audio.stopping = true;
    }
    if (value.type === "audio.interrupt" || value.resource === "conversation.interrupt"
      || value.type === "audio.stop") this.stop(true);
  }

  observeGateway(value: Record<string, unknown>): void {
    if (value.type === "session.ready") {
      this.capable = Boolean(this.tts && Array.isArray(value.capabilities)
        && value.capabilities.includes("audio_output"));
    }
    const audio = this.audio;
    if (audio && value.requestId === audio.requestId) {
      if (value.type === "audio.ready") audio.ready = true;
      if (value.type === "audio.turn.started" && audio.ready && !audio.active) {
        audio.active = true;
        audio.cancelled = audio.pendingInterrupts > 0 || audio.stopping;
      }
      // A turn ending finishes generation; its synthesized audio can still be playing.
      if (value.type === "audio.turn.ended") audio.active = false;
      if (value.type === "audio.stopped") this.audio = null;
    }
    if (value.type === "result" && typeof value.requestId === "string"
      && this.turns.delete(value.requestId) && value.ok === true && record(value.result)
      && value.result.noReply === undefined) {
      this.speak(value.result.content);
    }
    if (value.type === "event" && record(value.event)) {
      if (value.event.type === "action" && value.event.data === "interrupt"
        && audio && audio.pendingInterrupts > 0) {
        // Gateway acknowledgements follow buffered turn events on this socket.
        // Cancellation already happened locally; do not cancel newly submitted text.
        audio.pendingInterrupts -= 1;
      } else if (value.event.type === "assistant.interrupted"
        || (value.event.type === "action"
          && (value.event.data === "pause-audio" || value.event.data === "interrupt"))) this.stop(false);
      if (value.event.type === "message" && record(value.event.data)
        && value.event.data.role === "assistant" && value.event.data.final === true
        && audio?.active && !audio.cancelled && !audio.stopping && audio.pendingInterrupts === 0) {
        // Audio message events have no interaction ID. Accept one final only inside
        // an observed, uncancelled turn of the admitted microphone stream.
        audio.cancelled = true;
        this.speak(value.event.data.content);
      }
    }
  }

  stop(notify: boolean): void {
    this.turns.clear();
    if (this.audio) this.audio.cancelled = true;
    this.stopPlayback(notify);
  }

  private stopPlayback(notify: boolean): void {
    const active = this.controller;
    this.controller = null;
    active?.abort();
    if (notify && this.capable) this.event({ type: "action", data: "pause-audio" });
  }

  private speak(content: unknown): void {
    if (!this.capable || !this.tts || typeof content !== "string" || !content.trim()) return;
    this.stopPlayback(true);
    const controller = new AbortController();
    this.controller = controller;
    const tts = this.tts;
    const text = sanitizeSpokenText(content);
    void (async () => {
      let started = false;
      for await (const chunk of abortableAsyncIterable(
        tts.streamText((async function* () { yield text; })(), { signal: controller.signal }),
        controller.signal,
      )) {
        if (controller.signal.aborted) return;
        if (chunk.length === 0) continue;
        if (!started) this.event({ type: "text", data: "audio-init" });
        started = true;
        this.event({ type: "audio", data: chunk.toString("base64") });
      }
      if (started && !controller.signal.aborted) this.event({ type: "text", data: "audio-end" });
    })().catch(() => {
      if (!controller.signal.aborted) {
        this.event({ type: "action", data: "pause-audio" });
        this.event({ type: "error-event", data: { message: "Spoken reply unavailable; the reply remains in chat", scope: "speech" } });
      }
    }).finally(() => {
      if (this.controller === controller) this.controller = null;
    });
  }

  private event(event: unknown): void { this.send({ schemaVersion: 1, type: "event", event }); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
