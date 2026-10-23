import type * as net from 'node:net';

// Fixed protocol resource boundaries, independent of peer input.
export const GATEWAY_RPC_PENDING_CONNECTIONS = 2;
export const GATEWAY_RPC_MAX_CONNECTIONS = 64;
export const GATEWAY_RPC_FIRST_FRAME_TIMEOUT_MS = 5_000;

export interface GatewayRpcConnectionLimits {
  total: number;
}

/** Charges raw sockets before TLS/HTTP/framing allocates application state. */
export class GatewayRpcSocketAdmission {
  private static readonly byServer = new WeakMap<net.Server, GatewayRpcSocketAdmission>();
  private readonly sockets = new Map<net.Socket, { timer: NodeJS.Timeout; pending: boolean }>();

  constructor(private readonly limits: GatewayRpcConnectionLimits) {}

  bindServer(server: net.Server): void {
    GatewayRpcSocketAdmission.byServer.set(server, this);
  }

  static closeServer(server: net.Server): void {
    GatewayRpcSocketAdmission.byServer.get(server)?.close();
  }

  accept(socket: net.Socket): boolean {
    if (this.sockets.size >= this.limits.total
      || [...this.sockets.values()].filter(entry => entry.pending).length >= GATEWAY_RPC_PENDING_CONNECTIONS) {
      socket.destroy();
      return false;
    }
    const timer = setTimeout(() => socket.destroy(), GATEWAY_RPC_FIRST_FRAME_TIMEOUT_MS);
    timer.unref();
    this.sockets.set(socket, { timer, pending: true });
    socket.once('close', () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
    return true;
  }

  /** TLS sockets wrap the accepted socket but retain its public endpoint tuple. */
  complete(socket: net.Socket): void {
    for (const [raw, entry] of this.sockets) {
      if (raw === socket || (socket.remotePort !== undefined && raw.remotePort === socket.remotePort
        && raw.remoteAddress === socket.remoteAddress
        && raw.localPort === socket.localPort
        && raw.localAddress === socket.localAddress)) {
        clearTimeout(entry.timer);
        entry.pending = false;
        return;
      }
    }
  }

  close(): void {
    for (const [socket, entry] of this.sockets) {
      clearTimeout(entry.timer);
      socket.destroy();
    }
    this.sockets.clear();
  }
}
