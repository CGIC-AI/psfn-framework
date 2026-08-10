import type {
  ActionMessage,
  AudioOutMessage,
  ClientToHubMessage,
  HelloAckMessage,
  HelloMessage,
  HubToClientMessage,
  MessageEvent as HubMessageEvent,
  PongMessage,
  SatelliteCapabilities,
  SatelliteControlCapability,
  SatelliteInputCapability,
  SatelliteOutputCapability,
  SatelliteSafetyCapability,
  SessionReadyMessage,
  StatusMessage,
  TextMessage,
} from "../shared/protocol.js";
import type {
  DeviceControlCapability,
  DeviceInputCapability,
  DeviceOutputCapability,
  DeviceProfile,
} from "./model.js";

export type DeviceStudioTransportMode = "live" | "mock";

export type DeviceStudioConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "ready"
  | "closing"
  | "closed"
  | "error";

export type DeviceStudioEventSource = "live" | "mock" | "user" | "transport";

export type DeviceStudioEventDirection = "in" | "out" | "internal";

export interface DeviceStudioTransportLogEntry {
  id: number;
  at: string;
  source: DeviceStudioEventSource;
  direction: DeviceStudioEventDirection;
  kind: string;
  state: DeviceStudioConnectionState;
  profileId?: string;
  sessionId?: string;
  channelId?: string;
  messageType?: string;
  payload?: unknown;
  error?: string;
}

export interface DeviceStudioSessionState {
  sessionId?: string;
  channelId?: string;
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  satelliteName: string;
  audioFormat?: string;
  capabilities?: SatelliteCapabilities;
  assistantSpeaking: boolean;
  lastPingSentAt?: number;
  lastPongAt?: string;
  lastPingRttMs?: number;
}

export interface DeviceStudioTransportSnapshot {
  mode: DeviceStudioTransportMode;
  state: DeviceStudioConnectionState;
  ready: boolean;
  profileId?: string;
  hello: HelloMessage;
  session: DeviceStudioSessionState;
  log: readonly DeviceStudioTransportLogEntry[];
}

export interface DeviceStudioStateEvent {
  previous: DeviceStudioConnectionState;
  current: DeviceStudioConnectionState;
  log: DeviceStudioTransportLogEntry;
}

export interface DeviceStudioInboundEvent {
  message: HubToClientMessage;
  log: DeviceStudioTransportLogEntry;
}

export interface DeviceStudioOutboundEvent {
  message: ClientToHubMessage;
  log: DeviceStudioTransportLogEntry;
}

export interface DeviceStudioConversationEvent {
  role: HubMessageEvent["data"]["role"];
  content: string;
  live: boolean;
  final: boolean;
  message: HubMessageEvent;
  log: DeviceStudioTransportLogEntry;
}

export interface DeviceStudioAudioEvent {
  data: string;
  estimatedBytes: number;
  message: AudioOutMessage;
  log: DeviceStudioTransportLogEntry;
}

export interface DeviceStudioLifecycleEvent {
  name:
    | "session.ready"
    | "hello.ack"
    | "status"
    | "audio.start"
    | "audio.end"
    | "assistant.interrupted"
    | "action.interrupt"
    | "action.pause-audio"
    | "action.play-audio";
  message?: HubToClientMessage;
  log: DeviceStudioTransportLogEntry;
}

export interface DeviceStudioPongEvent {
  sentAt: number;
  receivedAt: string;
  rttMs?: number;
  message: PongMessage;
  log: DeviceStudioTransportLogEntry;
}

export interface DeviceStudioErrorEvent {
  message: string;
  recoverable: boolean;
  cause?: unknown;
  log: DeviceStudioTransportLogEntry;
}

export interface DeviceStudioTransportEventMap {
  state: DeviceStudioStateEvent;
  log: DeviceStudioTransportLogEntry;
  inbound: DeviceStudioInboundEvent;
  outbound: DeviceStudioOutboundEvent;
  message: DeviceStudioConversationEvent;
  audio: DeviceStudioAudioEvent;
  lifecycle: DeviceStudioLifecycleEvent;
  pong: DeviceStudioPongEvent;
  error: DeviceStudioErrorEvent;
}

export type DeviceStudioTransportUnsubscribe = () => void;

