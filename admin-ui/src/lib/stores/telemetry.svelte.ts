import type { TelemetryEvent } from '$lib/types';
import { ReconnectingWebSocket } from '$lib/api/websocket';

const MAX_EVENTS = 500;

let events = $state<TelemetryEvent[]>([]);
let connected = $state(false);
let paused = $state(false);
let ws: ReconnectingWebSocket | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function getEvents(): TelemetryEvent[] {
  return events;
}

export function isConnected(): boolean {
  return connected;
}

export function isPaused(): boolean {
  return paused;
}

export function startTelemetry(): void {
  if (ws) return;
  ws = new ReconnectingWebSocket('/api/admin/events');

  ws.onMessage((evt) => {
    if (paused) return;
    try {
      const parsed = JSON.parse(evt.data) as TelemetryEvent;
      events = [...events, parsed].slice(-MAX_EVENTS);
    } catch {
      // ignore non-JSON messages
    }
  });

  // Poll connected state from the WebSocket wrapper
  pollInterval = setInterval(() => {
    connected = ws?.connected ?? false;
  }, 1000);

  ws.connect();
  connected = ws.connected;
}

export function stopTelemetry(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  ws?.close();
  ws = null;
  connected = false;
}

export function clearEvents(): void {
  events = [];
}

export function pauseTelemetry(): void {
  paused = true;
}

export function resumeTelemetry(): void {
  paused = false;
}

/** Alias for startTelemetry */
export function connectTelemetry(): void {
  startTelemetry();
}

/** Alias for stopTelemetry */
export function disconnectTelemetry(): void {
  stopTelemetry();
}

export function filterEvents(prefix: string): TelemetryEvent[] {
  return events.filter(e => e.type.startsWith(prefix));
}
