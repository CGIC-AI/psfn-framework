export type WyomingJsonPrimitive = string | number | boolean | null;

export type WyomingJsonValue =
  | WyomingJsonPrimitive
  | WyomingJsonObject
  | WyomingJsonValue[];

export interface WyomingJsonObject {
  [key: string]: WyomingJsonValue | undefined;
}

export interface WyomingFrame {
  type: string;
  data?: WyomingJsonObject;
  payload?: Uint8Array;
  headers?: Record<string, string>;
}

export interface WyomingTransportSession {
  id: string;
  connectionId: string;
  openedAtMs: number;
  lastSeenAtMs: number;
  remoteAddress?: string;
  remotePort?: number;
}

export interface WyomingServiceInfo extends WyomingJsonObject {
  name: string;
  description?: string;
  version?: string;
  supports?: string[];
}

export interface WyomingInfoData extends WyomingJsonObject {
  name: string;
  version: string;
  description?: string;
  services: WyomingServiceInfo[];
}

export const WYOMING_EVENT_DESCRIBE = 'describe' as const;
export const WYOMING_EVENT_INFO = 'info' as const;
export const WYOMING_EVENT_ERROR = 'error' as const;
export const WYOMING_EVENT_PING = 'ping' as const;
export const WYOMING_EVENT_PONG = 'pong' as const;
export const WYOMING_EVENT_ACK = 'ack' as const;
export const WYOMING_EVENT_SESSION_START = 'session.start' as const;
export const WYOMING_EVENT_SESSION_END = 'session.end' as const;

export interface WyomingPolicyViolationDetail {
  scope: 'runtime' | 'transport' | 'codec';
  sessionId?: string;
  eventType?: string;
  limit?: number;
  observed?: number;
}

export type WyomingCodecErrorCode =
  | 'HEADER_TOO_LARGE'
  | 'FRAME_TOO_LARGE'
  | 'INVALID_HEADER'
  | 'INVALID_DATA'
  | 'INVALID_PAYLOAD_LENGTH'
  | 'PAYLOAD_TOO_LARGE';

export class WyomingCodecError extends Error {
  readonly code: WyomingCodecErrorCode;
  readonly detail?: WyomingPolicyViolationDetail;

  constructor(code: WyomingCodecErrorCode, message: string, detail?: WyomingPolicyViolationDetail) {
    super(message);
    this.name = 'WyomingCodecError';
    this.code = code;
    this.detail = detail;
  }
}

export type WyomingRuntimeErrorCode =
  | 'INVALID_EVENT'
  | 'SESSION_ID_REQUIRED'
  | 'SESSION_ALREADY_EXISTS'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_LIMIT_REACHED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'UNHANDLED_EVENT'
  | 'INTERNAL_RUNTIME_ERROR';

export class WyomingRuntimeError extends Error {
  readonly code: WyomingRuntimeErrorCode;
  readonly detail?: WyomingPolicyViolationDetail;

  constructor(code: WyomingRuntimeErrorCode, message: string, detail?: WyomingPolicyViolationDetail) {
    super(message);
    this.name = 'WyomingRuntimeError';
    this.code = code;
    this.detail = detail;
  }
}

export type WyomingServerCloseReason =
  | 'timeout'
  | 'client_disconnect'
  | 'decode_error'
  | 'runtime_error'
  | 'rate_limited'
  | 'backpressure'
  | 'shutdown';

export type WyomingServerErrorCode =
  | 'SERVER_NOT_RUNNING'
  | 'SESSION_NOT_FOUND'
  | 'READ_RATE_LIMIT_EXCEEDED'
  | 'WRITE_QUEUE_OVERFLOW'
  | 'SOCKET_CLOSED';

export class WyomingServerError extends Error {
  readonly code: WyomingServerErrorCode;
  readonly detail?: WyomingPolicyViolationDetail;

  constructor(code: WyomingServerErrorCode, message: string, detail?: WyomingPolicyViolationDetail) {
    super(message);
    this.name = 'WyomingServerError';
    this.code = code;
    this.detail = detail;
  }
}

export { isRecord } from '../../shared/utils/types.js';

export function normalizeSessionId(frame: WyomingFrame): string | undefined {
  const data = frame.data;
  if (!data) return undefined;

  const candidates = [
    data.session_id,
    data.sessionId,
    data.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

export function cloneInfoData(info: WyomingInfoData): WyomingInfoData {
  return {
    ...info,
    services: info.services.map((service) => ({
      ...service,
      supports: service.supports ? [...service.supports] : undefined,
    })),
  };
}
