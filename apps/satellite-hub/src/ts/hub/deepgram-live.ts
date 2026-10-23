import { resolveHubResourceLimits, type HubResourceLimits } from "./transport-resources.js";
import WebSocket from "ws";
import { ProviderSocketOutput } from "./provider-socket-output.js";

export interface TranscriptInterim {
  text: string;
  provider: string;
  latencyMs: number;
}

export interface TranscriptResult {
  text: string;
  provider: string;
  latencyMs: number;
}

interface DeepgramRealtimeCallbacks {
  onInterim?: (event: TranscriptInterim) => void;
  onUtterance?: (event: TranscriptResult) => void;
  onError?: (error: Error) => void;
}

export class DeepgramRealtimeSession {
  private ws: WebSocket | null = null;
  private output: ProviderSocketOutput | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private lastSendAt = Date.now();
  private readonly finalSegments: string[] = [];
  private interimText = "";
  private finalBytes = 0;
  private readonly limits: HubResourceLimits;
  private utteranceStartedAt = 0;
  private readonly endpointingMs = parsePositiveInt(process.env.DEEPGRAM_ENDPOINTING_MS, 800);
  private readonly utteranceEndMs = parsePositiveInt(process.env.DEEPGRAM_UTTERANCE_END_MS, 1800);

  constructor(
    private readonly apiKey: string,
    private readonly sampleRate: number,
    private readonly callbacks: DeepgramRealtimeCallbacks,
    private readonly model = "nova-3",
    limits?: Partial<HubResourceLimits>,
    private readonly connect = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options),
  ) { this.limits = resolveHubResourceLimits(limits); }

  async start(): Promise<void> {
    const url =
      "wss://api.deepgram.com/v1/listen" +
      `?model=${encodeURIComponent(this.model)}` +
      "&encoding=linear16" +
      `&sample_rate=${this.sampleRate}` +
      "&channels=1" +
      "&interim_results=true" +
      `&endpointing=${this.endpointingMs}` +
      `&utterance_end_ms=${this.utteranceEndMs}` +
      "&vad_events=true" +
      "&smart_format=true";

    this.ws = this.connect(url, {
      maxPayload: this.limits.maxFrameBytes, perMessageDeflate: false, autoPong: false, handshakeTimeout: this.limits.providerTimeoutMs,
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });
    const ws = this.ws;
    const output = new ProviderSocketOutput(ws, this.limits, error => {
      if (this.ws !== ws) return;
      this.resetUtterance();
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      this.callbacks.onError?.(error);
    });
    this.output = output;
    ws.on("ping", data => { try { output.pong(data); } catch { /* Failure was delivered to onError. */ } });
    ws.on("close", () => {
      output.closed();
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      this.resetUtterance();
    });
    this.ws.on("message", (data) => {
      if (this.ws !== ws) return;
      try {
        this.handleMessage(String(data));
      } catch {
        this.resetUtterance();
        this.ws?.terminate();
        this.callbacks.onError?.(new Error("Deepgram provider response rejected"));
      }
    });
    this.ws.on("error", () => {
      if (this.ws !== ws) return;
      this.callbacks.onError?.(new Error("Deepgram provider stream failed"));
    });
    await waitForOpen(this.ws);
    this.keepAliveTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if ((Date.now() - this.lastSendAt) < 8000) {
        return;
      }
      try { output.send(JSON.stringify({ type: "KeepAlive" })); } catch { /* Failure was delivered to onError. */ }
    }, 8000);
  }

  sendAudio(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || chunk.length === 0) {
      return;
    }
    if (this.utteranceStartedAt === 0) {
      this.utteranceStartedAt = Date.now();
    }
    this.output!.send(chunk);
    this.lastSendAt = Date.now();
  }

  async close(): Promise<void> {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.resetUtterance();
    if (!ws) {
      return;
    }
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.terminate();
    });
  }

  private handleMessage(raw: string): void {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const type = String(payload.type || "");
    if (type === "UtteranceEnd") {
      this.flushUtterance();
      return;
    }
    if (type !== "Results") {
      return;
    }

    const channel = (payload.channel || {}) as Record<string, unknown>;
    const alternatives = (channel.alternatives || []) as Array<Record<string, unknown>>;
    const transcript = String(alternatives[0]?.transcript || "").trim();
    const isFinal = Boolean(payload.is_final);
    const speechFinal = Boolean(payload.speech_final || payload.from_finalize);

    if (transcript) {
      if (this.utteranceStartedAt === 0) {
        this.utteranceStartedAt = Date.now();
      }
      if ((!isFinal || this.finalSegments[this.finalSegments.length - 1] !== transcript)
        && this.finalBytes + Buffer.byteLength(transcript) + (this.finalSegments.length > 0 ? 1 : 0) > this.limits.maxQueuedBytes) {
        throw new Error("Hub transcript exceeds byte limit");
      }
      if (isFinal) {
        if (this.finalSegments[this.finalSegments.length - 1] !== transcript) {
          this.finalBytes += Buffer.byteLength(transcript) + (this.finalSegments.length > 0 ? 1 : 0);
          this.finalSegments.push(transcript);
        }
        this.interimText = "";
      } else {
        this.interimText = transcript;
        const combined = [...this.finalSegments, transcript].join(" ").trim();
        if (combined) {
          this.callbacks.onInterim?.({
            text: combined,
            provider: "deepgram-live",
            latencyMs: this.utteranceLatencyMs(),
          });
        }
      }
    }

    if (speechFinal) {
      this.flushUtterance();
    }
  }

  private flushUtterance(): void {
    const text = [...this.finalSegments, this.finalSegments.length === 0 ? this.interimText : ""]
      .join(" ")
      .trim();
    if (!text) {
      this.resetUtterance();
      return;
    }
    this.callbacks.onUtterance?.({
      text,
      provider: "deepgram-live",
      latencyMs: this.utteranceLatencyMs(),
    });
    this.resetUtterance();
  }

  private utteranceLatencyMs(): number {
    return this.utteranceStartedAt > 0 ? Date.now() - this.utteranceStartedAt : 0;
  }

  private resetUtterance(): void {
    this.finalSegments.length = 0;
    this.finalBytes = 0;
    this.interimText = "";
    this.utteranceStartedAt = 0;
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}
