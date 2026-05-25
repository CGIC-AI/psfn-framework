import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { VoxtaFacadeConfig } from "../shared/env.js";
import { sanitizeSpokenText } from "../shared/text.js";
import type { AgentRuntimeAdapter } from "./agent-runtime.js";
import {
  EmbodiedSessionRegistry,
  VOXTA_VAM_CAPABILITIES,
} from "./embodied-session.js";
import type { PsfnChannelContext, VisionCaptureImage, VisionCaptureMetadata } from "./embodied-session.js";
import type { ConversationMessage } from "./session-store.js";
import { SessionStore } from "./session-store.js";

const SIGNALR_RECORD_SEPARATOR = "\x1e";
const VOXTA_API_VERSION = "2025-11";
const VOXTA_SERVER_VERSION = "1.1.3";
const VAM_PLUGIN_VERSION = "1.1.1";

interface VoxtaFacadeDependencies {
  config: VoxtaFacadeConfig;
  sessions: SessionStore;
  embodiedSessions: EmbodiedSessionRegistry;
  agent: AgentRuntimeAdapter;
  artifactsRoot: string;
  tts?: VoxtaTtsAdapter;
  stt?: VoxtaSttAdapter;
}

export interface VoxtaTtsAdapter {
  synthesizeWav(text: string): Promise<Buffer>;
}

export interface VoxtaAudioInputSpec {
  sampleRate: number;
  channels: number;
  bufferMilliseconds: number;
  bitsPerSample: number;
  contentType: string;
}

export interface VoxtaSttAdapter {
  transcribePcm(input: {
    sessionId: string;
    spec: VoxtaAudioInputSpec;
    pcm: Buffer;
  }): Promise<{ text: string; provider?: string }>;
}

interface PendingConnection {
  connectionId: string;
  connectionToken: string;
  createdAt: number;
}

interface SignalRInvocation {
  type: number;
  target?: string;
  invocationId?: string;
  arguments?: unknown[];
}

type VoxtaServiceType = "SpeechToText" | "TextToSpeech" | "ComputerVision" | "ActionInference";
type ToggleableVoxtaServiceType = Exclude<VoxtaServiceType, "ActionInference">;

type VoxtaServiceState = Record<VoxtaServiceType, boolean>;
type VoxtaVisionSource = "Screen" | "Eyes";

interface VoxtaFacadeRuntime {
  serviceStates: Map<string, VoxtaServiceState>;
  connectionsByConfigurationId: Map<string, VoxtaConnection>;
  connectionsBySessionId: Map<string, VoxtaConnection>;
  pendingVisionRequests: Map<string, PendingVisionRequest>;
}

interface PendingVisionRequest {
  requestId: string;
  sessionId: string;
  source: VoxtaVisionSource;
  resolve: (capture: VisionCaptureImage | null) => void;
  timeout: NodeJS.Timeout;
}

type VoxtaClientPayload = Record<string, unknown> & {
  $type?: string;
  sessionId?: string;
  chatId?: string;
  characterId?: string;
  text?: string;
  name?: string;
  value?: string;
};

type VoxtaServerPayload = Record<string, unknown> & {
  $type: string;
};

interface VoxtaParticipant {
  id: string;
  name: string;
  role: "Assistant" | "User";
}

export class VoxtaFacade {
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly runtime: VoxtaFacadeRuntime = {
    serviceStates: new Map(),
    connectionsByConfigurationId: new Map(),
    connectionsBySessionId: new Map(),
    pendingVisionRequests: new Map(),
  };
  private readonly audioWsServer = new WebSocketServer({ noServer: true });

  constructor(private readonly deps: VoxtaFacadeDependencies) {
    this.wsServer.on("connection", (socket, request) => {
      const url = new URL(request.url || "/hub", "http://localhost");
      const connectionToken = url.searchParams.get("id") || crypto.randomUUID();
      const pending = this.pendingConnections.get(connectionToken);
      this.pendingConnections.delete(connectionToken);
      const connection = new VoxtaConnection(
        socket,
        this.deps,
        this.runtime,
        pending?.connectionId ?? crypto.randomUUID(),
      );
      connection.run();
    });
    this.audioWsServer.on("connection", (socket, request) => {
      const url = new URL(request.url || "/", "http://localhost");
      const stream = new VoxtaAudioInputStream(
        socket,
        this.runtime,
        this.deps.stt,
        normalizedString(url.searchParams.get("sessionId")) ?? "",
      );
      stream.run();
    });
  }

