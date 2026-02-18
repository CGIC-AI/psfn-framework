import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createComponentLogger } from '../../logger.js';
import type { WebSocketVoiceConnection } from '../../voice/transports/websocket/types.js';

const log = createComponentLogger('ApiVoiceWebSocket');

const DEFAULT_VOICE_WEBSOCKET_PATH = '/v1/voice/ws';
const CLOSE_CODE_SERVER_SHUTDOWN = 1012;

type UpgradeRejectStatus = 401 | 404;

export type VoiceWebSocketCloseReason = 'client_disconnect' | 'shutdown';

export interface WebSocketVoiceSession {
  id: string;
  openedAtMs: number;
  lastSeenAtMs: number;
}

export interface VoiceWebSocketRuntimeContext {
  request: IncomingMessage;
}

export interface VoiceWebSocketRuntime {
  attach(connection: WebSocketVoiceConnection, context: VoiceWebSocketRuntimeContext): () => void;
  stop(): void | Promise<void>;
}

export interface VoiceWebSocketRuntimeHooks {
  onSessionOpen?: (session: WebSocketVoiceSession, context: VoiceWebSocketRuntimeContext) => void | Promise<void>;
  onSessionClose?: (session: WebSocketVoiceSession, reason: VoiceWebSocketCloseReason) => void | Promise<void>;
  onMessage?: (session: WebSocketVoiceSession, data: string) => void | Promise<void>;
}

export interface ApiVoiceWebSocketConfig {
  apiKey?: string;
  path?: string;
  runtime?: VoiceWebSocketRuntime;
  runtimeHooks?: VoiceWebSocketRuntimeHooks;
  now?: () => number;
  createWebSocketServer?: () => WebSocketServer;
}

interface ActiveConnection {
  close: () => void;
}

function fireHook(fn: (() => void | Promise<void>) | undefined): void {
  if (!fn) return;
  Promise.resolve(fn()).catch((error) => {
    log.warn('Voice websocket hook failed', { error: String(error) });
  });
}

function decodeRawData(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Buffer) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function sendUpgradeRejection(socket: Duplex, status: UpgradeRejectStatus): void {
  if (socket.destroyed) return;

  const statusText = status === 401 ? 'Unauthorized' : 'Not Found';
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n\r\n',
  );
  socket.destroy();
}

function createVoiceConnection(connectionId: string, socket: WebSocket): WebSocketVoiceConnection {
  const messageHandlers = new Set<(data: string) => void>();
  const closeHandlers = new Set<() => void>();

  socket.on('message', (raw: RawData) => {
    const data = decodeRawData(raw);
    for (const handler of [...messageHandlers]) {
      handler(data);
    }
  });

  socket.once('close', () => {
    for (const handler of [...closeHandlers]) {
      handler();
    }
    messageHandlers.clear();
    closeHandlers.clear();
  });

  return {
    id: connectionId,
    send(data: string): void {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(data);
    },
    close(code?: number, reason?: string): void {
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
      socket.close(code, reason);
    },
    onMessage(handler: (data: string) => void): () => void {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onClose(handler: () => void): () => void {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
  };
}

export function createHookVoiceWebSocketRuntime(
  hooks: VoiceWebSocketRuntimeHooks = {},
  now: () => number = () => Date.now(),
): VoiceWebSocketRuntime {
  const activeSessions = new Map<string, () => void>();

  return {
    attach(connection: WebSocketVoiceConnection, context: VoiceWebSocketRuntimeContext): () => void {
      const openedAtMs = now();
      const session: WebSocketVoiceSession = {
        id: connection.id,
        openedAtMs,
        lastSeenAtMs: openedAtMs,
      };

      fireHook(() => hooks.onSessionOpen?.(session, context));

      let closed = false;
      let removeMessageListener = () => {};
      let removeCloseListener = () => {};

      const closeSession = (reason: VoiceWebSocketCloseReason): void => {
        if (closed) return;
        closed = true;

        removeMessageListener();
        removeCloseListener();
        activeSessions.delete(session.id);
        fireHook(() => hooks.onSessionClose?.(session, reason));
      };

      removeMessageListener = connection.onMessage((data) => {
        session.lastSeenAtMs = now();
        fireHook(() => hooks.onMessage?.(session, data));
      });

      removeCloseListener = connection.onClose(() => {
        closeSession('client_disconnect');
      });

      activeSessions.set(session.id, () => {
        closeSession('shutdown');
      });

      return () => {
        closeSession('shutdown');
      };
    },
    stop(): void {
      for (const closeSession of activeSessions.values()) {
        closeSession();
      }
      activeSessions.clear();
    },
  };
}

export class ApiVoiceWebSocketAdapter {
  private readonly apiKey?: string;
  private readonly path: string;
  private readonly runtime: VoiceWebSocketRuntime;
  private readonly now: () => number;
  private readonly webSocketServer: WebSocketServer;
  private readonly activeConnections = new Map<string, ActiveConnection>();
  private stopped = false;

  constructor(config: ApiVoiceWebSocketConfig = {}) {
    this.apiKey = config.apiKey;
    this.path = config.path ?? DEFAULT_VOICE_WEBSOCKET_PATH;
    this.now = config.now ?? (() => Date.now());
    this.runtime = config.runtime ?? createHookVoiceWebSocketRuntime(config.runtimeHooks, this.now);
    this.webSocketServer = config.createWebSocketServer
      ? config.createWebSocketServer()
      : new WebSocketServer({ noServer: true });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== this.path) {
      return false;
    }

    if (!this.checkAuth(req)) {
      sendUpgradeRejection(socket, 401);
      return true;
    }

    this.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      this.attachSocket(ws, req);
    });

    return true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    for (const active of this.activeConnections.values()) {
      active.close();
    }
    this.activeConnections.clear();
    await Promise.resolve(this.runtime.stop());

    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close((error) => {
        if (error && error.message !== 'The server is not running') {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.apiKey) return true;

    const auth = req.headers.authorization;
    return !!auth && auth.startsWith('Bearer ') && auth.slice(7) === this.apiKey;
  }

  private attachSocket(ws: WebSocket, req: IncomingMessage): void {
    const connection = createVoiceConnection(`api-voice-${randomUUID()}`, ws);
    const detachRuntime = this.runtime.attach(connection, { request: req });

    let closed = false;
    let removeCloseListener = () => {};

    const closeActiveConnection = (closeSocket: boolean): void => {
      if (closed) return;
      closed = true;

      removeCloseListener();
      this.activeConnections.delete(connection.id);
      detachRuntime();

      if (closeSocket) {
        connection.close(CLOSE_CODE_SERVER_SHUTDOWN, 'server shutdown');
      }
    };

    removeCloseListener = connection.onClose(() => {
      closeActiveConnection(false);
    });

    this.activeConnections.set(connection.id, {
      close: () => {
        closeActiveConnection(true);
      },
    });

    log.debug('Voice websocket connected', { connectionId: connection.id, path: req.url });
  }

  rejectUnknownUpgrade(socket: Duplex): void {
    sendUpgradeRejection(socket, 404);
  }
}
