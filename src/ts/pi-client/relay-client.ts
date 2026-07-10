import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import type { PiClientConfig } from "../shared/env.js";
import {
  decodeAudioChunk,
  encodeAudioChunk,
  type HubToClientMessage,
} from "../shared/protocol.js";

interface RelayTranscriptionResult {
  text: string;
  provider: string;
  latencyMs: number;
}

interface RelaySpeechResult {
  audio: Buffer;
  mimeType: string;
}

interface PendingSttRequest {
  resolve: (result: RelayTranscriptionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingTtsRequest {
  resolve: (result: RelaySpeechResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  chunks: Buffer[];
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class HubOpenAiRelayClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly pendingSttRequests = new Map<string, PendingSttRequest>();
  private readonly pendingTtsRequests = new Map<string, PendingTtsRequest>();

  constructor(private readonly config: PiClientConfig) {}

  start(): void {
    this.connect();
  }

  async transcribePcm(
    pcm: Buffer,
    options: {
      mimeType?: string;
      prompt?: string;
      language?: string;
    } = {},
  ): Promise<RelayTranscriptionResult> {
    await this.waitUntilReady();
    const requestId = `stt-${randomUUID()}`;
    return await new Promise<RelayTranscriptionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSttRequests.delete(requestId);
        reject(new Error("Relay STT request timed out"));
      }, this.config.relayRequestTimeoutMs);

      this.pendingSttRequests.set(requestId, { resolve, reject, timer });
      try {
        this.send({
          type: "relay.stt",
          requestId,
          audio: encodeAudioChunk(pcm),
          ...(options.mimeType ? { mimeType: options.mimeType } : {}),
          ...(options.prompt ? { prompt: options.prompt } : {}),
          ...(options.language ? { language: options.language } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingSttRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async synthesizeSpeech(
    text: string,
    options: {
      voice?: string;
      model?: string;
    } = {},
  ): Promise<RelaySpeechResult> {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("Relay TTS text is empty");
    }

    await this.waitUntilReady();
    const requestId = `tts-${randomUUID()}`;
    return await new Promise<RelaySpeechResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTtsRequests.delete(requestId);
        reject(new Error("Relay TTS request timed out"));
      }, this.config.relayRequestTimeoutMs);

      this.pendingTtsRequests.set(requestId, {
        resolve,
        reject,
        timer,
        chunks: [],
      });
      try {
        this.send({
          type: "relay.tts",
          requestId,
          text: normalized,
          ...(options.voice ? { voice: options.voice } : {}),
          ...(options.model ? { model: options.model } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingTtsRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private connect(): void {
    this.ws = new WebSocket(this.config.hubUrl);
    this.ws.on("open", () => {
      this.ready = false;
      this.send({
        type: "hello",
        deviceId: `${this.config.deviceId}-relay`,
        deviceName: `${this.config.deviceName} OpenAI Relay`,
        ...(this.config.relayDeviceCredential ? { credential: this.config.relayDeviceCredential } : {}),
        sessionId: `${this.config.conversationId?.trim() || `realtime:${this.config.deviceId}`}:relay`,
      });
      console.log("Relay client connected to hub:", this.config.hubUrl);
    });
    this.ws.on("message", (raw) => {
      const json = decodeRawData(raw);
      if (!json) {
        return;
      }

      const message = JSON.parse(json) as HubToClientMessage;
      this.handleMessage(message);
    });
    this.ws.on("close", () => {
      this.ready = false;
      this.failReadyWaiters(new Error("Relay client disconnected from hub"));
      this.failPendingRequests(new Error("Relay client disconnected from hub"));
      console.error("Relay hub connection closed");
      this.scheduleReconnect();
    });
    this.ws.on("error", (error) => {
      console.error("Relay websocket error:", error);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

  private handleMessage(message: HubToClientMessage): void {
    switch (message.type) {
      case "session.ready":
      case "hello.ack":
        this.ready = true;
        this.resolveReadyWaiters();
        return;
      case "status":
      case "pong":
      case "text":
      case "audio":
      case "message":
      case "action":
      case "assistant.interrupted":
        return;
      case "relay.stt.result": {
        const pending = this.pendingSttRequests.get(message.requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pendingSttRequests.delete(message.requestId);
        pending.resolve({
          text: message.text,
          provider: message.provider,
          latencyMs: message.latencyMs ?? 0,
        });
        return;
      }
      case "relay.tts.chunk": {
        const pending = this.pendingTtsRequests.get(message.requestId);
        if (!pending) {
          return;
        }
        pending.chunks.push(decodeAudioChunk(message.audio));
        return;
      }
      case "relay.tts.done": {
        const pending = this.pendingTtsRequests.get(message.requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pendingTtsRequests.delete(message.requestId);
        pending.resolve({
          audio: Buffer.concat(pending.chunks),
          mimeType: message.mimeType,
        });
        return;
      }
      case "relay.error": {
        const error = new Error(message.message);
        const pendingStt = this.pendingSttRequests.get(message.requestId);
        if (pendingStt) {
          clearTimeout(pendingStt.timer);
          this.pendingSttRequests.delete(message.requestId);
          pendingStt.reject(error);
        }
        const pendingTts = this.pendingTtsRequests.get(message.requestId);
        if (pendingTts) {
          clearTimeout(pendingTts.timer);
          this.pendingTtsRequests.delete(message.requestId);
          pendingTts.reject(error);
        }
        return;
      }
      case "error-event":
        console.error("Relay hub error:", message.data.message);
        return;
      default:
        return;
    }
  }

  private waitUntilReady(): Promise<void> {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new Error("Relay hub connection did not become ready in time"));
      }, this.config.relayRequestTimeoutMs);
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer,
      };
      this.readyWaiters.add(waiter);
    });
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.readyWaiters.clear();
  }

  private failReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  private failPendingRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingSttRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingSttRequests.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingTtsRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingTtsRequests.delete(requestId);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay websocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }
}

function decodeRawData(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
}
