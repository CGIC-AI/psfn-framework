import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import {
  abortableAsyncIterable,
  abortReason,
  throwIfAborted,
} from "../shared/abort.js";
import { AsyncQueue } from "../shared/async-queue.js";
import type { HubConfig } from "../shared/env.js";
import {
  decodeAudioChunk,
  encodeAudioChunk,
  type ClientToHubMessage,
  type HubToClientMessage,
  type RuntimeIdentity,
  type SatelliteCapabilities,
  type TouchInteractionMessage,
} from "../shared/protocol.js";
import {
  appendEvent,
  appendPcm,
  createArtifactTurn,
  finalizeWav,
  writeJson,
  type ArtifactTurn,
} from "./artifacts.js";
import {
  DeepgramRealtimeSession,
  type TranscriptInterim,
  type TranscriptResult,
} from "./deepgram-live.js";
import type { FrameworkAgentAdapter, FrameworkReplyInputMode } from "./framework-agent.js";
import {
  CompanionBridge,
  CompanionRequestError,
  type CompanionEvent,
} from "./companion-bridge.js";
import { ElevenLabsStream, type StreamingTtsAdapter } from "./elevenlabs-stream.js";
import { PsfnModelAdapter } from "./psfn-model.js";
import { VoxtaFacade, type VoxtaSttAdapter, type VoxtaTtsAdapter } from "./voxta-facade.js";
import {
  canReceiveArtifacts,
  canReceiveStreamingAudio,
  canReceiveToolActivity,
  canSendTouchInteractions,
  canUseApprovals,
  DEFAULT_REALTIME_CAPABILITIES,
  EmbodiedSessionRegistry,
} from "./embodied-session.js";
import { SessionStore } from "./session-store.js";
import {
  sanitizeSpokenText,
  SPOKEN_SEGMENT_FLUSH_OPTIONS,
  takeFlushChunk,
} from "../shared/text.js";
import {
  authenticateHubDevice,
  intersectCapabilities,
  type HubDeviceRegistry,
} from "./device-registry.js";
import type { PsfnChannelContext } from "./embodied-session.js";

export class RealtimeHubServer {
  private readonly httpServer: http.Server;
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly sessions: SessionStore;
  private readonly embodiedSessions: EmbodiedSessionRegistry;
  private readonly agent: FrameworkAgentAdapter;
  private readonly tts: StreamingTtsAdapter;
  private readonly voxta: VoxtaFacade;
  private readonly companion: CompanionBridge | null;

  constructor(
    private readonly config: HubConfig,
    options: {
      agent?: FrameworkAgentAdapter;
      realtimeTts?: StreamingTtsAdapter;
      voxtaTts?: VoxtaTtsAdapter | null;
      voxtaStt?: VoxtaSttAdapter | null;
      companion?: CompanionBridge | null;
    } = {},
  ) {
    this.sessions = new SessionStore(config.sessionTtlSeconds);
    this.embodiedSessions = new EmbodiedSessionRegistry(resolveChannelType(config));
    this.agent = options.agent ?? createFrameworkAgent(config);
    this.companion = options.companion !== undefined
      ? options.companion
      : (config.companion ? new CompanionBridge(config.companion) : null);
    this.tts = options.realtimeTts ?? new ElevenLabsStream(
      config.elevenlabsApiKey ?? "",
      config.elevenlabsModelId,
      config.elevenlabsVoiceId ?? "",
    );
    const voxtaTts = options.voxtaTts === null
      ? undefined
      : options.voxtaTts
        ?? (config.elevenlabsApiKey && config.elevenlabsVoiceId ? new ElevenLabsVoxtaTts(this.tts) : undefined);
    const voxtaStt = options.voxtaStt === null
      ? undefined
      : options.voxtaStt
        ?? (config.deepgramApiKey ? new DeepgramVoxtaStt(config.deepgramApiKey) : undefined);
    this.voxta = new VoxtaFacade({
      config: config.voxta,
      sessions: this.sessions,
      embodiedSessions: this.embodiedSessions,
      agent: this.agent,
      artifactsRoot: config.artifactsRoot,
      tts: voxtaTts,
      stt: voxtaStt,
    });
    this.httpServer = http.createServer((request, response) => {
      if (this.voxta.handleHttp(request, response)) {
        return;
      }
      response.statusCode = 200;
      response.end("psfn-satellite-hub\n");
    });
  }

