import { Utf8ByteBudget } from "../shared/upstream-response.js";
import { hubConsole as console } from "../shared/private-log.js";
import crypto from "node:crypto";
import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { abortReason, awaitWithAbort, throwIfAborted } from "../shared/abort.js";
import { readPrivateArtifact, writePrivateArtifact } from "../shared/private-artifacts.js";
import type { VoxtaFacadeConfig } from "../shared/env.js";
import { sanitizeSpokenText } from "../shared/text.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import {
  EmbodiedSessionRegistry,
  VOXTA_VAM_CAPABILITIES,
} from "./embodied-session.js";
import type { PsfnChannelContext, SatelliteAttachmentOwnership, VisionCaptureImage, VisionCaptureMetadata } from "./embodied-session.js";
import type { ConversationMessage } from "./session-store.js";
import { SessionStore } from "./session-store.js";
import { HubAccess, rejectHubUpgrade, type HubPrincipal } from "./hub-auth.js";
import { HubResources, HubSocketFlow, HubRequestError, readHubBody, rejectHttp, type HubSocketAdmission } from "./transport-resources.js";

const SIGNALR_RECORD_SEPARATOR = "\x1e";
const SIGNALR_KEEPALIVE_INTERVAL_MS = 15_000;
const VOXTA_API_VERSION = "2025-11";
const VOXTA_SERVER_VERSION = "1.1.3";
const VAM_PLUGIN_VERSION = "1.1.1";

interface VoxtaFacadeDependencies {
  resources: HubResources;
  access: HubAccess;
  config: VoxtaFacadeConfig;
  sessions: SessionStore;
  embodiedSessions: EmbodiedSessionRegistry;
  agent: FrameworkAgentAdapter;
  artifactsRoot: string;
  tts?: VoxtaTtsAdapter;
  stt?: VoxtaSttAdapter;
}

export interface VoxtaTtsAdapter {
  synthesizeWav(text: string, signal: AbortSignal): Promise<Buffer>;
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
    signal: AbortSignal;
  }): Promise<{ text: string; provider?: string }>;
}

interface PendingConnection {
  principalId: string;
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
  audioOwners: Map<string, string>;
  serviceStates: Map<string, VoxtaServiceState>;
  connectionsByConfigurationId: Map<string, VoxtaConnection>;
  connectionsBySessionId: Map<string, VoxtaConnection>;
  pendingVisionRequests: Map<string, PendingVisionRequest>;
  connections: Set<VoxtaConnection>;
  audioInputs: Set<VoxtaAudioInputStream>;
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
  characterIds?: unknown;
  text?: string;
  name?: string;
  value?: string;
  contexts?: unknown;
  contextKey?: string;
  doReply?: unknown;
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
  private readonly principalSessions = new Map<string, { sessionId: string; chatId: string }>();
  private readonly wsServer: WebSocketServer;
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly runtime: VoxtaFacadeRuntime = {
    audioOwners: new Map(),
    serviceStates: new Map(),
    connectionsByConfigurationId: new Map(),
    connectionsBySessionId: new Map(),
    pendingVisionRequests: new Map(),
    connections: new Set(),
    audioInputs: new Set(),
  };
  private readonly audioWsServer: WebSocketServer;
  private readonly principals = new WeakMap<http.IncomingMessage, HubPrincipal>();
  private readonly admissions = new WeakMap<http.IncomingMessage, HubSocketAdmission>();

  constructor(private readonly deps: VoxtaFacadeDependencies) {
    const options = { noServer: true, autoPong: false, maxPayload: deps.resources.limits.maxFrameBytes, perMessageDeflate: false } as const;
    this.wsServer = new WebSocketServer(options);
    this.audioWsServer = new WebSocketServer(options);
    this.wsServer.on("connection", (socket, request) => {
      const url = new URL(request.url || "/hub", "http://localhost");
      const connectionToken = url.searchParams.get("id") || "";
      const pending = this.pendingConnections.get(connectionToken);
      this.pendingConnections.delete(connectionToken);
      const principal = this.principals.get(request)!;
      let session = this.principalSessions.get(principal.id);
      if (!session) {
        session = { sessionId: crypto.randomUUID(), chatId: crypto.randomUUID() };
        if (this.principalSessions.size >= this.deps.resources.limits.maxSessions) {
          this.principalSessions.delete(this.principalSessions.keys().next().value!);
        }
        this.principalSessions.set(principal.id, session);
      }
      const connection = new VoxtaConnection(
        socket,
        this.deps,
        this.runtime,
        pending?.connectionId ?? crypto.randomUUID(),
        publicBaseUrlForRequest(this.deps.config.publicBaseUrl, request),
        principal,
        session,
        this.admissions.get(request)!,
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
        this.principals.get(request)!,
        this.deps.access,
        this.deps.resources,
        this.admissions.get(request)!,
      );
      stream.run();
    });
  }

