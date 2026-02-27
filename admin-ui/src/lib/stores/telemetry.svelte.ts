// ── Telemetry store — wraps TelemetrySocket with Svelte 5 reactivity ──

import { TelemetrySocket } from '$lib/api/websocket';
import type { TelemetryEvent } from '$lib/types';
import { getToken } from './auth.svelte';

let socket: TelemetrySocket | null = null;
let events = $state<TelemetryEvent[]>([]);
let connected = $state(false);
let paused = $state(false);

export function getEvents(): TelemetryEvent[] {
  return events;
}

export function isConnected(): boolean {
  return connected;
}

export function isPaused(): boolean {
  return paused;
}

export function connectTelemetry(): void {
  const token = getToken();
  if (!token) return;
  if (socket) socket.disconnect();

  socket = new TelemetrySocket(token);
  socket.subscribe((event) => {
    events = [...socket!.events];
    connected = socket!.connected;
  });
  socket.connect();

  // Poll connection state
  const interval = setInterval(() => {
    if (socket) connected = socket.connected;
    else clearInterval(interval);
  }, 2000);
}

export function disconnectTelemetry(): void {
  socket?.disconnect();
  socket = null;
  connected = false;
}

export function pauseTelemetry(): void {
  socket?.pause();
  paused = true;
}

export function resumeTelemetry(): void {
  socket?.resume();
  paused = false;
}

export function clearEvents(): void {
  socket?.clear();
  events = [];
}

export function filterEvents(type?: string): TelemetryEvent[] {
  if (!type) return events;
  return events.filter(e => e.type.startsWith(type));
}
