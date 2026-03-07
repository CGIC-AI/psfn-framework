import type { EventBus, EventMap } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';
import {
  WYOMING_EVENT_ACK,
  WYOMING_EVENT_DESCRIBE,
  WYOMING_EVENT_ERROR,
  WYOMING_EVENT_INFO,
  WYOMING_EVENT_PING,
  WYOMING_EVENT_PONG,
  WYOMING_EVENT_SESSION_END,
  WYOMING_EVENT_SESSION_START,
  WyomingRuntimeError,
  type WyomingFrame,
  type WyomingInfoData,
  type WyomingPolicyViolationDetail,
  type WyomingRuntimeErrorCode,
  type WyomingServiceInfo,
  type WyomingTransportSession,
  cloneInfoData,
  normalizeSessionId,
} from './protocol.js';
import type { WyomingServiceRegistry } from './services/index.js';

const log = createComponentLogger('WyomingRuntime');
const DEFAULT_MAX_CONCURRENT_SESSIONS = 128;
const DEFAULT_MAX_EVENTS_PER_WINDOW = 120;
const DEFAULT_EVENT_RATE_WINDOW_MS = 1_000;

type WyomingEventName = Extract<keyof EventMap, `wyoming.${string}`>;

interface WyomingRuntimeSessionState {
  key: string;
  sessionId: string;
  connectionId: string;
  openedAtMs: number;
  lastSeenAtMs: number;
  transportSession: WyomingTransportSession;
  eventWindowStartedAtMs: number;
  eventsInWindow: number;
}

export interface WyomingRuntimeSessionSnapshot {
  sessionId: string;
  connectionId: string;
  openedAtMs: number;
  lastSeenAtMs: number;
}

export interface WyomingUnhandledEventRequest {
  transportSession: WyomingTransportSession;
  frame: WyomingFrame;
  sessionId?: string;
  session?: WyomingRuntimeSessionSnapshot;
}

export type WyomingUnhandledEventResult =
  | void
  | WyomingFrame
  | WyomingFrame[];

export interface WyomingAuditSummary {
  method: string;
  decision: 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL';
  params?: Record<string, unknown>;
  error?: string;
}

export interface WyomingRuntimeOptions {
  info: WyomingInfoData | (() => WyomingInfoData);
  emitFrame: (transportSession: WyomingTransportSession, frame: WyomingFrame) => void | Promise<void>;
  serviceRegistry?: WyomingServiceRegistry;
  onSessionStart?: (
    session: WyomingRuntimeSessionSnapshot,
    frame: WyomingFrame,
  ) => void | Promise<void>;
  onSessionEnd?: (
    session: WyomingRuntimeSessionSnapshot,
    reason: string,
  ) => void | Promise<void>;
  onUnhandledEvent?: (
    request: WyomingUnhandledEventRequest,
  ) => Promise<WyomingUnhandledEventResult> | WyomingUnhandledEventResult;
  onAuditSummary?: (summary: WyomingAuditSummary) => void | Promise<void>;
  eventBus?: Pick<EventBus, 'emit'>;
  maxConcurrentSessions?: number;
  maxEventsPerSessionWindow?: number;
  eventRateWindowMs?: number;
  now?: () => number;
}

