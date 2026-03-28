import type {
  WyomingFrame,
  WyomingServiceInfo,
  WyomingTransportSession,
} from '../../protocol/index.js';

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
