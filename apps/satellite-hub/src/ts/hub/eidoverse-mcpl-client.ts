/**
 * MCP-over-WebSocket (MCPL) client for the Eidoverse door.
 *
 * Phase 1 polls the plain-MCP `pending_pings` tool on a timer. The door's MCPL
 * face pushes the same events as `channels/incoming` requests instead, so a
 * knock costs one frame rather than a busy loop. This client speaks that face:
 * newline-delimited JSON-RPC over a single WebSocket to
 * `wss://<host>/mcpl?token=...`, an `initialize` carrying
 * `capabilities.experimental.mcpl`, and a `featureSets/update` Request stating
 * the grant the Hub — not the door — decided on.
 *
 * It is a bidirectional peer, not a caller. The door registers its world
 * channel with an inbound `channels/register` Request and asks permission for
 * every world transition with the Request form of `channels/changed`, including
 * transitions this client itself started with the `travel` tool. Those answers
 * must be written while a `tools/call` is still pending on the same socket, so
 * the read loop dispatches inbound requests independently of outbound ones. The
 * door then confirms the transition with the NOTIFICATION form of the same
 * method, which is routed to the responder so the channel the body left is
 * retired rather than tracked forever.
 *
 * Fail-closed throughout: a malformed frame is dropped and never becomes a
 * wake, a tool result carrying a configured secret is refused, reconnection is
 * bounded, and every log line is content-free.
 */

import { WebSocket } from "ws";

import {
  EIDOVERSE_SAY_MAX_TEXT_LENGTH,
  EidoverseMcpRequestError,
  EidoverseMcpUnavailableError,
  type EidoverseCredentialResolver,
  type EidoverseMcpLogger,
} from "./eidoverse-mcp.js";
import type { EidoverseMcplConfig } from "./eidoverse-mcpl-config.js";
import { EidoverseMcplResponder } from "./eidoverse-mcpl-responder.js";
import {
  descriptorWorldName,
  disabledFeatureSetsForSelection,
  EIDOVERSE_TRAVEL_FEATURE_SET,
  extractSingleToolText,
  hostManifestForCapabilities,
  isRecord,
  MCPL_METHOD,
  MCPL_PROTOCOL_VERSION,
  parseFeatureSetsUpdateResult,
  parseJsonRpcFrame,
  type JsonRpcId,
  type McplChannelDescriptor,
  type McplIncomingChannelMessage,
  type McplIncomingMessageResult,
} from "./eidoverse-mcpl-wire.js";

const HUB_CLIENT_INFO = { name: "psfn-satellite-hub", version: "0.1.0" } as const;

/** Minimal socket seam so tests can drive a local door without a real dial. */
export interface EidoverseMcplSocket {
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: () => void): void;
}

export type EidoverseMcplSocketFactory = (url: string) => EidoverseMcplSocket;

export type EidoverseMcplIncomingHandler = (
  messages: readonly McplIncomingChannelMessage[],
) => void;

/**
 * Called with the world the door says this connection is attached to, once per
 * successful (re)connection.
 */
export type EidoverseMcplWorldHandler = (world: string) => void;

export interface EidoverseMcplClientOptions {
  logger?: EidoverseMcpLogger;
  connect?: EidoverseMcplSocketFactory;
}

const SILENT_LOGGER: EidoverseMcpLogger = {
  info: () => undefined,
  warn: () => undefined,
};

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface McplSession {
  socket: EidoverseMcplSocket;
  pending: Map<JsonRpcId, PendingRequest>;
  responder: EidoverseMcplResponder;
  nextId: number;
  closed: boolean;
  /**
   * Feature sets this hub selected that the door's own degradation receipt
   * says it will not honour on this connection. Read from the receipt, never
   * assumed: it is what the door will DO, and the surfaces that depend on a
   * degraded set are refused Hub-side rather than tried and failed.
   */
  degradedFeatureSets: Set<string>;
}

export class EidoverseMcplClient {
  private session: McplSession | null = null;
  private startPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectDelay: { timer: NodeJS.Timeout; resolve: () => void } | null = null;
  private stopped = true;
  private remainingReconnectAttempts: number;
  private sensitiveValues: readonly string[] = [];
  private readonly logger: EidoverseMcpLogger;
  private readonly connect: EidoverseMcplSocketFactory;
  private onIncoming: EidoverseMcplIncomingHandler | null = null;
  private onWorld: EidoverseMcplWorldHandler | null = null;

  constructor(
    private readonly config: EidoverseMcplConfig,
    private readonly resolveCredential: EidoverseCredentialResolver,
    options: EidoverseMcplClientOptions = {},
  ) {
    this.remainingReconnectAttempts = config.reconnectMaxAttempts;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.connect = options.connect ?? createWebSocketConnector;
  }