export interface DeviceStudioWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  on?: (type: string, listener: (...args: unknown[]) => void) => void;
  off?: (type: string, listener: (...args: unknown[]) => void) => void;
}

export type DeviceStudioWebSocketFactory = (
  url: string,
  protocols?: string | string[],
) => DeviceStudioWebSocketLike;

export interface DeviceStudioIdentityOptions {
  deviceId?: string;
  deviceName?: string;
  sessionId?: string;
  channelId?: string;
  satelliteId?: string;
  satelliteName?: string;
}

export interface DeviceStudioHelloOptions extends DeviceStudioIdentityOptions {
  profile?: DeviceProfile;
  capabilities?: SatelliteCapabilities;
}

export interface DeviceStudioMockOptions {
  stepDelayMs?: number;
  assistantText?: string;
  assistantLiveDeltas?: string[];
}

export interface DeviceStudioHubClientOptions extends DeviceStudioHelloOptions {
  mode: DeviceStudioTransportMode;
  url?: string;
  webSocketFactory?: DeviceStudioWebSocketFactory;
  clock?: () => Date;
  nowMs?: () => number;
  autoHello?: boolean;
  maxLogEntries?: number;
  mock?: DeviceStudioMockOptions;
}

export interface ParsedHubMessage {
  ok: true;
  message: HubToClientMessage;
}

export interface HubMessageParseError {
  ok: false;
  error: string;
  payload?: unknown;
}

type Listener = (event: DeviceStudioTransportEventMap[keyof DeviceStudioTransportEventMap]) => void;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const DEFAULT_MAX_LOG_ENTRIES = 250;
const DEFAULT_MOCK_STEP_DELAY_MS = 0;
const DEFAULT_MOCK_AUDIO_FORMAT = "mock_text_in/mock_audio_out";

export class DeviceStudioHubClient {
  private readonly listeners = new Map<keyof DeviceStudioTransportEventMap, Set<Listener>>();
  private readonly logEntries: DeviceStudioTransportLogEntry[] = [];
  private readonly clock: () => Date;
  private readonly nowMs: () => number;
  private readonly maxLogEntries: number;
  private readonly autoHello: boolean;
  private readonly mock: Required<DeviceStudioMockOptions>;
  private readonly hello: HelloMessage;
  private socket: DeviceStudioWebSocketLike | null = null;
  private state: DeviceStudioConnectionState = "idle";
  private logSequence = 0;
  private ready = false;
  private closingRequested = false;
  private readonly mockTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly session: DeviceStudioSessionState;

  constructor(private readonly options: DeviceStudioHubClientOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.maxLogEntries = options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
    this.autoHello = options.autoHello ?? true;
    this.mock = {
      stepDelayMs: options.mock?.stepDelayMs ?? DEFAULT_MOCK_STEP_DELAY_MS,
      assistantText: options.mock?.assistantText ?? "Mock assistant response from Device Studio.",
      assistantLiveDeltas: options.mock?.assistantLiveDeltas ?? [],
    };
    this.hello = buildDeviceStudioHelloPayload(options);
    this.session = {
      deviceId: this.hello.deviceId,
      deviceName: this.hello.deviceName,
      satelliteId: this.hello.satelliteId ?? this.hello.deviceId,
      satelliteName: this.hello.satelliteName ?? this.hello.deviceName,
      sessionId: this.hello.sessionId,
      channelId: this.hello.channelId,
      capabilities: this.hello.capabilities,
      assistantSpeaking: false,
    };
  }

