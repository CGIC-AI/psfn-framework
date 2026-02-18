// ── NDJSON-framed Unix socket transport ──
// Shared by gateway server and agent client.

import * as net from 'node:net';
import * as readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { unlinkSync, chmodSync } from 'node:fs';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('Transport');

export interface TransportOptions {
  socketPath: string;
}

export interface SocketServerOptions {
  onStartupError?: (error: NodeJS.ErrnoException) => void;
}

type MessageHandler = (message: unknown) => void;

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
        log.error('Invalid JSON line', { data: line.slice(0, 100) });
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

// ── Client: connects to Unix socket with auto-reconnect ──

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
    let attempts = 0;

    function connect() {
      const socket = net.createConnection(socketPath);

      socket.once('connect', () => {
        log.info(`Connected to ${socketPath}`);
        attempts = 0;
        const conn = new NdjsonConnection(socket);

        if (reconnect) {
          conn.on('close', () => {
            log.info('Connection lost, reconnecting...');
            setTimeout(tryReconnect, reconnectDelayMs);
          });
        }

        resolve(conn);
      });

      socket.once('error', (err) => {
        socket.destroy();
        if (attempts === 0) {
          // First attempt failure — reject the promise
          reject(err);
        } else if (reconnect && attempts < maxReconnectAttempts) {
          setTimeout(tryReconnect, reconnectDelayMs);
        } else {
          log.error(`Failed to connect after ${attempts} attempts`);
        }
      });
    }

    function tryReconnect() {
      attempts++;
      if (attempts > maxReconnectAttempts) {
        log.error('Max reconnect attempts reached');
        return;
      }
      log.info(`Reconnect attempt ${attempts}/${maxReconnectAttempts}...`);
      connect();
    }

    connect();
  });
}
