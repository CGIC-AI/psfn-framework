import * as net from 'node:net';
import { createComponentLogger } from '../../logger.js';
import { WyomingFrameCodec, type WyomingFrameCodecOptions } from './codec.js';
import {
  WyomingServerError,
  type WyomingFrame,
  type WyomingServerCloseReason,
  type WyomingTransportSession,
} from './protocol.js';

const log = createComponentLogger('WyomingTcpServer');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WRITE_QUEUE_BYTES = 1024 * 1024;

interface ConnectionState {
  session: WyomingTransportSession;
  socket: net.Socket;
  codec: WyomingFrameCodec;
  timeout: NodeJS.Timeout;
  closed: boolean;
  frameQueue: Promise<void>;
}

export interface WyomingTcpServerOptions extends WyomingFrameCodecOptions {
  host?: string;
  port: number;
  backlog?: number;
  idleTimeoutMs?: number;
  maxWriteQueueBytes?: number;
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

export class WyomingTcpServer {
  private readonly host: string;
  private readonly port: number;
  private readonly backlog?: number;
  private readonly idleTimeoutMs: number;
  private readonly maxWriteQueueBytes: number;
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
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxWriteQueueBytes = options.maxWriteQueueBytes ?? DEFAULT_MAX_WRITE_QUEUE_BYTES;
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
    if (!Number.isInteger(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) {
      throw new WyomingServerError('SERVER_NOT_RUNNING', 'idleTimeoutMs must be a positive integer');
    }
    if (!Number.isInteger(this.maxWriteQueueBytes) || this.maxWriteQueueBytes <= 0) {
      throw new WyomingServerError('SERVER_NOT_RUNNING', 'maxWriteQueueBytes must be a positive integer');
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
      throw new WyomingServerError(
        'SESSION_NOT_FOUND',
        `No active transport session for ${transportSession.connectionId}`,
      );
    }

    if (!state.socket.writable || state.socket.destroyed) {
      this.closeSession(state.session.connectionId, 'runtime_error');
      throw new WyomingServerError(
        'SOCKET_CLOSED',
        `Socket for ${transportSession.connectionId} is not writable`,
      );
    }

    const encoded = state.codec.encode(frame);
    const queuedBytes = state.socket.writableLength;
    if (queuedBytes + encoded.byteLength > this.maxWriteQueueBytes) {
      this.closeSession(state.session.connectionId, 'backpressure');
      throw new WyomingServerError(
        'WRITE_QUEUE_OVERFLOW',
        `Write queue exceeded (${queuedBytes + encoded.byteLength} > ${this.maxWriteQueueBytes})`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      state.socket.write(encoded, (error) => {
        if (error) {
          this.closeSession(state.session.connectionId, 'runtime_error');
          reject(error);
          return;
        }

        resolve();
      });
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
      void this.fireHook('onConnectionError', state.session, error);
      this.closeSession(connectionId, 'runtime_error');
    });

    void this.fireHook('onSessionOpen', session);
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
      const normalized = error instanceof Error ? error : new Error(String(error));
      void this.fireHook('onConnectionError', state.session, normalized);
      this.closeSession(state.session.connectionId, 'decode_error');
      return;
    }

    state.frameQueue = state.frameQueue.then(async () => {
      for (const frame of frames) {
        if (state.closed) {
          return;
        }

        try {
          await Promise.resolve(this.hooks.onFrame?.(state.session, frame));
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          await this.fireHook('onConnectionError', state.session, normalized);
          this.closeSession(state.session.connectionId, 'runtime_error');
          return;
        }
      }
    }).catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      void this.fireHook('onConnectionError', state.session, normalized);
      this.closeSession(state.session.connectionId, 'runtime_error');
    });
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

    void this.fireHook('onSessionClose', state.session, reason);
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