  handleHttp(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    const url = new URL(request.url || "/", "http://localhost");
    if (isCorsPreflight(request, url.pathname)) {
      writeCorsHeaders(response);
      response.statusCode = 204;
      response.end();
      return true;
    }
    const visionRequest = parseVisionRequestPath(url.pathname);
    if (visionRequest) {
      writeCorsHeaders(response);
      void this.handleVisionRequest(request, response, url, visionRequest).catch((error) => {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return true;
    }
    const serviceToggle = parseServiceTogglePath(url.pathname);
    if (serviceToggle) {
      writeCorsHeaders(response);
      void this.handleServiceToggle(request, response, serviceToggle).catch((error) => {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return true;
    }
    if (!isNegotiatePath(url.pathname)) {
      return false;
    }
    writeCorsHeaders(response);
    if (!this.deps.config.enabled) {
      writeJson(response, 404, { error: "Voxta facade is disabled" });
      return true;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      writeJson(response, 405, { error: "Voxta negotiation requires POST" });
      return true;
    }

    const connectionId = crypto.randomUUID();
    const connectionToken = crypto.randomUUID();
    this.pendingConnections.set(connectionToken, {
      connectionId,
      connectionToken,
      createdAt: Date.now(),
    });
    this.prunePendingConnections();
    writeJson(response, 200, {
      negotiateVersion: 1,
      connectionId,
      connectionToken,
      availableTransports: [
        {
          transport: "WebSockets",
          transferFormats: ["Text"],
        },
      ],
    });
    return true;
  }

  shouldHandleUpgrade(request: http.IncomingMessage): boolean {
    if (!this.deps.config.enabled) {
      return false;
    }
    const url = new URL(request.url || "/", "http://localhost");
    return isHubPath(url.pathname) || isAudioInputStreamPath(url.pathname);
  }

  handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url || "/", "http://localhost");
    const server = isAudioInputStreamPath(url.pathname) ? this.audioWsServer : this.wsServer;
    server.handleUpgrade(request, socket, head, (websocket) => {
      server.emit("connection", websocket, request);
    });
  }

  async close(): Promise<void> {
    for (const client of this.wsServer.clients) {
      client.close();
    }
    for (const client of this.audioWsServer.clients) {
      client.close();
    }
    await new Promise<void>((resolve, reject) => {
      this.wsServer.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      this.audioWsServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private prunePendingConnections(): void {
    const expiresBefore = Date.now() - 60_000;
    for (const [token, pending] of this.pendingConnections) {
      if (pending.createdAt < expiresBefore) {
        this.pendingConnections.delete(token);
      }
    }
  }

  private async handleServiceToggle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    toggle: { configurationId: string; serviceType: ToggleableVoxtaServiceType },
  ): Promise<void> {
    if (!this.deps.config.enabled) {
      writeJson(response, 404, { error: "Voxta facade is disabled" });
      return;
    }
    if (request.method !== "PUT") {
      response.setHeader("Allow", "PUT, OPTIONS");
      writeJson(response, 405, { error: "Voxta service updates require PUT" });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.enabled !== "boolean") {
      writeJson(response, 400, { error: "Voxta service update body must be { enabled: boolean }" });
      return;
    }
    const state = this.runtime.serviceStates.get(toggle.configurationId);
    if (!state) {
      writeJson(response, 404, { error: `Unknown Voxta configuration: ${toggle.configurationId}` });
      return;
    }
    state[toggle.serviceType] = body.enabled;
    writeJson(response, 200, {
      configurationId: toggle.configurationId,
      serviceType: toggle.serviceType,
      enabled: body.enabled,
    });
    const connection = this.runtime.connectionsByConfigurationId.get(toggle.configurationId);
    if (connection) {
      await connection.emitConfiguration();
      if (toggle.serviceType === "SpeechToText" && this.deps.config.sttStreamEnabled) {
        await connection.emitRecordingRequest(body.enabled);
      }
    }
  }

  private async handleVisionRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    visionRequest: { requestId: string; action: "send" | "cancel" },
  ): Promise<void> {
    if (!this.deps.config.enabled) {
      writeJson(response, 404, { error: "Voxta facade is disabled" });
      return;
    }
    const sessionId = normalizedString(url.searchParams.get("sessionId"));
    if (!sessionId) {
      writeJson(response, 400, { error: "Voxta vision request requires sessionId" });
      return;
    }
    const connection = this.runtime.connectionsBySessionId.get(sessionId);
    if (!connection) {
      writeJson(response, 404, { error: `Unknown Voxta session: ${sessionId}` });
      return;
    }
    if (visionRequest.action === "cancel") {
      if (request.method !== "DELETE") {
        response.setHeader("Allow", "DELETE, OPTIONS");
        writeJson(response, 405, { error: "Voxta vision request cancellation requires DELETE" });
        return;
      }
      this.resolveVisionRequest(visionRequest.requestId, null);
      writeJson(response, 200, { success: true, cancelled: true });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      writeJson(response, 405, { error: "Voxta vision upload requires POST" });
      return;
    }
    const source = parseVisionSource(url.searchParams.get("source"));
    if (!source) {
      writeJson(response, 400, { error: "Voxta vision upload source must be Screen or Eyes" });
      return;
    }
    const label = normalizedString(url.searchParams.get("label")) ?? "virtamate";
    const upload = await readMultipartUpload(request);
    const capture = persistVisionCapture({
      root: this.deps.artifactsRoot,
      requestId: visionRequest.requestId,
      sessionId,
      source,
      label,
      upload,
    });
    connection.recordVisionCapture(capture);
    this.resolveVisionRequest(visionRequest.requestId, capture);
    writeJson(response, 200, { success: true, requestId: visionRequest.requestId });
  }

  private resolveVisionRequest(requestId: string, capture: VisionCaptureImage | null): void {
    const pending = this.runtime.pendingVisionRequests.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.runtime.pendingVisionRequests.delete(requestId);
    pending.resolve(capture);
  }
}

class VoxtaConnection {
  private readonly assistant: VoxtaParticipant;
  private readonly user: VoxtaParticipant;
  private readonly actionAllowlist: Set<string>;
  private readonly servicesConfigurationsSetId = crypto.randomUUID();
  private messageChain: Promise<void> = Promise.resolve();
  private sessionId: string;
  private chatId: string;
  private registeredSessionId: string | null = null;
  private visionCaptures: VisionCaptureImage[] = [];
  private replyAbort = false;
  private replySequence = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: VoxtaFacadeDependencies,
    private readonly runtime: VoxtaFacadeRuntime,
    connectionId: string,
  ) {
    this.sessionId = normalizeGuid(connectionId) ?? crypto.randomUUID();
    this.chatId = crypto.randomUUID();
    this.assistant = {
      id: normalizeGuid(deps.config.assistantId) ?? crypto.randomUUID(),
      name: deps.config.assistantName,
      role: "Assistant",
    };
    this.user = {
      id: normalizeGuid(deps.config.userId) ?? crypto.randomUUID(),
      name: deps.config.userName,
      role: "User",
    };
    this.actionAllowlist = new Set(deps.config.actionAllowlist);
    this.runtime.serviceStates.set(this.servicesConfigurationsSetId, {
      SpeechToText: true,
      TextToSpeech: true,
      ComputerVision: false,
      ActionInference: true,
    });
    this.runtime.connectionsByConfigurationId.set(this.servicesConfigurationsSetId, this);
    this.attachSatellite();
    this.registerSession();
  }

  run(): void {
    this.socket.on("message", (raw) => {
      for (const frame of decodeSignalRFrames(raw)) {
        this.messageChain = this.messageChain
          .then(() => this.handleFrame(frame))
          .catch((error) => {
            console.error("Voxta message handling failed:", error);
            void this.sendReceive({
              $type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }
    });
    this.socket.on("close", () => {
      this.cancelReply();
      this.runtime.connectionsByConfigurationId.delete(this.servicesConfigurationsSetId);
      if (this.registeredSessionId) {
        this.runtime.connectionsBySessionId.delete(this.registeredSessionId);
        this.registeredSessionId = null;
      }
    });
  }

  private async handleFrame(frame: unknown): Promise<void> {
    if (!isRecord(frame)) {
      return;
    }
    if (isSignalRHandshake(frame)) {
      await this.sendFrame({});
      return;
    }
    if (frame.type === 6) {
      return;
    }
    if (frame.type !== 1) {
      return;
    }

    const invocation = frame as unknown as SignalRInvocation;
    if (invocation.target !== "SendMessage") {
      await this.sendCompletion(invocation.invocationId, `Unsupported SignalR target: ${invocation.target || ""}`);
      return;
    }

    const payload = invocation.arguments?.[0];
    if (!isRecord(payload)) {
      await this.sendCompletion(invocation.invocationId, "SendMessage requires a payload argument");
      return;
    }

    const clientPayload = payload as VoxtaClientPayload;
    const type = typeof clientPayload.$type === "string" ? clientPayload.$type : "";
    switch (type) {
      case "authenticate":
        await this.handleAuthenticate(invocation.invocationId);
        return;
      case "registerApp":
        await this.handleRegisterApp(invocation.invocationId, clientPayload);
        return;
      case "loadCharactersList":
        await this.sendReceive({
          $type: "charactersListLoaded",
          characters: [this.characterSummary()],
        });
        await this.sendCompletion(invocation.invocationId);
        return;
      case "loadScenariosList":
        await this.sendReceive({ $type: "scenariosListLoaded", scenarios: [] });
        await this.sendCompletion(invocation.invocationId);
        return;
      case "loadChatsList":
        await this.sendReceive({
          $type: "chatsListLoaded",
          chats: [this.chatSummary()],
        });
        await this.sendCompletion(invocation.invocationId);
        return;
      case "startChat":
        await this.handleStartChat(invocation.invocationId, clientPayload);
        return;
      case "resumeChat":
        await this.handleResumeChat(invocation.invocationId, clientPayload);
        return;
      case "subscribeToChat":
        await this.sendCompletion(invocation.invocationId);
        return;
      case "send":
        await this.handleSend(invocation.invocationId, clientPayload);
        return;
      case "interrupt":
        await this.handleInterrupt(invocation.invocationId, clientPayload);
        return;
      case "speechPlaybackStart":
      case "speechPlaybackComplete":
      case "typingStart":
      case "typingEnd":
      case "pauseChat":
      case "inspect":
      case "inspectAudioInput":
        await this.sendCompletion(invocation.invocationId);
        return;
      case "updateContext":
        await this.handleUpdateContext(invocation.invocationId, clientPayload);
        return;
      case "triggerAction":
        await this.handleTriggerAction(invocation.invocationId, clientPayload);
        return;
      default:
        await this.sendCompletion(invocation.invocationId, `Unsupported Voxta message type: ${type}`);
    }
  }

  private async handleAuthenticate(invocationId?: string): Promise<void> {
    await this.sendReceive({
      $type: "welcome",
      apiVersion: VOXTA_API_VERSION,
      voxtaServerVersion: VOXTA_SERVER_VERSION,
      registeredClientVersion: VAM_PLUGIN_VERSION,
      assistant: this.characterSummary(),
      user: this.userSummary(),
      capabilities: {
        audioInput: "None",
        audioOutput: "Url",
        visionCapture: "PostImage",
        visionSources: ["Screen", "Eyes", "Attachment"],
      },
    });
    await this.emitConfiguration();
    await this.sendCompletion(invocationId);
  }

  async emitConfiguration(): Promise<void> {
    await this.sendReceive(this.configurationPayload());
  }

  async emitRecordingRequest(enabled: boolean): Promise<void> {
    await this.sendReceive({
      $type: "recordingRequest",
      sessionId: this.sessionId,
      enabled,
    });
  }

  async emitSpeechRecognitionStart(): Promise<void> {
    await this.sendReceive({
      $type: "speechRecognitionStart",
      sessionId: this.sessionId,
    });
  }

  async emitSpeechRecognitionPartial(text: string): Promise<void> {
    await this.sendReceive({
      $type: "speechRecognitionPartial",
      sessionId: this.sessionId,
      text,
    });
  }

  async emitSpeechRecognitionEnd(text: string): Promise<void> {
    await this.sendReceive({
      $type: "speechRecognitionEnd",
      sessionId: this.sessionId,
      text,
    });
  }

  recordVisionCapture(capture: VisionCaptureImage): void {
    this.visionCaptures = [
      ...this.visionCaptures.filter((item) => item.requestId !== capture.requestId),
      capture,
    ].slice(-6);
  }

  private async handleRegisterApp(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const label = typeof payload.label === "string" ? payload.label : this.deps.config.appLabel;
    await this.sendReceive({
      $type: "moduleRuntimeInstances",
      instances: [
        {
          id: this.deps.config.satelliteId,
          label,
          clientVersion: this.deps.config.clientVersion,
          capabilities: VOXTA_VAM_CAPABILITIES,
        },
      ],
    });
    await this.sendCompletion(invocationId);
  }

  private async handleStartChat(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    this.sessionId = crypto.randomUUID();
    this.chatId = crypto.randomUUID();
    this.attachSatellite();
    this.registerSession();
    await this.emitChatStarted(payload.characterId);
    await this.sendCompletion(invocationId);
  }

  private async handleResumeChat(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const chatId = normalizedString(payload.chatId);
    if (chatId) {
      this.chatId = normalizeGuid(chatId) ?? crypto.randomUUID();
      this.sessionId = crypto.randomUUID();
      this.attachSatellite();
      this.registerSession();
    }
    await this.emitChatStarted(payload.characterId);
    await this.sendCompletion(invocationId);
  }

  private async handleSend(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const text = normalizedString(payload.text);
    if (!text) {
      await this.sendCompletion(invocationId, "Voxta send text is empty");
      return;
    }
    const sessionId = normalizedString(payload.sessionId) ?? this.sessionId;
    this.sessionId = sessionId;
    this.attachSatellite();
    this.registerSession();

    await this.sendReceive({
      $type: "message",
      messageId: crypto.randomUUID(),
      senderId: this.user.id,
      senderName: this.user.name,
      senderType: "User",
      role: this.user.role,
      text,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    });

    this.deps.sessions.append(this.sessionId, { role: "user", content: text });
    const replyTask = this.streamAssistantReply(text);
    await replyTask;
    await this.sendCompletion(invocationId);
  }

  private async handleInterrupt(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const sessionId = normalizedString(payload.sessionId) ?? this.sessionId;
    this.cancelReply();
    await this.sendReceive({
      $type: "interruptSpeech",
      sessionId,
    });
    await this.sendReceive({
      $type: "replyCancelled",
      sessionId,
      messageId: crypto.randomUUID(),
    });
    await this.sendCompletion(invocationId);
  }

  private async handleUpdateContext(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    await this.sendReceive({
      $type: "contextUpdated",
      sessionId: normalizedString(payload.sessionId) ?? this.sessionId,
      contextKey: normalizedString(payload.contextKey) ?? "voxta-context",
      flags: this.contextFlags(),
      actions: this.contextActions(),
    });
    await this.sendCompletion(invocationId);
  }

  private async handleTriggerAction(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const action = normalizedString(payload.name) ?? normalizedString(payload.value);
    if (!action) {
      await this.sendCompletion(invocationId, "triggerAction name or value is required");
      return;
    }
    if (!this.actionAllowlist.has(action)) {
      await this.sendCompletion(invocationId, `Voxta appTrigger is not allowlisted: ${action}`);
      return;
    }
    await this.sendReceive({
      $type: "appTrigger",
      name: action,
      arguments: normalizeArguments(payload.arguments),
      role: this.assistant.role,
      senderId: this.assistant.id,
      sessionId: normalizedString(payload.sessionId) ?? this.sessionId,
    });
    await this.sendCompletion(invocationId);
  }

  private async streamAssistantReply(userText: string): Promise<void> {
    const replyId = ++this.replySequence;
    this.replyAbort = false;
    const messageId = crypto.randomUUID();
    let responseText = "";
    await this.requestVisionCapturesIfNeeded();

    await this.sendReceive({
      $type: "chatFlow",
      state: "Thinking",
      sessionId: this.sessionId,
    });
    await this.sendReceive({
      $type: "replyGenerating",
      sessionId: this.sessionId,
      messageId,
      senderId: this.assistant.id,
      role: this.assistant.role,
      thinkingSpeechUrl: "",
      isNarration: false,
    });
    await this.sendReceive({
      $type: "replyStart",
      sessionId: this.sessionId,
      messageId,
      senderId: this.assistant.id,
      senderName: this.assistant.name,
      role: this.assistant.role,
      timestamp: new Date().toISOString(),
    });

    const stream = this.deps.agent.streamReply({
      userText,
      conversationId: this.sessionId,
      history: this.deps.sessions.getHistory(this.sessionId) as ConversationMessage[],
      channel: this.agentChannelContext(),
    });
    for await (const delta of stream) {
      if (this.replyAbort || replyId !== this.replySequence) {
        await this.sendReceive({
          $type: "replyCancelled",
          sessionId: this.sessionId,
          messageId,
        });
        return;
      }
      responseText += delta;
    }

    responseText = responseText.trim();
    this.deps.sessions.append(this.sessionId, { role: "assistant", content: responseText });
    const audioUrl = await this.createSpeechArtifact(messageId, responseText);
    await this.sendReceive({
      $type: "replyChunk",
      sessionId: this.sessionId,
      messageId,
      senderId: this.assistant.id,
      role: this.assistant.role,
      text: responseText,
      audioUrl,
      startIndex: 0,
      endIndex: responseText.length,
      isNarration: false,
      audioGapMs: 0,
      timestamp: new Date().toISOString(),
    });
    await this.sendReceive({
      $type: "message",
      messageId,
      senderId: this.assistant.id,
      senderName: this.assistant.name,
      senderType: "Assistant",
      role: this.assistant.role,
      text: responseText,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    });
    await this.sendReceive({
      $type: "replyEnd",
      sessionId: this.sessionId,
      messageId,
      senderId: this.assistant.id,
    });
    await this.sendReceive({
      $type: "chatFlow",
      state: "WaitingForUser",
      sessionId: this.sessionId,
    });
    if (this.deps.config.sttStreamEnabled && this.currentServiceState().SpeechToText) {
      await this.emitRecordingRequest(true);
    }
  }

  private async createSpeechArtifact(messageId: string, text: string): Promise<string> {
    const audioFolder = this.deps.config.audioFolder;
    const serviceState = this.runtime.serviceStates.get(this.servicesConfigurationsSetId);
    if (!audioFolder || !this.deps.tts || serviceState?.TextToSpeech === false) {
      return "silence:0";
    }
    const spokenText = sanitizeSpokenText(text);
    if (!spokenText) {
      return "silence:0";
    }
    try {
      fs.mkdirSync(audioFolder, { recursive: true });
      const wav = await this.deps.tts.synthesizeWav(spokenText);
      if (wav.length === 0) {
        return "silence:0";
      }
      const filename = `voxta_${safePathPart(this.sessionId)}_${safePathPart(messageId)}_0.wav`;
      const filePath = path.join(audioFolder, filename);
      fs.writeFileSync(filePath, wav);
      return filePath;
    } catch (error) {
      console.error("Voxta TTS artifact generation failed:", error);
      return "silence:0";
    }
  }

  private async emitChatStarted(characterId?: string): Promise<void> {
    await this.sendReceive({
      $type: "chatStarting",
      chatId: this.chatId,
      sessionId: this.sessionId,
    });
    await this.sendReceive({
      $type: "chatStarted",
      chatId: this.chatId,
      sessionId: this.sessionId,
      characterId: normalizeGuid(characterId) ?? this.assistant.id,
      title: this.assistant.name,
      chatStyle: "Roleplay",
      messages: [],
      context: this.contextPayload(),
      services: this.chatServicesPayload(),
      servicesConfigurationsSetId: this.servicesConfigurationsSetId,
      user: this.userSummary(),
      characters: [this.characterSummary()],
      augmentations: [],
      participants: [this.characterSummary(), this.userSummary()],
    });
    await this.sendReceive({
      $type: "chatsSessionsUpdated",
      sessions: [this.chatSummary()],
    });
    await this.sendReceive({
      $type: "chatParticipantsUpdated",
      sessionId: this.sessionId,
      participants: [this.characterSummary(), this.userSummary()],
    });
    await this.sendReceive({
      $type: "chatFlow",
      state: "WaitingForUser",
      sessionId: this.sessionId,
    });
    if (this.deps.config.sttStreamEnabled && this.currentServiceState().SpeechToText) {
      await this.emitRecordingRequest(true);
    }
  }

  private async requestVisionCapturesIfNeeded(): Promise<void> {
    if (!this.currentServiceState().ComputerVision) {
      return;
    }
    const sources: VoxtaVisionSource[] = ["Screen", "Eyes"];
    const captures = await Promise.all(sources.map((source) => this.requestVisionCapture(source)));
    for (const capture of captures) {
      if (capture) {
        this.recordVisionCapture(capture);
      }
    }
  }

  private async requestVisionCapture(source: VoxtaVisionSource): Promise<VisionCaptureImage | null> {
    const requestId = crypto.randomUUID();
    const promise = new Promise<VisionCaptureImage | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.runtime.pendingVisionRequests.delete(requestId);
        resolve(null);
      }, Math.max(100, this.deps.config.visionCaptureTimeoutMs));
      this.runtime.pendingVisionRequests.set(requestId, {
        requestId,
        sessionId: this.sessionId,
        source,
        resolve,
        timeout,
      });
    });
    await this.sendReceive({
      $type: "visionCaptureRequest",
      sessionId: this.sessionId,
      visionCaptureRequestId: requestId,
      source,
    });
    return promise;
  }

  private async sendReceive(payload: VoxtaServerPayload): Promise<void> {
    await this.sendFrame({
      type: 1,
      target: "ReceiveMessage",
      arguments: [payload],
    });
  }

  private async sendCompletion(invocationId?: string, error?: string): Promise<void> {
    if (!invocationId) {
      return;
    }
    await this.sendFrame({
      type: 3,
      invocationId,
      ...(error ? { error } : { result: null }),
    });
  }

  private async sendFrame(payload: Record<string, unknown>): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(`${JSON.stringify(payload)}${SIGNALR_RECORD_SEPARATOR}`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private attachSatellite(): void {
    this.deps.embodiedSessions.attachSatellite({
      sessionId: this.sessionId,
      satelliteId: this.deps.config.satelliteId,
      satelliteName: this.deps.config.satelliteName,
      capabilities: VOXTA_VAM_CAPABILITIES,
    });
  }

  private agentChannelContext(): PsfnChannelContext {
    const context = this.deps.embodiedSessions.getContext(this.sessionId, this.deps.config.satelliteId);
    return {
      ...context,
      visionCaptures: this.visionCaptures.slice(-4).map(stripVisionCaptureImageData),
      visionCaptureImages: this.visionCaptures.slice(-4),
    };
  }

  private cancelReply(): void {
    this.replyAbort = true;
    this.replySequence += 1;
  }

  private characterSummary(): Record<string, unknown> {
    return {
      id: this.assistant.id,
      name: this.assistant.name,
      role: this.assistant.role,
      isPrimary: true,
      creatorNotes: "",
      packageId: "",
      packageName: "",
      packageVersion: "",
    };
  }

  private userSummary(): Record<string, unknown> {
    return {
      id: this.user.id,
      name: this.user.name,
      role: this.user.role,
    };
  }

  private chatSummary(): Record<string, unknown> {
    return {
      id: this.chatId,
      chatId: this.chatId,
      sessionId: this.sessionId,
      title: this.assistant.name,
      characterId: this.assistant.id,
      participants: [this.characterSummary(), this.userSummary()],
      created: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private contextPayload(): Record<string, unknown> {
    return {
      flags: this.contextFlags(),
      characters: [this.characterSummary()],
      actions: this.contextActions(),
      roles: {
        user: this.userSummary(),
        assistant: this.characterSummary(),
      },
    };
  }

  private contextFlags(): Array<Record<string, unknown>> {
    return [];
  }

  private contextActions(): Array<Record<string, unknown>> {
    return [...this.actionAllowlist].sort().map((name) => ({ name }));
  }

  private chatServicesPayload(): Record<string, unknown> {
    return {
      textGen: { serviceName: "PSFN" },
      textToSpeech: { serviceName: "PSFN TTS" },
      speechToText: { serviceName: "PSFN STT" },
      actionInference: { serviceName: "PSFN Actions" },
    };
  }

  private configurationPayload(): VoxtaServerPayload {
    const serviceState = this.currentServiceState();
    return {
      $type: "configuration",
      configurations: [
        {
          id: this.servicesConfigurationsSetId,
          name: "PSFN Satellite Hub",
          isDefault: true,
          services: {
            SpeechToText: {
              enabled: serviceState.SpeechToText,
              serviceName: "PSFN STT",
            },
            TextToSpeech: {
              enabled: serviceState.TextToSpeech,
              serviceName: "PSFN TTS",
            },
            ComputerVision: {
              enabled: serviceState.ComputerVision,
              serviceName: "PSFN Vision",
            },
            ActionInference: {
              enabled: serviceState.ActionInference,
              serviceName: "PSFN Actions",
            },
          },
        },
      ],
    };
  }

  private currentServiceState(): VoxtaServiceState {
    return this.runtime.serviceStates.get(this.servicesConfigurationsSetId) ?? {
      SpeechToText: true,
      TextToSpeech: true,
      ComputerVision: false,
      ActionInference: true,
    };
  }

  private registerSession(): void {
    if (this.registeredSessionId && this.registeredSessionId !== this.sessionId) {
      this.runtime.connectionsBySessionId.delete(this.registeredSessionId);
    }
    this.runtime.connectionsBySessionId.set(this.sessionId, this);
    this.registeredSessionId = this.sessionId;
  }
}

class VoxtaAudioInputStream {
  private spec: VoxtaAudioInputSpec | null = null;
  private readonly chunks: Buffer[] = [];
  private started = false;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: VoxtaFacadeRuntime,
    private readonly stt: VoxtaSttAdapter | undefined,
    private readonly sessionId: string,
  ) {}

  run(): void {
    if (!normalizeGuid(this.sessionId) || !this.runtime.connectionsBySessionId.has(this.sessionId)) {
      this.socket.close(1008, "Unknown Voxta audio input session");
      return;
    }
    this.socket.on("message", (raw, isBinary) => {
      void this.handleMessage(raw, isBinary).catch((error) => {
        console.error("Voxta audio input stream failed:", error);
        this.socket.close(1011, error instanceof Error ? error.message : String(error));
      });
    });
    this.socket.on("close", () => {
      void this.finish().catch((error) => {
        console.error("Voxta audio input finalization failed:", error);
      });
    });
  }

  private async handleMessage(raw: RawData, isBinary: boolean): Promise<void> {
    if (!this.spec) {
      if (isBinary) {
        throw new Error("Voxta audio input stream must start with a JSON stream spec");
      }
      this.spec = parseAudioInputSpec(decodeRawData(raw));
      return;
    }
    const chunk = rawDataToBuffer(raw);
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    if (!this.started) {
      this.started = true;
      await this.connection()?.emitSpeechRecognitionStart();
    }
  }

  private async finish(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const connection = this.connection();
    if (!connection || !this.started || !this.spec) {
      return;
    }
    const pcm = Buffer.concat(this.chunks);
    if (pcm.length === 0) {
      await connection.emitSpeechRecognitionEnd("");
      return;
    }
    if (!this.stt) {
      await connection.emitSpeechRecognitionPartial("");
      await connection.emitSpeechRecognitionEnd("");
      return;
    }
    const result = await this.stt.transcribePcm({
      sessionId: this.sessionId,
      spec: this.spec,
      pcm,
    });
    const text = result.text.trim();
    if (text) {
      await connection.emitSpeechRecognitionPartial(text);
    }
    await connection.emitSpeechRecognitionEnd(text);
  }

  private connection(): VoxtaConnection | undefined {
    return this.runtime.connectionsBySessionId.get(this.sessionId);
  }
}

function isNegotiatePath(pathname: string): boolean {
  return pathname === "/hub/negotiate" || pathname === "/voxta/hub/negotiate";
}

function isHubPath(pathname: string): boolean {
  return pathname === "/hub" || pathname === "/voxta/hub";
}

function isAudioInputStreamPath(pathname: string): boolean {
  return pathname === "/ws/audio/input/stream";
}

function isCorsPreflight(request: http.IncomingMessage, pathname: string): boolean {
  return request.method === "OPTIONS" && (
    isNegotiatePath(pathname) ||
    isHubPath(pathname) ||
    parseServiceTogglePath(pathname) !== null ||
    parseVisionRequestPath(pathname) !== null
  );
}

function writeCorsHeaders(response: http.ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, PUT, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function parseVisionRequestPath(pathname: string): { requestId: string; action: "send" | "cancel" } | null {
  const sendMatch = /^\/api\/vision\/requests\/([^/]+)\/send$/.exec(pathname);
  if (sendMatch) {
    return {
      requestId: decodeURIComponent(sendMatch[1] || ""),
      action: "send",
    };
  }
  const cancelMatch = /^\/api\/vision\/requests\/([^/]+)$/.exec(pathname);
  if (cancelMatch) {
    return {
      requestId: decodeURIComponent(cancelMatch[1] || ""),
      action: "cancel",
    };
  }
  return null;
}

function parseServiceTogglePath(
  pathname: string,
): { configurationId: string; serviceType: ToggleableVoxtaServiceType } | null {
  const match = /^\/api\/configurations\/([^/]+)\/services\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }
  const serviceType = decodeURIComponent(match[2] || "");
  if (serviceType !== "SpeechToText" && serviceType !== "TextToSpeech" && serviceType !== "ComputerVision") {
    return null;
  }
  return {
    configurationId: decodeURIComponent(match[1] || ""),
    serviceType,
  };
}

interface MultipartUpload {
  data: Buffer;
  mimeType: string;
  filename: string;
}

async function readMultipartUpload(request: http.IncomingMessage): Promise<MultipartUpload> {
  const contentType = String(request.headers["content-type"] || "");
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1]?.trim();
  if (!boundary) {
    throw new Error("Voxta vision upload must be multipart/form-data with a boundary");
  }
  const body = await readRequestBuffer(request);
  const part = extractMultipartFile(body, boundary.replace(/^"|"$/g, ""), "file");
  if (!part) {
    throw new Error("Voxta vision upload must include a file field");
  }
  return part;
}

async function readRequestBuffer(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function extractMultipartFile(body: Buffer, boundary: string, fieldName: string): MultipartUpload | null {
  const delimiter = Buffer.from(`--${boundary}`);
  let offset = 0;
  while (offset < body.length) {
    const partStart = body.indexOf(delimiter, offset);
    if (partStart === -1) {
      return null;
    }
    const headersStart = partStart + delimiter.length;
    if (body.subarray(headersStart, headersStart + 2).toString("ascii") === "--") {
      return null;
    }
    const partBodyStart = body.indexOf(Buffer.from("\r\n\r\n"), headersStart);
    if (partBodyStart === -1) {
      return null;
    }
    const headerText = body.subarray(headersStart, partBodyStart).toString("utf8");
    const nextPart = body.indexOf(delimiter, partBodyStart + 4);
    if (nextPart === -1) {
      return null;
    }
    const partBodyEnd = body.subarray(nextPart - 2, nextPart).toString("ascii") === "\r\n"
      ? nextPart - 2
      : nextPart;
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headerText)?.[1] || "";
    const name = /name="([^"]+)"/i.exec(disposition)?.[1] || "";
    if (name === fieldName) {
      const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] || "upload.jpg";
      const mimeType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || "application/octet-stream";
      return {
        data: body.subarray(partBodyStart + 4, partBodyEnd),
        filename,
        mimeType,
      };
    }
    offset = nextPart;
  }
  return null;
}

