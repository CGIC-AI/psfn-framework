import http from "node:http";
import { Readable } from "node:stream";

import type { PiClientControlConfig } from "../shared/env.js";
import { PiRealtimeClient } from "./client.js";
import { HubOpenAiRelayClient } from "./relay-client.js";
import { decodeSpeechUploadToPcm16 } from "./wav.js";

interface MicStatePayload {
  muted: boolean;
  available: boolean;
}

export class PiClientApiServer {
  private micMuted = false;
  private readonly httpServer = http.createServer((request, response) => {
    void this.handleRequest(request, response);
  });

  constructor(
    private readonly config: PiClientControlConfig,
    private readonly relayClient: HubOpenAiRelayClient,
    private readonly realtimeClient: PiRealtimeClient | null,
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.config.port, this.config.bindHost, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    if (request.method === "OPTIONS") {
      this.respondOptions(request, response);
      return;
    }

    if (url.pathname === "/mic") {
      await this.handleMicRequest(request, response);
      return;
    }

    if (url.pathname === "/v1/audio/transcriptions") {
      await this.handleTranscriptionsRequest(request, response);
      return;
    }

    if (url.pathname === "/v1/audio/speech") {
      await this.handleSpeechRequest(request, response);
      return;
    }

    this.respondJson(request, response, 404, { error: "Not found." });
  }

  private async handleMicRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method === "GET") {
      this.respondJson(request, response, 200, this.getMicStatePayload());
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", ["GET", "POST", "OPTIONS"]);
      this.respondJson(request, response, 405, {
        error: `Method ${request.method} Not Allowed`,
      });
      return;
    }

    try {
      const payload = await readJsonBody(request);
      if (typeof payload?.muted !== "boolean") {
        this.respondJson(request, response, 400, {
          error: "Boolean muted value is required.",
        });
        return;
      }

      this.setMicMuted(payload.muted);
      this.respondJson(request, response, 200, this.getMicStatePayload());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.respondJson(request, response, 400, { error: message });
    }
  }

  private async handleTranscriptionsRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("Allow", ["POST", "OPTIONS"]);
      this.respondJson(request, response, 405, {
        error: `Method ${request.method} Not Allowed`,
      });
      return;
    }

    try {
      if (this.isMicMuted()) {
        this.respondJson(request, response, 200, {
          text: "",
          provider: "pi-client-muted",
          latency_ms: 0,
        });
        return;
      }

      const form = await readFormData(request);
      const file = form.get("file");
      if (!(file instanceof File)) {
        this.respondJson(request, response, 400, {
          error: "Multipart file field is required.",
        });
        return;
      }

      const promptValue = form.get("prompt");
      const languageValue = form.get("language");
      const audioBuffer = Buffer.from(await file.arrayBuffer());
      const pcm = decodeSpeechUploadToPcm16(audioBuffer, file.type);
      const result = await this.relayClient.transcribePcm(pcm, {
        mimeType: file.type || "audio/wav",
        prompt: typeof promptValue === "string" ? promptValue : undefined,
        language: typeof languageValue === "string" ? languageValue : undefined,
      });
      this.respondJson(request, response, 200, {
        text: result.text.trim(),
        provider: result.provider,
        latency_ms: result.latencyMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.respondJson(request, response, 502, { error: message });
    }
  }

  private async handleSpeechRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("Allow", ["POST", "OPTIONS"]);
      this.respondJson(request, response, 405, {
        error: `Method ${request.method} Not Allowed`,
      });
      return;
    }

    try {
      const payload = await readJsonBody(request);
      const input = typeof payload.input === "string" ? payload.input.trim() : "";
      if (!input) {
        this.respondJson(request, response, 400, {
          error: "Non-empty input text is required.",
        });
        return;
      }

      const voice = typeof payload.voice === "string" ? payload.voice.trim() : undefined;
      const model = typeof payload.model === "string" ? payload.model.trim() : undefined;
      const result = await this.relayClient.synthesizeSpeech(input, {
        ...(voice ? { voice } : {}),
        ...(model ? { model } : {}),
      });
      this.respondBuffer(request, response, 200, result.mimeType, result.audio);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.respondJson(request, response, 502, { error: message });
    }
  }

  private getMicStatePayload(): MicStatePayload {
    return {
      muted: this.isMicMuted(),
      available: true,
    };
  }

  private isMicMuted(): boolean {
    return this.realtimeClient?.isMicMuted() ?? this.micMuted;
  }

  private setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    this.realtimeClient?.setMicMuted(muted);
  }

  private respondOptions(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void {
    this.applyCors(request, response);
    response.statusCode = 204;
    response.end();
  }

  private respondJson(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    statusCode: number,
    payload: unknown,
  ): void {
    this.applyCors(request, response);
    response.statusCode = statusCode;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  private respondBuffer(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    statusCode: number,
    contentType: string,
    payload: Buffer,
  ): void {
    this.applyCors(request, response);
    response.statusCode = statusCode;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", String(payload.byteLength));
    response.end(payload);
  }

  private applyCors(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void {
    const origin = request.headers.origin?.trim();
    response.setHeader("Access-Control-Allow-Origin", origin || "*");
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const payload = JSON.parse(raw) as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object.");
  }
  return payload;
}

async function readFormData(request: http.IncomingMessage): Promise<FormData> {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const body = Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>;
  const formRequest = new Request(url, {
    method: request.method,
    headers: normalizeHeaders(request.headers),
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return await formRequest.formData();
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized.set(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      normalized.set(key, value.join(", "));
    }
  }
  return normalized;
}