  on<K extends keyof DeviceStudioTransportEventMap>(
    type: K,
    listener: (event: DeviceStudioTransportEventMap[K]) => void,
  ): DeviceStudioTransportUnsubscribe {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set<Listener>();
      this.listeners.set(type, listeners);
    }
    const wrapped = listener as Listener;
    listeners.add(wrapped);
    return () => {
      listeners?.delete(wrapped);
    };
  }

  snapshot(): DeviceStudioTransportSnapshot {
    return {
      mode: this.options.mode,
      state: this.state,
      ready: this.ready,
      profileId: this.options.profile?.id,
      hello: { ...this.hello, capabilities: cloneCapabilities(this.hello.capabilities) },
      session: {
        ...this.session,
        capabilities: cloneCapabilities(this.session.capabilities),
      },
      log: [...this.logEntries],
    };
  }

  getLog(): readonly DeviceStudioTransportLogEntry[] {
    return this.logEntries;
  }

  async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "connected" || this.state === "ready") {
      return;
    }
    this.closingRequested = false;
    if (this.options.mode === "mock") {
      this.connectMock();
      return;
    }
    await this.connectLive();
  }

  disconnect(): void {
    this.closingRequested = true;
    this.clearMockTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== SOCKET_CLOSED && socket.readyState !== SOCKET_CLOSING) {
      this.setState("closing", "transport.disconnect", "transport");
      socket.close(1000, "Device Studio disconnect");
    }
    this.ready = false;
    this.session.assistantSpeaking = false;
    this.setState("closed", "transport.closed", "transport");
  }

  waitUntilReady(timeoutMs = 5000): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = this.on("state", (event) => {
        if (event.current === "ready") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Device Studio hub client did not become ready in time"));
      }, timeoutMs);
    });
  }

  sendUserText(text: string, options: { interrupt?: boolean } = {}): void {
    const normalized = text.trim();
    if (!normalized) {
      throw this.emitLocalError("Typed user text is empty", true);
    }
    this.send({
      type: "user.text",
      text: normalized,
      interrupt: options.interrupt ?? true,
    }, "user");
  }

  startTurn(options: { interrupt?: boolean } = {}): void {
    this.send({
      type: "turn.start",
      interrupt: options.interrupt,
    }, "user");
  }

  endTurn(reason = "manual"): void {
    this.send({
      type: "turn.end",
      reason,
    }, "user");
  }

  interrupt(): void {
    this.send({ type: "interrupt" }, "user");
  }

  ping(sentAt = this.nowMs()): void {
    this.session.lastPingSentAt = sentAt;
    this.send({ type: "ping", sentAt }, "user");
  }

  sendTextSignal(data: string): void {
    this.send({ type: "text", data }, "user");
  }

  private connectMock(): void {
    this.setState("connecting", "transport.connecting", "transport");
    this.setState("connected", "transport.connected", "mock");
    if (this.autoHello) {
      this.emitOutbound(this.hello, "transport");
    }
    this.consumeHubMessage(createMockSessionReady(this.hello), "mock");
    this.consumeHubMessage(createMockHelloAck(this.hello), "mock");
    this.consumeHubMessage({ type: "status", data: "call_initialized" }, "mock");
  }

  private connectLive(): Promise<void> {
    const url = this.options.url?.trim();
    if (!url) {
      throw this.emitLocalError("Live Device Studio transport requires a websocket URL", false);
    }

    this.setState("connecting", "transport.connecting", "transport");

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleReject = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const socket = this.createSocket(url);
      this.socket = socket;
      this.attachSocketListener(socket, "open", () => {
        this.setState("connected", "transport.connected", "live");
        if (this.autoHello) {
          this.send(this.hello, "transport");
        }
        settleResolve();
      });
      this.attachSocketListener(socket, "message", (raw) => {
        void this.handleRawSocketMessage(raw);
      });
      this.attachSocketListener(socket, "error", (error) => {
        const emitted = this.emitLocalError("Live websocket error", true, error);
        if (this.state === "connecting") {
          settleReject(emitted);
        }
      });
      this.attachSocketListener(socket, "close", () => {
        this.socket = null;
        this.ready = false;
        this.session.assistantSpeaking = false;
        this.setState(this.closingRequested ? "closed" : "closed", "transport.closed", "live");
        settleResolve();
      });
    });
  }

  private createSocket(url: string): DeviceStudioWebSocketLike {
    if (this.options.webSocketFactory) {
      return this.options.webSocketFactory(url);
    }
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw this.emitLocalError(
        "No global WebSocket implementation is available; provide webSocketFactory in headless runtimes",
        false,
      );
    }
    return new WebSocketCtor(url) as DeviceStudioWebSocketLike;
  }

  private attachSocketListener(
    socket: DeviceStudioWebSocketLike,
    type: "open" | "message" | "error" | "close",
    listener: (event?: unknown) => void,
  ): void {
    if (socket.addEventListener) {
      socket.addEventListener(type, listener);
      return;
    }
    if (socket.on) {
      socket.on(type, (...args) => listener(type === "message" ? args[0] : args[0]));
      return;
    }
    throw this.emitLocalError("WebSocket implementation does not expose an event API", false);
  }

  private async handleRawSocketMessage(raw: unknown): Promise<void> {
    const text = await decodeRawSocketText(raw);
    if (text === null) {
      this.emitLocalError("Unsupported websocket message payload", true, raw);
      return;
    }
    const parsed = parseHubMessage(text);
    if (!parsed.ok) {
      this.emitLocalError(parsed.error, true, parsed.payload);
      return;
    }
    this.consumeHubMessage(parsed.message, "live");
  }

  private send(message: ClientToHubMessage, source: DeviceStudioEventSource): void {
    this.ensureSendable();
    this.emitOutbound(message, source);
    if (this.options.mode === "mock") {
      this.handleMockOutbound(message);
      return;
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      throw this.emitLocalError("Live websocket is not connected", false);
    }
    socket.send(JSON.stringify(message));
  }

  private emitOutbound(message: ClientToHubMessage, source: DeviceStudioEventSource): void {
    const log = this.recordLog({
      source,
      direction: "out",
      kind: `hub.${message.type}`,
      messageType: message.type,
      payload: message,
    });
    this.emit("outbound", { message, log });
  }

  private ensureSendable(): void {
    if (this.options.mode === "mock") {
      if (this.state === "connected" || this.state === "ready") {
        return;
      }
      throw this.emitLocalError("Mock transport is not connected", false);
    }
    const socket = this.socket;
    if (socket && socket.readyState === SOCKET_OPEN) {
      return;
    }
    throw this.emitLocalError("Live websocket is not connected", false);
  }

  private handleMockOutbound(message: ClientToHubMessage): void {
    switch (message.type) {
      case "hello":
        return;
      case "ping":
        this.consumeHubMessage({ type: "pong", sentAt: message.sentAt }, "mock");
        return;
      case "interrupt":
        this.clearMockTimers();
        this.session.assistantSpeaking = false;
        this.consumeHubMessage({
          type: "assistant.interrupted",
          sessionId: this.session.sessionId ?? this.hello.sessionId ?? `device-studio:${this.hello.deviceId}`,
        }, "mock");
        return;
      case "user.text":
        this.runMockTypedTurn(message);
        return;
      case "text":
      case "turn.start":
      case "turn.end":
      case "audio":
      case "relay.stt":
      case "relay.tts":
        return;
      default:
        return;
    }
  }

  private runMockTypedTurn(message: Extract<ClientToHubMessage, { type: "user.text" }>): void {
    const text = message.text.trim();
    if (!text) {
      this.consumeHubMessage({
        type: "error-event",
        data: { message: "Typed user text is empty" },
      }, "mock");
      return;
    }

    if (message.interrupt !== false) {
      this.clearMockTimers();
      if (this.session.assistantSpeaking) {
        this.consumeHubMessage({
          type: "assistant.interrupted",
          sessionId: this.session.sessionId ?? this.hello.sessionId ?? `device-studio:${this.hello.deviceId}`,
        }, "mock");
      }
    }

    const assistantText = this.mock.assistantText;
    const liveDeltas = this.mock.assistantLiveDeltas.length > 0
      ? this.mock.assistantLiveDeltas
      : splitMockAssistantText(assistantText);
    const messages: HubToClientMessage[] = [
      {
        type: "message",
        data: {
          role: "user",
          content: text,
          final: true,
        },
      },
      { type: "text", data: "audio-init" },
      ...liveDeltas.map((delta): HubToClientMessage => ({
        type: "message",
        data: {
          role: "assistant",
          content: delta,
          live: true,
        },
      })),
      { type: "text", data: "audio-end" },
      {
        type: "message",
        data: {
          role: "assistant",
          content: assistantText,
          final: true,
        },
      },
    ];
    this.scheduleMockInbound(messages);
  }

  private scheduleMockInbound(messages: HubToClientMessage[]): void {
    messages.forEach((message, index) => {
      const delay = this.mock.stepDelayMs * (index + 1);
      const timer = setTimeout(() => {
        this.mockTimers.delete(timer);
        this.consumeHubMessage(message, "mock");
      }, delay);
      this.mockTimers.add(timer);
    });
  }

  private clearMockTimers(): void {
    for (const timer of this.mockTimers) {
      clearTimeout(timer);
    }
    this.mockTimers.clear();
  }

  private consumeHubMessage(message: HubToClientMessage, source: "live" | "mock"): void {
    const log = this.recordLog({
      source,
      direction: "in",
      kind: `hub.${message.type}`,
      messageType: message.type,
      payload: message,
    });
    this.emit("inbound", { message, log });

    switch (message.type) {
      case "session.ready":
        this.applySessionReady(message);
        this.ready = true;
        this.setState("ready", "transport.ready", source);
        this.emit("lifecycle", { name: "session.ready", message, log });
        return;
      case "hello.ack":
        this.applyHelloAck(message);
        this.ready = true;
        this.setState("ready", "transport.ready", source);
        this.emit("lifecycle", { name: "hello.ack", message, log });
        return;
      case "status":
        this.handleStatus(message, log);
        return;
      case "message":
        this.emit("message", {
          role: message.data.role,
          content: message.data.content,
          live: message.data.live ?? false,
          final: message.data.final ?? false,
          message,
          log,
        });
        return;
      case "text":
        this.handleText(message, log);
        return;
      case "audio":
        this.emit("audio", {
          data: message.data,
          estimatedBytes: estimateBase64ByteLength(message.data),
          message,
          log,
        });
        return;
      case "action":
        this.handleAction(message, log);
        return;
      case "pong":
        this.handlePong(message, log);
        return;
      case "assistant.interrupted":
        this.session.assistantSpeaking = false;
        this.emit("lifecycle", { name: "assistant.interrupted", message, log });
        return;
      case "error-event":
        this.emit("error", {
          message: message.data.message,
          recoverable: true,
          log,
        });
        return;
      case "relay.stt.result":
      case "relay.tts.chunk":
      case "relay.tts.done":
      case "relay.error":
        return;
      default:
        return;
    }
  }

  private applySessionReady(message: SessionReadyMessage): void {
    this.session.sessionId = message.sessionId;
    this.session.channelId = message.channelId;
    this.session.deviceId = message.deviceId;
    this.session.deviceName = message.deviceName;
    this.session.satelliteId = message.satelliteId;
    this.session.audioFormat = message.audioFormat;
  }

  private applyHelloAck(message: HelloAckMessage): void {
    this.session.sessionId = message.sessionId;
    this.session.channelId = message.channelId;
    this.session.deviceId = message.deviceId;
    this.session.deviceName = message.deviceName;
    this.session.satelliteId = message.satelliteId;
    this.session.satelliteName = message.satelliteName;
    this.session.capabilities = cloneCapabilities(message.capabilities);
  }

  private handleStatus(
    message: StatusMessage,
    log: DeviceStudioTransportLogEntry,
  ): void {
    if (message.data === "call_initialized") {
      this.ready = true;
      this.setState("ready", "transport.ready", log.source);
    }
    this.emit("lifecycle", { name: "status", message, log });
  }

  private handleText(message: TextMessage, log: DeviceStudioTransportLogEntry): void {
    if (message.data === "audio-init") {
      this.session.assistantSpeaking = true;
      this.emit("lifecycle", { name: "audio.start", message, log });
      return;
    }
    if (message.data === "audio-end") {
      this.session.assistantSpeaking = false;
      this.emit("lifecycle", { name: "audio.end", message, log });
      return;
    }
    this.emit("lifecycle", { name: "status", message, log });
  }

  private handleAction(message: ActionMessage, log: DeviceStudioTransportLogEntry): void {
    if (message.data === "interrupt") {
      this.session.assistantSpeaking = false;
      this.emit("lifecycle", { name: "action.interrupt", message, log });
      return;
    }
    this.emit("lifecycle", { name: `action.${message.data}`, message, log });
  }

  private handlePong(message: PongMessage, log: DeviceStudioTransportLogEntry): void {
    const receivedAt = this.clock().toISOString();
    const rttMs = this.session.lastPingSentAt === message.sentAt
      ? Math.max(0, this.nowMs() - message.sentAt)
      : undefined;
    this.session.lastPongAt = receivedAt;
    this.session.lastPingRttMs = rttMs;
    this.emit("pong", {
      sentAt: message.sentAt,
      receivedAt,
      rttMs,
      message,
      log,
    });
  }

  private setState(
    next: DeviceStudioConnectionState,
    kind: string,
    source: DeviceStudioEventSource,
  ): void {
    if (this.state === next) {
      return;
    }
    const previous = this.state;
    this.state = next;
    const log = this.recordLog({
      source,
      direction: "internal",
      kind,
      payload: { previous, current: next },
    });
    this.emit("state", { previous, current: next, log });
  }

  private emitLocalError(message: string, recoverable: boolean, cause?: unknown): Error {
    const error = cause instanceof Error ? cause : new Error(message);
    const log = this.recordLog({
      source: "transport",
      direction: "internal",
      kind: "transport.error",
      payload: cause,
      error: cause instanceof Error && cause.message ? cause.message : message,
    });
    if (!recoverable) {
      this.ready = false;
      this.setState("error", "transport.error", "transport");
    }
    this.emit("error", { message, recoverable, cause, log });
    return error;
  }

  private recordLog(input: {
    source: DeviceStudioEventSource;
    direction: DeviceStudioEventDirection;
    kind: string;
    messageType?: string;
    payload?: unknown;
    error?: string;
  }): DeviceStudioTransportLogEntry {
    const entry: DeviceStudioTransportLogEntry = {
      id: ++this.logSequence,
      at: this.clock().toISOString(),
      source: input.source,
      direction: input.direction,
      kind: input.kind,
      state: this.state,
      profileId: this.options.profile?.id,
      sessionId: this.session.sessionId,
      channelId: this.session.channelId,
      messageType: input.messageType,
      payload: input.payload,
      error: input.error,
    };
    this.logEntries.push(entry);
    while (this.logEntries.length > this.maxLogEntries) {
      this.logEntries.shift();
    }
    this.emit("log", entry);
    return entry;
  }

  private emit<K extends keyof DeviceStudioTransportEventMap>(
    type: K,
    event: DeviceStudioTransportEventMap[K],
  ): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(event);
    }
  }
}

