import crypto from "node:crypto";

import WebSocket from "ws";

import {
  abortableAsyncIterable,
  abortReason,
  awaitWithAbort,
  throwIfAborted,
} from "../shared/abort.js";
import { AsyncQueue } from "../shared/async-queue.js";

export interface StreamingTtsAdapter {
  streamText(
    textStream: AsyncIterable<string>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<Buffer>;
  close(): Promise<void>;
}

export class ElevenLabsStream implements StreamingTtsAdapter {
  private ws: WebSocket | null = null;
  private readonly contexts = new Map<string, AsyncQueue<Buffer>>();

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly voiceId: string,
  ) {}

  async *streamText(
    textStream: AsyncIterable<string>,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<Buffer, void, void> {
    const signal = options.signal;
    if (signal) {
      throwIfAborted(signal);
      await awaitWithAbort(this.ensureConnected(), signal);
      throwIfAborted(signal);
    } else {
      await this.ensureConnected();
    }
    const contextId = `ctx-${crypto.randomUUID()}`;
    const queue = new AsyncQueue<Buffer>();
    this.contexts.set(contextId, queue);

    let closeRequested = false;
    const requestContextClose = (): void => {
      if (closeRequested) {
        return;
      }
      closeRequested = true;
      this.sendJson({
        context_id: contextId,
        close_context: true,
      });
    };
    const onAbort = (): void => {
      queue.close();
      try {
        requestContextClose();
      } catch (error) {
        console.error("Failed to close cancelled ElevenLabs TTS context:", error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", onAbort);
      queue.close();
      this.contexts.delete(contextId);
      throw abortReason(signal);
    }

    this.sendJson({
      context_id: contextId,
      text: " ",
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.7,
        speed: 1.0,
      },
    });

    const sender = (async (): Promise<void> => {
      const input = signal ? abortableAsyncIterable(textStream, signal) : textStream;
      for await (const delta of input) {
        if (signal) {
          throwIfAborted(signal);
        }
        const text = delta.trim();
        if (!text) {
          continue;
        }
        this.sendJson({
          context_id: contextId,
          text,
          flush: true,
        });
      }
      requestContextClose();
    })();
    void sender.catch(() => undefined);

    try {
      for await (const chunk of queue) {
        if (signal) {
          throwIfAborted(signal);
        }
        yield chunk;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      requestContextClose();
      queue.close();
      this.contexts.delete(contextId);
      if (signal?.aborted) {
        void sender.catch(() => undefined);
      } else {
        await sender;
      }
    }
    if (signal) {
      throwIfAborted(signal);
    }
  }

  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    for (const queue of this.contexts.values()) {
      queue.close();
    }
    this.contexts.clear();
    if (!ws) {
      return;
    }
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    const uri =
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/multi-stream-input` +
      `?model_id=${encodeURIComponent(this.modelId)}` +
      "&output_format=mp3_44100_128" +
      "&inactivity_timeout=180" +
      "&auto_mode=true";
    const ws = new WebSocket(uri, {
      headers: {
        "xi-api-key": this.apiKey,
      },
    });
    this.ws = ws;
    ws.on("message", (data) => this.handleMessage(String(data)));
    ws.on("error", (error) => {
      console.error("ElevenLabs TTS stream failed:", error);
      if (this.ws === ws) {
        for (const queue of this.contexts.values()) {
          queue.close();
        }
      }
    });
    ws.on("close", () => {
      if (this.ws === ws) {
        this.ws = null;
        for (const queue of this.contexts.values()) {
          queue.close();
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
    const queue = this.contexts.get(contextId);
    if (!queue) {
      return;
    }
    const audio = String(payload.audio || "");
    if (audio) {
      queue.push(Buffer.from(audio, "base64"));
    }
    if (payload.isFinal || payload.is_final) {
      queue.close();
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }
}
