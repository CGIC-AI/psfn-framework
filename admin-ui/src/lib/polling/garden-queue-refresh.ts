import {
  connectGardenEventBus,
  disconnectGardenEventBus,
  isGardenEventBusConnected,
  subscribeGardenEventBusConnection,
  subscribeGardenEvents,
} from '../events/garden-event-bus.svelte';
import type { GardenEventEnvelope, GardenEventFilter } from '../events/envelope';
import type { GardenQueueName } from '../../../../src/shared/event-bus.js';
import {
  createVisibilityAwarePoller,
  type VisibilityAwarePoller,
  type VisibilityDocument,
} from './visibility-aware-poller';

export interface GardenQueueRefreshBus {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  subscribeEvents(
    listener: (event: GardenEventEnvelope) => void,
    filter?: GardenEventFilter,
  ): () => void;
  subscribeConnection(listener: (connected: boolean) => void): () => void;
}

export interface GardenQueueRefreshController {
  start(): void;
  stop(): void;
  requestRefresh(): void;
}

interface GardenQueueRefreshOptions {
  queue: GardenQueueName;
  refresh: () => void | Promise<unknown>;
  intervalMs: number;
  documentRef?: VisibilityDocument;
  onError?: (error: unknown) => void;
  bus?: GardenQueueRefreshBus;
}

const sharedGardenBus: GardenQueueRefreshBus = {
  connect: connectGardenEventBus,
  disconnect: disconnectGardenEventBus,
  isConnected: isGardenEventBusConnected,
  subscribeEvents: subscribeGardenEvents,
  subscribeConnection: subscribeGardenEventBusConnection,
};

function queueFromEvent(event: GardenEventEnvelope): unknown {
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
    return undefined;
  }
  return (event.data as Record<string, unknown>).queue;
}

export function createGardenQueueRefresh(
  options: GardenQueueRefreshOptions,
): GardenQueueRefreshController {
  const bus = options.bus ?? sharedGardenBus;
  const pollerOptions = {
    refresh: options.refresh,
    intervalMs: options.intervalMs,
    pollingEnabled: !bus.isConnected(),
    ...(options.documentRef ? { documentRef: options.documentRef } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  };
  const poller: VisibilityAwarePoller = createVisibilityAwarePoller(pollerOptions);
  let running = false;
  let disconnectedWhileRunning = false;
  let unsubscribeEvents: (() => void) | undefined;
  let unsubscribeConnection: (() => void) | undefined;

  function start(): void {
    if (running) return;
    running = true;
    unsubscribeEvents = bus.subscribeEvents(
      (event) => {
        if (queueFromEvent(event) === options.queue) poller.requestRefresh();
      },
      { types: ['garden.queue.changed'] },
    );
    unsubscribeConnection = bus.subscribeConnection((connected) => {
      if (!connected) {
        disconnectedWhileRunning = true;
      } else if (disconnectedWhileRunning) {
        disconnectedWhileRunning = false;
        poller.requestRefresh();
      }
      poller.setPollingEnabled(!connected);
    });
    bus.connect();
    poller.setPollingEnabled(!bus.isConnected());
    poller.start();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    disconnectedWhileRunning = false;
    unsubscribeEvents?.();
    unsubscribeEvents = undefined;
    unsubscribeConnection?.();
    unsubscribeConnection = undefined;
    poller.stop();
    bus.disconnect();
  }

  return {
    start,
    stop,
    requestRefresh: () => poller.requestRefresh(),
  };
}
