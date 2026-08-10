import WebSocket, { type RawData } from "ws";

import type { PiClientConfig } from "../shared/env.js";
import {
  decodeAudioChunk,
  encodeAudioChunk,
  type HubToClientMessage,
} from "../shared/protocol.js";
import {
  sanitizeSpokenText,
  SPOKEN_SEGMENT_FLUSH_OPTIONS,
  takeFlushChunk,
} from "../shared/text.js";
import { AlsaVolumeController } from "./alsa-volume.js";
import { AmicaBridge } from "./amica-bridge.js";
import { StreamingAudioPlayer } from "./audio-player.js";
import { AudioCapture, type AudioChunk } from "./audio-capture.js";

const PLAYBACK_CAPTURE_COOLDOWN_MS = 0;

export class PiRealtimeClient {
  private ws: WebSocket | null = null;
  private readonly player: StreamingAudioPlayer;
  private readonly capture: AudioCapture;
  private readonly ducking: AlsaVolumeController | null;
  private readonly amicaBridge: AmicaBridge | null;
  private micMuted = false;
  private ready = false;
  private playbackActive = false;
  private playbackGeneration = 0;
  private sentenceCompleted = false;
  private requireNewAudioInit = true;
  private botSpeakEndSent = false;
  private assistantTurnOpen = false;
  private assistantPendingText = "";
  private readonly assistantTextSegments: string[] = [];
  private assistantTextHasStarted = false;
  private userSpeaking = false;
  private lastVoiceActivityAt = 0;
  private interruptingUntil = 0;
  private ownerPlaybackTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private messageChain: Promise<void> = Promise.resolve();
  private pendingOwnerSegments = 0;
  private interruptSpeechStartedAt = 0;
  private playbackStartedAt = 0;
  private captureSuppressedUntil = 0;
  private bridgeTurnSequence = 0;
  private bridgeTurnId: string | null = null;
  private bridgeAssistantSegmentIndex = 0;

  constructor(private readonly config: PiClientConfig) {
    this.player = new StreamingAudioPlayer(config.outputCommand);
    this.capture = new AudioCapture(config.inputCommand, config.micGain);
    this.ducking = config.ducking ? new AlsaVolumeController(config.ducking) : null;
    this.amicaBridge = config.amicaBridge ? new AmicaBridge(config.amicaBridge) : null;

    this.player.on("closed", ({ graceful, generation }) => {
      if (generation !== this.playbackGeneration) {
        console.log(`playback.closed stale generation=${generation}`);
        return;
      }
      this.playbackActive = false;
      this.captureSuppressedUntil = Date.now() + PLAYBACK_CAPTURE_COOLDOWN_MS;
      void this.ducking?.restore();
      if (graceful && this.sentenceCompleted && !this.botSpeakEndSent) {
        this.botSpeakEndSent = true;
        this.send({
          type: "text",
          data: "bot-speak-end",
        });
      }
      this.requireNewAudioInit = true;
      this.sentenceCompleted = false;
      console.log(`playback.closed graceful=${String(graceful)}`);
    });

    this.capture.on("audio", (chunk) => {
      void this.handleChunk(chunk);
    });
    this.capture.on("close", () => {
      setTimeout(() => this.capture.start(), 1000);
    });
    this.capture.on("error", (error) => {
      console.error("Audio capture failed:", error);
    });
  }

  start(): void {
    this.capture.start();
    this.connect();
  }

  isMicMuted(): boolean {
    return this.micMuted;
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    if (muted) {
      this.userSpeaking = false;
      this.lastVoiceActivityAt = 0;
    }
    console.log(`mic.muted=${String(this.micMuted)}`);
  }

