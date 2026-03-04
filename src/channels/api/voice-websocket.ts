import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createComponentLogger } from '../../logger.js';
import type { WebSocketVoiceConnection } from '../../voice/transports/websocket/types.js';
import {
  getBearerToken,
  getCookieValue,
  isExpectedApiToken,
  principalFromApiKeyToken,
  INSECURE_LOCAL_API_PRINCIPAL,
  type ApiAuthPrincipal,
} from '../http/auth.js';

const log = createComponentLogger('ApiVoiceWebSocket');

const DEFAULT_VOICE_WEBSOCKET_PATH = '/v1/voice/ws';
const CLOSE_CODE_SERVER_SHUTDOWN = 1012;
const AUTH_SUBPROTOCOL_PREFIX = 'auth.b64.';

type UpgradeRejectStatus = 401 | 404;

export type VoiceWebSocketCloseReason = 'client_disconnect' | 'shutdown';

export interface WebSocketVoiceSession {
  id: string;
  openedAtMs: number;
  lastSeenAtMs: number;
}

export interface VoiceWebSocketRuntimeContext {
  request: IncomingMessage;
  principal: ApiAuthPrincipal;
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

function parseWebSocketProtocols(req: IncomingMessage): string[] {
  const headerValue = req.headers['sec-websocket-protocol'];
  if (!headerValue) return [];

  const combined = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  return combined
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

function decodeBase64Url(value: string): string | null {
  if (!value) return null;

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    return null;
  }

  const padded = remainder === 0
    ? normalized
    : `${normalized}${'='.repeat(4 - remainder)}`;

  try {
    return Buffer.from(padded, 'base64').toString('utf8').trim();
  } catch {
    return null;
  }
}

function getAuthTokenFromSubprotocol(req: IncomingMessage): string | null {
  const protocols = parseWebSocketProtocols(req);
  for (const protocol of protocols) {
    if (!protocol.startsWith(AUTH_SUBPROTOCOL_PREFIX)) continue;
    const encodedToken = protocol.slice(AUTH_SUBPROTOCOL_PREFIX.length);
    const decodedToken = decodeBase64Url(encodedToken);
    if (decodedToken) {
      return decodedToken;
    }
  }

  return null;
}

function redactRequestPath(rawUrl: string | undefined): string {
  if (!rawUrl) return '/';
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    return parsed.pathname;
  } catch {
    return rawUrl.split('?')[0] ?? '/';
  }
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
    this.apiKey = config.apiKey?.trim() || undefined;
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

    const principal = this.resolvePrincipal(req);
    if (!principal) {
      sendUpgradeRejection(socket, 401);
      return true;
    }

    this.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      this.attachSocket(ws, req, principal);
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

  private resolvePrincipal(req: IncomingMessage): ApiAuthPrincipal | null {
    if (!this.apiKey) {
      return INSECURE_LOCAL_API_PRINCIPAL;
    }

    const bearerToken = getBearerToken(req);
    if (isExpectedApiToken(bearerToken, this.apiKey)) {
      return principalFromApiKeyToken(this.apiKey);
    }

    const cookieToken = getCookieValue(req, 'psfn_api_token')
      ?? getCookieValue(req, 'api_key');
    if (isExpectedApiToken(cookieToken, this.apiKey)) {
      return principalFromApiKeyToken(this.apiKey);
    }

    const subprotocolToken = getAuthTokenFromSubprotocol(req);
    if (!isExpectedApiToken(subprotocolToken, this.apiKey)) return null;

    return principalFromApiKeyToken(this.apiKey);
  }

  private attachSocket(ws: WebSocket, req: IncomingMessage, principal: ApiAuthPrincipal): void {
    const connection = createVoiceConnection(`api-voice-${randomUUID()}`, ws);
    const detachRuntime = this.runtime.attach(connection, { request: req, principal });

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

    log.debug('Voice websocket connected', {
      connectionId: connection.id,
      path: redactRequestPath(req.url),
    });
  }

  rejectUnknownUpgrade(socket: Duplex): void {
    sendUpgradeRejection(socket, 404);
  }
}
