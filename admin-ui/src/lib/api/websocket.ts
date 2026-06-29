export type WsMessageHandler = (event: MessageEvent) => void;
export type WsConnectionHandler = (connected: boolean) => void;

interface WebSocketLocation {
  protocol: string;
  host: string;
}

export function buildAdminWebSocketUrl(
  path: string,
  location: WebSocketLocation | undefined = typeof window !== 'undefined' ? window.location : undefined,
): string {
  const proto = location?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location?.host ?? 'localhost:3001';
  return `${proto}//${host}${path}`;
}

export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private readonly path: string;
  private readonly reconnectMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Set<WsMessageHandler> = new Set();
  private connectionHandlers: Set<WsConnectionHandler> = new Set();
  private _connected = false;
  private reconnectEnabled = false;

  constructor(path: string, reconnectMs = 5000) {
    this.path = path;
    this.reconnectMs = reconnectMs;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (typeof window === 'undefined') return;
    this.reconnectEnabled = true;
    if (this.ws && (
      this.ws.readyState === WebSocket.CONNECTING
      || this.ws.readyState === WebSocket.OPEN
    )) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const socket = new WebSocket(this.buildUrl());
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.setConnected(true);
      };

      socket.onmessage = (evt) => {
        for (const handler of this.handlers) {
          handler(evt);
        }
      };

      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = null;
        }
        this.setConnected(false);
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  onMessage(handler: WsMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onConnectionChange(handler: WsConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  close(): void {
    this.reconnectEnabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.ws;
    this.ws = null;
    this.setConnected(false);
    socket?.close();
  }

  private buildUrl(): string {
    return buildAdminWebSocketUrl(this.path);
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.timer || typeof window === 'undefined') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.reconnectMs);
  }

  private setConnected(connected: boolean): void {
    if (this._connected === connected) return;
    this._connected = connected;
    for (const handler of this.connectionHandlers) {
      handler(connected);
    }
  }
}
