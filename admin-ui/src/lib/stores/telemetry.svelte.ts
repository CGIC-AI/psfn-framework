import type { TelemetryEvent } from '$lib/types';
import {
  clearGardenEventBus,
  connectGardenEventBus,
  disconnectGardenEventBus,
  getTelemetryEvents,
  isGardenEventBusConnected,
  isGardenEventBusPaused,
  pauseGardenEventBus,
  resumeGardenEventBus,
} from '$lib/events/garden-event-bus.svelte';

export function getEvents(): TelemetryEvent[] {
  return getTelemetryEvents();
}

export function isConnected(): boolean {
  return isGardenEventBusConnected();
}

export function isPaused(): boolean {
  return isGardenEventBusPaused();
}

export function startTelemetry(): void {
  connectGardenEventBus();
}

export function stopTelemetry(): void {
  disconnectGardenEventBus();
}

export function clearEvents(): void {
  clearGardenEventBus();
}

export function pauseTelemetry(): void {
  pauseGardenEventBus();
}

export function resumeTelemetry(): void {
  resumeGardenEventBus();
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
  return getEvents().filter(event => event.type.startsWith(prefix));
}
