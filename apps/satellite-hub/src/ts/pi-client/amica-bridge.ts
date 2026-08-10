import { Buffer } from "node:buffer";

import type { AmicaBridgeConfig } from "../shared/env.js";

interface SatelliteBridgeSessionEventData {
  sessionId: string;
  turnId?: string;
}

interface SatelliteUserFinalEvent {
  type: "user.final";
  data: SatelliteBridgeSessionEventData & {
    text: string;
  };
}

interface SatelliteAssistantFinalEvent {
  type: "assistant.final";
  data: SatelliteBridgeSessionEventData & {
    text: string;
    audioBase64: string;
    mimeType: string;
    durationMs?: number;
    segmentIndex?: number;
  };
}

interface SatelliteAssistantSegmentEvent {
  type: "assistant.segment";
  data: SatelliteBridgeSessionEventData & {
    text: string;
    audioBase64: string;
    mimeType: string;
    durationMs?: number;
    segmentIndex?: number;
  };
}

interface SatelliteInterruptEvent {
  type: "interrupt";
  data: SatelliteBridgeSessionEventData;
}

type SatelliteBridgeEvent =
  | SatelliteUserFinalEvent
  | SatelliteAssistantSegmentEvent
  | SatelliteAssistantFinalEvent
  | SatelliteInterruptEvent;

export class AmicaBridge {
  private readonly endpointUrl: URL;
  private sessionId: string | null = null;
  private currentAssistantAudioChunks: Buffer[] = [];
  private currentAssistantAudioBytes = 0;
  private assistantAudioSegments: Array<{
    audioChunks: Buffer[];
    audioBytes: number;
  }> = [];

  constructor(private readonly config: AmicaBridgeConfig) {
    this.endpointUrl = new URL(config.endpointUrl);
  }

  isOwnerMode(): boolean {
    return this.config.ownerMode;
  }

  setSessionId(sessionId: string | null | undefined): void {
    const normalized = sessionId?.trim() ?? "";
    this.sessionId = normalized ? normalized : null;
  }

  clearAssistantTurn(): void {
    this.currentAssistantAudioChunks = [];
    this.currentAssistantAudioBytes = 0;
    this.assistantAudioSegments = [];
  }

  recordAssistantAudio(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.currentAssistantAudioChunks.push(Buffer.from(chunk));
    this.currentAssistantAudioBytes += chunk.length;
  }

  sealAssistantAudioSegment(): boolean {
    if (this.currentAssistantAudioBytes === 0) {
      return false;
    }
    this.assistantAudioSegments.push({
      audioChunks: this.currentAssistantAudioChunks,
      audioBytes: this.currentAssistantAudioBytes,
    });
    this.currentAssistantAudioChunks = [];
    this.currentAssistantAudioBytes = 0;
    return true;
  }

  hasQueuedAssistantAudio(): boolean {
    return this.assistantAudioSegments.length > 0 || this.currentAssistantAudioBytes > 0;
  }

  estimateAssistantAudioDurationMs(): number {
    const audioBytes = this.assistantAudioSegments[0]?.audioBytes ?? this.currentAssistantAudioBytes;
    return Math.max(0, Math.round(audioBytes / 16));
  }

  async postUserFinal(text: string, turnId?: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("Amica bridge user text is empty");
    }
    await this.postEvent({
      type: "user.final",
      data: {
        sessionId: this.requireSessionId(),
        ...(turnId ? { turnId } : {}),
        text: normalized,
      },
    });
  }

  async postAssistantFinal(text: string, turnId?: string, segmentIndex?: number): Promise<number> {
    return this.postAssistantAudioEvent("assistant.final", text, turnId, segmentIndex);
  }

  async postAssistantSegment(text: string, turnId?: string, segmentIndex?: number): Promise<number> {
    return this.postAssistantAudioEvent("assistant.segment", text, turnId, segmentIndex);
  }

  private async postAssistantAudioEvent(
    type: SatelliteAssistantSegmentEvent["type"] | SatelliteAssistantFinalEvent["type"],
    text: string,
    turnId?: string,
    segmentIndex?: number,
  ): Promise<number> {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("Amica bridge assistant text is empty");
    }
    const segment = this.takeAssistantAudioSegment();
    if (!segment) {
      throw new Error("Amica bridge assistant audio is empty");
    }

    const durationMs = Math.max(0, Math.round(segment.audioBytes / 16));
    const audioBase64 = Buffer.concat(segment.audioChunks).toString("base64");

    await this.postEvent({
      type,
      data: {
        sessionId: this.requireSessionId(),
        ...(turnId ? { turnId } : {}),
        text: normalized,
        audioBase64,
        mimeType: "audio/mpeg",
        durationMs: durationMs > 0 ? durationMs : undefined,
        ...(segmentIndex !== undefined ? { segmentIndex } : {}),
      },
    });
    return durationMs;
  }

  async postInterrupt(turnId?: string): Promise<void> {
    await this.postEvent({
      type: "interrupt",
      data: {
        sessionId: this.requireSessionId(),
        ...(turnId ? { turnId } : {}),
      },
    });
    this.clearAssistantTurn();
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error("Amica bridge session ID is not available yet");
    }
    return this.sessionId;
  }

  private takeAssistantAudioSegment(): {
    audioChunks: Buffer[];
    audioBytes: number;
  } | null {
    if (this.assistantAudioSegments.length > 0) {
      return this.assistantAudioSegments.shift() ?? null;
    }
    if (this.currentAssistantAudioBytes === 0) {
      return null;
    }
    const segment = {
      audioChunks: this.currentAssistantAudioChunks,
      audioBytes: this.currentAssistantAudioBytes,
    };
    this.currentAssistantAudioChunks = [];
    this.currentAssistantAudioBytes = 0;
    return segment;
  }

  private async postEvent(event: SatelliteBridgeEvent): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(this.endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Amica-Bridge-Token": this.config.token,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await formatError(response));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function formatError(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  if (body) {
    return `Amica bridge request failed (${response.status}): ${body}`;
  }
  return `Amica bridge request failed (${response.status})`;
}