export function buildDeviceStudioHelloPayload(options: DeviceStudioHelloOptions = {}): HelloMessage {
  const profileSlug = slugify(options.profile?.id ?? "generic");
  const deviceId = normalizeOptional(options.deviceId) ?? `device-studio-${profileSlug}`;
  const deviceName = normalizeOptional(options.deviceName)
    ?? (options.profile ? `Device Studio ${options.profile.name}` : "Device Studio Simulated Satellite");
  const sessionId = normalizeOptional(options.sessionId) ?? `device-studio:${profileSlug}`;
  const satelliteId = normalizeOptional(options.satelliteId) ?? deviceId;
  const satelliteName = normalizeOptional(options.satelliteName) ?? deviceName;
  const hello: HelloMessage = {
    type: "hello",
    deviceId,
    deviceName,
    sessionId,
    satelliteId,
    satelliteName,
    capabilities: mergeCapabilities(inferSatelliteCapabilities(options.profile), options.capabilities),
  };
  const channelId = normalizeOptional(options.channelId);
  if (channelId) {
    hello.channelId = channelId;
  }
  return hello;
}

export function inferSatelliteCapabilities(profile?: DeviceProfile): Required<SatelliteCapabilities> {
  const input = new Set<SatelliteInputCapability>(["text", "wake_event"]);
  const output = new Set<SatelliteOutputCapability>(["text", "subtitle"]);
  const control = new Set<SatelliteControlCapability>(["interrupt", "presence", "session_attach"]);
  const safety = new Set<SatelliteSafetyCapability>(["local_only"]);

  for (const capability of profile?.capabilities.input ?? []) {
    applyInputCapability(capability, input);
  }
  for (const capability of profile?.capabilities.output ?? []) {
    applyOutputCapability(capability, output);
  }
  for (const capability of profile?.capabilities.control ?? []) {
    applyControlCapability(capability, control);
  }

  return {
    input: [...input],
    output: [...output],
    control: [...control],
    safety: [...safety],
  };
}

