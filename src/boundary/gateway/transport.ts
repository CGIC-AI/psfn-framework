// ── Gateway RPC transports ──
// Shared by gateway server and agent client.

import * as net from 'node:net';
import * as https from 'node:https';
import * as readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { unlinkSync, chmodSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { WebSocket, WebSocketServer } from 'ws';
import { createComponentLogger } from '../../shared/logger.js';
import {
  createSpiffeCheckServerIdentity,
  normalizeSpiffeUri,
  requireMtlsPeerFileConfig,
  verifyPeerCertificateSpiffeUri,
} from '../../shared/net/mtls.js';

const log = createComponentLogger('Transport');
const FRAME_PREVIEW_LIMIT = 200;
const GATEWAY_RPC_HEARTBEAT_PING_FRAME = 'PSFN_RPC_HEARTBEAT_PING';
const GATEWAY_RPC_HEARTBEAT_PONG_FRAME = 'PSFN_RPC_HEARTBEAT_PONG';
export const GATEWAY_RPC_WS_PROTOCOL = 'psfn-rpc-v1';
export const DEFAULT_GATEWAY_RPC_WS_PATH = '/rpc';
export const GATEWAY_RPC_ENDPOINT_ENV = 'GATEWAY_RPC_ENDPOINT';
export const GATEWAY_RPC_TLS_CA_PATH_ENV = 'GATEWAY_RPC_TLS_CA_PATH';
export const GATEWAY_RPC_TLS_CERT_PATH_ENV = 'GATEWAY_RPC_TLS_CERT_PATH';
export const GATEWAY_RPC_TLS_KEY_PATH_ENV = 'GATEWAY_RPC_TLS_KEY_PATH';
export const GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI_ENV = 'GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI';
export const GATEWAY_RPC_TLS_SERVER_NAME_ENV = 'GATEWAY_RPC_TLS_SERVER_NAME';

export interface TransportOptions {
  socketPath: string;
}

export interface SocketServerOptions {
  onStartupError?: (error: NodeJS.ErrnoException) => void;
}

type MessageHandler = (message: unknown) => void;

export interface GatewayRpcMethodSerializedTransportStats {
  callCount: number;
  serializedBytes: number;
}

/** Exact UTF-8 JSON payload bytes written by one RPC connection. */
export interface GatewayRpcSerializedTransportStats {
  frameCount: number;
  serializedBytes: number;
  rpcCallCount: number;
  byMethod: Record<string, GatewayRpcMethodSerializedTransportStats>;
}

export interface GatewayRpcConnection extends EventEmitter {
  /**
   * Returns true only when the transport accepted the complete frame into its
   * outbound path. A false result means nothing was accepted. For NDJSON,
   * `net.Socket.write(false)` is still acceptance with backpressure.
   */
  send(data: unknown): boolean;
  /** Send a transport-level liveness probe without entering JSON-RPC or audit handling. */
  sendHeartbeat(): boolean;
  onMessage(handler: MessageHandler): void;
  destroy(): void;
  readonly destroyed: boolean;
  readonly serializedTransportStats: GatewayRpcSerializedTransportStats;
}

interface MutableSerializedTransportStats {
  frameCount: number;
  serializedBytes: number;
  rpcCallCount: number;
  byMethod: Map<string, GatewayRpcMethodSerializedTransportStats>;
}

function createSerializedTransportStats(): MutableSerializedTransportStats {
  return {
    frameCount: 0,
    serializedBytes: 0,
    rpcCallCount: 0,
    byMethod: new Map(),
  };
}

function recordSerializedTransportFrame(
  stats: MutableSerializedTransportStats,
  data: unknown,
  serialized: string,
): void {
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  stats.frameCount += 1;
  stats.serializedBytes += serializedBytes;
  const method = typeof data === 'object'
    && data !== null
    && 'method' in data
    && typeof data.method === 'string'
    ? data.method
    : null;
  if (!method) return;
  stats.rpcCallCount += 1;
  const methodStats = stats.byMethod.get(method) ?? { callCount: 0, serializedBytes: 0 };
  methodStats.callCount += 1;
  methodStats.serializedBytes += serializedBytes;
  stats.byMethod.set(method, methodStats);
}

function snapshotSerializedTransportStats(
  stats: MutableSerializedTransportStats,
): GatewayRpcSerializedTransportStats {
  return {
    frameCount: stats.frameCount,
    serializedBytes: stats.serializedBytes,
    rpcCallCount: stats.rpcCallCount,
    byMethod: Object.fromEntries(
      [...stats.byMethod].map(([method, methodStats]) => [method, { ...methodStats }]),
    ),
  };
}

export interface GatewayRpcTlsFileConfig {
  caPath: string;
  certPath: string;
  keyPath: string;
  expectedPeerSpiffeUri: string;
  serverName?: string;
}

export interface GatewayRpcUnixEndpoint {
  kind: 'unix';
  socketPath: string;
}

export interface GatewayRpcWssEndpoint {
  kind: 'wss';
  url: string;
  host: string;
  port: number;
  path: string;
  tls: GatewayRpcTlsFileConfig;
}

export type GatewayRpcEndpoint = GatewayRpcUnixEndpoint | GatewayRpcWssEndpoint;

export interface GatewayRpcEndpointEnv extends NodeJS.ProcessEnv {
  GATEWAY_RPC_ENDPOINT?: string;
  GATEWAY_SOCKET?: string;
  GATEWAY_RPC_TLS_CA_PATH?: string;
  GATEWAY_RPC_TLS_CERT_PATH?: string;
  GATEWAY_RPC_TLS_KEY_PATH?: string;
  GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI?: string;
  GATEWAY_RPC_TLS_SERVER_NAME?: string;
}

export function resolveGatewayRpcEndpointFromEnv(
  env: GatewayRpcEndpointEnv,
  defaultSocketPath: string,
): GatewayRpcEndpoint {
  const rawEndpoint = parseOptionalEnvString(env.GATEWAY_RPC_ENDPOINT);
  if (!rawEndpoint) {
    return {
      kind: 'unix',
      socketPath: parseOptionalEnvString(env.GATEWAY_SOCKET) ?? defaultSocketPath,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    throw new Error(
      `${GATEWAY_RPC_ENDPOINT_ENV} must be a unix:///path.sock or wss://host:port/path endpoint.`,
    );
  }

  if (parsed.protocol === 'unix:') {
    if (parsed.hostname || parsed.search || parsed.hash || !parsed.pathname) {
      throw new Error(`${GATEWAY_RPC_ENDPOINT_ENV}=unix must use unix:///absolute/path.sock with no host, query, or hash.`);
    }
    if (!parsed.pathname.startsWith('/')) {
      throw new Error(`${GATEWAY_RPC_ENDPOINT_ENV}=unix must use an absolute socket path.`);
    }
    return {
      kind: 'unix',
      socketPath: decodeURIComponent(parsed.pathname),
    };
  }

  if (parsed.protocol !== 'wss:') {
    throw new Error(`${GATEWAY_RPC_ENDPOINT_ENV} must use unix:// or wss://. Plain ws:// is not allowed.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${GATEWAY_RPC_ENDPOINT_ENV}=wss must not include credentials, query, or hash components.`);
  }
  if (!parsed.hostname) {
    throw new Error(`${GATEWAY_RPC_ENDPOINT_ENV}=wss requires a host.`);
  }
  if (!parsed.port) {
    throw new Error(`${GATEWAY_RPC_ENDPOINT_ENV}=wss requires an explicit port.`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${GATEWAY_RPC_ENDPOINT_ENV}=wss requires a port between 1 and 65535.`);
  }

  const path = normalizeRpcWebSocketPath(parsed.pathname);
  parsed.pathname = path;
  return {
    kind: 'wss',
    url: parsed.toString(),
    host: parsed.hostname,
    port,
    path,
    tls: resolveGatewayRpcTlsConfigFromEnv(env),
  };
}

export function formatGatewayRpcEndpoint(endpoint: GatewayRpcEndpoint): string {
  return endpoint.kind === 'unix' ? endpoint.socketPath : endpoint.url;
}

export class NdjsonFramingError extends Error {
  readonly preview: string;

  constructor(line: string) {
    super('Malformed NDJSON frame received');
    this.name = 'NdjsonFramingError';
    this.preview = summarizeFramePreview(line);
  }
}

function summarizeFramePreview(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= FRAME_PREVIEW_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, FRAME_PREVIEW_LIMIT)}... (${trimmed.length} chars)`;
}

// ── Socket connection wrapper (both client and server connections) ──

export class NdjsonConnection extends EventEmitter implements GatewayRpcConnection {
  private socket: net.Socket;
  private rl: readline.Interface;
  private closed = false;
  private heartbeatAwaitingAck = false;
  private readonly outboundStats = createSerializedTransportStats();

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    this.rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    this.rl.on('line', (line) => {
      if (line === GATEWAY_RPC_HEARTBEAT_PING_FRAME) {
        this.emit('heartbeat');
        this.writeHeartbeatFrame(GATEWAY_RPC_HEARTBEAT_PONG_FRAME);
        return;
      }
      if (line === GATEWAY_RPC_HEARTBEAT_PONG_FRAME) {
        this.heartbeatAwaitingAck = false;
        return;
      }
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        this.emit('message', parsed);
      } catch {
        const framingError = new NdjsonFramingError(line);
        log.error('Malformed NDJSON frame received; closing connection', {
          preview: framingError.preview,
        });
        this.emit('frameError', framingError);
        this.destroy();
      }
    });
    this.rl.on('error', (err) => {
      this.emitConnectionError(err);
      this.destroy();
    });

    socket.on('close', () => this.finishClose());
    socket.on('error', (err) => this.emitConnectionError(err));
  }

  send(data: unknown): boolean {
    if (this.socket.destroyed) return false;
    try {
      const serialized = JSON.stringify(data);
      // Node's boolean reports buffer pressure, not frame acceptance: false
      // means this frame was queued, not rejected, so it cannot be reused as
      // the delivery-receipt result.
      this.socket.write(serialized + '\n');
      recordSerializedTransportFrame(this.outboundStats, data, serialized);
      return true;
    } catch (error) {
      this.emitConnectionError(error);
      return false;
    }
  }

  sendHeartbeat(): boolean {
    if (this.socket.destroyed || this.heartbeatAwaitingAck) return false;
    this.heartbeatAwaitingAck = true;
    if (this.writeHeartbeatFrame(GATEWAY_RPC_HEARTBEAT_PING_FRAME)) {
      return true;
    }
    this.heartbeatAwaitingAck = false;
    return false;
  }

  onMessage(handler: MessageHandler): void {
    this.on('message', handler);
  }

  destroy(): void {
    if (this.closed) return;
    this.rl.close();
    this.socket.destroy();
    this.finishClose();
  }

  get destroyed(): boolean {
    return this.socket.destroyed;
  }

  get serializedTransportStats(): GatewayRpcSerializedTransportStats {
    return snapshotSerializedTransportStats(this.outboundStats);
  }

  private emitConnectionError(err: unknown): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
      return;
    }
    log.warn('Socket connection error without listener', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private writeHeartbeatFrame(frame: string): boolean {
    if (this.socket.destroyed) return false;
    try {
      this.socket.write(`${frame}\n`);
      return true;
    } catch (error) {
      this.emitConnectionError(error);
      return false;
    }
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    this.rl.removeAllListeners();
    this.socket.removeAllListeners();
    this.removeAllListeners();
  }
}

class WebSocketRpcConnection extends EventEmitter implements GatewayRpcConnection {
  private readonly outboundStats = createSerializedTransportStats();
  private heartbeatAwaitingAck = false;

  constructor(private readonly socket: WebSocket) {
    super();

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const framingError = new NdjsonFramingError('<binary websocket frame>');
        log.error('Binary websocket RPC frame received; closing connection');
        this.emit('frameError', framingError);
        this.destroy();
        return;
      }

      const text = normalizeWebSocketMessage(data);
      if (!text.trim()) return;
      try {
        const parsed = JSON.parse(text);
        this.emit('message', parsed);
      } catch {
        const framingError = new NdjsonFramingError(text);
        log.error('Malformed websocket RPC frame received; closing connection', {
          preview: framingError.preview,
        });
        this.emit('frameError', framingError);
        this.destroy();
      }
    });

    socket.on('close', () => this.emit('close'));
    socket.on('error', (err) => this.emitConnectionError(err));
    socket.on('ping', () => this.emit('heartbeat'));
    socket.on('pong', () => {
      this.heartbeatAwaitingAck = false;
    });
  }

  send(data: unknown): boolean {
    if (this.destroyed || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      const serialized = JSON.stringify(data);
      this.socket.send(serialized);
      recordSerializedTransportFrame(this.outboundStats, data, serialized);
      return true;
    } catch (error) {
      this.emitConnectionError(error);
      return false;
    }
  }

  sendHeartbeat(): boolean {
    if (this.destroyed || this.socket.readyState !== WebSocket.OPEN || this.heartbeatAwaitingAck) {
      return false;
    }
    this.heartbeatAwaitingAck = true;
    try {
      this.socket.ping();
      return true;
    } catch (error) {
      this.heartbeatAwaitingAck = false;
      this.emitConnectionError(error);
      return false;
    }
  }

  onMessage(handler: MessageHandler): void {
    this.on('message', handler);
  }

  destroy(): void {
    if (
      this.socket.readyState === WebSocket.CLOSING
      || this.socket.readyState === WebSocket.CLOSED
    ) {
      return;
    }
    this.socket.terminate();
  }

  get destroyed(): boolean {
    return (
      this.socket.readyState === WebSocket.CLOSING
      || this.socket.readyState === WebSocket.CLOSED
    );
  }

  get serializedTransportStats(): GatewayRpcSerializedTransportStats {
    return snapshotSerializedTransportStats(this.outboundStats);
  }

  private emitConnectionError(err: unknown): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
      return;
    }
    log.warn('Websocket RPC connection error without listener', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function normalizeWebSocketMessage(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

// ── Server: listens on Unix socket, accepts connections ──

export function createSocketServer(
  socketPath: string,
  onConnection: (conn: GatewayRpcConnection) => void,
  options: SocketServerOptions = {},
): net.Server {
  // Clean up stale socket file
  try {
    unlinkSync(socketPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      log.warn('Failed to remove stale socket path', {
        socketPath,
        code: e.code,
        errno: e.errno,
        syscall: e.syscall,
        error: e.message,
      });
    }
  }

  const server = net.createServer((socket) => {
    const conn = new NdjsonConnection(socket);
    onConnection(conn);
  });

  let listening = false;

  server.on('error', (err: NodeJS.ErrnoException) => {
    const startupPhase = !listening;
    log.error(startupPhase ? 'Socket server startup error' : 'Socket server error', {
      socketPath,
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
      error: err.message,
    });

    if (startupPhase) {
      if (options.onStartupError) {
        options.onStartupError(err);
      } else {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  });

  server.once('listening', () => {
    listening = true;

    // Make socket accessible
    try {
      chmodSync(socketPath, 0o770);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      log.warn('Failed to set socket permissions', {
        socketPath,
        code: e.code,
        errno: e.errno,
        syscall: e.syscall,
        error: e.message,
      });
    }
    log.info(`Listening on ${socketPath}`);
  });

  try {
    server.listen(socketPath);
  } catch (err) {
    const startupErr = err as NodeJS.ErrnoException;
    log.error('Socket server listen threw synchronously', {
      socketPath,
      code: startupErr.code,
      errno: startupErr.errno,
      syscall: startupErr.syscall,
      error: startupErr.message,
    });
    if (options.onStartupError) {
      options.onStartupError(startupErr);
    } else {
      throw startupErr;
    }
  }

  return server;
}

export interface WebSocketRpcServerOptions extends SocketServerOptions {
  host: string;
  port: number;
  path?: string;
  tls: GatewayRpcTlsFileConfig;
  authorizePeer?: GatewayRpcUpgradeAuthorizer;
}

export type GatewayRpcUpgradeAuthorizer = (input: {
  request: IncomingMessage;
}) => string | null;

export function createWebSocketRpcServer(
  options: WebSocketRpcServerOptions,
  onConnection: (conn: GatewayRpcConnection) => void,
): https.Server {
  const path = normalizeRpcWebSocketPath(options.path);
  const tlsConfig = requireMtlsPeerFileConfig(options.tls, 'Gateway RPC WSS TLS');
  const tlsOptions = loadGatewayRpcServerTlsOptions(tlsConfig);
  const authorizePeer = options.authorizePeer
    ?? ((input) => authorizeMutualTlsPeer(input, tlsConfig.expectedPeerSpiffeUri));
  const webSocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (
      protocols.has(GATEWAY_RPC_WS_PROTOCOL) ? GATEWAY_RPC_WS_PROTOCOL : false
    ),
  });
  const server = https.createServer(tlsOptions, (_req, res) => {
    res.writeHead(404);
    res.end('Not found');
  });

  let listening = false;

  server.on('upgrade', (req, socket, head) => {
    const requestPath = new URL(req.url ?? '/', 'https://localhost').pathname;
    if (requestPath !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!upgradeRequestIncludesProtocol(req)) {
      socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n');
      socket.destroy();
      return;
    }

    const rejectionReason = authorizePeer({ request: req });
    if (rejectionReason) {
      log.warn('Rejected gateway RPC websocket peer', { reason: rejectionReason });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      if (ws.protocol !== GATEWAY_RPC_WS_PROTOCOL) {
        ws.close(1002, 'unsupported_protocol');
        return;
      }
      onConnection(new WebSocketRpcConnection(ws));
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    const startupPhase = !listening;
    log.error(startupPhase ? 'Gateway RPC websocket startup error' : 'Gateway RPC websocket error', {
      host: options.host,
      port: options.port,
      path,
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
      error: err.message,
    });

    if (startupPhase) {
      if (options.onStartupError) {
        options.onStartupError(err);
      } else {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  });

  server.once('listening', () => {
    listening = true;
    log.info('Gateway RPC websocket listening', {
      host: options.host,
      port: options.port,
      path,
    });
  });
  server.once('close', () => {
    webSocketServer.close();
  });

  try {
    server.listen(options.port, options.host);
  } catch (err) {
    const startupErr = err as NodeJS.ErrnoException;
    log.error('Gateway RPC websocket listen threw synchronously', {
      host: options.host,
      port: options.port,
      path,
      code: startupErr.code,
      errno: startupErr.errno,
      syscall: startupErr.syscall,
      error: startupErr.message,
    });
    if (options.onStartupError) {
      options.onStartupError(startupErr);
    } else {
      throw startupErr;
    }
  }

  return server;
}

// ── Client: connects to Unix socket with bounded startup retries ──

/**
 * Exponential-backoff-with-jitter delay for the Nth failed connect attempt.
 * Delay doubles each attempt up to `maxDelayMs`, then equal-jitter is applied
 * (result in [capped/2, capped]) so concurrent agents do not retry in lockstep.
 */
export function computeReconnectDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  const half = capped / 2;
  return Math.round(half + Math.random() * half);
}

export interface ClientConnectionOptions {
  socketPath: string;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxReconnectAttempts?: number;
}

export function createSocketClient(
  options: ClientConnectionOptions,
): Promise<NdjsonConnection> {
  const {
    socketPath,
    reconnect = true,
    // Exponential backoff from this base, capped by reconnectMaxDelayMs, gives a
    // multi-minute startup budget that outlasts gateway readiness instead of the
    // former fixed ~10s window.
    reconnectDelayMs = 1000,
    reconnectMaxDelayMs = 10_000,
    maxReconnectAttempts = 30,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let attempts = 0;

    const connectOnce = () => {
      if (settled) return;
      attempts++;
      const socket = net.createConnection(socketPath);

      socket.once('connect', () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        log.info(`Connected to ${socketPath}`);
        resolve(new NdjsonConnection(socket));
      });

      socket.once('error', (err) => {
        socket.destroy();
        if (settled) return;

        if (!reconnect || attempts >= maxReconnectAttempts) {
          settled = true;
          reject(err);
          return;
        }

        const delayMs = computeReconnectDelayMs(attempts, reconnectDelayMs, reconnectMaxDelayMs);
        log.info(`Connect attempt ${attempts}/${maxReconnectAttempts} failed; retrying in ${delayMs}ms...`);
        setTimeout(connectOnce, delayMs);
      });
    };

    connectOnce();
  });
}

export interface WebSocketRpcClientOptions {
  url: string;
  tls: GatewayRpcTlsFileConfig;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxReconnectAttempts?: number;
}

export function createWebSocketRpcClient(
  options: WebSocketRpcClientOptions,
): Promise<GatewayRpcConnection> {
  const {
    url,
    tls,
    reconnect = true,
    // Exponential backoff from this base, capped by reconnectMaxDelayMs, gives a
    // multi-minute startup budget that outlasts gateway readiness instead of the
    // former fixed ~10s window.
    reconnectDelayMs = 1000,
    reconnectMaxDelayMs = 10_000,
    maxReconnectAttempts = 30,
  } = options;
  const tlsOptions = loadGatewayRpcClientTlsOptions(tls);

  return new Promise((resolve, reject) => {
    let settled = false;
    let attempts = 0;

    const connectOnce = () => {
      if (settled) return;
      attempts++;
      const socket = new WebSocket(url, GATEWAY_RPC_WS_PROTOCOL, tlsOptions);

      const cleanupStartupListeners = () => {
        socket.removeListener('open', onOpen);
        socket.removeListener('error', onError);
        socket.removeListener('unexpected-response', onUnexpectedResponse);
      };

      const onOpen = () => {
        if (settled) {
          terminateOpenWebSocket(socket);
          return;
        }
        settled = true;
        cleanupStartupListeners();
        log.info('Connected to gateway RPC websocket', { url });
        resolve(new WebSocketRpcConnection(socket));
      };

      const onError = (err: Error) => {
        cleanupStartupListeners();
        terminateOpenWebSocket(socket);
        if (settled) return;

        if (!reconnect || attempts >= maxReconnectAttempts) {
          settled = true;
          reject(err);
          return;
        }

        const delayMs = computeReconnectDelayMs(attempts, reconnectDelayMs, reconnectMaxDelayMs);
        log.info(`Gateway RPC websocket connect attempt ${attempts}/${maxReconnectAttempts} failed; retrying in ${delayMs}ms...`);
        setTimeout(connectOnce, delayMs);
      };

      const onUnexpectedResponse = (_req: IncomingMessage, res: IncomingMessage) => {
        const error = new Error(`Gateway RPC websocket upgrade failed with HTTP ${res.statusCode ?? 0}`);
        onError(error);
      };

      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('unexpected-response', onUnexpectedResponse);
    };

    connectOnce();
  });
}

function terminateOpenWebSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
    socket.terminate();
  }
}