  async start(): Promise<void> {
    this.companion?.start();
    this.wsServer.on("connection", (socket) => {
      const connection = new RealtimeConnection(
        socket,
        this.config,
        this.sessions,
        this.embodiedSessions,
        this.agent,
        this.tts,
        this.companion,
        this.config.deviceRegistry,
      );
      connection.run().catch((error) => {
        console.error("Realtime connection failed:", error);
      });
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      if (this.voxta.shouldHandleUpgrade(request)) {
        this.voxta.handleUpgrade(request, socket, head);
        return;
      }
      this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
        this.wsServer.emit("connection", websocket, request);
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.port, this.config.bindHost, () => resolve());
    });
  }

  address(): AddressInfo | string | null {
    return this.httpServer.address();
  }

  async close(): Promise<void> {
    await this.companion?.stop();
    await this.agent.close();
    await this.tts.close();
    await new Promise<void>((resolve, reject) => {
      this.wsServer.close((error) => (error ? reject(error) : resolve()));
    });
    await this.voxta.close();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

class DeepgramVoxtaStt implements VoxtaSttAdapter {
  constructor(private readonly apiKey: string) {}

  async transcribePcm(input: { pcm: Buffer }): Promise<{ text: string; provider: string }> {
    const transcript = await transcribePcmClip(this.apiKey, input.pcm);
    return {
      text: transcript.text,
      provider: transcript.provider,
    };
  }
}

class ElevenLabsVoxtaTts implements VoxtaTtsAdapter {
  constructor(private readonly tts: StreamingTtsAdapter) {}

  async synthesizeWav(text: string, signal: AbortSignal): Promise<Buffer> {
    const mp3Chunks: Buffer[] = [];
    const audio = this.tts.streamText(singleValueStream(text), { signal });
    for await (const chunk of abortableAsyncIterable(audio, signal)) {
      mp3Chunks.push(chunk);
    }
    throwIfAborted(signal);
    const mp3 = Buffer.concat(mp3Chunks);
    if (mp3.length === 0) {
      return Buffer.alloc(0);
    }
    return convertMp3ToWav(mp3, signal);
  }
}

function createFrameworkAgent(config: HubConfig): FrameworkAgentAdapter {
  return new PsfnModelAdapter(config.psfn);
}

function resolveChannelType(config: HubConfig): string {
  return config.psfn.channelType;
}

class RealtimeConnection {
  private deviceId = `client-${Math.random().toString(16).slice(2, 10)}`;
  private deviceName = "Opanhome TS Client";
  private sessionId = `realtime:${this.deviceId}`;
  private channelId = "";
  private satelliteId = this.deviceId;
  private satelliteName = this.deviceName;
  private capabilities: Required<SatelliteCapabilities> = DEFAULT_REALTIME_CAPABILITIES;
  private activeTurn: ArtifactTurn | null = null;
  private sttSession: DeepgramRealtimeSession | null = null;
  private replyAbort = false;
  private replySequence = 0;
  private replyTask: Promise<void> | null = null;
  private replyAbortController: AbortController | null = null;
  private messageChain: Promise<void> = Promise.resolve();
  private identityTask: Promise<RuntimeIdentity | undefined> | null = null;
  private claimIdentity: PsfnChannelContext["claimIdentity"];
  private authenticated: boolean;
  private unsubscribeCompanion: (() => void) | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly config: HubConfig,
    private readonly sessions: SessionStore,
    private readonly embodiedSessions: EmbodiedSessionRegistry,
    private readonly agent: FrameworkAgentAdapter,
    private readonly tts: StreamingTtsAdapter,
    private readonly companion: CompanionBridge | null = null,
    private readonly deviceRegistry: HubDeviceRegistry | null = null,
  ) {
    this.authenticated = !this.deviceRegistry;
    if (!this.deviceRegistry) this.attachSatellite();
    if (!this.deviceRegistry) this.subscribeCompanion();
  }

  private subscribeCompanion(): void {
    if (this.unsubscribeCompanion || !this.companion) return;
    this.unsubscribeCompanion = this.companion.addListener((event) => {
      this.messageChain = this.messageChain
        .then(() => this.relayCompanionEvent(event))
        .catch((error) => {
          console.error("Companion event relay failed:", error);
        });
    });
  }

  async run(): Promise<void> {
    this.socket.on("message", (raw) => {
      const json = decodeRawData(raw);
      if (!json) {
        return;
      }
      const payload = JSON.parse(json) as ClientToHubMessage;
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(payload))
        .catch((error) => {
          console.error("Realtime message handling failed:", error);
        });
    });
    this.socket.on("close", () => {
      void this.cleanup();
    });

    console.log("Realtime client connected");
    if (!this.deviceRegistry) await this.sendSessionReady();
  }

  private async sendSessionReady(): Promise<void> {
    await this.send({
      type: "session.ready",
      sessionId: this.sessionId,
      channelId: this.channelId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      satelliteId: this.satelliteId,
      audioFormat: this.config.deepgramApiKey ? "pcm_s16le_16000_mono_in/mp3_44100_out" : "text_only",
      identity: await this.resolveRuntimeIdentity(),
    });
  }

  private async handleMessage(message: ClientToHubMessage): Promise<void> {
    if (!this.authenticated && message.type !== "hello") {
      await this.send({ type: "error-event", data: { message: "Satellite device authentication required" } });
      this.socket.close(1008, "device authentication required");
      return;
    }
    if (this.deviceRegistry && this.authenticated && message.type === "hello") {
      await this.send({ type: "error-event", data: { message: "Satellite hello was already accepted" } });
      this.socket.close(1008, "duplicate hello");
      return;
    }
    switch (message.type) {
      case "hello":
        if (this.deviceRegistry) {
          const device = authenticateHubDevice(this.deviceRegistry, message.credential);
          if (!device || message.deviceId !== device.deviceId) {
            await this.send({
              type: "error-event",
              data: { message: "Satellite device authentication failed" },
            });
            this.socket.close(1008, "device authentication failed");
            return;
          }
          this.deviceId = device.deviceId;
          this.deviceName = device.deviceName;
          this.satelliteId = device.satelliteId;
          this.satelliteName = device.satelliteName;
          this.claimIdentity = {
            satelliteId: device.satelliteId,
            endpointId: device.endpointId,
            claimType: device.claimType,
            displayName: device.satelliteName,
          };
          this.sessionId = deriveAuthenticatedSessionId(device.deviceId, message.sessionId);
          try {
            this.attachSatellite(
              undefined,
              intersectCapabilities(message.capabilities, device.maxCapabilities),
              this.claimIdentity,
            );
          } catch {
            await this.send({
              type: "error-event",
              data: { message: "Satellite capability authorization failed" },
            });
            this.socket.close(1008, "capability authorization failed");
            return;
          }
          this.authenticated = true;
          this.subscribeCompanion();
          await this.sendSessionReady();
        } else {
          this.deviceId = message.deviceId;
          this.deviceName = message.deviceName;
          this.sessionId = message.sessionId?.trim() || `realtime:${this.deviceId}`;
          this.satelliteId = message.satelliteId?.trim() || this.deviceId;
          this.satelliteName = message.satelliteName?.trim() || this.deviceName;
          this.attachSatellite(message.channelId, message.capabilities);
        }
        this.sessions.touch(this.sessionId);
        console.log(`hello device=${this.deviceId} session=${this.sessionId}`);
        await this.send({
          type: "hello.ack",
          sessionId: this.sessionId,
          channelId: this.channelId,
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          satelliteId: this.satelliteId,
          satelliteName: this.satelliteName,
          capabilities: this.capabilities,
          identity: await this.resolveRuntimeIdentity(),
        });
        await this.send({
          type: "status",
          data: "call_initialized",
        });
        return;
      case "ping":
        await this.send({ type: "pong", sentAt: message.sentAt });
        return;
      case "interrupt":
        await this.cancelReply("client_interrupt");
        await this.send({ type: "assistant.interrupted", sessionId: this.sessionId });
        return;
      case "relay.stt":
        await this.handleRelaySttRequest(message);
        return;
      case "relay.tts":
        await this.handleRelayTtsRequest(message);
        return;
      case "text":
        await this.handleTextSignal(message.data);
        return;
      case "user.text":
        await this.handleUserText(message);
        return;
      case "audio":
        await this.handleAudio(decodeAudioChunk(message.audio));
        return;
      case "turn.start":
      case "turn.end":
        return;
      case "approval.decision":
        await this.handleApprovalDecision(message);
        return;
      case "touch.interaction":
        await this.handleTouchInteraction(message);
        return;
      case "artifact.preview":
        await this.handleArtifactPreviewRequest(message);
        return;
      default:
        await this.send({
          type: "error-event",
          data: { message: `Unsupported message type: ${String((message as { type?: string }).type || "")}` },
        });
    }
  }

  private async resolveRuntimeIdentity(): Promise<RuntimeIdentity | undefined> {
    this.identityTask ??= this.loadRuntimeIdentity();
    return this.identityTask;
  }

  private async handleTouchInteraction(message: TouchInteractionMessage): Promise<void> {
    if (!canSendTouchInteractions(this.capabilities)) {
      await this.send({
        type: "error-event",
        data: { message: "Satellite did not advertise the touch capability" },
      });
      return;
    }
    if (!this.companion) {
      await this.send({
        type: "error-event",
        data: { message: "Companion touch bridge is not configured" },
      });
      return;
    }
    if (
      !["headpat", "petting", "hug", "kiss"].includes(message.kind)
      || !["head", "cheek", "body"].includes(message.region)
      || !Number.isInteger(message.count)
      || message.count < 1
      || message.count > 20
      || !Number.isInteger(message.durationMs)
      || message.durationMs < 0
      || message.durationMs > 60_000
    ) {
      await this.send({
        type: "error-event",
        data: { message: "Touch interaction payload is invalid" },
      });
      return;
    }

    try {
      const result = await this.companion.submitTouchStimulus({
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        kind: message.kind,
        region: message.region,
        count: message.count,
        durationMs: message.durationMs,
        responseMode: "respond",
      });
      if (result.response) {
        await this.send({
          type: "message",
          data: {
            role: "assistant",
            content: result.response,
            final: true,
          },
        });
      }
    } catch (error) {
      console.error("Touch interaction delivery failed", {
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        error,
      });
      const messageText = error instanceof CompanionRequestError && error.status === 429
        ? "Touch interaction is cooling down"
        : "Touch interaction delivery failed";
      await this.send({ type: "error-event", data: { message: messageText } });
    }
  }

  private async loadRuntimeIdentity(): Promise<RuntimeIdentity | undefined> {
    if (!this.agent.getIdentity) {
      return undefined;
    }
    try {
      return await this.agent.getIdentity() ?? undefined;
    } catch (error) {
      console.warn("Unable to load PSFN runtime identity:", error);
      return undefined;
    }
  }

  private async handleUserText(
    message: Extract<ClientToHubMessage, { type: "user.text" }>,
  ): Promise<void> {
    const userText = message.text.trim();
    if (!userText) {
      await this.send({
        type: "error-event",
        data: { message: "Typed user text is empty" },
      });
      return;
    }
    const previousReply = this.replyTask;
    if (message.interrupt !== false) {
      await this.cancelReply("typed_user_text");
      // SAFETY: inbound protocol messages stay serialized, but a model reply
      // must not hold that queue. Wait only for the already-aborted reply to
      // settle before appending the replacement turn so history stays ordered.
      await previousReply?.catch(() => undefined);
    } else if (this.replyTask && !this.replyAbort) {
      await this.send({
        type: "error-event",
        data: { message: "Assistant reply already in progress" },
      });
      return;
    }

    if (this.activeTurn) {
      appendEvent(this.activeTurn, "turn.cancel", { reason: "typed_user_text" });
      this.activeTurn = null;
    }

    const turn = createArtifactTurn(this.config.artifactsRoot, this.sessionId);
    appendEvent(turn, "start", {
      inputMode: "text",
      sessionId: this.sessionId,
      channelId: this.channelId,
      satelliteId: this.satelliteId,
      turnId: turn.turnId,
    });
    appendEvent(turn, "transcript", {
      text: userText,
      provider: "typed",
      latencyMs: 0,
    });
    writeJson(turn.transcriptPath, {
      text: userText,
      provider: "typed",
      latencyMs: 0,
    });

    await this.send({
      type: "message",
      data: {
        role: "user",
        content: userText,
        final: true,
      },
    });

    this.sessions.append(this.sessionId, { role: "user", content: userText });
    this.startReply(turn, userText, "text");
  }

  private async handleTextSignal(signal: string): Promise<void> {
    if (signal === "interrupt-event") {
      await this.cancelReply("client_interrupt");
      return;
    }
    if (signal === "bot-speak-end") {
      if (this.activeTurn) {
        appendEvent(this.activeTurn, "client.bot_speak_end", {});
      }
      return;
    }
    if (signal === "bot-speaking") {
      if (this.activeTurn) {
        appendEvent(this.activeTurn, "client.bot_speaking", {});
      }
      return;
    }
  }

  private async handleRelaySttRequest(
    message: Extract<ClientToHubMessage, { type: "relay.stt" }>,
  ): Promise<void> {
    try {
      if (!this.config.deepgramApiKey) {
        throw new Error("Deepgram STT is not configured for this hub");
      }
      const transcript = await transcribePcmClip(
        this.config.deepgramApiKey,
        decodeAudioChunk(message.audio),
      );
      await this.send({
        type: "relay.stt.result",
        requestId: message.requestId,
        text: transcript.text,
        provider: transcript.provider,
        latencyMs: transcript.latencyMs,
      });
    } catch (error) {
      await this.sendRelayError("stt", message.requestId, error);
    }
  }

  private async handleRelayTtsRequest(
    message: Extract<ClientToHubMessage, { type: "relay.tts" }>,
  ): Promise<void> {
    const spokenText = sanitizeSpokenText(message.text);
    if (!spokenText) {
      await this.sendRelayError("tts", message.requestId, new Error("Relay TTS text is empty"));
      return;
    }

    try {
      if (!this.config.elevenlabsApiKey || !this.config.elevenlabsVoiceId) {
        throw new Error("ElevenLabs TTS is not configured for this hub");
      }
      for await (const audioChunk of this.tts.streamText(singleValueStream(spokenText))) {
        await this.send({
          type: "relay.tts.chunk",
          requestId: message.requestId,
          audio: encodeAudioChunk(audioChunk),
        });
      }
      await this.send({
        type: "relay.tts.done",
        requestId: message.requestId,
        mimeType: "audio/mpeg",
      });
    } catch (error) {
      await this.sendRelayError("tts", message.requestId, error);
    }
  }

  private async relayCompanionEvent(event: CompanionEvent): Promise<void> {
    switch (event.kind) {
      case "approval.requested":
        if (!canUseApprovals(this.capabilities)) {
          return;
        }
        await this.send({ type: "approval.requested", data: event.payload });
        return;
      case "approval.resolved":
        if (!canUseApprovals(this.capabilities)) {
          return;
        }
        await this.send({ type: "approval.resolved", data: event.payload });
        return;
      case "artifact.created":
        if (!canReceiveArtifacts(this.capabilities)) {
          return;
        }
        await this.send({ type: "artifact.created", data: event.payload });
        return;
      case "tool.activity":
        if (!canReceiveToolActivity(this.capabilities)) {
          return;
        }
        await this.send({ type: "tool.activity", data: event.payload });
        return;
    }
  }

  private async handleApprovalDecision(
    message: Extract<ClientToHubMessage, { type: "approval.decision" }>,
  ): Promise<void> {
    if (!canUseApprovals(this.capabilities)) {
      await this.send({
        type: "error-event",
        data: { message: "Satellite did not advertise the approvals capability" },
      });
      return;
    }
    if (!this.companion) {
      await this.send({
        type: "error-event",
        data: { message: "Companion bridge is not configured on this hub" },
      });
      return;
    }
    const approvalId = typeof message.id === "string" ? message.id.trim() : "";
    if (!approvalId) {
      await this.send({
        type: "error-event",
        data: { message: "Approval decision requires a non-empty id" },
      });
      return;
    }
    if (message.decision !== "approve" && message.decision !== "deny") {
      await this.send({
        type: "error-event",
        data: { message: "Approval decision must be 'approve' or 'deny'" },
      });
      return;
    }
    try {
      await this.companion.submitApprovalDecision({
        approvalId,
        decision: message.decision,
        satelliteId: this.satelliteId,
        deviceId: this.deviceId,
      });
    } catch (error) {
      const detail = error instanceof CompanionRequestError
        ? error.message
        : `Approval decision failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.send({
        type: "error-event",
        data: { message: detail },
      });
    }
  }

  private async handleArtifactPreviewRequest(
    message: Extract<ClientToHubMessage, { type: "artifact.preview" }>,
  ): Promise<void> {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const artifactId = typeof message.artifactId === "string" ? message.artifactId.trim() : "";
    const sendError = async (detail: string): Promise<void> => {
      await this.send({
        type: "artifact.preview.error",
        requestId,
        artifactId,
        message: detail,
      });
    };
    if (!canReceiveArtifacts(this.capabilities)) {
      await sendError("Satellite did not advertise the artifact capability");
      return;
    }
    if (!this.companion) {
      await sendError("Companion bridge is not configured on this hub");
      return;
    }
    if (!requestId.trim() || !artifactId) {
      await sendError("Artifact preview requires non-empty requestId and artifactId");
      return;
    }
    try {
      const preview = await this.companion.fetchArtifactPreview(artifactId);
      await this.send({
        type: "artifact.preview.result",
        requestId,
        artifactId,
        mediaType: preview.mediaType,
        data: preview.dataBase64,
      });
    } catch (error) {
      await sendError(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleAudio(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) {
      return;
    }
    if (!this.config.deepgramApiKey) {
      await this.send({
        type: "error-event",
        data: { message: "Deepgram STT is not configured for this hub" },
      });
      return;
    }
    await this.ensureSttSession();
    if (this.replyTask && !this.replyAbort) {
      return;
    }
    const turn = this.ensureActiveTurn();
    appendPcm(turn, chunk);
    this.sttSession?.sendAudio(chunk);
  }

  private async handleInterim(event: TranscriptInterim): Promise<void> {
    if (!event.text.trim()) {
      return;
    }
    const turn = this.ensureActiveTurn();
    appendEvent(turn, "transcript.live", event);
    await this.send({
      type: "message",
      data: {
        role: "user",
        content: event.text,
        live: true,
      },
    });
  }

  private async handleUtterance(event: TranscriptResult): Promise<void> {
    const turn = this.activeTurn ?? this.ensureActiveTurn();
    this.activeTurn = null;

    finalizeWav(turn);
    appendEvent(turn, "stop", {
      bytesReceived: turn.bytesReceived,
      chunks: turn.chunks,
    });
    appendEvent(turn, "transcript", event);
    writeJson(turn.transcriptPath, event);
    console.log(`transcript turn=${turn.turnId} latency_ms=${event.latencyMs} text=${JSON.stringify(event.text)}`);

    if (!event.text.trim()) {
      writeJson(turn.replyPath, {
        sessionId: this.sessionId,
        turnId: turn.turnId,
        status: "no_input",
      });
      return;
    }

    await this.send({
      type: "message",
      data: {
        role: "user",
        content: event.text,
        final: true,
      },
    });

    if (this.replyTask && !this.replyAbort) {
      appendEvent(turn, "ignored", { reason: "reply_in_progress" });
      writeJson(turn.replyPath, {
        sessionId: this.sessionId,
        turnId: turn.turnId,
        transcript: event.text,
        status: "ignored_reply_in_progress",
      });
      return;
    }

    this.sessions.append(this.sessionId, { role: "user", content: event.text });
    this.startReply(turn, event.text, "voice");
  }

  private startReply(
    turn: ArtifactTurn,
    transcript: string,
    inputMode: FrameworkReplyInputMode,
  ): void {
    const task = this.runReply(turn, transcript, inputMode);
    this.replyTask = task;
    void this.observeReplyTask(task);
  }

  private async observeReplyTask(task: Promise<void>): Promise<void> {
    try {
      await task;
    } catch (error) {
      console.error("Realtime reply task failed:", error);
    } finally {
      if (this.replyTask === task) {
        this.replyTask = null;
      }
    }
  }

  private async runReply(
    turn: ArtifactTurn,
    transcript: string,
    inputMode: FrameworkReplyInputMode,
  ): Promise<void> {
    const replyId = ++this.replySequence;
    this.replyAbort = false;
    const replyAbortController = new AbortController();
    this.replyAbortController = replyAbortController;
    let responseText = "";
    const shouldStreamAudio = canReceiveStreamingAudio(this.capabilities);
    const audioSegmentQueue = shouldStreamAudio ? new AsyncQueue<string>() : null;

    const audioTask: Promise<void> = shouldStreamAudio && audioSegmentQueue ? (async () => {
      for await (const segmentText of audioSegmentQueue) {
        this.assertReplyActive(replyId, replyAbortController);
        const spokenSegmentText = sanitizeSpokenText(segmentText);
        if (!spokenSegmentText) {
          continue;
        }
        if (!this.config.elevenlabsApiKey || !this.config.elevenlabsVoiceId) {
          throw new Error("ElevenLabs TTS is not configured for this hub");
        }
        await this.send({
          type: "text",
          data: "audio-init",
        });
        this.assertReplyActive(replyId, replyAbortController);
        let emittedAudio = false;
        const audio = this.tts.streamText(singleValueStream(spokenSegmentText), {
          signal: replyAbortController.signal,
        });
        for await (const audioChunk of abortableAsyncIterable(audio, replyAbortController.signal)) {
          this.assertReplyActive(replyId, replyAbortController);
          emittedAudio = true;
          await this.send({
            type: "audio",
            data: encodeAudioChunk(audioChunk),
          });
          this.assertReplyActive(replyId, replyAbortController);
        }
        this.assertReplyActive(replyId, replyAbortController);
        if (emittedAudio) {
          await this.send({
            type: "text",
            data: "audio-end",
          });
          this.assertReplyActive(replyId, replyAbortController);
        }
      }
    })() : Promise.resolve();
    void audioTask.catch(() => undefined);

    try {
      let pendingAudioText = "";
      let audioHasStarted = false;
      const stream = this.agent.streamReply({
        inputMode,
        userText: transcript,
        conversationId: this.sessionId,
        history: this.sessions.getHistory(this.sessionId),
        channel: this.embodiedSessions.getContext(this.sessionId, this.satelliteId),
        signal: replyAbortController.signal,
      });
      for await (const delta of stream) {
        this.assertReplyActive(replyId, replyAbortController);
        responseText += delta;
        await this.send({
          type: "message",
          data: {
            role: "assistant",
            content: delta,
            live: true,
          },
        });
        this.assertReplyActive(replyId, replyAbortController);
        if (audioSegmentQueue) {
          pendingAudioText += delta;
          while (true) {
            const { flushText, remainder } = takeFlushChunk(pendingAudioText, {
              hasStarted: audioHasStarted,
              ...SPOKEN_SEGMENT_FLUSH_OPTIONS,
            });
            pendingAudioText = remainder;
            if (!flushText) {
              break;
            }
            audioSegmentQueue.push(flushText);
            audioHasStarted = true;
          }
        }
      }
      this.assertReplyActive(replyId, replyAbortController);
      if (audioSegmentQueue && pendingAudioText.trim()) {
        audioSegmentQueue.push(pendingAudioText.trim());
      }
      audioSegmentQueue?.close();
      await audioTask;
      this.assertReplyActive(replyId, replyAbortController);

      responseText = responseText.trim();
      this.sessions.append(this.sessionId, { role: "assistant", content: responseText });
      appendEvent(turn, "reply", { text: responseText });
      writeJson(turn.replyPath, {
        sessionId: this.sessionId,
        turnId: turn.turnId,
        transcript,
        response: responseText,
      });
      console.log(`reply turn=${turn.turnId} text=${JSON.stringify(responseText)}`);
      await this.send({
        type: "message",
        data: {
          role: "assistant",
          content: responseText,
          final: true,
        },
      });
    } catch (error) {
      audioSegmentQueue?.close();
      await audioTask.catch(() => undefined);
      if (this.replyAbort || replyId !== this.replySequence || replyAbortController.signal.aborted) {
        // The in-flight request (including any bounded fallback attempt) was
        // cancelled because the client disconnected or interrupted. This is a
        // normal cancel, not a reply failure, so it must not surface as an
        // error-event.
        appendEvent(turn, "reply.cancel", { reason: "client_interrupt" });
      } else {
        writeJson(turn.replyPath, {
          sessionId: this.sessionId,
          turnId: turn.turnId,
          transcript,
          error: String(error),
        });
        await this.send({
          type: "error-event",
          data: {
            message: String(error),
          },
        });
      }
    } finally {
      if (this.replyAbortController === replyAbortController) {
        this.replyAbortController = null;
      }
    }
  }

  private async cancelReply(reason: string): Promise<void> {
    this.replyAbort = true;
    this.replySequence += 1;
    this.replyAbortController?.abort(new DOMException(`reply cancelled: ${reason}`, "AbortError"));
    if (this.activeTurn) {
      appendEvent(this.activeTurn, "reply.cancel", { reason });
    }
  }

  private assertReplyActive(replyId: number, controller: AbortController): void {
    if (this.replyAbort || replyId !== this.replySequence) {
      throw controller.signal.reason ?? new DOMException("reply cancelled", "AbortError");
    }
    throwIfAborted(controller.signal);
  }

  private async sendRelayError(
    operation: "stt" | "tts",
    requestId: string,
    error: unknown,
  ): Promise<void> {
    await this.send({
      type: "relay.error",
      requestId,
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private ensureActiveTurn(): ArtifactTurn {
    if (this.activeTurn) {
      return this.activeTurn;
    }
    const turn = createArtifactTurn(this.config.artifactsRoot, this.sessionId);
    appendEvent(turn, "start", {
      sessionId: this.sessionId,
      turnId: turn.turnId,
    });
    this.activeTurn = turn;
    return turn;
  }

  private async ensureSttSession(): Promise<void> {
    if (this.sttSession) {
      return;
    }
    if (!this.config.deepgramApiKey) {
      throw new Error("Deepgram STT is not configured for this hub");
    }
    this.sttSession = new DeepgramRealtimeSession(this.config.deepgramApiKey, 16000, {
      onInterim: (event) => {
        this.messageChain = this.messageChain
          .then(() => this.handleInterim(event))
          .catch((error) => {
            console.error("Realtime interim handling failed:", error);
          });
      },
      onUtterance: (event) => {
        this.messageChain = this.messageChain
          .then(() => this.handleUtterance(event))
          .catch((error) => {
            console.error("Realtime utterance handling failed:", error);
          });
      },
      onError: (error) => {
        console.error("Deepgram realtime session failed:", error);
      },
    });
    await this.sttSession.start();
  }

  private async cleanup(): Promise<void> {
    this.unsubscribeCompanion?.();
    this.unsubscribeCompanion = null;
    await this.cancelReply("connection_closed");
    this.activeTurn = null;
    if (this.sttSession) {
      await this.sttSession.close();
      this.sttSession = null;
    }
  }

  private async send(message: HubToClientMessage): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private attachSatellite(
    channelId?: string,
    capabilities?: SatelliteCapabilities,
    claimIdentity?: PsfnChannelContext["claimIdentity"],
  ): void {
    const attachment = this.embodiedSessions.attachSatellite({
      sessionId: this.sessionId,
      channelId,
      satelliteId: this.satelliteId,
      satelliteName: this.satelliteName,
      capabilities,
      ...(claimIdentity ? { claimIdentity } : {}),
    });
    this.channelId = attachment.session.channelId;
    this.capabilities = attachment.satellite.capabilities;
  }
}

function deriveAuthenticatedSessionId(deviceId: string, requested: string | undefined): string {
  const requestedSession = requested?.trim();
  if (!requestedSession) return `realtime:${deviceId}`;
  const digest = createHash("sha256").update(requestedSession, "utf8").digest("hex").slice(0, 20);
  return `realtime:${deviceId}:${digest}`;
}

async function* singleValueStream(text: string): AsyncGenerator<string, void, void> {
  yield text;
}

async function convertMp3ToWav(mp3: Buffer, signal: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal);
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "mp3",
    "-i",
    "pipe:0",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "wav",
    "pipe:1",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  ffmpeg.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  ffmpeg.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onAbort = (): void => {
      ffmpeg.kill("SIGKILL");
      finish(abortReason(signal));
    };
    ffmpeg.once("error", (error) => finish(error));
    ffmpeg.stdin.once("error", (error) => finish(error));
    ffmpeg.once("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(
        `ffmpeg failed converting Voxta TTS audio: ${Buffer.concat(stderr).toString("utf8").trim()}`,
      ));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  ffmpeg.stdin.end(mp3);
  await exit;
  throwIfAborted(signal);
  return Buffer.concat(stdout);
}

async function transcribePcmClip(
  apiKey: string,
  pcm: Buffer,
): Promise<TranscriptResult> {
  const startedAt = Date.now();
  const response = await fetch(
    "https://api.deepgram.com/v1/listen" +
      "?model=nova-3" +
      "&encoding=linear16" +
      "&sample_rate=16000" +
      "&channels=1" +
      "&smart_format=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/raw",
      },
      body: new Uint8Array(pcm),
    },
  );
  if (!response.ok) {
    throw new Error(await formatDeepgramError(response));
  }

  const payload = await response.json() as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{
          transcript?: string;
        }>;
      }>;
    };
  };
  const text = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || "";
  return {
    text,
    provider: "deepgram-prerecorded",
    latencyMs: Date.now() - startedAt,
  };
}

async function formatDeepgramError(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  if (body) {
    return `Deepgram transcription failed (${response.status}): ${body}`;
  }
  return `Deepgram transcription failed (${response.status})`;
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
