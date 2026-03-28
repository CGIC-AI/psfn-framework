import * as net from 'node:net';
import type { EventBus, EventMap } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { WyomingFrameCodec, type WyomingFrameCodecOptions } from './codec.js';
import {
  WyomingCodecError,
  WyomingServerError,
  type WyomingFrame,
  type WyomingPolicyViolationDetail,
  type WyomingServerCloseReason,
  type WyomingTransportSession,
  normalizeSessionId,
} from './protocol.js';

const log = createComponentLogger('WyomingTcpServer');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WRITE_QUEUE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FRAMES_PER_WINDOW = 240;
const DEFAULT_FRAME_RATE_WINDOW_MS = 1_000;

type WyomingEventName = Extract<keyof EventMap, `wyoming.${string}`>;

interface ConnectionState {
  session: WyomingTransportSession;
  socket: net.Socket;
  codec: WyomingFrameCodec;
  timeout: NodeJS.Timeout;
  closed: boolean;
  frameQueue: Promise<void>;
  frameWindowStartedAtMs: number;
  framesInWindow: number;
}

export interface WyomingAuditSummary {
  method: string;
  decision: 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL';
  params?: Record<string, unknown>;
  error?: string;
}

export interface WyomingTcpServerOptions extends WyomingFrameCodecOptions {
  host?: string;
  port: number;
  backlog?: number;
  idleTimeoutMs?: number;
  maxWriteQueueBytes?: number;
  maxFramesPerWindow?: number;
  frameRateWindowMs?: number;
  eventBus?: Pick<EventBus, 'emit'>;
  onAuditSummary?: (summary: WyomingAuditSummary) => void | Promise<void>;
  now?: () => number;
  connectionIdFactory?: () => string;
}

export interface WyomingTcpServerHooks {
  onSessionOpen?: (session: WyomingTransportSession) => void | Promise<void>;
  onSessionClose?: (
    session: WyomingTransportSession,
    reason: WyomingServerCloseReason,
  ) => void | Promise<void>;
  onFrame?: (session: WyomingTransportSession, frame: WyomingFrame) => void | Promise<void>;
  onConnectionError?: (session: WyomingTransportSession, error: Error) => void | Promise<void>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function payloadBytes(frame: WyomingFrame): number {
  return frame.payload?.byteLength ?? 0;
}

function toPositiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new WyomingServerError('SERVER_NOT_RUNNING', `${field} must be a positive integer`);
  }
  return resolved;
}

function isPolicyCode(code: string): boolean {
  return code === 'PAYLOAD_TOO_LARGE'
    || code === 'FRAME_TOO_LARGE'
    || code === 'HEADER_TOO_LARGE'
    || code === 'INVALID_PAYLOAD_LENGTH'
    || code === 'WRITE_QUEUE_OVERFLOW'
    || code === 'READ_RATE_LIMIT_EXCEEDED';
}

export class WyomingTcpServer {
  private readonly host: string;
  private readonly port: number;
  private readonly backlog?: number;
  private readonly idleTimeoutMs: number;
  private readonly maxWriteQueueBytes: number;
  private readonly maxFramesPerWindow: number;
  private readonly frameRateWindowMs: number;
  private readonly eventBus: WyomingTcpServerOptions['eventBus'];
  private readonly onAuditSummary: WyomingTcpServerOptions['onAuditSummary'];
  private readonly codecOptions: WyomingFrameCodecOptions;
  private readonly hooks: WyomingTcpServerHooks;
  private readonly now: () => number;
  private readonly connectionIdFactory: () => string;
  private readonly sessions = new Map<string, ConnectionState>();
  private server: net.Server | null = null;
  private connectionCounter = 0;