  /**
   * Bind the wake path. Set before `start()`: an unbound client still answers
   * the door correctly, it simply has nowhere to route a knock, so binding late
   * silently drops whatever arrived first.
   */
  setIncomingHandler(handler: EidoverseMcplIncomingHandler | null): void {
    this.onIncoming = handler;
  }

  /**
   * Bind the world-resync path. A fresh connection is not "resume where you
   * left off": the door builds the attachment from the join credential's own
   * world claim, so every reconnect reseats the body in this deployment's home
   * world whatever it had travelled to. Without this the Hub's belief and the
   * door's actual world diverge permanently.
   */
  setWorldHandler(handler: EidoverseMcplWorldHandler | null): void {
    this.onWorld = handler;
  }

  start(): Promise<void> {
    if (this.session) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.startPromise = this.connectInitial().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.cancelReconnectDelay();
    const active = this.session;
    this.session = null;
    if (active) this.teardown(active, "Eidoverse MCPL connection closed");
    await this.reconnectPromise;
  }

  /** The world the door most recently registered a channel for, if any. */
  currentWorldName(): string | null {
    return this.session?.responder.currentWorldName() ?? null;
  }

  async look(): Promise<string> {
    return this.callTool("look", {});
  }

  async say(text: string): Promise<void> {
    if (text.length > EIDOVERSE_SAY_MAX_TEXT_LENGTH || this.containsSensitiveValue(text)) {
      throw new EidoverseMcpRequestError("Eidoverse MCPL say request failed");
    }
    const result = await this.callTool("say", { text });
    if (result !== "said") {
      throw new EidoverseMcpRequestError("Eidoverse MCPL say request failed");
    }
  }

  /**
   * Allowlisted locomotion, the same narrow surface the stdio transport
   * exposes. A walk blocks door-side until it arrives or gives up, so it takes
   * its own timeout rather than the ordinary request budget.
   */
  async walkTo(x: number, z: number, run: boolean, timeoutMs: number): Promise<string> {
    return this.callTool("walk_to", { x, z, run }, timeoutMs);
  }

  async face(target: string): Promise<string> {
    return this.callTool("face", { target });
  }

  async stop(): Promise<string> {
    return this.callTool("stop", {});
  }

  /**
   * Ask the door to move this body to another world. The tool's synchronous
   * return is the arrival signal: the door answers `Arrived in "<world>"` (or
   * `Already in`) on success and an error result on refusal, so there is no
   * separate confirmation to listen for. A refusal, a timeout, or a dropped
   * connection all surface as a request error and leave the caller's world
   * belief untouched.
   */
  async travel(world: string): Promise<string> {
    if (!this.grantsTravel()) {
      // Either the operator withheld the feature set, or the door's own
      // receipt says it will not honour it. Feature-set names carry no
      // authority on the wire, so this refusal is the enforcement: the door is
      // never asked.
      this.logger.warn("Eidoverse MCPL travel is not available under this hub's feature sets");
      throw new EidoverseMcpRequestError("Eidoverse MCPL travel request failed");
    }
    return this.callTool("travel", { world });
  }

  /**
   * Whether world-to-world travel is live: this hub selected the feature set
   * AND the door's own receipt did not report it degraded on this connection.
   */
  grantsTravel(): boolean {
    if (!this.config.featureSets.includes(EIDOVERSE_TRAVEL_FEATURE_SET)) return false;
    return !this.session?.degradedFeatureSets.has(EIDOVERSE_TRAVEL_FEATURE_SET);
  }

  private async connectInitial(): Promise<void> {
    try {
      await this.openSession();
      this.remainingReconnectAttempts = this.config.reconnectMaxAttempts;
      this.logger.info("Eidoverse MCPL connected");
    } catch {
      this.stopped = true;
      throw new EidoverseMcpUnavailableError("Eidoverse MCPL connection failed");
    }
  }

