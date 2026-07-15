import { ReconnectingWebSocket } from '$lib/api/websocket';
import type { TelemetryEvent } from '$lib/types';
import type { GardenEventEnvelope, GardenEventFilter } from './envelope';
import {
  matchesGardenEventFilter,
  normalizeGardenEventEnvelope,
} from './envelope';

const MAX_GARDEN_EVENTS = 750;

type GardenEventListener = (event: GardenEventEnvelope) => void;
type GardenEventConnectionListener = (connected: boolean) => void;

interface GardenEventSubscription {
  listener: GardenEventListener;
  filter?: GardenEventFilter;
}

let events = $state<GardenEventEnvelope[]>([]);
let connected = $state(false);
let paused = $state(false);
let socket: ReconnectingWebSocket | null = null;
const subscriptions = new Set<GardenEventSubscription>();
const connectionSubscriptions = new Set<GardenEventConnectionListener>();

function setGardenEventBusConnected(nextConnected: boolean): void {
  if (connected === nextConnected) return;
  connected = nextConnected;
  for (const listener of connectionSubscriptions) {
    listener(nextConnected);
  }
}

function publishGardenEvent(event: GardenEventEnvelope): void {
  if (!paused) {
    events = [...events, event].slice(-MAX_GARDEN_EVENTS);
  }

  for (const subscription of subscriptions) {
    if (!matchesGardenEventFilter(event, subscription.filter)) {
      continue;
    }
    subscription.listener(event);
  }
}

function handleSocketMessage(message: MessageEvent): void {
  if (typeof message.data !== 'string') {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    return;
  }

  const event = normalizeGardenEventEnvelope(parsed);
  if (!event) {
    return;
  }

  publishGardenEvent(event);
}

export function getGardenEvents(): GardenEventEnvelope[] {
  return events;
}

export function getTelemetryEvents(): TelemetryEvent[] {
  return events as TelemetryEvent[];
}

export function isGardenEventBusConnected(): boolean {
  return connected;
}

export function isGardenEventBusPaused(): boolean {
  return paused;
}

export function connectGardenEventBus(): void {
  if (!socket) {
    const nextSocket = new ReconnectingWebSocket('/api/admin/events');
    nextSocket.onMessage(handleSocketMessage);
    nextSocket.onConnectionChange((nextConnected) => {
      setGardenEventBusConnected(nextConnected);
    });
    socket = nextSocket;
  }

  socket.connect();
  setGardenEventBusConnected(socket.connected);
}

export function disconnectGardenEventBus(): void {
  if (!socket) {
    setGardenEventBusConnected(false);
    return;
  }

  const closingSocket = socket;
  socket = null;
  closingSocket.close();
  setGardenEventBusConnected(false);
}

export function clearGardenEventBus(): void {
  events = [];
}

export function pauseGardenEventBus(): void {
  paused = true;
}

export function resumeGardenEventBus(): void {
  paused = false;
}

export function subscribeGardenEvents(
  listener: GardenEventListener,
  filter?: GardenEventFilter,
): () => void {
  const subscription: GardenEventSubscription = { listener, filter };
  subscriptions.add(subscription);
  return () => subscriptions.delete(subscription);
}

export function subscribeGardenEventBusConnection(
  listener: GardenEventConnectionListener,
): () => void {
  connectionSubscriptions.add(listener);
  return () => connectionSubscriptions.delete(listener);
}
