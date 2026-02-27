// ── Auto-reconnecting WebSocket client for /api/admin/events ──

import type { TelemetryEvent } from '$lib/types';

export type TelemetryHandler = (event: TelemetryEvent) => void;

const MAX_EVENTS = 500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class TelemetrySocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<TelemetryHandler>();
  private reconnectMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private _paused = false;
  private token: string;
  events: TelemetryEvent[] = [];

  constructor(token: string) {
    this.token = token;
  }

  get connected(): boolean {
    return this._connected;
  }

  get paused(): boolean {
    return this._paused;
  }

  connect(): void {
    if (this.ws) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/admin/events?token=${encodeURIComponent(this.token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._connected = true;
      this.reconnectMs = RECONNECT_BASE_MS;
    };

    this.ws.onmessage = (ev) => {
      if (this._paused) return;
      try {
        const event = JSON.parse(ev.data) as TelemetryEvent;
        this.events.push(event);
        if (this.events.length > MAX_EVENTS) {
          this.events = this.events.slice(-MAX_EVENTS);
        }
        for (const h of this.handlers) h(event);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
  }

  subscribe(handler: TelemetryHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  clear(): void {
    this.events = [];
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
  }
}
