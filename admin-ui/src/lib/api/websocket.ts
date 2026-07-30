import {
  onCompanionScopeChange,
  scopeGardenDataPath,
} from '$lib/fleet/companion-scope';

export type WsMessageHandler = (event: MessageEvent) => void;
export type WsConnectionHandler = (connected: boolean) => void;
export type WsConnectionErrorHandler = (error: WsConnectionError | null) => void;

export interface WsConnectionError {
  readonly kind: 'authentication' | 'close' | 'connection' | 'configuration';
  readonly code: number | null;
  readonly reason: string;
}

interface WebSocketLocation {
  protocol: string;
  host: string;
  pathname?: string;
}

const activeSockets = new Set<ReconnectingWebSocket>();
const activeNativeSockets = new Set<WebSocket>();

onCompanionScopeChange(() => {
  for (const socket of [...activeSockets]) socket.close();
  for (const socket of [...activeNativeSockets]) socket.close();
  activeNativeSockets.clear();
});

export function registerCompanionWebSocket(socket: WebSocket): () => void {
  activeNativeSockets.add(socket);
  return () => activeNativeSockets.delete(socket);
}

export function buildAdminWebSocketUrl(
  path: string,
  location: WebSocketLocation | undefined = typeof window !== 'undefined' ? window.location : undefined,
): string {
  const proto = location?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location?.host ?? 'localhost:3001';
  const scopedPath = scopeGardenDataPath(path, location?.pathname ?? '/');
  return `${proto}//${host}${scopedPath}`;
}

export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private readonly path: string;
  private readonly reconnectMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Set<WsMessageHandler> = new Set();
  private connectionHandlers: Set<WsConnectionHandler> = new Set();
  private connectionErrorHandlers: Set<WsConnectionErrorHandler> = new Set();
  private _connected = false;
  private _connectionError: WsConnectionError | null = null;
  private reconnectEnabled = false;
  private preparing = false;
  private generation = 0;

  constructor(
    path: string,
    reconnectMs = 5000,
    private readonly prepareConnection?: () => Promise<void>,
  ) {
    this.path = path;
    this.reconnectMs = reconnectMs;
  }

  get connected(): boolean {
    return this._connected;
  }

  get connectionError(): WsConnectionError | null {
    return this._connectionError;
  }

  connect(): void {
    if (typeof window === 'undefined') return;
    this.reconnectEnabled = true;
    activeSockets.add(this);
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
      const url = this.buildUrl();
      if (this.preparing) return;
      const generation = ++this.generation;
      if (!this.prepareConnection) {
        this.openSocket(url, generation);
        return;
      }
      this.preparing = true;
      void this.prepareConnection().then(
        () => {
          if (this.generation !== generation || !this.reconnectEnabled) return;
          try {
            this.openSocket(url, generation);
          } catch (error) {
            this.failConfiguration(error);
          }
        },
        (error: unknown) => {
          if (this.generation !== generation || !this.reconnectEnabled) return;
          this.reconnectEnabled = false;
          activeSockets.delete(this);
          this.setConnectionError({
            kind: 'authentication',
            code: null,
            reason: error instanceof Error ? error.message : String(error),
          });
        },
      ).finally(() => {
        if (this.generation === generation) this.preparing = false;
      });
    } catch (error) {
      this.failConfiguration(error);
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

  onConnectionError(handler: WsConnectionErrorHandler): () => void {
    this.connectionErrorHandlers.add(handler);
    return () => this.connectionErrorHandlers.delete(handler);
  }

  close(): void {
    this.reconnectEnabled = false;
    this.generation += 1;
    this.preparing = false;
    activeSockets.delete(this);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.ws;
    this.ws = null;
    this.setConnected(false);
    this.setConnectionError(null);
    socket?.close();
  }

  private buildUrl(): string {
    return buildAdminWebSocketUrl(this.path);
  }

  private openSocket(url: string, generation: number): void {
    if (this.generation !== generation || !this.reconnectEnabled) return;
    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.setConnectionError(null);
      this.setConnected(true);
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      for (const handler of this.handlers) {
        handler(event);
      }
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.setConnected(false);
      if (this.reconnectEnabled) {
        this.setConnectionError({
          kind: 'close',
          code: event.code,
          reason: event.reason.trim()
            || (event.code === 1006
              ? 'Connection failed before the WebSocket upgrade completed'
              : 'Connection closed without a reason'),
        });
      } else {
        this.setConnectionError(null);
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      this.setConnectionError({
        kind: 'connection',
        code: null,
        reason: 'WebSocket connection failed',
      });
    };
  }

  private failConfiguration(error: unknown): void {
    this.ws = null;
    this.reconnectEnabled = false;
    activeSockets.delete(this);
    this.setConnected(false);
    this.setConnectionError({
      kind: 'configuration',
      code: null,
      reason: error instanceof Error ? error.message : String(error),
    });
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

  private setConnectionError(error: WsConnectionError | null): void {
    if (this._connectionError?.kind === error?.kind
      && this._connectionError?.code === error?.code
      && this._connectionError?.reason === error?.reason) {
      return;
    }
    this._connectionError = error;
    for (const handler of this.connectionErrorHandlers) {
      handler(error);
    }
  }
}
