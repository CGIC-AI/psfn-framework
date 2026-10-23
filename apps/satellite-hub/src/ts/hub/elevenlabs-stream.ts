import { resolveHubResourceLimits, type HubResourceLimits } from "./transport-resources.js";
import { hubConsole as console } from "../shared/private-log.js";
import crypto from "node:crypto";

import WebSocket from "ws";

import {
  abortableAsyncIterable,
  awaitWithAbort,
} from "../shared/abort.js";
import { AsyncQueue } from "../shared/async-queue.js";

export interface StreamingTtsAdapter {
  streamText(
    textStream: AsyncIterable<string>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<Buffer>;
  close(): Promise<void>;
}

interface TtsContext {
  queue: AsyncQueue<Buffer>;
  receivedBytes: number;
  completed: boolean;
  error?: Error;
}

export class ElevenLabsStream implements StreamingTtsAdapter {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly contexts = new Map<string, TtsContext>();
  private readonly limits: HubResourceLimits;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly voiceId: string,
    limits?: Partial<HubResourceLimits>,
    private readonly connect = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options),
  ) { this.limits = resolveHubResourceLimits(limits); }

  async *streamText(textStream: AsyncIterable<string>, options: { signal?: AbortSignal } = {}): AsyncGenerator<Buffer, void, void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.limits.providerTimeoutMs), ...(options.signal ? [options.signal] : [])]);
    assertTtsActive(signal);
    if (this.contexts.size >= this.limits.maxProviderOperations) throw new Error("Hub TTS context quota exceeded");
    try { await awaitWithAbort(this.ensureConnected(), signal); }
    catch { throw new Error("Hub TTS connection failed"); }
    assertTtsActive(signal);
    if (this.contexts.size >= this.limits.maxProviderOperations) throw new Error("Hub TTS context quota exceeded");
    const contextId = `ctx-${crypto.randomUUID()}`;
    const context: TtsContext = { queue: new AsyncQueue<Buffer>(this.limits.maxQueuedMessages), receivedBytes: 0, completed: false };
    this.contexts.set(contextId, context);
    let closeRequested = false;
    const requestContextClose = (): void => {
      if (closeRequested) return;
      closeRequested = true;
      this.sendJson({ context_id: contextId, close_context: true });
    };
    const onAbort = (): void => context.queue.close();
    signal.addEventListener("abort", onAbort, { once: true });
    let sender = Promise.resolve();
    try {
      assertTtsActive(signal);
      this.sendJson({ context_id: contextId, text: " ", voice_settings: { stability: 0.35, similarity_boost: 0.7, speed: 1.0 } });
      sender = (async (): Promise<void> => {
        for await (const delta of abortableAsyncIterable(textStream, signal)) {
          assertTtsActive(signal);
          const text = delta.trim();
          if (text) this.sendJson({ context_id: contextId, text, flush: true });
        }
        requestContextClose();
      })();
      void sender.catch(() => {
        context.error = new Error("Hub TTS input failed");
        context.queue.close();
      });
      for await (const chunk of context.queue) {
        assertTtsActive(signal);
        if (context.error) throw context.error;
        yield chunk;
      }
      assertTtsActive(signal);
      if (context.error) throw context.error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      context.queue.close();
      this.contexts.delete(contextId);
      try { requestContextClose(); }
      catch { console.error("Failed to close cancelled ElevenLabs TTS context:"); }
      void sender.catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    for (const context of this.contexts.values()) {
      context.error = new Error("Hub TTS provider stream closed");
      context.queue.close();
    }
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { ws.once("close", resolve); ws.terminate(); });
  }

  private ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.connecting ??= this.openConnection().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async openConnection(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    const uri =
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/multi-stream-input` +
      `?model_id=${encodeURIComponent(this.modelId)}` +
      "&output_format=mp3_44100_128" +
      "&inactivity_timeout=180" +
      "&auto_mode=true";
    const ws = this.connect(uri, {
      maxPayload: this.limits.maxFrameBytes, perMessageDeflate: false, handshakeTimeout: this.limits.providerTimeoutMs,
      headers: {
        "xi-api-key": this.apiKey,
      },
    });
    this.ws = ws;
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      try { this.handleMessage(String(data)); }
      catch {
        for (const context of this.contexts.values()) {
          context.error = new Error("Hub TTS provider response rejected");
          context.queue.close();
        }
        ws.terminate();
      }
    });
    ws.on("error", (error) => {
      console.error("ElevenLabs TTS stream failed:", error);
      if (this.ws === ws) {
        for (const context of this.contexts.values()) {
          if (!context.completed) context.error = new Error("Hub TTS provider stream closed");
          context.queue.close();
        }
      }
    });
    ws.on("close", () => {
      if (this.ws === ws) {
        this.ws = null;
        for (const context of this.contexts.values()) {
          if (!context.completed) context.error = new Error("Hub TTS provider stream closed");
          context.queue.close();
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        ws.removeListener("open", onOpen);
        ws.removeListener("error", onError);
        ws.removeListener("close", onClose);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onOpen = (): void => finish();
      const onError = (error: Error): void => finish(error);
      const onClose = (): void => finish(new Error("ElevenLabs TTS stream closed before opening"));
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
  }

  private handleMessage(raw: string): void {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const contextId = String(payload.contextId || payload.context_id || "");
    if (!contextId) {
      return;
    }
    const context = this.contexts.get(contextId);
    if (!context || context.completed) {
      return;
    }
    const audio = String(payload.audio || "");
    if (audio) {
      const bytes = Buffer.byteLength(audio, "base64");
      const total = context.receivedBytes + bytes;
      if (total > this.limits.maxAudioBytes) throw new Error("Hub TTS audio exceeds byte limit");
      context.receivedBytes = total;
      if (bytes > 0) context.queue.push(Buffer.from(audio, "base64"));
    }
    if (payload.isFinal || payload.is_final) {
      context.completed = true;
      context.queue.close();
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }
}

function assertTtsActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Hub TTS operation aborted", "AbortError");
}