  private async openSession(): Promise<void> {
    let credential: string;
    try {
      credential = await this.resolveCredential(this.config.tokenRef);
    } catch {
      throw new EidoverseMcpUnavailableError("Eidoverse MCPL credential is unavailable");
    }
    if (!credential) {
      throw new EidoverseMcpUnavailableError("Eidoverse MCPL credential is unavailable");
    }
    this.sensitiveValues = [
      ...new Set([credential, this.config.tokenRef, this.config.doorUrl].filter((v) => v.length > 0)),
    ];

    const session: McplSession = {
      socket: this.connect(dialUrl(this.config.doorUrl, credential)),
      pending: new Map(),
      responder: new EidoverseMcplResponder({
        warn: (message) => this.logger.warn(message),
      }),
      nextId: 1,
      closed: false,
      degradedFeatureSets: new Set<string>(),
    };
    session.socket.onMessage((data) => this.receive(session, data));
    session.socket.onClose(() => this.handleDisconnect(session));
    session.socket.onError(() => session.socket.close());

    let world: string;
    try {
      await this.awaitOpen(session);
      await this.handshake(session);
      // The door's own answer for where this attachment is, asked on every
      // connection. `channels/list` is not capability-gated and always
      // describes the current world, so a connection that cannot answer it is
      // one the Hub cannot situate — it is torn down for the bounded
      // reconnect path rather than used with a guessed world.
      world = await this.currentWorldFromDoor(session);
    } catch (error) {
      this.teardown(session, "Eidoverse MCPL connection failed");
      throw error instanceof EidoverseMcpUnavailableError
        ? error
        : new EidoverseMcpUnavailableError("Eidoverse MCPL connection failed");
    }
    if (this.stopped || session.closed) {
      this.teardown(session, "Eidoverse MCPL connection stopped");
      throw new EidoverseMcpUnavailableError("Eidoverse MCPL connection stopped");
    }
    this.session = session;
    try {
      this.onWorld?.(world);
    } catch {
      this.logger.warn("Eidoverse MCPL world resync failed");
    }
  }

  /** Read the world of the single channel the door lists for this connection. */
  private async currentWorldFromDoor(session: McplSession): Promise<string> {
    const result = await this.request(
      session,
      MCPL_METHOD.channelsList,
      {},
      this.config.handshakeTimeoutMs,
    );
    if (!isRecord(result) || !Array.isArray(result.channels)) {
      throw new EidoverseMcpUnavailableError("Eidoverse MCPL door did not name its world");
    }
    for (const descriptor of result.channels) {
      if (!isRecord(descriptor) || typeof descriptor.id !== "string") continue;
      const world = descriptorWorldName(descriptor as unknown as McplChannelDescriptor);
      if (world) return world;
    }
    throw new EidoverseMcpUnavailableError("Eidoverse MCPL door did not name its world");
  }

