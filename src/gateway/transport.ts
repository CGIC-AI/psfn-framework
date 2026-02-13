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
): net.Server {
  // Clean up stale socket file
  try {
    unlinkSync(socketPath);
  } catch { /* doesn't exist, that's fine */ }

  const server = net.createServer((socket) => {
    const conn = new NdjsonConnection(socket);
    onConnection(conn);
  });

  server.listen(socketPath, () => {
    // Make socket accessible
    try {
      chmodSync(socketPath, 0o770);
    } catch { /* ignore chmod errors */ }
    log.info(`Listening on ${socketPath}`);
  });

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