export function parseHubMessage(raw: unknown): ParsedHubMessage | HubMessageParseError {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? `Invalid hub JSON: ${error.message}` : "Invalid hub JSON",
        payload: raw,
      };
    }
  }

  const record = asRecord(payload);
  if (!record) {
    return { ok: false, error: "Hub message must be an object", payload };
  }
  if (typeof record.type !== "string") {
    return { ok: false, error: "Hub message type is required", payload };
  }

  const validationError = validateHubMessage(record);
  if (validationError) {
    return { ok: false, error: validationError, payload };
  }
  return { ok: true, message: payload as HubToClientMessage };
}

function validateHubMessage(message: Record<string, unknown>): string | null {
  switch (message.type) {
    case "session.ready":
      return requireStringFields(message, [
        "sessionId",
        "channelId",
        "deviceId",
        "deviceName",
        "satelliteId",
        "audioFormat",
      ]);
    case "hello.ack": {
      const error = requireStringFields(message, [
        "sessionId",
        "channelId",
        "deviceId",
        "deviceName",
        "satelliteId",
        "satelliteName",
      ]);
      if (error) return error;
      return isRecord(message.capabilities) ? null : "hello.ack capabilities must be an object";
    }
    case "status":
    case "text":
      return typeof message.data === "string" ? null : `${message.type} data must be a string`;
    case "audio":
      return typeof message.data === "string" ? null : "audio data must be a base64 string";
    case "message":
      return validateConversationMessage(message);
    case "action":
      return message.data === "interrupt" || message.data === "pause-audio" || message.data === "play-audio"
        ? null
        : "action data is invalid";
    case "error-event": {
      const data = asRecord(message.data);
      return typeof data?.message === "string" ? null : "error-event data.message must be a string";
    }
    case "relay.stt.result": {
      const error = requireStringFields(message, ["requestId", "text", "provider"]);
      if (error) return error;
      return message.latencyMs === undefined || typeof message.latencyMs === "number"
        ? null
        : "relay.stt.result latencyMs must be a number";
    }
    case "relay.tts.chunk":
      return requireStringFields(message, ["requestId", "audio"]);
    case "relay.tts.done":
      return requireStringFields(message, ["requestId", "mimeType"]);
    case "relay.error": {
      const error = requireStringFields(message, ["requestId", "message"]);
      if (error) return error;
      return message.operation === "stt" || message.operation === "tts"
        ? null
        : "relay.error operation is invalid";
    }
    case "pong":
      return typeof message.sentAt === "number" ? null : "pong sentAt must be a number";
    case "assistant.interrupted":
      return typeof message.sessionId === "string" ? null : "assistant.interrupted sessionId must be a string";
    default:
      return `Unsupported hub message type: ${String(message.type)}`;
  }
}