  private awaitOpen(session: McplSession): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new EidoverseMcpUnavailableError("Eidoverse MCPL connection failed"));
      }, this.config.handshakeTimeoutMs);
      timer.unref?.();
      session.socket.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
      session.socket.onError(() => {
        clearTimeout(timer);
        session.socket.close();
        reject(new EidoverseMcpUnavailableError("Eidoverse MCPL connection failed"));
      });
      session.socket.onClose(() => {
        clearTimeout(timer);
        this.handleDisconnect(session);
        reject(new EidoverseMcpUnavailableError("Eidoverse MCPL connection failed"));
      });
    });
  }

  /**
   * `initialize` → `notifications/initialized` → `featureSets/update`.
   *
   * The policy Request is not optional politeness. A door that sees a 0.5 host
   * holds every capability-dependent behavior — the push channel included —
   * until the first grant is answered, so skipping it would leave a connected
   * client that never hears anything.
   */
  private async handshake(session: McplSession): Promise<void> {
    const manifest = hostManifestForCapabilities(this.config.effectiveCapabilities);
    await this.request(session, MCPL_METHOD.initialize, {
      protocolVersion: MCPL_PROTOCOL_VERSION,
      capabilities: { tools: {}, experimental: { mcpl: manifest } },
      clientInfo: HUB_CLIENT_INFO,
    }, this.config.handshakeTimeoutMs);
    this.notify(session, MCPL_METHOD.initialized, {});
    const receipt = await this.request(session, MCPL_METHOD.featureSetsUpdate, {
      enabled: [...this.config.featureSets],
      disabled: disabledFeatureSetsForSelection(this.config.featureSets),
      effectiveCapabilities: [...this.config.effectiveCapabilities],
    }, this.config.handshakeTimeoutMs);
    this.applyDegradationReceipt(session, receipt);
  }

  /**
   * Read the door's §6.7 degradation receipt.
   *
   * The receipt reports what the door will stop doing, and it is the only
   * signal the Hub gets that its hand-maintained mirror of the door's feature
   * -set table has drifted — a routine upstream change, not an attack. A set
   * this hub selected and the door reports unavailable disables the surfaces
   * that depend on it, and says so in one content-free line naming the set ids
   * and the capability paths the door found missing. A set the operator
   * withheld coming back unavailable is the expected consequence of
   * withholding it and is not reported.
   *
   * An unreadable receipt, or one refusing the policy outright, degrades every
   * selected set: the Hub cannot tell what survived, so it assumes nothing did.
   */
  private applyDegradationReceipt(session: McplSession, result: unknown): void {
    const receipt = parseFeatureSetsUpdateResult(result);
    if (!receipt || !receipt.accepted) {
      for (const name of this.config.featureSets) session.degradedFeatureSets.add(name);
      this.logger.warn(
        receipt
          ? "Eidoverse MCPL door refused the feature-set policy; every selected set is degraded"
          : "Eidoverse MCPL feature-set receipt was unreadable; every selected set is degraded",
      );
      return;
    }
    const degraded: string[] = [];
    for (const entry of receipt.unavailableFeatures ?? []) {
      if (!this.config.featureSets.includes(entry.featureSet)) continue;
      session.degradedFeatureSets.add(entry.featureSet);
      degraded.push(entry.missingCapabilities.length > 0
        ? `${entry.featureSet} [${entry.missingCapabilities.join(" ")}]`
        : entry.featureSet);
    }
    if (degraded.length === 0) return;
    this.logger.warn(`Eidoverse MCPL feature sets degraded: ${degraded.join(", ")}`);
  }

  /**
   * One WebSocket message is one complete newline-delimited JSON-RPC payload.
   * The door writes exactly one object per frame, and WebSocket preserves
   * message boundaries, so there is no partial line to carry across frames —
   * splitting keeps a batched sender working without inventing a reassembly
   * buffer that could silently join two unrelated frames.
   */
  private receive(session: McplSession, data: string): void {
    for (const line of data.split("\n")) this.consumeLine(session, line);
  }

  private consumeLine(session: McplSession, line: string): void {
    if (!line.trim()) return;
    const frame = parseJsonRpcFrame(line);
    if (!frame) {
      this.logger.warn("Eidoverse MCPL frame was malformed and was dropped");
      return;
    }
    if (frame.kind === "response") {
      const pending = session.pending.get(frame.response.id);
      if (!pending) return;
      session.pending.delete(frame.response.id);
      clearTimeout(pending.timer);
      if (frame.response.error) {
        pending.reject(new EidoverseMcpRequestError("Eidoverse MCPL request was refused"));
        return;
      }
      pending.resolve(frame.response.result);
      return;
    }
    if (frame.kind === "notification") {
      // The COMMIT half of a world transition. Without it the responder keeps
      // answering for channels the door has already retired, so the world the
      // body left would stay tracked for the life of the connection.
      if (frame.notification.method === MCPL_METHOD.channelsChanged) {
        session.responder.commit(frame.notification.params);
      }
      return;
    }
    if (frame.request.method === MCPL_METHOD.channelsIncoming) {
      this.handleIncoming(session, frame.request.id, frame.request.params);
      return;
    }
    const response = session.responder.handle(frame.request);
    if (response.error) {
      this.sendError(session, frame.request.id, response.error);
      return;
    }
    this.sendResult(session, frame.request.id, response.result);
  }

  /**
   * Answer the door first, dispatch second. `channels/incoming` is a Request
   * and the door times it out; a wake turn is inference-length, so awaiting the
   * turn before answering would make every knock look like a host failure.
   */
  private handleIncoming(session: McplSession, id: JsonRpcId, params: unknown): void {
    const messages = parseIncomingMessages(params);
    if (!messages) {
      this.logger.warn("Eidoverse MCPL delivered a malformed incoming batch");
      this.sendResult(session, id, { results: [] });
      return;
    }
    const results: McplIncomingMessageResult[] = messages.map((message) => ({
      messageId: message.messageId,
      accepted: true,
    }));
    this.sendResult(session, id, { results });
    if (!this.onIncoming || messages.length === 0) return;
    try {
      this.onIncoming(messages);
    } catch {
      this.logger.warn("Eidoverse MCPL incoming delivery failed");
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<string> {
    const session = this.session;
    if (!session || session.closed) {
      throw new EidoverseMcpUnavailableError("Eidoverse MCPL is not connected");
    }
    try {
      const result = await this.request(
        session,
        MCPL_METHOD.toolsCall,
        { name, arguments: args },
        timeoutMs ?? this.config.requestTimeoutMs,
      );
      const text = extractSingleToolText(result);
      if (this.containsSensitiveValue(text)) throw new Error("sensitive result");
      this.remainingReconnectAttempts = this.config.reconnectMaxAttempts;
      return text;
    } catch {
      throw new EidoverseMcpRequestError(`Eidoverse MCPL ${name} request failed`);
    }
  }

  private request(
    session: McplSession,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (session.closed) {
      return Promise.reject(new EidoverseMcpUnavailableError("Eidoverse MCPL is not connected"));
    }
    const id = session.nextId;
    session.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new EidoverseMcpRequestError("Eidoverse MCPL request timed out"));
      }, timeoutMs);
      timer.unref?.();
      session.pending.set(id, { resolve, reject, timer });
      try {
        session.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(new EidoverseMcpRequestError("Eidoverse MCPL request could not be sent"));
      }
    });
  }

  private notify(session: McplSession, method: string, params: unknown): void {
    this.write(session, { jsonrpc: "2.0", method, params });
  }

  private sendResult(session: McplSession, id: JsonRpcId, result: unknown): void {
    this.write(session, { jsonrpc: "2.0", id, result });
  }

  private sendError(
    session: McplSession,
    id: JsonRpcId,
    error: { code: number; message: string },
  ): void {
    this.write(session, { jsonrpc: "2.0", id, error });
  }

  private write(session: McplSession, frame: Record<string, unknown>): void {
    if (session.closed) return;
    try {
      session.socket.send(JSON.stringify(frame));
    } catch {
      this.logger.warn("Eidoverse MCPL frame could not be sent");
    }
  }

  private teardown(session: McplSession, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    for (const [id, pending] of session.pending) {
      session.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new EidoverseMcpRequestError(reason));
    }
    try {
      session.socket.close();
    } catch {
      // The socket is already gone; there is nothing further to release.
    }
  }

  private handleDisconnect(session: McplSession): void {
    const wasActive = this.session === session;
    this.teardown(session, "Eidoverse MCPL disconnected");
    if (!wasActive) return;
    this.session = null;
    if (this.stopped) return;
    this.logger.warn("Eidoverse MCPL disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectPromise || this.stopped) return;
    if (this.remainingReconnectAttempts <= 0) {
      this.logger.warn("Eidoverse MCPL reconnect budget exhausted");
      return;
    }
    this.reconnectPromise = this.reconnect().finally(() => {
      this.reconnectPromise = null;
      if (!this.stopped && !this.session && this.remainingReconnectAttempts <= 0) {
        this.logger.warn("Eidoverse MCPL reconnect budget exhausted");
      }
    });
  }

  private async reconnect(): Promise<void> {
    while (!this.stopped && !this.session && this.remainingReconnectAttempts > 0) {
      const attempt = this.config.reconnectMaxAttempts - this.remainingReconnectAttempts;
      this.remainingReconnectAttempts -= 1;
      const delayMs = Math.min(
        this.config.reconnectBaseMs * (2 ** attempt),
        this.config.reconnectMaxMs,
      );
      await this.waitForReconnect(delayMs);
      if (this.stopped) return;
      try {
        await this.openSession();
        this.logger.info("Eidoverse MCPL reconnected");
        return;
      } catch {
        // The next bounded attempt is the only recovery path.
      }
    }
  }

  private waitForReconnect(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.reconnectDelay?.timer === timer) this.reconnectDelay = null;
        resolve();
      }, delayMs);
      timer.unref?.();
      this.reconnectDelay = { timer, resolve };
    });
  }

  private cancelReconnectDelay(): void {
    const pending = this.reconnectDelay;
    if (!pending) return;
    this.reconnectDelay = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private containsSensitiveValue(value: string): boolean {
    return this.sensitiveValues.some((sensitive) => value.includes(sensitive));
  }
}

/**
 * The identity token rides in the dial URL's query string, exactly where the
 * door reads it, and never in configuration or a log line.
 */
function dialUrl(doorUrl: string, credential: string): string {
  const url = new URL(doorUrl);
  url.searchParams.set("token", credential);
  return url.toString();
}

function parseIncomingMessages(params: unknown): McplIncomingChannelMessage[] | null {
  if (!isRecord(params)) return null;
  const messages = params.messages;
  if (!Array.isArray(messages)) return null;
  const parsed: McplIncomingChannelMessage[] = [];
  for (const entry of messages) {
    if (!isRecord(entry)) return null;
    if (typeof entry.channelId !== "string" || typeof entry.messageId !== "string") return null;
    if (!Array.isArray(entry.content)) return null;
    parsed.push(entry as unknown as McplIncomingChannelMessage);
  }
  return parsed;
}

function createWebSocketConnector(url: string): EidoverseMcplSocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: (handler) => { socket.on("open", handler); },
    onMessage: (handler) => {
      socket.on("message", (data: unknown) => {
        handler(typeof data === "string" ? data : String(data));
      });
    },
    onClose: (handler) => { socket.on("close", handler); },
    onError: (handler) => { socket.on("error", () => handler()); },
  };
}