  handleHttp(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    const url = new URL(request.url || "/", "http://localhost");
    if (!isVoxtaPath(url.pathname)) return false;
    if (!this.deps.access.originAllowed(request)) {
      writeJson(response, 403, { error: "Origin is not allowed" });
      return true;
    }
    this.deps.access.writeCors(request, response);
    if (!this.deps.config.enabled) {
      writeJson(response, 404, { error: "Voxta facade is disabled" });
      return true;
    }
    if (isCorsPreflight(request, url.pathname)) {
      response.statusCode = 204;
      response.end();
      return true;
    }
    const principal = this.deps.access.authenticate(request);
    if (!principal) {
      writeJson(response, 401, { error: "Hub authentication required" });
      return true;
    }
    this.principals.set(request, principal);
    const audioArtifact = parseAudioArtifactPath(url.pathname);
    if (audioArtifact) {
      this.handleAudioArtifact(request, response, audioArtifact);
      return true;
    }
    const visionRequest = parseVisionRequestPath(url.pathname);
    if (visionRequest) {
      void this.handleVisionRequest(request, response, url, visionRequest).catch((error) => {
        rejectHttp(request, response, error);
      });
      return true;
    }
    const serviceToggle = parseServiceTogglePath(url.pathname);
    if (serviceToggle) {
      void this.handleServiceToggle(request, response, serviceToggle).catch((error) => {
        rejectHttp(request, response, error);
      });
      return true;
    }
    if (!isNegotiatePath(url.pathname)) {
      writeJson(response, 404, { error: "Unknown Voxta route" });
      return true;
    }
    if (!this.deps.config.enabled) {
      writeJson(response, 404, { error: "Voxta facade is disabled" });
      return true;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      writeJson(response, 405, { error: "Voxta negotiation requires POST" });
      return true;
    }

    void this.negotiate(request, response, principal).catch(error => rejectHttp(request, response, error));
    return true;
  }

  private async negotiate(request: http.IncomingMessage, response: http.ServerResponse, principal: HubPrincipal): Promise<void> {
    await readHubBody(request, this.deps.resources.limits.maxHttpBodyBytes, this.deps.resources.limits.httpBodyTimeoutMs);
    const connectionId = crypto.randomUUID();
    const connectionToken = crypto.randomUUID();
    this.prunePendingConnections();
    if (this.pendingConnections.size >= this.deps.resources.limits.maxPendingNegotiations) {
      writeJson(response, 429, { error: "Hub pending negotiation quota exceeded" });
      return;
    }
    this.pendingConnections.set(connectionToken, {
      principalId: principal.id,
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
  }

  shouldHandleUpgrade(request: http.IncomingMessage): boolean {
    const url = new URL(request.url || "/", "http://localhost");
    return isVoxtaPath(url.pathname);
  }

  handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url || "/", "http://localhost");
    if (!this.deps.config.enabled) return rejectHubUpgrade(socket, 404);
    const principal = this.deps.access.authenticate(request);
    if (!principal) return rejectHubUpgrade(socket, 401);
    this.principals.set(request, principal);
    this.prunePendingConnections();
    if (isAudioInputStreamPath(url.pathname)) {
      if (!this.deps.resources.providerAvailable()) return rejectHubUpgrade(socket, 429);
      const connection = this.runtime.connectionsBySessionId.get(url.searchParams.get("sessionId") ?? "");
      if (!connection || !connection.ownedBy(principal)) return rejectHubUpgrade(socket, 403);
      if (principal.device && !principal.device.maxCapabilities.input.includes("microphone_pcm")) return rejectHubUpgrade(socket, 403);
      if (!this.deps.config.sttStreamEnabled) return rejectHubUpgrade(socket, 404);
    } else if (isHubPath(url.pathname)) {
      const id = url.searchParams.get("id");
      if (id !== null) {
        const pending = this.pendingConnections.get(id);
        if (!pending || pending.principalId !== principal.id) return rejectHubUpgrade(socket, 401);
      }
    } else {
      return rejectHubUpgrade(socket, 404);
    }
    const admission = this.deps.resources.admitSocket(true);
    if (!admission) return rejectHubUpgrade(socket, 429);
    this.admissions.set(request, admission);
    const releaseUpgrade = (): void => admission.release();
    socket.once("close", releaseUpgrade);
    const server = isAudioInputStreamPath(url.pathname) ? this.audioWsServer : this.wsServer;
    server.handleUpgrade(request, socket, head, (websocket) => {
      socket.off("close", releaseUpgrade);
      server.emit("connection", websocket, request);
    });
  }

