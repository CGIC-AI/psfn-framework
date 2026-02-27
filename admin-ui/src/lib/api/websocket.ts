import { getToken } from '$lib/stores/auth.svelte';

export type WsMessageHandler = (event: MessageEvent) => void;

export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Set<WsMessageHandler> = new Set();
  private _connected = false;

  constructor(path: string, reconnectMs = 5000) {
    const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3001';
    const token = getToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    this.url = `${proto}//${host}${path}${qs}`;
    this.reconnectMs = reconnectMs;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (typeof window === 'undefined') return;
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this._connected = true;
      };

      this.ws.onmessage = (evt) => {
        for (const handler of this.handlers) {
          handler(evt);
        }
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  onMessage(handler: WsMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.reconnectMs);
  }
}