function validateConversationMessage(message: Record<string, unknown>): string | null {
  const data = asRecord(message.data);
  if (!data) {
    return "message data must be an object";
  }
  if (data.role !== "user" && data.role !== "assistant") {
    return "message data.role must be user or assistant";
  }
  if (typeof data.content !== "string") {
    return "message data.content must be a string";
  }
  if (data.live !== undefined && typeof data.live !== "boolean") {
    return "message data.live must be a boolean";
  }
  if (data.final !== undefined && typeof data.final !== "boolean") {
    return "message data.final must be a boolean";
  }
  return null;
}

function requireStringFields(message: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    if (typeof message[field] !== "string") {
      return `${String(message.type)} ${field} must be a string`;
    }
  }
  return null;
}

function applyInputCapability(
  capability: DeviceInputCapability,
  input: Set<SatelliteInputCapability>,
): void {
  switch (capability) {
    case "text":
      input.add("text");
      return;
    case "audio":
      input.add("microphone_pcm");
      input.add("final_transcript");
      return;
    case "touch":
    case "button":
    case "gesture":
      input.add("wake_event");
      return;
  }
}

function applyOutputCapability(
  capability: DeviceOutputCapability,
  output: Set<SatelliteOutputCapability>,
): void {
  switch (capability) {
    case "display":
      output.add("text");
      output.add("subtitle");
      output.add("action");
      return;
    case "expression":
      output.add("expression");
      return;
    case "viseme":
      output.add("subtitle");
      return;
    case "speech":
    case "audio":
      output.add("streamed_audio");
      return;
    case "motion":
      output.add("servo");
      output.add("gaze");
      output.add("animation");
      return;
    case "led":
    case "backlight":
      output.add("action");
      return;
  }
}

