// ── NDJSON-framed Unix socket transport ──
// Shared by gateway server and agent client.

import * as net from 'node:net';
import * as readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { unlinkSync, chmodSync } from 'node:fs';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('Transport');
const FRAME_PREVIEW_LIMIT = 200;

export interface TransportOptions {
  socketPath: string;
}

export interface SocketServerOptions {
  onStartupError?: (error: NodeJS.ErrnoException) => void;
}

type MessageHandler = (message: unknown) => void;

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

export class NdjsonConnection extends EventEmitter {
  private socket: net.Socket;
  private rl: readline.Interface;

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    this.rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    this.rl.on('line', (line) => {
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

    socket.on('close', () => this.emit('close'));
    socket.on('error', (err) => this.emit('error', err));
  }

  send(data: unknown): boolean {
    if (this.socket.destroyed) return false;
    return this.socket.write(JSON.stringify(data) + '\n');
  }

  onMessage(handler: MessageHandler): void {
    this.on('message', handler);
  }

  destroy(): void {
    this.rl.close();
    this.socket.destroy();
  }

  get destroyed(): boolean {
    return this.socket.destroyed;
  }
}

// ── Server: listens on Unix socket, accepts connections ──

export function createSocketServer(
  socketPath: string,
  onConnection: (conn: NdjsonConnection) => void,
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

// ── Client: connects to Unix socket with bounded startup retries ──

export interface ClientConnectionOptions {
  socketPath: string;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

export function createSocketClient(
  options: ClientConnectionOptions,
): Promise<NdjsonConnection> {
  const {
    socketPath,
    reconnect = true,
    reconnectDelayMs = 1000,
    maxReconnectAttempts = 10,
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

        log.info(`Connect attempt ${attempts}/${maxReconnectAttempts} failed; retrying...`);
        setTimeout(connectOnce, reconnectDelayMs);
      });
    };

    connectOnce();
  });
}
