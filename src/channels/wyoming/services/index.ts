import type {
  WyomingFrame,
  WyomingServiceInfo,
  WyomingTransportSession,
} from '../protocol.js';
import { WYOMING_ASR_EVENT_TYPES } from './asr.js';
import { WYOMING_HANDLE_EVENT_TYPES } from './handle.js';
import { WYOMING_TTS_EVENT_TYPES } from './tts.js';

export * from './handle.js';
export * from './asr.js';
export * from './tts.js';

export type WyomingServiceFamily = 'handle' | 'asr' | 'tts';

export interface WyomingServiceSessionSnapshot {
  sessionId: string;
  connectionId: string;
  openedAtMs: number;
  lastSeenAtMs: number;
}

export interface WyomingServiceDispatchRequest {
  transportSession: WyomingTransportSession;
  frame: WyomingFrame;
  sessionId?: string;
  session?: WyomingServiceSessionSnapshot;
}

export type WyomingServiceDispatchResult = void | WyomingFrame | WyomingFrame[];

export interface WyomingServiceSessionClosedRequest {
  connectionId: string;
  sessionId: string;
  reason: string;
}

export interface WyomingServiceAdapter {
  id: string;
  family: WyomingServiceFamily;
  service: WyomingServiceInfo;
  eventTypes: readonly string[];
  handle(
    request: WyomingServiceDispatchRequest,
  ): Promise<WyomingServiceDispatchResult> | WyomingServiceDispatchResult;
  onSessionClosed?(request: WyomingServiceSessionClosedRequest): Promise<void> | void;
}

export interface WyomingServiceRegistry {
  services: WyomingServiceInfo[];
  dispatch(
    request: WyomingServiceDispatchRequest,
  ): Promise<WyomingServiceDispatchResult | undefined>;
  closeSession(request: WyomingServiceSessionClosedRequest): Promise<void>;
}

const EVENT_FAMILY_BY_TYPE: ReadonlyMap<string, WyomingServiceFamily> = (() => {
  const entries: Array<readonly [string, WyomingServiceFamily]> = [];
  for (const type of WYOMING_HANDLE_EVENT_TYPES) {
    entries.push([type, 'handle'] as const);
  }
  for (const type of WYOMING_ASR_EVENT_TYPES) {
    entries.push([type, 'asr'] as const);
  }
  for (const type of WYOMING_TTS_EVENT_TYPES) {
    entries.push([type, 'tts'] as const);
  }
  return new Map(entries);
})();

function createNotSupportedFrame(
  family: WyomingServiceFamily,
  frame: WyomingFrame,
  sessionId?: string,
): WyomingFrame {
  return {
    type: 'error',
    data: {
      code: 'not_supported',
      event: frame.type,
      service: family,
      message: `${family} service is not enabled`,
      session_id: sessionId ?? null,
    },
  };
}

export function createWyomingServiceRegistry(
  adapters: WyomingServiceAdapter[],
): WyomingServiceRegistry {
  const eventMap = new Map<string, WyomingServiceAdapter>();
  const enabledFamilies = new Set<WyomingServiceFamily>();
  const servicesByName = new Map<string, WyomingServiceInfo>();

  for (const adapter of adapters) {
    enabledFamilies.add(adapter.family);

    if (!servicesByName.has(adapter.service.name)) {
      servicesByName.set(adapter.service.name, {
        ...adapter.service,
        supports: adapter.service.supports ? [...adapter.service.supports] : undefined,
      });
    }

    for (const eventType of adapter.eventTypes) {
      if (!eventMap.has(eventType)) {
        eventMap.set(eventType, adapter);
      }
    }
  }

  return {
    services: [...servicesByName.values()],
    async dispatch(request): Promise<WyomingServiceDispatchResult | undefined> {
      const adapter = eventMap.get(request.frame.type);
      if (adapter) {
        return await Promise.resolve(adapter.handle(request));
      }

      const family = EVENT_FAMILY_BY_TYPE.get(request.frame.type);
      if (family && !enabledFamilies.has(family)) {
        return createNotSupportedFrame(family, request.frame, request.sessionId);
      }

      return undefined;
    },
    async closeSession(request): Promise<void> {
      await Promise.all(
        adapters.map(async (adapter) => {
          if (!adapter.onSessionClosed) return;
          try {
            await Promise.resolve(adapter.onSessionClosed(request));
          } catch {
            // Service cleanup should never block runtime session teardown.
          }
        }),
      );
    },
  };
}
