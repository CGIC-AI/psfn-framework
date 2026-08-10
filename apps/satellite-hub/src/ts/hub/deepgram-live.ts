import WebSocket from "ws";

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
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private lastSendAt = Date.now();
  private readonly finalSegments: string[] = [];
  private interimText = "";
  private utteranceStartedAt = 0;
  private readonly endpointingMs = parsePositiveInt(process.env.DEEPGRAM_ENDPOINTING_MS, 800);
  private readonly utteranceEndMs = parsePositiveInt(process.env.DEEPGRAM_UTTERANCE_END_MS, 1800);

  constructor(
    private readonly apiKey: string,
    private readonly sampleRate: number,
    private readonly callbacks: DeepgramRealtimeCallbacks,
    private readonly model = "nova-3",
  ) {}

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

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });
    this.ws.on("message", (data) => {
      try {
        this.handleMessage(String(data));
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.ws.on("error", (error) => {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    await waitForOpen(this.ws);
    this.keepAliveTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if ((Date.now() - this.lastSendAt) < 8000) {
        return;
      }
      this.ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8000);
  }

  sendAudio(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || chunk.length === 0) {
      return;
    }
    if (this.utteranceStartedAt === 0) {
      this.utteranceStartedAt = Date.now();
    }
    this.ws.send(chunk);
    this.lastSendAt = Date.now();
  }

  async close(): Promise<void> {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
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
      if (isFinal) {
        if (this.finalSegments[this.finalSegments.length - 1] !== transcript) {
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