function toSessionKey(connectionId: string, sessionId: string): string {
  return `${connectionId}:${sessionId}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toSessionSnapshot(state: WyomingRuntimeSessionState): WyomingRuntimeSessionSnapshot {
  return {
    sessionId: state.sessionId,
    connectionId: state.connectionId,
    openedAtMs: state.openedAtMs,
    lastSeenAtMs: state.lastSeenAtMs,
  };
}

function mergeServiceInfo(
  infoServices: WyomingServiceInfo[],
  registryServices: WyomingServiceInfo[],
): WyomingServiceInfo[] {
  const merged = new Map<string, WyomingServiceInfo>();

  for (const service of infoServices) {
    merged.set(service.name, {
      ...service,
      supports: service.supports ? [...service.supports] : undefined,
    });
  }

  for (const service of registryServices) {
    const existing = merged.get(service.name);
    if (!existing) {
      merged.set(service.name, {
        ...service,
        supports: service.supports ? [...service.supports] : undefined,
      });
      continue;
    }

    const supports = new Set<string>([
      ...(existing.supports ?? []),
      ...(service.supports ?? []),
    ]);

    merged.set(service.name, {
      ...existing,
      ...service,
      supports: supports.size > 0 ? [...supports] : undefined,
    });
  }

  return [...merged.values()];
}

function payloadBytes(frame: WyomingFrame): number {
  return frame.payload?.byteLength ?? 0;
}

function toPositiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new WyomingRuntimeError('INTERNAL_RUNTIME_ERROR', `${field} must be a positive integer`);
  }
  return resolved;
}

export class WyomingRuntime {
  private readonly sessions = new Map<string, WyomingRuntimeSessionState>();
  private readonly emitFrame: WyomingRuntimeOptions['emitFrame'];
  private readonly serviceRegistry?: WyomingServiceRegistry;
  private readonly onSessionStart: WyomingRuntimeOptions['onSessionStart'];
  private readonly onSessionEnd: WyomingRuntimeOptions['onSessionEnd'];
  private readonly onUnhandledEvent: WyomingRuntimeOptions['onUnhandledEvent'];
  private readonly onAuditSummary: WyomingRuntimeOptions['onAuditSummary'];
  private readonly eventBus: WyomingRuntimeOptions['eventBus'];
  private readonly infoProvider: () => WyomingInfoData;
  private readonly now: () => number;
  private readonly maxConcurrentSessions: number;
  private readonly maxEventsPerSessionWindow: number;
  private readonly eventRateWindowMs: number;

  constructor(options: WyomingRuntimeOptions) {
    this.emitFrame = options.emitFrame;
    this.serviceRegistry = options.serviceRegistry;
    this.onSessionStart = options.onSessionStart;
    this.onSessionEnd = options.onSessionEnd;
    this.onUnhandledEvent = options.onUnhandledEvent;
    this.onAuditSummary = options.onAuditSummary;
    this.eventBus = options.eventBus;
    const runtimeInfo = options.info;
    this.infoProvider = typeof runtimeInfo === 'function'
      ? runtimeInfo
      : () => runtimeInfo;
    this.now = options.now ?? (() => Date.now());

    this.maxConcurrentSessions = toPositiveInteger(
      options.maxConcurrentSessions,
      DEFAULT_MAX_CONCURRENT_SESSIONS,
      'maxConcurrentSessions',
    );
    this.maxEventsPerSessionWindow = toPositiveInteger(
      options.maxEventsPerSessionWindow,
      DEFAULT_MAX_EVENTS_PER_WINDOW,
      'maxEventsPerSessionWindow',
    );
    this.eventRateWindowMs = toPositiveInteger(
      options.eventRateWindowMs,
      DEFAULT_EVENT_RATE_WINDOW_MS,
      'eventRateWindowMs',
    );
  }

  async handleFrame(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    const sessionId = normalizeSessionId(frame);
    await this.safeEmitWyomingEvent('wyoming.frame.received', {
      connectionId: transportSession.connectionId,
      frameType: frame.type,
      sessionId,
      payloadBytes: payloadBytes(frame),
      timestampMs: this.now(),
    });

    try {
      switch (frame.type) {
        case WYOMING_EVENT_DESCRIBE:
          await this.handleDescribe(transportSession);
          return;
        case WYOMING_EVENT_PING:
          await this.handlePing(transportSession, frame);
          return;
        case WYOMING_EVENT_SESSION_START:
          await this.handleSessionStart(transportSession, frame);
          return;
        case WYOMING_EVENT_SESSION_END:
          await this.handleSessionEnd(transportSession, frame);
          return;
        default:
          await this.handleUnhandled(transportSession, frame);
      }
    } catch (error) {
      const runtimeError = this.asRuntimeError(error);
      if (runtimeError.code === 'RATE_LIMIT_EXCEEDED') {
        await this.forceCloseRateLimitedSession(transportSession.connectionId, sessionId);
      }
      await this.safeEmitPolicyViolation(transportSession, frame, runtimeError);
      await this.safeEmitError(transportSession, frame, runtimeError.code, runtimeError.message, runtimeError.detail);
    }
  }

  async stop(): Promise<void> {
    const states = [...this.sessions.values()];
    for (const state of states) {
      await this.endSession(state, 'runtime.stop', { suppressHookErrors: true });
    }
  }

  async closeConnection(connectionId: string, reason = 'transport.closed'): Promise<void> {
    const states = [...this.sessions.values()].filter((state) => state.connectionId === connectionId);
    for (const state of states) {
      await this.endSession(state, reason, { suppressHookErrors: true });
    }
  }

  listSessions(): WyomingRuntimeSessionSnapshot[] {
    return [...this.sessions.values()].map((state) => toSessionSnapshot(state));
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  private async handleDescribe(transportSession: WyomingTransportSession): Promise<void> {
    const info = cloneInfoData(this.infoProvider());
    if (this.serviceRegistry) {
      info.services = mergeServiceInfo(info.services, this.serviceRegistry.services);
    }
    await this.emit(transportSession, {
      type: WYOMING_EVENT_INFO,
      data: info,
    });
  }

  private async handlePing(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    const sessionId = normalizeSessionId(frame);
    if (sessionId) {
      const key = toSessionKey(transportSession.connectionId, sessionId);
      const state = this.sessions.get(key);
      if (state) {
        state.lastSeenAtMs = this.now();
      }
    }

    await this.emit(transportSession, {
      type: WYOMING_EVENT_PONG,
      data: sessionId ? { session_id: sessionId } : undefined,
    });
  }

  private async handleSessionStart(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    const sessionId = this.requireSessionId(frame);
    const key = toSessionKey(transportSession.connectionId, sessionId);

    if (this.sessions.has(key)) {
      throw new WyomingRuntimeError(
        'SESSION_ALREADY_EXISTS',
        `Session ${transportSession.connectionId}/${sessionId} already exists`,
        {
          scope: 'runtime',
          sessionId,
          eventType: frame.type,
        },
      );
    }

    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new WyomingRuntimeError(
        'SESSION_LIMIT_REACHED',
        `Maximum session count reached (${this.maxConcurrentSessions})`,
        {
          scope: 'runtime',
          sessionId,
          eventType: frame.type,
          limit: this.maxConcurrentSessions,
          observed: this.sessions.size + 1,
        },
      );
    }

    const now = this.now();
    const state: WyomingRuntimeSessionState = {
      key,
      sessionId,
      connectionId: transportSession.connectionId,
      openedAtMs: now,
      lastSeenAtMs: now,
      transportSession,
      eventWindowStartedAtMs: now,
      eventsInWindow: 0,
    };
    this.sessions.set(key, state);

    try {
      if (this.onSessionStart) {
        await Promise.resolve(this.onSessionStart(toSessionSnapshot(state), frame));
      }
    } catch (error) {
      this.sessions.delete(key);
      throw error;
    }

    await this.safeEmitWyomingEvent('wyoming.session.start', {
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      activeSessions: this.sessions.size,
      maxSessions: this.maxConcurrentSessions,
      timestampMs: now,
    });
    await this.safeAuditSummary({
      method: 'wyoming.session.start',
      decision: 'ALLOW',
      params: {
        connectionId: state.connectionId,
        sessionId: state.sessionId,
        activeSessions: this.sessions.size,
        maxSessions: this.maxConcurrentSessions,
      },
    });

    await this.emit(transportSession, {
      type: WYOMING_EVENT_ACK,
      data: {
        event: WYOMING_EVENT_SESSION_START,
        session_id: sessionId,
      },
    });
  }

  private async handleSessionEnd(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    const sessionId = this.requireSessionId(frame);
    const state = this.requireState(transportSession.connectionId, sessionId);
    this.enforceSessionRateLimit(state, frame.type);

    await this.endSession(state, 'session.end', { suppressHookErrors: false });

    await this.emit(transportSession, {
      type: WYOMING_EVENT_ACK,
      data: {
        event: WYOMING_EVENT_SESSION_END,
        session_id: sessionId,
      },
    });
  }

  private async handleUnhandled(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    const sessionId = normalizeSessionId(frame);
    const state = sessionId
      ? this.requireState(transportSession.connectionId, sessionId)
      : undefined;

    if (state) {
      this.enforceSessionRateLimit(state, frame.type);
      state.lastSeenAtMs = this.now();
    }

    if (this.serviceRegistry) {
      const serviceResult = await this.serviceRegistry.dispatch({
        transportSession,
        frame,
        sessionId,
        session: state ? toSessionSnapshot(state) : undefined,
      });
      if (serviceResult) {
        if (Array.isArray(serviceResult)) {
          for (const outbound of serviceResult) {
            await this.emit(transportSession, outbound);
          }
          return;
        }

        await this.emit(transportSession, serviceResult);
        return;
      }
    }

    if (!this.onUnhandledEvent) {
      throw new WyomingRuntimeError('UNHANDLED_EVENT', `Unhandled Wyoming event: ${frame.type}`, {
        scope: 'runtime',
        sessionId,
        eventType: frame.type,
      });
    }

    const result = await Promise.resolve(this.onUnhandledEvent({
      transportSession,
      frame,
      sessionId,
      session: state ? toSessionSnapshot(state) : undefined,
    }));

    if (!result) {
      return;
    }

    if (Array.isArray(result)) {
      for (const outbound of result) {
        await this.emit(transportSession, outbound);
      }
      return;
    }

    await this.emit(transportSession, result);
  }

  private requireSessionId(frame: WyomingFrame): string {
    const sessionId = normalizeSessionId(frame);
    if (!sessionId) {
      throw new WyomingRuntimeError('SESSION_ID_REQUIRED', `Event ${frame.type} requires data.session_id`, {
        scope: 'runtime',
        eventType: frame.type,
      });
    }
    return sessionId;
  }

  private requireState(connectionId: string, sessionId: string): WyomingRuntimeSessionState {
    const key = toSessionKey(connectionId, sessionId);
    const state = this.sessions.get(key);
    if (!state) {
      throw new WyomingRuntimeError(
        'SESSION_NOT_FOUND',
        `No active session for ${connectionId}/${sessionId}`,
        {
          scope: 'runtime',
          sessionId,
        },
      );
    }

    return state;
  }

  private enforceSessionRateLimit(state: WyomingRuntimeSessionState, eventType: string): void {
    const now = this.now();
    if (now - state.eventWindowStartedAtMs >= this.eventRateWindowMs) {
      state.eventWindowStartedAtMs = now;
      state.eventsInWindow = 0;
    }

    state.eventsInWindow += 1;
    if (state.eventsInWindow <= this.maxEventsPerSessionWindow) {
      return;
    }

    throw new WyomingRuntimeError(
      'RATE_LIMIT_EXCEEDED',
      `Session ${state.connectionId}/${state.sessionId} exceeded rate limit (${state.eventsInWindow} > ${this.maxEventsPerSessionWindow} in ${this.eventRateWindowMs}ms)`,
      {
        scope: 'runtime',
        sessionId: state.sessionId,
        eventType,
        limit: this.maxEventsPerSessionWindow,
        observed: state.eventsInWindow,
      },
    );
  }

  private async endSession(
    state: WyomingRuntimeSessionState,
    reason: string,
    options: { suppressHookErrors: boolean },
  ): Promise<void> {
    await this.safeOnServiceSessionClosed(state, reason);

    let hookError: Error | undefined;

    if (this.onSessionEnd) {
      try {
        await Promise.resolve(this.onSessionEnd(toSessionSnapshot(state), reason));
      } catch (error) {
        hookError = toError(error);
        if (options.suppressHookErrors) {
          log.warn('Wyoming onSessionEnd hook failed', {
            sessionId: state.sessionId,
            connectionId: state.connectionId,
            reason,
            error: hookError.message,
          });
        }
      }
    }

    this.sessions.delete(state.key);

    const durationMs = Math.max(0, this.now() - state.openedAtMs);
    await this.safeEmitWyomingEvent('wyoming.session.end', {
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      reason,
      durationMs,
      activeSessions: this.sessions.size,
      timestampMs: this.now(),
    });

    await this.safeAuditSummary({
      method: 'wyoming.session.end',
      decision: hookError ? 'DENY' : 'ALLOW',
      params: {
        connectionId: state.connectionId,
        sessionId: state.sessionId,
        reason,
        durationMs,
        activeSessions: this.sessions.size,
      },
      error: hookError?.message,
    });

    if (hookError && !options.suppressHookErrors) {
      throw hookError;
    }
  }

  private async forceCloseRateLimitedSession(connectionId: string, sessionId?: string): Promise<void> {
    if (!sessionId) {
      return;
    }

    const key = toSessionKey(connectionId, sessionId);
    const state = this.sessions.get(key);
    if (!state) {
      return;
    }

    await this.endSession(state, 'policy.rate_limit', { suppressHookErrors: true });
  }

  private async safeOnServiceSessionClosed(
    state: WyomingRuntimeSessionState,
    reason: string,
  ): Promise<void> {
    if (!this.serviceRegistry) {
      return;
    }

    try {
      await this.serviceRegistry.closeSession({
        connectionId: state.connectionId,
        sessionId: state.sessionId,
        reason,
      });
    } catch (error) {
      log.warn('Wyoming service cleanup hook failed', {
        sessionId: state.sessionId,
        connectionId: state.connectionId,
        reason,
        error: String(error),
      });
    }
  }

  private async emit(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    await Promise.resolve(this.emitFrame(transportSession, frame));
    await this.safeEmitWyomingEvent('wyoming.frame.sent', {
      connectionId: transportSession.connectionId,
      frameType: frame.type,
      sessionId: normalizeSessionId(frame),
      payloadBytes: payloadBytes(frame),
      timestampMs: this.now(),
    });
  }

  private async safeEmitError(
    transportSession: WyomingTransportSession,
    sourceFrame: WyomingFrame,
    code: WyomingRuntimeErrorCode,
    message: string,
    detail?: WyomingPolicyViolationDetail,
  ): Promise<void> {
    try {
      await this.emit(transportSession, {
        type: WYOMING_EVENT_ERROR,
        data: {
          code,
          message,
          event: sourceFrame.type,
          session_id: normalizeSessionId(sourceFrame) ?? null,
          limit: detail?.limit ?? null,
          observed: detail?.observed ?? null,
        },
      });
    } catch (error) {
      log.warn('Failed to emit Wyoming runtime error frame', {
        connectionId: transportSession.connectionId,
        code,
        error: String(error),
      });
    }
  }

  private async safeEmitPolicyViolation(
    transportSession: WyomingTransportSession,
    sourceFrame: WyomingFrame,
    runtimeError: WyomingRuntimeError,
  ): Promise<void> {
    const detail = runtimeError.detail;
    const sessionId = detail?.sessionId ?? normalizeSessionId(sourceFrame);
    const eventType = detail?.eventType ?? sourceFrame.type;

    await this.safeEmitWyomingEvent('wyoming.policy.violation', {
      connectionId: transportSession.connectionId,
      scope: detail?.scope ?? 'runtime',
      code: runtimeError.code,
      message: runtimeError.message,
      sessionId,
      eventType,
      limit: detail?.limit,
      observed: detail?.observed,
      action: 'error_frame',
      timestampMs: this.now(),
    });

    await this.safeAuditSummary({
      method: `wyoming.${eventType}`,
      decision: 'DENY',
      params: {
        connectionId: transportSession.connectionId,
        code: runtimeError.code,
        scope: detail?.scope ?? 'runtime',
        sessionId,
        eventType,
        limit: detail?.limit,
        observed: detail?.observed,
      },
      error: runtimeError.message,
    });
  }

  private async safeEmitWyomingEvent<E extends WyomingEventName>(event: E, data: EventMap[E]): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    try {
      await this.eventBus.emit(event, data);
    } catch (error) {
      log.warn('Failed to emit Wyoming telemetry event', {
        event,
        error: String(error),
      });
    }
  }

  private async safeAuditSummary(summary: WyomingAuditSummary): Promise<void> {
    await this.safeEmitWyomingEvent('wyoming.audit.summary', {
      ...summary,
      timestampMs: this.now(),
    });

    if (!this.onAuditSummary) {
      return;
    }

    try {
      await Promise.resolve(this.onAuditSummary(summary));
    } catch (error) {
      log.warn('Wyoming audit summary hook failed', {
        method: summary.method,
        decision: summary.decision,
        error: String(error),
      });
    }
  }

  private asRuntimeError(error: unknown): WyomingRuntimeError {
    if (error instanceof WyomingRuntimeError) {
      return error;
    }

    const normalized = toError(error);
    if (normalized.name === 'WyomingRuntimeError') {
      return new WyomingRuntimeError('INTERNAL_RUNTIME_ERROR', normalized.message, {
        scope: 'runtime',
      });
    }

    return new WyomingRuntimeError('INTERNAL_RUNTIME_ERROR', normalized.message, {
      scope: 'runtime',
    });
  }
}