function normalizeRpcWebSocketPath(path: string | undefined): string {
  const trimmed = path?.trim() || DEFAULT_GATEWAY_RPC_WS_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseOptionalEnvString(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveGatewayRpcTlsConfigFromEnv(env: GatewayRpcEndpointEnv): GatewayRpcTlsFileConfig {
  const caPath = parseOptionalEnvString(env.GATEWAY_RPC_TLS_CA_PATH);
  const certPath = parseOptionalEnvString(env.GATEWAY_RPC_TLS_CERT_PATH);
  const keyPath = parseOptionalEnvString(env.GATEWAY_RPC_TLS_KEY_PATH);
  const expectedPeerSpiffeUri = parseOptionalEnvString(env.GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI);
  if (!caPath || !certPath || !keyPath || !expectedPeerSpiffeUri) {
    throw new Error(
      `${GATEWAY_RPC_ENDPOINT_ENV}=wss requires ${GATEWAY_RPC_TLS_CA_PATH_ENV}, `
        + `${GATEWAY_RPC_TLS_CERT_PATH_ENV}, ${GATEWAY_RPC_TLS_KEY_PATH_ENV}, `
        + `and ${GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI_ENV}.`,
    );
  }
  const serverName = parseOptionalEnvString(env.GATEWAY_RPC_TLS_SERVER_NAME);
  return {
    caPath,
    certPath,
    keyPath,
    expectedPeerSpiffeUri: normalizeSpiffeUri(
      expectedPeerSpiffeUri,
      GATEWAY_RPC_TLS_EXPECTED_PEER_SPIFFE_URI_ENV,
    ),
    ...(serverName ? { serverName } : {}),
  };
}

function loadGatewayRpcServerTlsOptions(config: GatewayRpcTlsFileConfig): HttpsServerOptions {
  const tlsConfig = requireMtlsPeerFileConfig(config, 'Gateway RPC WSS TLS');
  return {
    ca: readFileSync(tlsConfig.caPath),
    cert: readFileSync(tlsConfig.certPath),
    key: readFileSync(tlsConfig.keyPath),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  };
}

function loadGatewayRpcClientTlsOptions(config: GatewayRpcTlsFileConfig): WebSocket.ClientOptions {
  const tlsConfig = requireMtlsPeerFileConfig(config, 'Gateway RPC WSS TLS');
  return {
    ca: readFileSync(tlsConfig.caPath),
    cert: readFileSync(tlsConfig.certPath),
    key: readFileSync(tlsConfig.keyPath),
    rejectUnauthorized: true,
    checkServerIdentity: createSpiffeCheckServerIdentity(
      tlsConfig.expectedPeerSpiffeUri,
    ) as unknown as WebSocket.ClientOptions['checkServerIdentity'],
    ...(tlsConfig.serverName ? { servername: tlsConfig.serverName } : {}),
  };
}

function authorizeMutualTlsPeer(
  input: { request: IncomingMessage },
  expectedPeerSpiffeUri: string,
): string | null {
  const req = input.request;
  const tlsSocket = req.socket as TLSSocket;
  if (!tlsSocket.authorized) {
    const authorizationError = tlsSocket.authorizationError;
    return authorizationError instanceof Error
      ? `peer TLS certificate is not authorized: ${authorizationError.message}`
      : 'peer TLS certificate is not authorized';
  }
  const peerCertificate = tlsSocket.getPeerCertificate();
  if (Object.keys(peerCertificate).length === 0) {
    return 'peer TLS certificate is missing';
  }
  return verifyPeerCertificateSpiffeUri(peerCertificate, expectedPeerSpiffeUri);
}

function upgradeRequestIncludesProtocol(req: IncomingMessage): boolean {
  const rawProtocol = req.headers['sec-websocket-protocol'];
  const values = Array.isArray(rawProtocol) ? rawProtocol : [rawProtocol];
  return values.some(value => typeof value === 'string'
    && value.split(',').map(entry => entry.trim()).includes(GATEWAY_RPC_WS_PROTOCOL));
}
