import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { AsyncQueue } from "../shared/async-queue.js";
import type { HubConfig } from "../shared/env.js";
import {
  decodeAudioChunk,
  encodeAudioChunk,
  type ClientToHubMessage,
  type HubToClientMessage,
  type RuntimeIdentity,
  type SatelliteCapabilities,
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
import type { AgentRuntimeAdapter } from "./agent-runtime.js";
import { ElevenLabsStream } from "./elevenlabs-stream.js";
import { HermesApiModelAdapter } from "./hermes-api-model.js";
import { PsfnModelAdapter } from "./psfn-model.js";
import { VoxtaFacade, type VoxtaSttAdapter, type VoxtaTtsAdapter } from "./voxta-facade.js";
import {
  canReceiveStreamingAudio,
  DEFAULT_REALTIME_CAPABILITIES,
  EmbodiedSessionRegistry,
} from "./embodied-session.js";
import { SessionStore } from "./session-store.js";
import {
  sanitizeSpokenText,
  SPOKEN_SEGMENT_FLUSH_OPTIONS,
  takeFlushChunk,
} from "../shared/text.js";

export class RealtimeHubServer {
  private readonly httpServer: http.Server;
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly sessions: SessionStore;
  private readonly embodiedSessions: EmbodiedSessionRegistry;
  private readonly agent: AgentRuntimeAdapter;
  private readonly tts: ElevenLabsStream;
  private readonly voxta: VoxtaFacade;

  constructor(
    private readonly config: HubConfig,
    options: { agent?: AgentRuntimeAdapter; voxtaTts?: VoxtaTtsAdapter; voxtaStt?: VoxtaSttAdapter } = {},
  ) {
    this.sessions = new SessionStore(config.sessionTtlSeconds);
    this.embodiedSessions = new EmbodiedSessionRegistry(resolveChannelType(config));
    this.agent = options.agent ?? createAgentRuntime(config);
    this.tts = new ElevenLabsStream(
      config.elevenlabsApiKey,
      config.elevenlabsModelId,
      config.elevenlabsVoiceId,
    );
    this.voxta = new VoxtaFacade({
      config: config.voxta,
      sessions: this.sessions,
      embodiedSessions: this.embodiedSessions,
      agent: this.agent,
      tts: options.voxtaTts ?? new ElevenLabsVoxtaTts(this.tts),
      stt: options.voxtaStt ?? new DeepgramVoxtaStt(config.deepgramApiKey),
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
    this.wsServer.on("connection", (socket) => {
      const connection = new RealtimeConnection(
        socket,
        this.config,
        this.sessions,
        this.embodiedSessions,
        this.agent,
        this.tts,
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
  constructor(private readonly tts: ElevenLabsStream) {}

  async synthesizeWav(text: string): Promise<Buffer> {
    const mp3Chunks: Buffer[] = [];
    for await (const chunk of this.tts.streamText(singleValueStream(text))) {
      mp3Chunks.push(chunk);
    }
    const mp3 = Buffer.concat(mp3Chunks);
    if (mp3.length === 0) {
      return Buffer.alloc(0);
    }
    return convertMp3ToWav(mp3);
  }
}

function createAgentRuntime(config: HubConfig): AgentRuntimeAdapter {
  if (config.agentRuntime === "hermes") {
    if (!config.hermes) {
      throw new Error("Hermes runtime config is required when AGENT_RUNTIME=hermes");
    }
    return new HermesApiModelAdapter(config.hermes);
  }
  if (!config.psfn) {
    throw new Error("PSFN runtime config is required when AGENT_RUNTIME=psfn");
  }
  return new PsfnModelAdapter(config.psfn);
}

function resolveChannelType(config: HubConfig): string {
  if (config.agentRuntime === "hermes") {
    if (!config.hermes) {
      throw new Error("Hermes runtime config is required when AGENT_RUNTIME=hermes");
    }
    return config.hermes.channelType;
  }
  if (!config.psfn) {
    throw new Error("PSFN runtime config is required when AGENT_RUNTIME=psfn");
  }
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
  private messageChain: Promise<void> = Promise.resolve();
  private identityTask: Promise<RuntimeIdentity | undefined> | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly config: HubConfig,
    private readonly sessions: SessionStore,
    private readonly embodiedSessions: EmbodiedSessionRegistry,
    private readonly agent: AgentRuntimeAdapter,
    private readonly tts: ElevenLabsStream,
  ) {
    this.attachSatellite();
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

    console.log("Realtime client connected");
    await this.send({
      type: "session.ready",
      sessionId: this.sessionId,
      channelId: this.channelId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      satelliteId: this.satelliteId,
      audioFormat: "pcm_s16le_16000_mono_in/mp3_44100_out",
      identity: await this.resolveRuntimeIdentity(),
    });
  }

  private async handleMessage(message: ClientToHubMessage): Promise<void> {
    switch (message.type) {
      case "hello":
        this.deviceId = message.deviceId;
        this.deviceName = message.deviceName;
        this.sessionId = message.sessionId?.trim() || `realtime:${this.deviceId}`;
        this.satelliteId = message.satelliteId?.trim() || this.deviceId;
        this.satelliteName = message.satelliteName?.trim() || this.deviceName;
        this.attachSatellite(message.channelId, message.capabilities);
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
    if (message.interrupt !== false) {
      await this.cancelReply("typed_user_text");
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
    const task = this.runReply(turn, userText);
    this.replyTask = task;
    await task.finally(() => {
      if (this.replyTask === task) {
        this.replyTask = null;
      }
    });
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

  private async handleAudio(chunk: Buffer): Promise<void> {
    if (!this.sttSession || chunk.length === 0) {
      return;
    }
    if (this.replyTask && !this.replyAbort) {
      return;
    }
    const turn = this.ensureActiveTurn();
    appendPcm(turn, chunk);
    this.sttSession.sendAudio(chunk);
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
    const task = this.runReply(turn, event.text);
    this.replyTask = task;
    await task.finally(() => {
      if (this.replyTask === task) {
        this.replyTask = null;
      }
    });
  }

  private async runReply(turn: ArtifactTurn, transcript: string): Promise<void> {
    const replyId = ++this.replySequence;
    this.replyAbort = false;
    let responseText = "";
    const shouldStreamAudio = canReceiveStreamingAudio(this.capabilities);
    const audioSegmentQueue = shouldStreamAudio ? new AsyncQueue<string>() : null;

    const audioTask: Promise<void> = shouldStreamAudio && audioSegmentQueue ? (async () => {
      for await (const segmentText of audioSegmentQueue) {
        if (this.replyAbort || replyId !== this.replySequence) {
          break;
        }
        const spokenSegmentText = sanitizeSpokenText(segmentText);
        if (!spokenSegmentText) {
          continue;
        }
        await this.send({
          type: "text",
          data: "audio-init",
        });
        let emittedAudio = false;
        for await (const audioChunk of this.tts.streamText(singleValueStream(spokenSegmentText))) {
          if (this.replyAbort || replyId !== this.replySequence) {
            break;
          }
          emittedAudio = true;
          await this.send({
            type: "audio",
            data: encodeAudioChunk(audioChunk),
          });
        }
        if (emittedAudio && !this.replyAbort && replyId === this.replySequence) {
          await this.send({
            type: "text",
            data: "audio-end",
          });
        }
      }
    })() : Promise.resolve();

    try {
      let pendingAudioText = "";
      let audioHasStarted = false;
      const stream = this.agent.streamReply({
        userText: transcript,
        conversationId: this.sessionId,
        history: this.sessions.getHistory(this.sessionId),
        channel: this.embodiedSessions.getContext(this.sessionId, this.satelliteId),
      });
      for await (const delta of stream) {
        if (this.replyAbort || replyId !== this.replySequence) {
          break;
        }
        responseText += delta;
        await this.send({
          type: "message",
          data: {
            role: "assistant",
            content: delta,
            live: true,
          },
        });
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
      if (audioSegmentQueue && pendingAudioText.trim()) {
        audioSegmentQueue.push(pendingAudioText.trim());
      }
      audioSegmentQueue?.close();
      await audioTask;

      if (this.replyAbort || replyId !== this.replySequence) {
        appendEvent(turn, "reply.cancel", { reason: "client_interrupt" });
        return;
      }

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
  }

  private async cancelReply(reason: string): Promise<void> {
    this.replyAbort = true;
    this.replySequence += 1;
    if (this.activeTurn) {
      appendEvent(this.activeTurn, "reply.cancel", { reason });
    }
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

  private async cleanup(): Promise<void> {
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

  private attachSatellite(channelId?: string, capabilities?: SatelliteCapabilities): void {
    const attachment = this.embodiedSessions.attachSatellite({
      sessionId: this.sessionId,
      channelId,
      satelliteId: this.satelliteId,
      satelliteName: this.satelliteName,
      capabilities,
    });
    this.channelId = attachment.session.channelId;
    this.capabilities = attachment.satellite.capabilities;
  }
}

async function* singleValueStream(text: string): AsyncGenerator<string, void, void> {
  yield text;
}

async function convertMp3ToWav(mp3: Buffer): Promise<Buffer> {
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
    ffmpeg.once("error", reject);
    ffmpeg.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg failed converting Voxta TTS audio: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
  ffmpeg.stdin.end(mp3);
  await exit;
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