function applyControlCapability(
  capability: DeviceControlCapability,
  control: Set<SatelliteControlCapability>,
): void {
  switch (capability) {
    case "interrupt":
      control.add("interrupt");
      return;
    case "profile-select":
    case "behavior-playback":
      control.add("session_attach");
      return;
    case "brightness":
    case "volume":
      control.add("presence");
      return;
  }
}

function mergeCapabilities(
  inferred: Required<SatelliteCapabilities>,
  overrides?: SatelliteCapabilities,
): Required<SatelliteCapabilities> {
  return {
    input: mergeCapabilityList(inferred.input, overrides?.input),
    output: mergeCapabilityList(inferred.output, overrides?.output),
    control: mergeCapabilityList(inferred.control, overrides?.control),
    safety: mergeCapabilityList(inferred.safety, overrides?.safety),
  };
}

function mergeCapabilityList<T extends string>(inferred: T[], overrides?: T[]): T[] {
  return [...new Set([...inferred, ...(overrides ?? [])])];
}

function createMockSessionReady(hello: HelloMessage): SessionReadyMessage {
  const sessionId = hello.sessionId ?? `device-studio:${hello.deviceId}`;
  return {
    type: "session.ready",
    sessionId,
    channelId: hello.channelId ?? `satellite.endpoint:${sessionId}`,
    deviceId: hello.deviceId,
    deviceName: hello.deviceName,
    satelliteId: hello.satelliteId ?? hello.deviceId,
    audioFormat: DEFAULT_MOCK_AUDIO_FORMAT,
  };
}