  constructor(options: WyomingTcpServerOptions, hooks: WyomingTcpServerHooks = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port;
    this.backlog = options.backlog;
    this.idleTimeoutMs = toPositiveInteger(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs');
    this.maxWriteQueueBytes = toPositiveInteger(
      options.maxWriteQueueBytes,
      DEFAULT_MAX_WRITE_QUEUE_BYTES,
      'maxWriteQueueBytes',
    );
    this.maxFramesPerWindow = toPositiveInteger(
      options.maxFramesPerWindow,
      DEFAULT_MAX_FRAMES_PER_WINDOW,
      'maxFramesPerWindow',
    );
    this.frameRateWindowMs = toPositiveInteger(
      options.frameRateWindowMs,
      DEFAULT_FRAME_RATE_WINDOW_MS,
      'frameRateWindowMs',
    );
    this.eventBus = options.eventBus;
    this.onAuditSummary = options.onAuditSummary;
    this.codecOptions = {
      maxHeaderBytes: options.maxHeaderBytes,
      maxPayloadBytes: options.maxPayloadBytes,
      maxFrameBytes: options.maxFrameBytes,
    };
    this.hooks = hooks;
    this.now = options.now ?? (() => Date.now());
    this.connectionIdFactory = options.connectionIdFactory ?? (() => {
      this.connectionCounter += 1;
      return `wyoming-conn-${this.connectionCounter}`;
    });

    if (!Number.isInteger(this.port) || this.port <= 0 || this.port > 65535) {
      throw new WyomingServerError('SERVER_NOT_RUNNING', `port must be in range 1-65535, got ${this.port}`);
    }
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = net.createServer((socket) => {
      this.attachSocket(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host, this.backlog);
    });

    server.on('error', (error) => {
      log.error('Wyoming TCP server error', { error: String(error) });
    });

    this.server = server;
    log.info('Wyoming TCP server listening', { host: this.host, port: this.port });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    for (const state of this.sessions.values()) {
      this.closeSession(state.session.connectionId, 'shutdown');
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.server = null;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  async send(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    const state = this.sessions.get(transportSession.connectionId);
    if (!state || state.closed) {
      const missing = new WyomingServerError(
        'SESSION_NOT_FOUND',
        `No active transport session for ${transportSession.connectionId}`,
      );
      await this.emitDetachedConnectionError(transportSession.connectionId, missing);
      throw missing;
    }

    if (!state.socket.writable || state.socket.destroyed) {
      const closed = new WyomingServerError(
        'SOCKET_CLOSED',
        `Socket for ${transportSession.connectionId} is not writable`,
      );
      await this.reportConnectionError(state.session, closed, {
        closeReason: 'runtime_error',
      });
      throw closed;
    }

    const encoded = state.codec.encode(frame);
    const queuedBytes = state.socket.writableLength;
    const observedBytes = queuedBytes + encoded.byteLength;
    if (observedBytes > this.maxWriteQueueBytes) {
      const overflow = new WyomingServerError(
        'WRITE_QUEUE_OVERFLOW',
        `Write queue exceeded (${observedBytes} > ${this.maxWriteQueueBytes})`,
        {
          scope: 'transport',
          eventType: frame.type,
          sessionId: normalizeSessionId(frame),
          limit: this.maxWriteQueueBytes,
          observed: observedBytes,
        },
      );
      await this.reportConnectionError(state.session, overflow, {
        closeReason: 'backpressure',
      });
      throw overflow;
    }

    await new Promise<void>((resolve, reject) => {
      state.socket.write(encoded, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }).catch(async (error) => {
      await this.reportConnectionError(state.session, toError(error), {
        closeReason: 'runtime_error',
      });
      throw error;
    });

    await this.safeEmitWyomingEvent('wyoming.frame.sent', {
      connectionId: state.session.connectionId,
      frameType: frame.type,
      sessionId: normalizeSessionId(frame),
      payloadBytes: payloadBytes(frame),
      timestampMs: this.now(),
    });
  }

  private attachSocket(socket: net.Socket): void {
    const now = this.now();
    const connectionId = this.connectionIdFactory();

    const session: WyomingTransportSession = {
      id: connectionId,
      connectionId,
      openedAtMs: now,
      lastSeenAtMs: now,
      remoteAddress: socket.remoteAddress ?? undefined,
      remotePort: socket.remotePort ?? undefined,
    };

    const timeout = setTimeout(() => {
      this.closeSession(connectionId, 'timeout');
    }, this.idleTimeoutMs);

    const state: ConnectionState = {
      session,
      socket,
      codec: new WyomingFrameCodec(this.codecOptions),
      timeout,
      closed: false,
      frameQueue: Promise.resolve(),
      frameWindowStartedAtMs: now,
      framesInWindow: 0,
    };

    this.sessions.set(connectionId, state);
    socket.setNoDelay(true);

    socket.on('data', (chunk: Buffer) => {
      this.handleSocketData(state, chunk);
    });

    socket.on('close', () => {
      this.closeSession(connectionId, 'client_disconnect');
    });

    socket.on('error', (error) => {
      void this.reportConnectionError(state.session, toError(error), {
        closeReason: 'runtime_error',
      });
    });

    void this.fireHook('onSessionOpen', session);
    void this.safeEmitWyomingEvent('wyoming.connection.open', {
      connectionId: session.connectionId,
      openedAtMs: session.openedAtMs,
      remoteAddress: session.remoteAddress,
      remotePort: session.remotePort,
      timestampMs: now,
    });
    void this.safeAuditSummary({
      method: 'wyoming.connection.open',
      decision: 'ALLOW',
      params: {
        connectionId: session.connectionId,
        remoteAddress: session.remoteAddress,
        remotePort: session.remotePort,
      },
    });
  }

  private handleSocketData(state: ConnectionState, chunk: Buffer): void {
    if (state.closed) {
      return;
    }

    state.session.lastSeenAtMs = this.now();
    this.resetTimeout(state);

    let frames: WyomingFrame[];
    try {
      frames = state.codec.push(chunk);
    } catch (error) {
      void this.reportConnectionError(state.session, toError(error), {
        closeReason: 'decode_error',
      });
      return;
    }

    state.frameQueue = state.frameQueue.then(async () => {
      for (const frame of frames) {
        if (state.closed) {
          return;
        }

        await this.safeEmitWyomingEvent('wyoming.frame.received', {
          connectionId: state.session.connectionId,
          frameType: frame.type,
          sessionId: normalizeSessionId(frame),
          payloadBytes: payloadBytes(frame),
          timestampMs: this.now(),
        });

        try {
          this.enforceReadRateLimit(state, frame);
          await Promise.resolve(this.hooks.onFrame?.(state.session, frame));
        } catch (error) {
          const normalized = toError(error);
          const closeReason: WyomingServerCloseReason = normalized instanceof WyomingServerError
            && normalized.code === 'READ_RATE_LIMIT_EXCEEDED'
            ? 'rate_limited'
            : 'runtime_error';
          await this.reportConnectionError(state.session, normalized, { closeReason });
          return;
        }
      }
    }).catch((error) => {
      void this.reportConnectionError(state.session, toError(error), {
        closeReason: 'runtime_error',
      });
    });
  }

  private enforceReadRateLimit(state: ConnectionState, frame: WyomingFrame): void {
    const now = this.now();
    if (now - state.frameWindowStartedAtMs >= this.frameRateWindowMs) {
      state.frameWindowStartedAtMs = now;
      state.framesInWindow = 0;
    }

    state.framesInWindow += 1;
    if (state.framesInWindow <= this.maxFramesPerWindow) {
      return;
    }

    throw new WyomingServerError(
      'READ_RATE_LIMIT_EXCEEDED',
      `Read frame rate exceeded (${state.framesInWindow} > ${this.maxFramesPerWindow} in ${this.frameRateWindowMs}ms)`,
      {
        scope: 'transport',
        eventType: frame.type,
        sessionId: normalizeSessionId(frame),
        limit: this.maxFramesPerWindow,
        observed: state.framesInWindow,
      },
    );
  }

  private resetTimeout(state: ConnectionState): void {
    clearTimeout(state.timeout);
    state.timeout = setTimeout(() => {
      this.closeSession(state.session.connectionId, 'timeout');
    }, this.idleTimeoutMs);
  }

  private closeSession(connectionId: string, reason: WyomingServerCloseReason): void {
    const state = this.sessions.get(connectionId);
    if (!state || state.closed) {
      return;
    }

    state.closed = true;
    clearTimeout(state.timeout);
    this.sessions.delete(connectionId);

    if (!state.socket.destroyed) {
      state.socket.removeAllListeners('data');
      state.socket.removeAllListeners('close');
      state.socket.removeAllListeners('error');
      state.socket.destroy();
    }

    const now = this.now();
    const durationMs = Math.max(0, now - state.session.openedAtMs);

    void this.fireHook('onSessionClose', state.session, reason);
    void this.safeEmitWyomingEvent('wyoming.connection.close', {
      connectionId: state.session.connectionId,
      reason,
      openedAtMs: state.session.openedAtMs,
      lastSeenAtMs: state.session.lastSeenAtMs,
      durationMs,
      timestampMs: now,
    });

    const decision = reason === 'client_disconnect' || reason === 'shutdown' ? 'ALLOW' : 'DENY';
    void this.safeAuditSummary({
      method: 'wyoming.connection.close',
      decision,
      params: {
        connectionId: state.session.connectionId,
        reason,
        durationMs,
      },
    });
  }

  private async reportConnectionError(
    session: WyomingTransportSession,
    error: Error,
    options: {
      closeReason: WyomingServerCloseReason;
    },
  ): Promise<void> {
    await this.fireHook('onConnectionError', session, error);

    const code = this.resolveErrorCode(error);
    const detail = this.resolvePolicyDetail(error, code);

    await this.safeEmitWyomingEvent('wyoming.connection.error', {
      connectionId: session.connectionId,
      code,
      error: error.message,
      timestampMs: this.now(),
    });

    if (detail) {
      await this.safeEmitWyomingEvent('wyoming.policy.violation', {
        connectionId: session.connectionId,
        scope: detail.scope,
        code,
        message: error.message,
        sessionId: detail.sessionId,
        eventType: detail.eventType,
        limit: detail.limit,
        observed: detail.observed,
        action: 'close_connection',
        timestampMs: this.now(),
      });
    }

    await this.safeAuditSummary({
      method: detail ? 'wyoming.policy.violation' : 'wyoming.connection.error',
      decision: 'DENY',
      params: {
        connectionId: session.connectionId,
        code,
        scope: detail?.scope,
        eventType: detail?.eventType,
        sessionId: detail?.sessionId,
        limit: detail?.limit,
        observed: detail?.observed,
        closeReason: options.closeReason,
      },
      error: error.message,
    });

    this.closeSession(session.connectionId, options.closeReason);
  }

  private async emitDetachedConnectionError(connectionId: string, error: Error): Promise<void> {
    const code = this.resolveErrorCode(error);
    await this.safeEmitWyomingEvent('wyoming.connection.error', {
      connectionId,
      code,
      error: error.message,
      timestampMs: this.now(),
    });
    await this.safeAuditSummary({
      method: 'wyoming.connection.error',
      decision: 'DENY',
      params: {
        connectionId,
        code,
      },
      error: error.message,
    });
  }

  private resolveErrorCode(error: Error): string {
    const candidate = error as Partial<{ code: unknown }>;
    if (typeof candidate.code === 'string' && candidate.code.trim()) {
      return candidate.code;
    }
    return 'INTERNAL_CONNECTION_ERROR';
  }

  private resolvePolicyDetail(error: Error, code: string): WyomingPolicyViolationDetail | undefined {
    const withDetail = error as Partial<{ detail: WyomingPolicyViolationDetail }>;
    if (withDetail.detail && typeof withDetail.detail.scope === 'string') {
      return withDetail.detail;
    }

    if (error instanceof WyomingCodecError) {
      return {
        scope: 'codec',
      };
    }

    if (error instanceof WyomingServerError && isPolicyCode(code)) {
      return {
        scope: 'transport',
      };
    }

    return undefined;
  }

  private async safeEmitWyomingEvent<E extends WyomingEventName>(event: E, data: EventMap[E]): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    try {
      await this.eventBus.emit(event, data);
    } catch (error) {
      log.warn('Failed to emit Wyoming telemetry event', {
        event,
        error: String(error),
      });
    }
  }

  private async safeAuditSummary(summary: WyomingAuditSummary): Promise<void> {
    await this.safeEmitWyomingEvent('wyoming.audit.summary', {
      ...summary,
      timestampMs: this.now(),
    });

    if (!this.onAuditSummary) {
      return;
    }

    try {
      await Promise.resolve(this.onAuditSummary(summary));
    } catch (error) {
      log.warn('Wyoming audit summary hook failed', {
        method: summary.method,
        decision: summary.decision,
        error: String(error),
      });
    }
  }

  private async fireHook(
    hook: 'onSessionOpen',
    session: WyomingTransportSession,
  ): Promise<void>;
  private async fireHook(
    hook: 'onSessionClose',
    session: WyomingTransportSession,
    reason: WyomingServerCloseReason,
  ): Promise<void>;
  private async fireHook(
    hook: 'onConnectionError',
    session: WyomingTransportSession,
    error: Error,
  ): Promise<void>;
  private async fireHook(
    hook: keyof WyomingTcpServerHooks,
    session: WyomingTransportSession,
    value?: unknown,
  ): Promise<void> {
    const fn = this.hooks[hook];
    if (!fn) {
      return;
    }

    try {
      await Promise.resolve(
        hook === 'onSessionOpen'
          ? (fn as NonNullable<WyomingTcpServerHooks['onSessionOpen']>)(session)
          : hook === 'onSessionClose'
            ? (fn as NonNullable<WyomingTcpServerHooks['onSessionClose']>)(
              session,
              value as WyomingServerCloseReason,
            )
            : (fn as NonNullable<WyomingTcpServerHooks['onConnectionError']>)(
              session,
              value as Error,
            ),
      );
    } catch (error) {
      log.warn('Wyoming TCP server hook failed', {
        hook,
        connectionId: session.connectionId,
        error: String(error),
      });
    }
  }
}