function persistVisionCapture(input: {
  root: string;
  requestId: string;
  sessionId: string;
  source: VoxtaVisionSource;
  label: string;
  upload: MultipartUpload;
}): VisionCaptureImage {
  const capturedAt = new Date();
  const dateKey = capturedAt.toISOString().slice(0, 10).replaceAll("-", "");
  const directory = path.join(input.root, "voxta-vision", dateKey);
  fs.mkdirSync(directory, { recursive: true });
  const extension = extensionForMimeType(input.upload.mimeType) ?? (path.extname(input.upload.filename) || ".bin");
  const filePath = path.join(
    directory,
    `voxta_${safePathPart(input.sessionId)}_${safePathPart(input.requestId)}_${input.source}${extension}`,
  );
  fs.writeFileSync(filePath, input.upload.data);
  return {
    requestId: input.requestId,
    sessionId: input.sessionId,
    source: input.source,
    label: input.label,
    mimeType: input.upload.mimeType,
    filePath,
    bytes: input.upload.data.length,
    capturedAt: capturedAt.toISOString(),
    dataBase64: input.upload.data.toString("base64"),
  };
}

function stripVisionCaptureImageData(capture: VisionCaptureImage): VisionCaptureMetadata {
  const { dataBase64: _dataBase64, ...metadata } = capture;
  return metadata;
}

