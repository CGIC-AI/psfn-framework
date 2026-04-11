import type { EventBus, EventMap } from '../event-bus.js';

export interface CostTelemetryPort {
  recordTurnUsage(payload: EventMap['agent.turn.usage']): Promise<void>;
  recordThinkTrace(payload: EventMap['agent.think.trace']): Promise<void>;
  recordMemoryRetrieval(payload: EventMap['memory.retrieval']): Promise<void>;
  recordMemoryExtractionStart(payload: EventMap['memory.extraction.start']): Promise<void>;
  recordMemoryExtractionEnd(payload: EventMap['memory.extraction.end']): Promise<void>;
}

export type CostTelemetryInput = CostTelemetryPort | Pick<EventBus, 'emit'> | null | undefined;

export function createCostTelemetryPort(port: CostTelemetryPort): CostTelemetryPort {
  return {
    recordTurnUsage: (payload) => port.recordTurnUsage(payload),
    recordThinkTrace: (payload) => port.recordThinkTrace(payload),
    recordMemoryRetrieval: (payload) => port.recordMemoryRetrieval(payload),
    recordMemoryExtractionStart: (payload) => port.recordMemoryExtractionStart(payload),
    recordMemoryExtractionEnd: (payload) => port.recordMemoryExtractionEnd(payload),
  };
}

export function createEventBusCostTelemetryPort(
  eventBus: Pick<EventBus, 'emit'>,
): CostTelemetryPort {
  return createCostTelemetryPort({
    recordTurnUsage: (payload) => eventBus.emit('agent.turn.usage', payload),
    recordThinkTrace: (payload) => eventBus.emit('agent.think.trace', payload),
    recordMemoryRetrieval: (payload) => eventBus.emit('memory.retrieval', payload),
    recordMemoryExtractionStart: (payload) => eventBus.emit('memory.extraction.start', payload),
    recordMemoryExtractionEnd: (payload) => eventBus.emit('memory.extraction.end', payload),
  });
}

export function normalizeCostTelemetryPort(input: CostTelemetryInput): CostTelemetryPort | undefined {
  if (!input) return undefined;
  if ('recordTurnUsage' in input) {
    return input;
  }
  return createEventBusCostTelemetryPort(input);
}