function createMockHelloAck(hello: HelloMessage): HelloAckMessage {
  const session = createMockSessionReady(hello);
  return {
    type: "hello.ack",
    sessionId: session.sessionId,
    channelId: session.channelId,
    deviceId: hello.deviceId,
    deviceName: hello.deviceName,
    satelliteId: hello.satelliteId ?? hello.deviceId,
    satelliteName: hello.satelliteName ?? hello.deviceName,
    capabilities: cloneCapabilities(hello.capabilities) ?? inferSatelliteCapabilities(),
  };
}

function splitMockAssistantText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const midpoint = Math.ceil(normalized.length / 2);
  return [
    normalized.slice(0, midpoint),
    normalized.slice(midpoint),
  ].filter((part) => part.length > 0);
}

function estimateBase64ByteLength(encoded: string): number {
  const normalized = encoded.trim();
  if (!normalized) {
    return 0;
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

async function decodeRawSocketText(raw: unknown): Promise<string | null> {
  const payload = isMessageEvent(raw) ? raw.data : raw;
  if (typeof payload === "string") {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return new TextDecoder().decode(payload);
  }
  if (ArrayBuffer.isView(payload)) {
    return new TextDecoder().decode(payload);
  }
  if (Array.isArray(payload)) {
    const chunks: Uint8Array[] = [];
    for (const item of payload) {
      if (typeof item === "string") {
        chunks.push(new TextEncoder().encode(item));
      } else if (item instanceof ArrayBuffer) {
        chunks.push(new Uint8Array(item));
      } else if (ArrayBuffer.isView(item)) {
        chunks.push(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
      } else {
        return null;
      }
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }
  if (isBlobLike(payload)) {
    return await payload.text();
  }
  return null;
}

function cloneCapabilities(capabilities?: SatelliteCapabilities): SatelliteCapabilities | undefined {
  if (!capabilities) {
    return undefined;
  }
  return {
    ...(capabilities.input ? { input: [...capabilities.input] } : {}),
    ...(capabilities.output ? { output: [...capabilities.output] } : {}),
    ...(capabilities.control ? { control: [...capabilities.control] } : {}),
    ...(capabilities.safety ? { safety: [...capabilities.safety] } : {}),
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "generic";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageEvent(value: unknown): value is { data: unknown } {
  return isRecord(value) && "data" in value;
}

function isBlobLike(value: unknown): value is { text: () => Promise<string> } {
  return isRecord(value) && typeof value.text === "function";
}