function extensionForMimeType(mimeType: string): string | undefined {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return ".jpg";
  }
  if (normalized === "image/png") {
    return ".png";
  }
  return undefined;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const raw = (await readRequestBuffer(request)).toString("utf8").trim();
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as unknown;
}

function decodeSignalRFrames(raw: RawData): unknown[] {
  const text = decodeRawData(raw);
  if (!text) {
    return [];
  }
  return text
    .split(SIGNALR_RECORD_SEPARATOR)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as unknown);
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

function rawDataToBuffer(raw: RawData): Buffer {
  if (typeof raw === "string") {
    return Buffer.from(raw, "utf8");
  }
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((item) => Buffer.isBuffer(item) ? item : Buffer.from(item)));
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as Uint8Array;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return Buffer.alloc(0);
}

function parseAudioInputSpec(raw: string | null): VoxtaAudioInputSpec {
  if (!raw) {
    throw new Error("Voxta audio input stream spec is empty");
  }
  const payload = JSON.parse(raw) as unknown;
  if (!isRecord(payload)) {
    throw new Error("Voxta audio input stream spec must be an object");
  }
  const spec = {
    sampleRate: numberField(payload.sampleRate, "sampleRate"),
    channels: numberField(payload.channels, "channels"),
    bufferMilliseconds: numberField(payload.bufferMilliseconds, "bufferMilliseconds"),
    bitsPerSample: numberField(payload.bitsPerSample, "bitsPerSample"),
    contentType: normalizedString(payload.contentType) ?? "",
  };
  if (!spec.contentType) {
    throw new Error("Voxta audio input stream spec contentType is required");
  }
  return spec;
}

function parseVisionSource(value: unknown): VoxtaVisionSource | undefined {
  const normalized = normalizedString(value);
  if (normalized === "Screen" || normalized === "Eyes") {
    return normalized;
  }
  return undefined;
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Voxta audio input stream spec ${name} must be a number`);
  }
  return value;
}

function isSignalRHandshake(frame: Record<string, unknown>): boolean {
  return frame.protocol === "json" && frame.version === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeGuid(value: unknown): string | undefined {
  const text = normalizedString(value);
  if (!text) {
    return undefined;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : undefined;
}

function normalizeArguments(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item : String(item));
  }
  if (isRecord(value)) {
    return Object.values(value).map((item) => typeof item === "string" ? item : String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function safePathPart(value: string): string {
  return value.replaceAll(/[^a-z0-9_-]/gi, "_");
}