  async close(): Promise<void> {
    for (const input of this.runtime.audioInputs) input.abort();
    for (const client of this.wsServer.clients) {
      client.close(1001, "Hub shutting down");
    }
    for (const client of this.audioWsServer.clients) {
      client.close(1001, "Hub shutting down");
    }
    await new Promise<void>((resolve, reject) => {
      this.wsServer.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      this.audioWsServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private prunePendingConnections(): void {
    const expiresBefore = Date.now() - this.deps.resources.limits.negotiationTtlMs;
    for (const [token, pending] of this.pendingConnections) {
      if (pending.createdAt < expiresBefore) {
        this.pendingConnections.delete(token);
      }
    }
  }

  private handleAudioArtifact(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    artifact: { filename: string },
  ): void {
    if (!this.deps.config.enabled) {
      writeJson(response, 404, { error: "Voxta facade is disabled" });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      writeJson(response, 405, { error: "Voxta audio artifacts require GET or HEAD" });
      return;
    }
    if (this.runtime.audioOwners.get(artifact.filename) !== this.principals.get(request)?.id) {
      writeJson(response, 404, { error: "Voxta audio artifact not found" });
      return;
    }
    const filePath = path.join(voxtaAudioArtifactsRoot(this.deps.artifactsRoot), artifact.filename);
    let bytes: Buffer;
    try {
      bytes = readPrivateArtifact(this.deps.artifactsRoot, filePath, this.deps.resources.limits.maxAudioBytes + 44);
    } catch {
      writeJson(response, 404, { error: "Voxta audio artifact not found" });
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "audio/x-wav");
    response.setHeader("Content-Length", String(bytes.length));
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(bytes);
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
    const body = await readJsonBody(request, this.deps.resources);
    if (!isRecord(body) || typeof body.enabled !== "boolean") {
      writeJson(response, 400, { error: "Voxta service update body must be { enabled: boolean }" });
      return;
    }
    const principal = this.principals.get(request)!;
    let connection = this.runtime.connectionsByConfigurationId.get(toggle.configurationId);
    if (!connection && this.runtime.connections.size === 1) {
      const soleConnection = [...this.runtime.connections][0];
      if (soleConnection?.ownedBy(principal)) {
        connection = soleConnection;
        connection.adoptConfigurationId(toggle.configurationId);
      }
    }
    if (!connection || !connection.ownedBy(principal)) {
      writeJson(response, 404, { error: "Voxta configuration not found" });
      return;
    }
    let state = this.runtime.serviceStates.get(toggle.configurationId);
    if (!state) {
      state = connection?.currentServiceState() ?? defaultServiceState();
      this.runtime.serviceStates.set(toggle.configurationId, state);
    }
    state[toggle.serviceType] = body.enabled;
    writeJson(response, 200, {
      configurationId: toggle.configurationId,
      serviceType: toggle.serviceType,
      enabled: body.enabled,
    });
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
    if (!connection || !connection.ownedBy(this.principals.get(request)!)) {
      writeJson(response, 404, { error: `Unknown Voxta session: ${sessionId}` });
      return;
    }
    const principal = this.principals.get(request)!;
    if (principal.device && !principal.device.maxCapabilities.input.includes("vision_upload")) {
      writeJson(response, 403, { error: "Voxta vision capability required" });
      return;
    }
    const pending = this.runtime.pendingVisionRequests.get(visionRequest.requestId);
    if (pending && pending.sessionId !== sessionId) {
      writeJson(response, 404, { error: "Voxta vision request not found" });
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
    const upload = await readMultipartUpload(request, this.deps.resources);
    const capture = await persistVisionCapture({
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
  private readonly flow: HubSocketFlow;
  private readonly assistant: VoxtaParticipant;
  private readonly user: VoxtaParticipant;
  private readonly actionAllowlist: Set<string>;
  private servicesConfigurationsSetId: string = crypto.randomUUID();
  private attachmentOwnership: SatelliteAttachmentOwnership | null = null;
  private released = false;
  private sessionId: string;
  private chatId: string;
  private registeredSessionId: string | null = null;
  private visionCaptures: VisionCaptureImage[] = [];
  private readonly voxtaContexts = new Map<string, string[]>();
  private replyAbort = false;
  private replySequence = 0;
  private replyTask: Promise<void> | null = null;
  private replyAbortController: AbortController | null = null;
  private keepAlive: NodeJS.Timeout | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: VoxtaFacadeDependencies,
    private readonly runtime: VoxtaFacadeRuntime,
    _connectionId: string,
    private readonly publicBaseUrl: string,
    private readonly principal: HubPrincipal,
    session: { sessionId: string; chatId: string },
    admission: HubSocketAdmission,
  ) {
    this.flow = new HubSocketFlow(socket, deps.resources.limits, true, () => this.release(), admission.release);
    // Only the authenticated transport may choose its conversation. Client or
    // environment session hints cannot join another connection's history.
    this.sessionId = session.sessionId;
    this.chatId = session.chatId;
    this.assistant = {
      id: stableVoxtaGuid("assistant", deps.config.assistantId),
      name: deps.config.assistantName,
      role: "Assistant",
    };
    this.user = {
      id: stableVoxtaGuid("user", deps.config.userId),
      name: deps.config.userName,
      role: "User",
    };
    this.actionAllowlist = new Set(deps.config.actionAllowlist);
    this.runtime.serviceStates.set(this.servicesConfigurationsSetId, defaultServiceState());
    this.runtime.connectionsByConfigurationId.set(this.servicesConfigurationsSetId, this);
    this.runtime.connections.add(this);
    this.attachSatellite();
    this.registerSession();
  }

  ownedBy(principal: HubPrincipal): boolean {
    return this.principal.id === principal.id;
  }

  run(): void {
    this.keepAlive = setInterval(() => {
      void this.sendFrame({ type: 6 }).catch(() => this.flow.fail(1011, "Hub output failed"));
    }, SIGNALR_KEEPALIVE_INTERVAL_MS);
    this.socket.on("message", (raw, isBinary) => this.flow.enqueue(raw, async () => {
      let frames: unknown[];
      try {
        if (isBinary) throw new Error("Invalid SignalR frame");
        frames = decodeSignalRFrames(raw);
        if (frames.some(frame => !isValidSignalRFrame(frame))) throw new Error("Invalid SignalR frame");
      } catch {
        this.flow.fail(1008, "Invalid SignalR frame");
        return;
      }
      if (frames.length > this.deps.resources.limits.maxQueuedMessages) {
        this.flow.fail(1008, "SignalR batch exceeds queue limit"); return;
      }
      for (const frame of frames) {
        await this.handleFrame(frame);
      }
    }));
    this.socket.on("close", () => this.release());
  }

  private release(): void {
      if (this.released) return;
      this.released = true;
      if (this.keepAlive) {
        clearInterval(this.keepAlive);
        this.keepAlive = null;
      }
      this.cancelReply();
      for (const [configurationId, connection] of this.runtime.connectionsByConfigurationId) {
        if (connection === this) {
          this.runtime.connectionsByConfigurationId.delete(configurationId);
          this.runtime.serviceStates.delete(configurationId);
        }
      }
      this.runtime.connections.delete(this);
      if (this.registeredSessionId && this.runtime.connectionsBySessionId.get(this.registeredSessionId) === this) {
        this.runtime.connectionsBySessionId.delete(this.registeredSessionId);
        this.registeredSessionId = null;
      }
      if (this.attachmentOwnership) {
        this.deps.embodiedSessions.detachSatellite(this.sessionId,
          this.principal.device?.satelliteId ?? this.deps.config.satelliteId, this.attachmentOwnership);
        this.attachmentOwnership = null;
      }
  }

  private async handleFrame(frame: unknown): Promise<void> {
    try {
      this.deps.access.assertCurrent(this.principal);
    } catch {
      this.cancelReply();
      this.socket.close(1008, "Hub device authority changed");
      return;
    }
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
    if ((clientPayload.sessionId && clientPayload.sessionId !== this.sessionId)
      || (clientPayload.chatId && clientPayload.chatId !== this.chatId)) {
      await this.sendCompletion(invocation.invocationId, "Voxta session does not belong to this connection");
      return;
    }
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

  adoptConfigurationId(configurationId: string): void {
    const nextId = normalizedString(configurationId);
    if (!nextId || nextId === this.servicesConfigurationsSetId) {
      return;
    }
    const state = this.currentServiceState();
    for (const [id, connection] of this.runtime.connectionsByConfigurationId) {
      if (connection === this) {
        this.runtime.connectionsByConfigurationId.delete(id);
        this.runtime.serviceStates.delete(id);
      }
    }
    this.servicesConfigurationsSetId = nextId;
    this.runtime.serviceStates.set(this.servicesConfigurationsSetId, state);
    this.runtime.connectionsByConfigurationId.set(this.servicesConfigurationsSetId, this);
  }

  async emitRecordingRequest(enabled: boolean, signal?: AbortSignal): Promise<void> {
    await this.sendReceive({
      $type: "recordingRequest",
      sessionId: this.sessionId,
      enabled,
    }, signal);
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
    this.applyRequestedCharacterId(payload);
    this.attachSatellite();
    this.registerSession();
    await this.emitChatStarted(payload.characterId);
    await this.sendCompletion(invocationId);
  }

  private async handleResumeChat(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    this.applyRequestedCharacterId(payload);
    this.attachSatellite();
    this.registerSession();
    await this.emitChatStarted(payload.characterId);
    await this.sendCompletion(invocationId);
  }

  private applyRequestedCharacterId(payload: VoxtaClientPayload): void {
    const requestedCharacterId = firstGuid(payload.characterId, payload.characterIds);
    if (requestedCharacterId) {
      this.assistant.id = requestedCharacterId;
    }
  }

  private async handleSend(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    if (this.principal.device && !this.principal.device.maxCapabilities.input.includes("text")) {
      await this.sendCompletion(invocationId, "Voxta text capability required");
      return;
    }
    const rawText = normalizedString(payload.text);
    if (!rawText) {
      await this.sendCompletion(invocationId, "Voxta send text is empty");
      return;
    }
    const input = normalizeVoxtaSendText(rawText);
    this.attachSatellite();
    this.registerSession();

    const previousReply = this.replyTask;
    if (previousReply) {
      this.cancelReply();
      // SAFETY: SignalR frames stay serialized, but the long model request is
      // observed outside that queue. Await only its cancellation settlement so
      // the replacement user turn cannot enter the prior reply's history.
      await previousReply.catch(() => undefined);
    }
    if (!shouldReplyToVoxtaSend(input, payload.doReply)) {
      this.deps.sessions.append(this.sessionId, { role: "user", content: input.promptText });
      await this.sendReceive({
        $type: "chatFlow",
        state: "WaitingForUser",
        sessionId: this.sessionId,
      });
      await this.sendCompletion(invocationId);
      return;
    }
    const replyTask = this.streamAssistantReply(input.promptText);
    this.replyTask = replyTask;
    void this.observeReplyTask(replyTask, invocationId).catch((error) => {
      console.error("Voxta reply observer failed:", error);
    });
  }

  private async handleInterrupt(invocationId: string | undefined, _payload: VoxtaClientPayload): Promise<void> {
    const hadActiveReply = this.cancelReply();
    await this.sendReceive({
      $type: "interruptSpeech",
      sessionId: this.sessionId,
    });
    if (!hadActiveReply) {
      await this.sendReceive({
        $type: "replyCancelled",
        sessionId: this.sessionId,
        messageId: crypto.randomUUID(),
      });
    }
    await this.sendCompletion(invocationId);
  }

  private async observeReplyTask(task: Promise<void>, invocationId: string | undefined): Promise<void> {
    try {
      await task;
      await this.sendCompletion(invocationId);
    } catch (error) {
      console.error("Voxta message handling failed:", error);
      await this.sendReceive({
        $type: "error",
        message: "Voxta reply failed",
      });
    } finally {
      if (this.replyTask === task) {
        this.replyTask = null;
      }
    }
  }

  private async handleUpdateContext(invocationId: string | undefined, payload: VoxtaClientPayload): Promise<void> {
    const contextKey = normalizedString(payload.contextKey) ?? "voxta-context";
    const contextTexts = extractVoxtaContextTexts(payload.contexts ?? payload.text ?? payload.value);
    if (contextTexts.length > 0) {
      this.voxtaContexts.set(contextKey, contextTexts);
      this.pruneVoxtaContexts();
    } else {
      this.voxtaContexts.delete(contextKey);
    }
    await this.sendReceive({
      $type: "contextUpdated",
      sessionId: this.sessionId,
      contextKey,
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
      sessionId: this.sessionId,
    });
    await this.sendCompletion(invocationId);
  }

  private async streamAssistantReply(userText: string): Promise<void> {
    const replyId = ++this.replySequence;
    this.replyAbort = false;
    const replyAbortController = new AbortController();
    this.replyAbortController = replyAbortController;
    const messageId = crypto.randomUUID();
    try {
      await this.streamAssistantReplyInner(userText, replyId, messageId, replyAbortController);
    } catch (error) {
      if (this.replyAbort || replyId !== this.replySequence || replyAbortController.signal.aborted) {
        // Client disconnected or interrupted; the in-flight request and any
        // bounded fallback attempt were cancelled. Report a normal cancel.
        await this.sendReceive({
          $type: "replyCancelled",
          sessionId: this.sessionId,
          messageId,
        });
        return;
      }
      throw error;
    } finally {
      if (this.replyAbortController === replyAbortController) {
        this.replyAbortController = null;
      }
    }
  }

  private async streamAssistantReplyInner(
    userText: string,
    replyId: number,
    messageId: string,
    replyAbortController: AbortController,
  ): Promise<void> {
    let responseText = "";
    const replyBytes = new Utf8ByteBudget(this.deps.resources.limits.maxQueuedBytes);
    await this.deps.resources.runProviderStream(async signal => {
      this.deps.sessions.append(this.sessionId, { role: "user", content: userText });
      await this.requestVisionCapturesIfNeeded(signal);
      this.assertReplyActive(replyId, replyAbortController);

      await this.sendReceive({
        $type: "chatFlow",
        state: "Thinking",
        sessionId: this.sessionId,
      }, signal);
      this.assertReplyActive(replyId, replyAbortController);
      await this.sendReceive({
        $type: "replyGenerating",
        sessionId: this.sessionId,
        messageId,
        senderId: this.assistant.id,
        role: this.assistant.role,
        thinkingSpeechUrl: "",
        isNarration: false,
      }, signal);
      this.assertReplyActive(replyId, replyAbortController);
      await this.sendReceive({
        $type: "replyStart",
        sessionId: this.sessionId,
        messageId,
        senderId: this.assistant.id,
        senderName: this.assistant.name,
        role: this.assistant.role,
        timestamp: new Date().toISOString(),
      }, signal);
      this.assertReplyActive(replyId, replyAbortController);

      throwIfAborted(signal);
      return this.deps.agent.streamReply({
        inputMode: "voice",
        userText,
        conversationId: this.sessionId,
        history: this.deps.sessions.getHistory(this.sessionId) as ConversationMessage[],
        channel: this.agentChannelContext(),
        signal,
      });
    }, (delta, signal) => {
      throwIfAborted(signal);
      this.assertReplyActive(replyId, replyAbortController);
      try { replyBytes.append(delta); }
      catch {
        replyAbortController.abort(new Error("Hub retained reply exceeds byte limit"));
        throw new Error("Hub retained reply exceeds byte limit");
      }
      responseText += delta;
    }, replyAbortController.signal);

    this.assertReplyActive(replyId, replyAbortController);
    responseText = responseText.trim();
    const audioUrl = await this.createSpeechArtifact(
      messageId,
      responseText,
      replyAbortController.signal,
    );
    this.assertReplyActive(replyId, replyAbortController);
    const wireResponseText = sanitizeVoxtaWireText(responseText);
    this.assertReplyActive(replyId, replyAbortController);
    await this.sendReceive({
      $type: "replyChunk",
      sessionId: this.sessionId,
      messageId,
      senderId: this.assistant.id,
      role: this.assistant.role,
      text: wireResponseText,
      audioUrl,
      startIndex: 0,
      endIndex: wireResponseText.length,
      isNarration: false,
      audioGapMs: 0,
      timestamp: new Date().toISOString(),
    }, replyAbortController.signal);
    this.assertReplyActive(replyId, replyAbortController);
    this.deps.sessions.append(this.sessionId, { role: "assistant", content: responseText });
    await this.sendReceive({
      $type: "replyEnd",
      sessionId: this.sessionId,
      messageId,
      senderId: this.assistant.id,
    }, replyAbortController.signal);
    this.assertReplyActive(replyId, replyAbortController);
    await this.sendReceive({
      $type: "chatFlow",
      state: "WaitingForUser",
      sessionId: this.sessionId,
    }, replyAbortController.signal);
    this.assertReplyActive(replyId, replyAbortController);
    if (this.deps.config.sttStreamEnabled && this.currentServiceState().SpeechToText) {
      await this.emitRecordingRequest(true, replyAbortController.signal);
      this.assertReplyActive(replyId, replyAbortController);
    }
  }

  private async createSpeechArtifact(
    messageId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    const serviceState = this.runtime.serviceStates.get(this.servicesConfigurationsSetId);
    if (!this.deps.tts || serviceState?.TextToSpeech === false) {
      return "silence:0";
    }
    const spokenText = sanitizeSpokenText(text);
    if (!spokenText) {
      return "silence:0";
    }
    try {
      const wav = await this.deps.resources.runProvider(providerSignal => this.deps.tts!.synthesizeWav(spokenText, providerSignal), signal);
      throwIfAborted(signal);
      if (wav.length > this.deps.resources.limits.maxAudioBytes) throw new Error("Hub TTS audio exceeds byte limit");
      if (wav.length === 0) {
        return "silence:0";
      }
      const filename = `voxta_${safePathPart(this.sessionId)}_${safePathPart(messageId)}_0.wav`;
      this.runtime.audioOwners.set(filename, this.principal.id);
      if (this.runtime.audioOwners.size > this.deps.resources.limits.maxSessions) {
        this.runtime.audioOwners.delete(this.runtime.audioOwners.keys().next().value!);
      }
      const audioFolder = this.deps.config.audioFolder;
      if (!audioFolder) {
        const directory = voxtaAudioArtifactsRoot(this.deps.artifactsRoot);
        const filePath = path.join(directory, filename);
        writePrivateArtifact(this.deps.artifactsRoot, filePath, wav);
        return `${this.publicBaseUrl}/api/voxta/audio/${encodeURIComponent(filename)}`;
      }
      const filePath = path.join(audioFolder, filename);
      writePrivateArtifact(audioFolder, filePath, wav);
      return filePath;
    } catch (error) {
      if (signal.aborted) {
        throw abortReason(signal);
      }
      console.error("Voxta TTS artifact generation failed:", error);
      throw new Error("Voxta speech unavailable");
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

  private async requestVisionCapturesIfNeeded(signal: AbortSignal): Promise<void> {
    if (!this.currentServiceState().ComputerVision) {
      return;
    }
    const sources: VoxtaVisionSource[] = ["Screen", "Eyes"];
    const captures = await Promise.all(sources.map((source) => this.requestVisionCapture(source, signal)));
    for (const capture of captures) {
      if (capture) {
        this.recordVisionCapture(capture);
      }
    }
  }

  private async requestVisionCapture(source: VoxtaVisionSource, signal: AbortSignal): Promise<VisionCaptureImage | null> {
    throwIfAborted(signal);
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
    try {
      await this.sendReceive({
        $type: "visionCaptureRequest",
        sessionId: this.sessionId,
        visionCaptureRequestId: requestId,
        source,
      }, signal);
      return await awaitWithAbort(promise, signal);
    } catch (error) {
      const pending = this.runtime.pendingVisionRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.runtime.pendingVisionRequests.delete(requestId);
        pending.resolve(null);
      }
      throw error;
    }
  }

  private async sendReceive(payload: VoxtaServerPayload, signal?: AbortSignal): Promise<void> {
    await this.sendFrame({
      type: 1,
      target: "ReceiveMessage",
      arguments: [payload],
    }, signal);
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

  private async sendFrame(payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    if (signal) {
      throwIfAborted(signal);
    }
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const wirePayload = sanitizeVoxtaWireValue(payload) as Record<string, unknown>;
    const sendOperation = this.flow.send(`${JSON.stringify(wirePayload)}${SIGNALR_RECORD_SEPARATOR}`);
    // SAFETY: reply cancellation releases only the logical waiter. The shared
    // authenticated socket stays open, and awaitWithAbort keeps observing a
    // callback that settles after detachment so it cannot reject unhandled.
    if (signal) {
      await awaitWithAbort(sendOperation, signal);
      return;
    }
    await sendOperation;
  }

  private attachSatellite(): void {
    const device = this.principal.device;
    const attachment = this.deps.embodiedSessions.attachSatellite({
      sessionId: this.sessionId,
      satelliteId: device?.satelliteId ?? this.deps.config.satelliteId,
      satelliteName: device?.satelliteName ?? this.deps.config.satelliteName,
      capabilities: device?.maxCapabilities ?? VOXTA_VAM_CAPABILITIES,
      ...(device ? {
        claimIdentity: { satelliteId: device.satelliteId, endpointId: device.endpointId,
          claimType: device.claimType, displayName: device.satelliteName },
        deviceAuthority: device,
      } : {}),
    });
    this.attachmentOwnership = attachment.ownership;
  }

  private agentChannelContext(): PsfnChannelContext {
    this.deps.access.assertCurrent(this.principal);
    const context = this.deps.embodiedSessions.getContext(this.sessionId, this.principal.device?.satelliteId ?? this.deps.config.satelliteId);
    return {
      ...context,
      visionCaptures: this.visionCaptures.slice(-4).map(stripVisionCaptureImageData),
      visionCaptureImages: this.visionCaptures.slice(-4),
      contextNotes: this.contextNotes(),
    };
  }

  private contextNotes(): NonNullable<PsfnChannelContext["contextNotes"]> {
    return [...this.voxtaContexts.entries()]
      .flatMap(([key, values]) => values.map((text) => ({ key, text })))
      .filter((note) => note.key.trim().length > 0 && note.text.trim().length > 0)
      .slice(-12);
  }

  private pruneVoxtaContexts(): void {
    const entries = [...this.voxtaContexts.entries()].slice(-16);
    if (entries.length === this.voxtaContexts.size) {
      return;
    }
    this.voxtaContexts.clear();
    for (const [key, value] of entries) {
      this.voxtaContexts.set(key, value);
    }
  }

  private cancelReply(): boolean {
    const hadActiveReply = this.replyAbortController !== null;
    this.replyAbort = true;
    this.replySequence += 1;
    this.replyAbortController?.abort(new DOMException("voxta reply cancelled", "AbortError"));
    return hadActiveReply;
  }

  private assertReplyActive(replyId: number, controller: AbortController): void {
    if (this.replyAbort || replyId !== this.replySequence) {
      throw controller.signal.reason ?? new DOMException("voxta reply cancelled", "AbortError");
    }
    throwIfAborted(controller.signal);
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

  currentServiceState(): VoxtaServiceState {
    const state = this.runtime.serviceStates.get(this.servicesConfigurationsSetId);
    if (state) {
      return state;
    }
    const fallback = defaultServiceState();
    this.runtime.serviceStates.set(this.servicesConfigurationsSetId, fallback);
    return fallback;
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
  private readonly flow: HubSocketFlow;
  private bytes = 0;
  private audioTimer: NodeJS.Timeout | undefined;
  private spec: VoxtaAudioInputSpec | null = null;
  private audio: Buffer | null = null;
  private started = false;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: VoxtaFacadeRuntime,
    private readonly stt: VoxtaSttAdapter | undefined,
    private readonly sessionId: string,
    private readonly principal: HubPrincipal,
    private readonly access: HubAccess,
    private readonly resources: HubResources,
    private readonly admission: HubSocketAdmission,
  ) {
    this.flow = new HubSocketFlow(socket, resources.limits, true, rejected => {
      if (rejected) { this.closed = true; this.audio = null; clearTimeout(this.audioTimer); this.runtime.audioInputs.delete(this); }
    });
    runtime.audioInputs.add(this);
  }

  abort(): void { this.closed = true; this.audio = null; clearTimeout(this.audioTimer); this.flow.fail(1001, "Hub shutting down"); this.runtime.audioInputs.delete(this); }

  run(): void {
    this.socket.once("close", code => {
      if (code !== 1000 && code !== 1005) { this.closed = true; this.audio = null; clearTimeout(this.audioTimer); }
      void this.finish().catch((error) => {
        console.error("Voxta audio input finalization failed:", error);
      }).finally(() => { this.admission.release(); this.runtime.audioInputs.delete(this); });
    });
    if (!normalizeGuid(this.sessionId) || !this.runtime.connectionsBySessionId.has(this.sessionId)) {
      this.flow.fail(1008, "Unknown Voxta audio input session");
      return;
    }
    this.socket.on("message", (raw, isBinary) => {
      this.flow.touch();
      try { this.handleMessage(raw, isBinary); } catch {
        this.closed = true;
        this.audio = null;
        clearTimeout(this.audioTimer);
        this.flow.fail(1008, "Invalid Voxta audio input");
      }
    });
  }

  private handleMessage(raw: RawData, isBinary: boolean): void {
    this.access.assertCurrent(this.principal);
    if (!this.spec) {
      if (isBinary) {
        throw new Error("Voxta audio input stream must start with a JSON stream spec");
      }
      this.spec = parseAudioInputSpec(decodeRawData(raw));
      this.audio = Buffer.allocUnsafe(Math.min(this.resources.limits.maxAudioBytes,
        Math.floor(this.resources.limits.maxAudioDurationMs * 32)));
      this.audioTimer = setTimeout(() => {
        this.closed = true; this.audio = null; this.flow.fail(1008, "Voxta audio duration exceeded");
      }, this.resources.limits.maxAudioDurationMs);
      return;
    }
    if (!isBinary || this.closed) throw new Error("Audio chunks must be binary");
    const chunk = rawDataToBuffer(raw);
    if (chunk.length === 0) {
      return;
    }
    const maxDurationBytes = Math.floor(this.spec.sampleRate * this.spec.channels * (this.spec.bitsPerSample / 8)
      * this.resources.limits.maxAudioDurationMs / 1000);
    if (chunk.length % (this.spec.channels * (this.spec.bitsPerSample / 8)) !== 0
      || this.bytes + chunk.length > Math.min(this.resources.limits.maxAudioBytes, maxDurationBytes)) {
      throw new Error("Voxta audio aggregate exceeded");
    }
    chunk.copy(this.audio!, this.bytes); this.bytes += chunk.length;
    if (!this.started) {
      this.started = true;
    }
  }

  private async finish(): Promise<void> {
    clearTimeout(this.audioTimer);
    if (this.closed) {
      return;
    }
    this.closed = true;
    const connection = this.connection();
    if (!connection || !this.started || !this.spec) {
      return;
    }
    const pcm = this.audio?.subarray(0, this.bytes) ?? Buffer.alloc(0);
    this.audio = null;
    if (pcm.length === 0) {
      await connection.emitSpeechRecognitionEnd("");
      return;
    }
    if (!this.stt) {
      await connection.emitSpeechRecognitionPartial("");
      await connection.emitSpeechRecognitionEnd("");
      return;
    }
    await connection.emitSpeechRecognitionStart();
    const spec = this.spec;
    const result = await this.resources.runProvider(signal => this.stt!.transcribePcm({
      sessionId: this.sessionId,
      spec,
      pcm,
      signal,
    }));
    const text = result.text.trim();
    if (text) {
      await connection.emitSpeechRecognitionPartial(text);
    }
    await connection.emitSpeechRecognitionEnd(text);
  }

  private connection(): VoxtaConnection | undefined {
    this.access.assertCurrent(this.principal);
    const connection = this.runtime.connectionsBySessionId.get(this.sessionId);
    return connection?.ownedBy(this.principal) ? connection : undefined;
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
    parseAudioArtifactPath(pathname) !== null ||
    parseServiceTogglePath(pathname) !== null ||
    parseVisionRequestPath(pathname) !== null
  );
}

function isVoxtaPath(pathname: string): boolean {
  return isHubPath(pathname) || isNegotiatePath(pathname) || isAudioInputStreamPath(pathname)
    || pathname.startsWith("/api/voxta/") || pathname.startsWith("/api/vision/")
    || pathname.startsWith("/api/configurations/");
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

function parseAudioArtifactPath(pathname: string): { filename: string } | null {
  const match = /^\/api\/voxta\/audio\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }
  const filename = decodeURIComponent(match[1] || "");
  if (!/^[a-z0-9_.-]+\.wav$/i.test(filename)) {
    return null;
  }
  return { filename };
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

async function readMultipartUpload(request: http.IncomingMessage, resources: HubResources): Promise<MultipartUpload> {
  const contentType = String(request.headers["content-type"] || "");
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1]?.trim();
  if (!/^multipart\/form-data\s*;/iu.test(contentType) || !boundary || boundary.length > 70) {
    throw new HubRequestError(400, "Voxta vision upload requires a valid multipart boundary");
  }
  const body = await readHubBody(request, resources.limits.maxVisionBodyBytes, resources.limits.httpBodyTimeoutMs);
  const part = extractMultipartFile(body, boundary.replace(/^"|"$/g, ""), "file");
  if (!part || !extensionForMimeType(part.mimeType)) {
    throw new HubRequestError(400, "Voxta vision upload requires one JPEG or PNG file");
  }
  if (part.data.length > resources.limits.maxVisionFileBytes) throw new HubRequestError(413, "Voxta vision file exceeds byte limit");
  return part;
}

function extractMultipartFile(body: Buffer, boundary: string, fieldName: string): MultipartUpload | null {
  const delimiter = Buffer.from(`--${boundary}`);
  const ending = Buffer.from(`--${boundary}--`);
  const tail = body.subarray(body.length - ending.length - 2);
  if (!body.subarray(0, delimiter.length + 2).equals(Buffer.from(`--${boundary}\r\n`))
    || (!body.subarray(body.length - ending.length).equals(ending) && !tail.equals(Buffer.concat([ending, Buffer.from("\r\n")])))) return null;
  let offset = 0;
  let file: MultipartUpload | null = null;
  while (offset < body.length) {
    const partStart = body.indexOf(delimiter, offset);
    if (partStart === -1) {
      return null;
    }
    const headersStart = partStart + delimiter.length;
    if (body.subarray(headersStart, headersStart + 2).toString("ascii") === "--") {
      return file;
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
      if (file) return null;
      const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] || "upload.jpg";
      const mimeType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || "application/octet-stream";
      file = {
        data: body.subarray(partBodyStart + 4, partBodyEnd),
        filename,
        mimeType,
      };
    }
    offset = nextPart;
  }
  return file;
}

async function persistVisionCapture(input: {
  root: string;
  requestId: string;
  sessionId: string;
  source: VoxtaVisionSource;
  label: string;
  upload: MultipartUpload;
}): Promise<VisionCaptureImage> {
  const capturedAt = new Date();
  const dateKey = capturedAt.toISOString().slice(0, 10).replaceAll("-", "");
  const directory = path.join(input.root, "voxta-vision", dateKey);
  const extension = extensionForMimeType(input.upload.mimeType) ?? ".bin";
  const filePath = path.join(
    directory,
    `voxta_${safePathPart(input.sessionId)}_${safePathPart(input.requestId)}_${input.source}${extension}`,
  );
  writePrivateArtifact(input.root, filePath, input.upload.data);
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

async function readJsonBody(request: http.IncomingMessage, resources: HubResources): Promise<unknown> {
  const raw = (await readHubBody(request, resources.limits.maxHttpBodyBytes, resources.limits.httpBodyTimeoutMs)).toString("utf8").trim();
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

function isValidSignalRFrame(frame: unknown): boolean {
  if (!isRecord(frame) || Array.isArray(frame)) return false;
  if (Object.hasOwn(frame, "protocol")) return frame.protocol === "json" && frame.version === 1;
  if (frame.type === 6) return true;
  return frame.type === 1 && typeof frame.target === "string" && Array.isArray(frame.arguments)
    && (frame.invocationId === undefined || typeof frame.invocationId === "string");
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
  if (spec.sampleRate !== 16000 || spec.channels !== 1 || spec.bitsPerSample !== 16
    || !Number.isSafeInteger(spec.bufferMilliseconds) || spec.bufferMilliseconds < 1
    || !["audio/wav", "audio/pcm", "audio/raw"].includes(spec.contentType)) {
    throw new Error("Voxta audio requires 16kHz mono PCM16");
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

function firstGuid(...values: unknown[]): string | undefined {
  for (const value of values) {
    const guid = normalizeGuid(value);
    if (guid) {
      return guid;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const itemGuid = normalizeGuid(item);
        if (itemGuid) {
          return itemGuid;
        }
      }
    }
  }
  return undefined;
}

function stableVoxtaGuid(kind: string, value: string): string {
  const guid = normalizeGuid(value);
  if (guid) {
    return guid;
  }
  const normalized = normalizedString(value) ?? kind;
  const bytes = crypto.createHash("sha256").update(`voxta:${kind}:${normalized}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type NormalizedVoxtaSend = {
  promptText: string;
  slashCommand?: string;
  slashShouldReply?: boolean;
};

function normalizeVoxtaSendText(input: string): NormalizedVoxtaSend {
  const text = normalizeVoxtaTemplateTokens(input);
  const slashCommand = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text);
  if (!slashCommand) {
    return { promptText: text };
  }

  const command = slashCommand[1]?.toLowerCase();
  const body = slashCommand[2]?.trim() ?? "";
  if (!body) {
    return { promptText: text };
  }

  return {
    promptText: body,
    slashCommand: command,
    slashShouldReply: command === "event" ? true : command === "secret" || command === "note" ? false : undefined,
  };
}

function shouldReplyToVoxtaSend(input: NormalizedVoxtaSend, payloadDoReply: unknown): boolean {
  if (typeof input.slashShouldReply === "boolean") {
    return input.slashShouldReply;
  }
  return normalizeVoxtaBoolean(payloadDoReply) ?? true;
}

function normalizeVoxtaBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const text = normalizedString(value);
  if (!text) {
    return undefined;
  }
  if (/^(true|1|yes|y)$/i.test(text)) {
    return true;
  }
  if (/^(false|0|no|n)$/i.test(text)) {
    return false;
  }
  return undefined;
}

function extractVoxtaContextTexts(value: unknown): string[] {
  const texts = collectVoxtaContextTexts(value)
    .map((text) => normalizeVoxtaTemplateTokens(text).trim())
    .filter(Boolean);
  return [...new Set(texts)].slice(-8);
}

function collectVoxtaContextTexts(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectVoxtaContextTexts(item));
  }
  if (!isRecord(value)) {
    return [];
  }
  return [
    value.text,
    value.content,
    value.value,
    value.description,
  ].flatMap((item) => collectVoxtaContextTexts(item));
}

function normalizeVoxtaTemplateTokens(input: string): string {
  return input.replaceAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, "{{$1}}");
}

function sanitizeVoxtaWireValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeVoxtaWireText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeVoxtaWireValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeVoxtaWireValue(item)]),
  );
}

function sanitizeVoxtaWireText(input: string): string {
  return input
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
    .replace(/[\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\u0000-\u00ff]/g, "?");
}

function defaultServiceState(): VoxtaServiceState {
  return {
    SpeechToText: true,
    TextToSpeech: true,
    ComputerVision: false,
    ActionInference: true,
  };
}

function voxtaAudioArtifactsRoot(artifactsRoot: string): string {
  return path.join(artifactsRoot, "voxta-audio");
}

function publicBaseUrlForRequest(configuredBaseUrl: string | null, request: http.IncomingMessage): string {
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }
  const host = normalizedString(request.headers.host) ?? "127.0.0.1";
  return `http://${host}`;
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
