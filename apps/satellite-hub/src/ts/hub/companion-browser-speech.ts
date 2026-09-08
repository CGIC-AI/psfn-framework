import type { StreamingTtsAdapter } from "./elevenlabs-stream.js";
import { abortableAsyncIterable } from "../shared/abort.js";
import { sanitizeSpokenText } from "../shared/text.js";

/** Only final companion text already authorized by the gateway enters TTS. */
export class CompanionBrowserSpeech {
  private controller: AbortController | null = null;
  private capable = false;
  private readonly turns = new Set<string>();

  constructor(private readonly tts: StreamingTtsAdapter | null,
    private readonly send: (value: unknown) => void) {}

  observeBrowser(value: Record<string, unknown>): void {
    if (typeof value.requestId === "string"
      && ["conversation.interact", "conversation.touch", "conversation.audio"].includes(String(value.resource))) {
      this.turns.add(value.requestId);
    }
    if (value.type === "audio.interrupt" || value.resource === "conversation.interrupt"
      || value.type === "audio.stop") this.stop(true);
  }

  observeGateway(value: Record<string, unknown>): void {
    if (value.type === "session.ready") {
      this.capable = Boolean(this.tts && Array.isArray(value.capabilities)
        && value.capabilities.includes("audio_output"));
    }
    if (value.type === "result" && typeof value.requestId === "string"
      && this.turns.delete(value.requestId) && value.ok === true && record(value.result)
      && value.result.noReply === undefined) {
      this.speak(value.result.content);
    }
    if (value.type === "event" && record(value.event)) {
      if (value.event.type === "assistant.interrupted"
        || (value.event.type === "text" && value.event.data === "pause-audio")) this.stop(false);
      if (value.event.type === "message" && record(value.event.data)
        && value.event.data.role === "assistant" && value.event.data.final === true) {
        this.speak(value.event.data.content);
      }
    }
  }

  stop(notify: boolean): void {
    const active = this.controller;
    this.controller = null;
    active?.abort();
    if (notify && this.capable) this.event({ type: "text", data: "pause-audio" });
  }

  private speak(content: unknown): void {
    if (!this.capable || !this.tts || typeof content !== "string" || !content.trim()) return;
    this.stop(true);
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
        this.event({ type: "text", data: "pause-audio" });
        this.event({ type: "error-event", data: { message: "Spoken reply unavailable; the reply remains in chat" } });
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
