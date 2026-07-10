import WebSocket, { type RawData } from "ws";

import type { HomeAssistantConfig } from "../../shared/env.js";
import {
  HomeAssistantRequestError,
  HomeAssistantUnavailableError,
  type HomeAssistantCallServiceInput,
  type HomeAssistantCallServiceResult,
  type HomeAssistantHealth,
  type HomeAssistantState,
} from "./contracts.js";

const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface HaResultMessage {
  id: number;
  type: "result";
  success: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export type HomeAssistantWebSocketFactory = (url: string) => WebSocket;

export class HomeAssistantClient {
  private socket: WebSocket | null = null;
  private readonly states = new Map<string, HomeAssistantState>();
  private readonly pending = new Map<number, PendingCommand>();
  private nextId = 1;
  private stopped = true;
  private status: HomeAssistantHealth["status"] = "stopped";
  private haVersion: string | undefined;
  private connectedAt: string | undefined;
  private lastDisconnectedAt: string | undefined;
  private lastError: string | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: HomeAssistantConfig,
    private readonly createSocket: HomeAssistantWebSocketFactory = defaultWebSocketFactory,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.status = "connecting";
    this.connect();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.status = "stopped";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending(new HomeAssistantUnavailableError("Home Assistant connection stopped"));
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close(1000, "hub shutdown");
      setTimeout(resolve, 1_000).unref();
    });
  }

  health(): HomeAssistantHealth {
    return {
      enabled: true,
      status: this.status,
      connected: this.status === "ready" && this.socket?.readyState === WebSocket.OPEN,
      stateCount: this.states.size,
      ...(this.haVersion ? { haVersion: this.haVersion } : {}),
      ...(this.connectedAt ? { connectedAt: this.connectedAt } : {}),
      ...(this.lastDisconnectedAt ? { lastDisconnectedAt: this.lastDisconnectedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  getStates(entityIds?: readonly string[]): HomeAssistantState[] {
    this.assertReady();
    if (!entityIds || entityIds.length === 0) {
      return [...this.states.values()].map(cloneState);
    }
    return entityIds.map((entityId) => {
      const state = this.states.get(entityId);
      if (!state) {
        throw new HomeAssistantRequestError(`Home Assistant entity not found: ${entityId}`);
      }
      return cloneState(state);
    });
  }

  async callService(input: HomeAssistantCallServiceInput): Promise<HomeAssistantCallServiceResult> {
    this.assertReady();
    const result = await this.sendCommand({
      type: "call_service",
      domain: input.domain,
      service: input.service,
      target: { entity_id: input.entityIds },
      ...(input.data ? { service_data: input.data } : {}),
    });
    const record = isRecord(result) ? result : {};
    const context = isRecord(record.context) ? record.context : undefined;
    return {
      requestId: input.requestId,
      domain: input.domain,
      service: input.service,
      entityIds: [...input.entityIds],
      ...(typeof context?.id === "string" ? { contextId: context.id } : {}),
      response: record.response ?? null,
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.status = "connecting";
    let socket: WebSocket;
    try {
      socket = this.createSocket(toWebSocketUrl(this.config.baseUrl));
    } catch (error) {
      this.handleDisconnect(error);
      return;
    }
    this.socket = socket;
    socket.on("message", (raw) => this.handleMessage(raw));
    socket.on("error", (error) => {
      this.lastError = safeError(error);
    });
    socket.on("close", () => this.handleDisconnect(new Error("Home Assistant websocket closed")));
  }

  private handleMessage(raw: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(rawDataToString(raw)) as unknown;
    } catch {
      this.failConnection("Home Assistant sent malformed JSON");
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      this.failConnection("Home Assistant sent a malformed websocket message");
      return;
    }

    if (message.type === "auth_required") {
      this.socket?.send(JSON.stringify({ type: "auth", access_token: this.config.token }));
      return;
    }
    if (message.type === "auth_invalid") {
      this.failConnection("Home Assistant authentication failed");
      return;
    }
    if (message.type === "auth_ok") {
      this.haVersion = typeof message.ha_version === "string" ? message.ha_version : undefined;
      void this.initializeConnection();
      return;
    }
    if (message.type === "result") {
      this.handleResult(message);
      return;
    }
    if (message.type === "event") {
      this.handleEvent(message);
    }
  }

  private async initializeConnection(): Promise<void> {
    try {
      const states = await this.sendCommand({ type: "get_states" });
      if (!Array.isArray(states)) {
        throw new HomeAssistantRequestError("Home Assistant get_states result must be an array");
      }
      const nextStates = new Map<string, HomeAssistantState>();
      for (const value of states) {
        const state = parseState(value);
        nextStates.set(state.entity_id, state);
      }
      await this.sendCommand({ type: "subscribe_events", event_type: "state_changed" });
      this.states.clear();
      for (const [entityId, state] of nextStates) this.states.set(entityId, state);
      this.status = "ready";
      this.connectedAt = new Date().toISOString();
      this.lastError = undefined;
      this.reconnectAttempt = 0;
    } catch (error) {
      this.failConnection(safeError(error));
    }
  }

  private handleResult(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number" || !Number.isInteger(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const result = message as unknown as HaResultMessage;
    if (!result.success) {
      pending.reject(new HomeAssistantRequestError(
        `Home Assistant command failed: ${result.error?.message ?? result.error?.code ?? "unknown error"}`,
      ));
      return;
    }
    pending.resolve(result.result);
  }

  private handleEvent(message: Record<string, unknown>): void {
    const event = isRecord(message.event) ? message.event : undefined;
    const data = event && isRecord(event.data) ? event.data : undefined;
    const entityId = data && typeof data.entity_id === "string" ? data.entity_id : undefined;
    if (!entityId) return;
    if (!data) return;
    if (data.new_state === null) {
      this.states.delete(entityId);
      return;
    }
    try {
      this.states.set(entityId, parseState(data.new_state));
    } catch {
      // A malformed state update must not poison the last validated snapshot.
    }
  }

  private sendCommand(command: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HomeAssistantUnavailableError("Home Assistant is not connected"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HomeAssistantUnavailableError("Home Assistant command timed out"));
      }, this.config.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, ...command }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HomeAssistantUnavailableError("Home Assistant command send failed"));
      });
    });
  }

  private assertReady(): void {
    if (this.status !== "ready" || this.socket?.readyState !== WebSocket.OPEN) {
      throw new HomeAssistantUnavailableError("Home Assistant is not ready");
    }
  }

  private failConnection(message: string): void {
    this.lastError = message;
    this.socket?.close(1011, "connection validation failed");
  }

  private handleDisconnect(error: unknown): void {
    if (this.stopped) return;
    this.socket = null;
    this.status = "degraded";
    this.lastDisconnectedAt = new Date().toISOString();
    this.lastError = safeError(error);
    this.rejectPending(new HomeAssistantUnavailableError("Home Assistant connection lost"));
    const delay = reconnectDelay(this.config, this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function defaultWebSocketFactory(url: string): WebSocket {
  return new WebSocket(url, { maxPayload: MAX_WS_PAYLOAD_BYTES });
}

export function toWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function reconnectDelay(config: Pick<HomeAssistantConfig, "reconnectBaseMs" | "reconnectMaxMs">, attempt: number): number {
  return Math.min(config.reconnectMaxMs, config.reconnectBaseMs * (2 ** Math.min(attempt, 8)));
}

function parseState(value: unknown): HomeAssistantState {
  if (!isRecord(value) || typeof value.entity_id !== "string" || typeof value.state !== "string") {
    throw new HomeAssistantRequestError("Home Assistant state is malformed");
  }
  return {
    entity_id: value.entity_id,
    state: value.state,
    attributes: isRecord(value.attributes) ? { ...value.attributes } : {},
    ...(typeof value.last_changed === "string" ? { last_changed: value.last_changed } : {}),
    ...(typeof value.last_updated === "string" ? { last_updated: value.last_updated } : {}),
  };
}

function cloneState(state: HomeAssistantState): HomeAssistantState {
  return { ...state, attributes: { ...state.attributes } };
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
