import {
  ReconnectingWebSocket,
  type WsConnectionError,
} from '$lib/api/websocket';
import type { TelemetryEvent } from '$lib/types';
import type { GardenEventEnvelope, GardenEventFilter } from './envelope';
import {
  matchesGardenEventFilter,
  normalizeGardenWebSocketMessage,
} from './envelope';
import { createGardenEventStream } from './garden-event-stream';
import {
  GardenTelemetryCache,
  MAX_CACHED_GARDEN_EVENTS,
} from '$lib/cache/telemetry-cache';
import {
  getCompanionCacheScope,
  onCompanionScopeChange,
  scopeGardenDataPath,
} from '$lib/fleet/companion-scope';
import { getToken } from '$lib/stores/auth.svelte';

const MAX_GARDEN_EVENTS = MAX_CACHED_GARDEN_EVENTS;

type GardenEventListener = (event: GardenEventEnvelope) => void;
type GardenEventConnectionListener = (connected: boolean) => void;

interface GardenEventSubscription {
  listener: GardenEventListener;
  filter?: GardenEventFilter;
}

let events = $state<GardenEventEnvelope[]>([]);
let connected = $state(false);
let connectionError = $state<WsConnectionError | null>(null);
let paused = $state(false);
let socket: ReconnectingWebSocket | null = null;
const subscriptions = new Set<GardenEventSubscription>();
const connectionSubscriptions = new Set<GardenEventConnectionListener>();
const telemetryCache = new GardenTelemetryCache();
let telemetryCacheHydrated = false;
let telemetryCacheHydration: Promise<void> | null = null;
let telemetryCacheWrite: Promise<void> = Promise.resolve();
let telemetryCacheError = $state<string | null>(null);
let preparedAdminToken = '';
let preparedAdminTokenUntil = 0;

onCompanionScopeChange((previousCompanionId) => {
  disconnectGardenEventBus();
  // Cancel any pending coalesced cache write before the scope changes so it
  // cannot flush the previous companion's buffer under the new cache scope,
  // and forget remembered revisions for the previous companion.
  gardenEventStream.reset();
  events = [];
  paused = false;
  subscriptions.clear();
  connectionSubscriptions.clear();
  telemetryCacheHydrated = false;
  telemetryCacheHydration = null;
  telemetryCacheError = null;
  connectionError = null;
  preparedAdminToken = '';
  preparedAdminTokenUntil = 0;
  if (!previousCompanionId) return;
  const clearing = telemetryCacheWrite.then(() => telemetryCache.clearScope(previousCompanionId));
  telemetryCacheWrite = clearing
    .then(() => {
      telemetryCacheError = null;
    })
    .catch((error: unknown) => {
      telemetryCacheError = toErrorMessage(error);
    });
  return telemetryCacheWrite;
});

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareGardenWebSocketCredential(): Promise<void> {
  const token = getToken();
  if (!token) return;
  const now = Date.now();
  if (preparedAdminToken === token && preparedAdminTokenUntil > now) return;
  const response = await fetch(scopeGardenDataPath('/login'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    credentials: 'include',
    body: new URLSearchParams({ token }).toString(),
  });
  if (!response.redirected) {
    throw new Error('Unable to refresh the Garden WebSocket session credential');
  }
  preparedAdminToken = token;
  preparedAdminTokenUntil = now + (60 * 60 * 1_000);
}

function writeGardenEventCache(): void {
  const snapshot = [...events];
  const companionScope = getCompanionCacheScope();
  telemetryCacheWrite = telemetryCacheWrite
    .then(() => telemetryCache.write(snapshot, companionScope))
    .then(() => {
      telemetryCacheError = null;
    })
    .catch((error: unknown) => {
      telemetryCacheError = toErrorMessage(error);
    });
}

// Shared ingest seam between the WebSocket and the reactive store: drops
// replayed/retransmitted snapshots before they can re-append, re-persist, or
// re-render, and coalesces the durable cache write so a burst of distinct
// events produces one bounded write instead of one per message. See
// garden-event-stream.ts.
const gardenEventStream = createGardenEventStream({}, writeGardenEventCache);

function setGardenEventBusConnected(nextConnected: boolean): void {
  if (connected === nextConnected) return;
  connected = nextConnected;
  for (const listener of connectionSubscriptions) {
    listener(nextConnected);
  }
}

function publishGardenEvent(event: GardenEventEnvelope): void {
  if (!gardenEventStream.ingest(event)) {
    // Identical retransmitted/replayed snapshot: do not re-append, re-persist,
    // or re-render. Real changes still append, persist, and broadcast below.
    return;
  }

  if (!paused) {
    events = [...events, event].slice(-MAX_GARDEN_EVENTS);
    gardenEventStream.schedulePersist();
  }

  for (const subscription of subscriptions) {
    if (!matchesGardenEventFilter(event, subscription.filter)) {
      continue;
    }
    subscription.listener(event);
  }
}

function handleSocketMessage(message: MessageEvent): void {
  const event = normalizeGardenWebSocketMessage(message.data);
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

export function getGardenEventCacheError(): string | null {
  return telemetryCacheError;
}

export function hydrateGardenEventBus(): Promise<void> {
  if (telemetryCacheHydrated) return Promise.resolve();
  if (telemetryCacheHydration) return telemetryCacheHydration;
  const current = telemetryCache.read()
    .then((cached) => {
      events = [...cached, ...events].slice(-MAX_GARDEN_EVENTS);
      // Seed the deduper so a reconnect that replays these same events does
      // not double-append or re-broadcast them.
      gardenEventStream.seed(events);
      telemetryCacheHydrated = true;
      telemetryCacheError = null;
    })
    .catch((error: unknown) => {
      telemetryCacheError = toErrorMessage(error);
      throw error;
    })
    .finally(() => {
      if (telemetryCacheHydration === current) telemetryCacheHydration = null;
    });
  telemetryCacheHydration = current;
  return current;
}

export function isGardenEventBusConnected(): boolean {
  return connected;
}

export function getGardenEventBusConnectionError(): WsConnectionError | null {
  return connectionError;
}

export function isGardenEventBusPaused(): boolean {
  return paused;
}

export function connectGardenEventBus(): void {
  if (!socket) {
    const nextSocket = new ReconnectingWebSocket(
      '/api/admin/events',
      undefined,
      prepareGardenWebSocketCredential,
    );
    nextSocket.onMessage(handleSocketMessage);
    nextSocket.onConnectionChange((nextConnected) => {
      setGardenEventBusConnected(nextConnected);
    });
    nextSocket.onConnectionError((nextError) => {
      connectionError = nextError;
    });
    socket = nextSocket;
  }

  socket.connect();
  setGardenEventBusConnected(socket.connected);
  connectionError = socket.connectionError;
}

export function disconnectGardenEventBus(): void {
  if (!socket) {
    setGardenEventBusConnected(false);
    connectionError = null;
    return;
  }

  const closingSocket = socket;
  socket = null;
  closingSocket.close();
  setGardenEventBusConnected(false);
  connectionError = null;
}

export function clearGardenEventBus(): void {
  gardenEventStream.reset();
  events = [];
  telemetryCacheWrite = telemetryCacheWrite
    .then(() => telemetryCache.clear())
    .then(() => {
      telemetryCacheError = null;
    })
    .catch((error: unknown) => {
      telemetryCacheError = toErrorMessage(error);
    });
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