  private connect(): void {
    this.ws = new WebSocket(this.config.hubUrl);
    this.ws.on("open", () => {
      this.resetConversationState();
      this.send({
        type: "hello",
        deviceId: this.config.deviceId,
        deviceName: this.config.deviceName,
        ...(this.config.deviceCredential ? { credential: this.config.deviceCredential } : {}),
        ...(this.config.conversationId ? { sessionId: this.config.conversationId } : {}),
      });
      console.log("Connected to hub:", this.config.hubUrl);
    });
    this.ws.on("message", (raw) => {
      const json = decodeRawData(raw);
      if (!json) {
        return;
      }
      const message = JSON.parse(json) as HubToClientMessage;
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(message))
        .catch((error) => {
          console.error("Pi client message handling failed:", error);
          this.failClosed(error);
        });
    });
    this.ws.on("close", () => {
      this.player.stop();
      void this.ducking?.restore();
      this.resetConversationState();
      console.error("Hub connection closed");
      this.scheduleReconnect();
    });
    this.ws.on("error", (error) => {
      console.error("Hub websocket error:", error);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

  private async handleMessage(message: HubToClientMessage): Promise<void> {
    switch (message.type) {
      case "session.ready":
      case "hello.ack":
        this.amicaBridge?.setSessionId(message.sessionId);
        return;
      case "pong":
        return;
      case "status":
        if (message.data === "call_initialized") {
          this.ready = true;
          console.log("call_initialized");
        }
        return;
      case "text":
        await this.handleTextSignal(message.data);
        return;
      case "audio":
        if (this.requireNewAudioInit || !message.data) {
          return;
        }
        await this.handleAudioChunk(decodeAudioChunk(message.data));
        return;
      case "action":
        if (message.data === "interrupt") {
          await this.detectInterrupt();
        }
        return;
      case "message":
        if (message.data.live && message.data.role === "assistant") {
          this.recordAssistantTextDelta(message.data.content);
          await this.flushOwnerModeSegments();
        }
        if (message.data.final && message.data.role === "user") {
          await this.handleFinalUser(message.data.content);
        }
        if (message.data.final && message.data.role === "assistant") {
          await this.handleFinalAssistant(message.data.content);
        }
        return;
      case "assistant.interrupted":
        await this.detectInterrupt();
        return;
      case "error-event":
        console.error("Hub error:", message.data.message);
        return;
      default:
        return;
    }
  }

  private async handleTextSignal(signal: string): Promise<void> {
    if (signal === "audio-init") {
      const startingOwnerTurn = this.amicaBridge?.isOwnerMode() && !this.assistantTurnOpen;
      this.requireNewAudioInit = false;
      this.sentenceCompleted = false;
      this.botSpeakEndSent = false;
      if (startingOwnerTurn) {
        this.resetAssistantTextState();
        this.pendingOwnerSegments = 0;
        this.ensureBridgeTurnId();
        this.bridgeAssistantSegmentIndex = 0;
        this.amicaBridge?.clearAssistantTurn();
      }
      this.assistantTurnOpen = true;
      this.playbackActive = true;
      this.playbackStartedAt = Date.now();
      this.interruptSpeechStartedAt = 0;
      this.clearOwnerPlaybackTimer();
      if (!this.amicaBridge?.isOwnerMode()) {
        this.playbackGeneration = this.player.start();
      }
      await this.ducking?.restore();
      this.send({
        type: "text",
        data: "bot-speaking",
      });
      console.log("audio-init");
      return;
    }
    if (signal === "audio-end") {
      this.sentenceCompleted = true;
      if (this.amicaBridge?.isOwnerMode()) {
        if (!this.amicaBridge.sealAssistantAudioSegment()) {
          console.warn("owner-mode segment ended without buffered audio");
          return;
        }
        this.pendingOwnerSegments += 1;
        await this.flushOwnerModeSegments();
      } else {
        this.player.finish();
      }
      console.log("audio-end");
    }
  }

  private async handleAudioChunk(chunk: Buffer): Promise<void> {
    if (this.amicaBridge) {
      this.amicaBridge.recordAssistantAudio(chunk);
    }
    if (!this.amicaBridge?.isOwnerMode()) {
      this.player.write(chunk);
    }
  }

  private async handleFinalUser(text: string): Promise<void> {
    if (!this.amicaBridge) {
      return;
    }
    const turnId = this.startBridgeTurn();
    await this.amicaBridge.postUserFinal(text, turnId);
  }

  private async handleFinalAssistant(text: string): Promise<void> {
    if (!this.assistantTurnOpen) {
      return;
    }

    if (!this.amicaBridge) {
      this.assistantTurnOpen = false;
      return;
    }

    this.finalizeAssistantText(text);
    this.assistantTurnOpen = false;
    await this.flushOwnerModeSegments();
  }

  private async handleChunk(chunk: AudioChunk): Promise<void> {
    if (!this.ready) {
      return;
    }
    if (this.micMuted) {
      this.userSpeaking = false;
      this.lastVoiceActivityAt = 0;
      return;
    }

    const now = Date.now();
    const speech = chunk.rms > this.config.startThreshold;
    if (speech) {
      this.userSpeaking = true;
      this.lastVoiceActivityAt = now;
    } else if (this.userSpeaking && (now - this.lastVoiceActivityAt) >= this.config.releaseMs) {
      this.userSpeaking = false;
    }

    if (!this.playbackActive) {
      this.interruptSpeechStartedAt = 0;
    } else if (now >= this.interruptingUntil) {
      const interruptThreshold = Math.max(
        this.config.continueThreshold,
        this.config.startThreshold * Math.max(1, this.config.interruptRatio),
      );
      if (chunk.rms > interruptThreshold) {
        if (this.interruptSpeechStartedAt === 0) {
          this.interruptSpeechStartedAt = now;
        }
      } else {
        this.interruptSpeechStartedAt = 0;
      }

      const sustainedInterrupt =
        this.interruptSpeechStartedAt > 0 &&
        (now - this.playbackStartedAt) >= 450 &&
        (now - this.interruptSpeechStartedAt) >= Math.max(140, this.config.releaseMs);

      if (sustainedInterrupt) {
        if (!this.amicaBridge?.isOwnerMode()) {
          await this.ducking?.duck();
        }
        await this.detectInterrupt();
      }
    }

    if (this.playbackActive || now < this.captureSuppressedUntil) {
      return;
    }

    this.send({
      type: "audio",
      audio: encodeAudioChunk(chunk.pcm),
    });
  }

  private async detectInterrupt(): Promise<void> {
    if (!this.playbackActive || Date.now() < this.interruptingUntil) {
      return;
    }
    this.interruptingUntil = Date.now() + 500;
    this.requireNewAudioInit = true;
    this.sentenceCompleted = false;
    this.botSpeakEndSent = true;
    this.playbackActive = false;
    this.assistantTurnOpen = false;
    this.playbackStartedAt = 0;
    this.interruptSpeechStartedAt = 0;
    this.captureSuppressedUntil = 0;
    this.clearOwnerPlaybackTimer();
    this.pendingOwnerSegments = 0;
    this.resetAssistantTextState();
    this.amicaBridge?.clearAssistantTurn();
    this.send({
      type: "text",
      data: "interrupt-event",
    });
    if (!this.amicaBridge?.isOwnerMode()) {
      this.player.stop();
    }
    await this.ducking?.restore();
    try {
      await this.amicaBridge?.postInterrupt(this.bridgeTurnId ?? undefined);
    } catch (error) {
      console.error("Amica bridge interrupt post failed:", error);
    }
    this.send({
      type: "text",
      data: "bot-speak-end",
    });
    console.log("interrupt-event");
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  private resetConversationState(): void {
    this.ready = false;
    this.playbackActive = false;
    this.playbackGeneration = 0;
    this.sentenceCompleted = false;
    this.requireNewAudioInit = true;
    this.botSpeakEndSent = false;
    this.assistantTurnOpen = false;
    this.userSpeaking = false;
    this.lastVoiceActivityAt = 0;
    this.interruptingUntil = 0;
    this.playbackStartedAt = 0;
    this.interruptSpeechStartedAt = 0;
    this.captureSuppressedUntil = 0;
    this.clearOwnerPlaybackTimer();
    this.pendingOwnerSegments = 0;
    this.resetAssistantTextState();
    this.bridgeTurnId = null;
    this.bridgeAssistantSegmentIndex = 0;
    this.amicaBridge?.setSessionId(null);
    this.amicaBridge?.clearAssistantTurn();
  }

  private scheduleOwnerPlaybackEnd(durationMs: number): void {
    if (!this.amicaBridge?.isOwnerMode()) {
      return;
    }
    this.clearOwnerPlaybackTimer();
    // durationMs is derived from compressed MP3 bytes, which can significantly
    // under-estimate real browser playback time on the Pi. Keep owner-mode
    // playback active conservatively so the mic does not reopen mid-utterance.
    const remainingMs = Math.max(0, (durationMs * 4) + 500, durationMs + 1200);
    this.ownerPlaybackTimer = setTimeout(() => {
      this.ownerPlaybackTimer = null;
      this.finishOwnerPlayback();
    }, remainingMs);
  }

  private finishOwnerPlayback(): void {
    if (!this.playbackActive || this.botSpeakEndSent) {
      return;
    }
    this.playbackActive = false;
    this.requireNewAudioInit = true;
    this.sentenceCompleted = false;
    this.botSpeakEndSent = true;
    this.assistantTurnOpen = false;
    this.playbackStartedAt = 0;
    this.interruptSpeechStartedAt = 0;
    this.captureSuppressedUntil = Date.now() + PLAYBACK_CAPTURE_COOLDOWN_MS;
    this.clearOwnerPlaybackTimer();
    this.pendingOwnerSegments = 0;
    void this.ducking?.restore();
    this.send({
      type: "text",
      data: "bot-speak-end",
    });
    console.log("playback.closed graceful=true");
  }

  private stopOwnerPlayback(): void {
    const shouldSendBotSpeakEnd = this.playbackActive && !this.botSpeakEndSent;
    this.playbackActive = false;
    this.requireNewAudioInit = true;
    this.sentenceCompleted = false;
    this.botSpeakEndSent = true;
    this.assistantTurnOpen = false;
    this.clearOwnerPlaybackTimer();
    this.resetAssistantTextState();
    this.amicaBridge?.clearAssistantTurn();
    void this.ducking?.restore();
    if (shouldSendBotSpeakEnd) {
      this.send({
        type: "text",
        data: "bot-speak-end",
      });
    }
    console.log("playback.closed graceful=false");
  }

  private clearOwnerPlaybackTimer(): void {
    if (this.ownerPlaybackTimer) {
      clearTimeout(this.ownerPlaybackTimer);
      this.ownerPlaybackTimer = null;
    }
  }

  private failClosed(error: unknown): void {
    console.error("Pi client failing closed:", error);
    this.player.stop();
    this.stopOwnerPlayback();
    const ws = this.ws;
    if (!ws) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  private recordAssistantTextDelta(delta: string): void {
    if (!delta) {
      return;
    }

    this.assistantPendingText += delta;
    while (true) {
      const { flushText, remainder } = takeFlushChunk(this.assistantPendingText, {
        hasStarted: this.assistantTextHasStarted,
        ...SPOKEN_SEGMENT_FLUSH_OPTIONS,
      });
      this.assistantPendingText = remainder;
      if (!flushText) {
        break;
      }
      if (!sanitizeSpokenText(flushText)) {
        continue;
      }
      this.assistantTextSegments.push(flushText);
      this.assistantTextHasStarted = true;
    }
  }

  private finalizeAssistantText(finalText: string): void {
    const remainder = this.assistantPendingText.trim();
    this.assistantPendingText = "";
    if (remainder) {
      if (!sanitizeSpokenText(remainder)) {
        return;
      }
      this.assistantTextSegments.push(remainder);
      this.assistantTextHasStarted = true;
      return;
    }

    if (
      this.assistantTextSegments.length === 0 &&
      finalText.trim() &&
      sanitizeSpokenText(finalText)
    ) {
      this.assistantTextSegments.push(finalText.trim());
      this.assistantTextHasStarted = true;
    }
  }

  private takeAssistantTextSegment(): string | null {
    const text = this.assistantTextSegments.shift()?.trim();
    return text || null;
  }

  private resetAssistantTextState(): void {
    this.assistantPendingText = "";
    this.assistantTextSegments.length = 0;
    this.assistantTextHasStarted = false;
  }

  private async flushOwnerModeSegments(): Promise<void> {
    if (!this.amicaBridge?.isOwnerMode()) {
      return;
    }
    while (
      this.pendingOwnerSegments > 0 &&
      this.amicaBridge.hasQueuedAssistantAudio()
    ) {
      const text = this.takeAssistantTextSegment();
      if (!text) {
        return;
      }
      const durationMs = await this.amicaBridge.postAssistantSegment(
        text,
        this.ensureBridgeTurnId(),
        this.bridgeAssistantSegmentIndex,
      );
      this.bridgeAssistantSegmentIndex += 1;
      this.pendingOwnerSegments -= 1;
      this.scheduleOwnerPlaybackEnd(durationMs);
    }
  }

  private startBridgeTurn(): string {
    this.bridgeTurnSequence += 1;
    this.bridgeTurnId = `bridge-turn-${this.bridgeTurnSequence}`;
    this.bridgeAssistantSegmentIndex = 0;
    return this.bridgeTurnId;
  }

  private ensureBridgeTurnId(): string {
    if (this.bridgeTurnId) {
      return this.bridgeTurnId;
    }
    return this.startBridgeTurn();
  }
}

function decodeRawData(raw: RawData): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((item) => Buffer.isBuffer(item) ? item : Buffer.from(item))).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as Uint8Array;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("utf8");
  }
  return null;
}
