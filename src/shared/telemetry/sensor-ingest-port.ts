import type { EventBus, ExternalTelemetryEvent } from '../event-bus.js';

export interface SensorIngestReceipt {
  id: string;
  acceptedEventType: string;
  event: ExternalTelemetryEvent;
}

export interface SensorIngestPort {
  ingestTelemetry(event: ExternalTelemetryEvent): Promise<SensorIngestReceipt>;
}

export function createEventBusSensorIngestPort(
  eventBus: Pick<EventBus, 'emit'>,
): SensorIngestPort {
  return {
    async ingestTelemetry(event) {
      await eventBus.emit('external.telemetry.ingested', { event });
      return {
        id: event.id,
        acceptedEventType: event.eventType,
        event,
      };
    },
  };
}
