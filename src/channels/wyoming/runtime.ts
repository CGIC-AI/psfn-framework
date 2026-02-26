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
  type WyomingRuntimeErrorCode,
  type WyomingTransportSession,
  cloneInfoData,
  normalizeSessionId,
} from './protocol.js';

const log = createComponentLogger('WyomingRuntime');
const DEFAULT_MAX_CONCURRENT_SESSIONS = 128;

interface WyomingRuntimeSessionState {
  key: string;
  sessionId: string;
  connectionId: string;
  openedAtMs: number;
  lastSeenAtMs: number;
  transportSession: WyomingTransportSession;
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

export interface WyomingRuntimeOptions {
  info: WyomingInfoData | (() => WyomingInfoData);
  emitFrame: (transportSession: WyomingTransportSession, frame: WyomingFrame) => void | Promise<void>;
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
  maxConcurrentSessions?: number;
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

export class WyomingRuntime {
  private readonly sessions = new Map<string, WyomingRuntimeSessionState>();
  private readonly emitFrame: WyomingRuntimeOptions['emitFrame'];
  private readonly onSessionStart: WyomingRuntimeOptions['onSessionStart'];
  private readonly onSessionEnd: WyomingRuntimeOptions['onSessionEnd'];
  private readonly onUnhandledEvent: WyomingRuntimeOptions['onUnhandledEvent'];
  private readonly infoProvider: () => WyomingInfoData;
  private readonly now: () => number;
  private readonly maxConcurrentSessions: number;

  constructor(options: WyomingRuntimeOptions) {
    this.emitFrame = options.emitFrame;
    this.onSessionStart = options.onSessionStart;
    this.onSessionEnd = options.onSessionEnd;
    this.onUnhandledEvent = options.onUnhandledEvent;
    this.infoProvider = typeof options.info === 'function'
      ? options.info
      : () => options.info;
    this.now = options.now ?? (() => Date.now());

    const maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    if (!Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions <= 0) {
      throw new WyomingRuntimeError('INTERNAL_RUNTIME_ERROR', 'maxConcurrentSessions must be a positive integer');
    }
    this.maxConcurrentSessions = maxConcurrentSessions;
  }

  async handleFrame(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
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
      await this.safeEmitError(transportSession, frame, runtimeError.code, runtimeError.message);
    }
  }

  async stop(): Promise<void> {
    const states = [...this.sessions.values()];
    for (const state of states) {
      await this.safeOnSessionEnd(state, 'runtime.stop');
      this.sessions.delete(state.key);
    }
  }

  async closeConnection(connectionId: string, reason = 'transport.closed'): Promise<void> {
    const states = [...this.sessions.values()].filter((state) => state.connectionId === connectionId);
    for (const state of states) {
      await this.safeOnSessionEnd(state, reason);
      this.sessions.delete(state.key);
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
    await this.emit(transportSession, {
      type: WYOMING_EVENT_INFO,
      data: info,
    });
  }

  private async handlePing(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    const sessionId = normalizeSessionId(frame);
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
      );
    }

    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new WyomingRuntimeError(
        'SESSION_LIMIT_REACHED',
        `Maximum session count reached (${this.maxConcurrentSessions})`,
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

    try {
      if (this.onSessionEnd) {
        await Promise.resolve(this.onSessionEnd(toSessionSnapshot(state), 'session.end'));
      }
    } finally {
      this.sessions.delete(state.key);
    }

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
      state.lastSeenAtMs = this.now();
    }

    if (!this.onUnhandledEvent) {
      throw new WyomingRuntimeError('UNHANDLED_EVENT', `Unhandled Wyoming event: ${frame.type}`);
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
      throw new WyomingRuntimeError('SESSION_ID_REQUIRED', `Event ${frame.type} requires data.session_id`);
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
      );
    }

    return state;
  }

  private async safeOnSessionEnd(state: WyomingRuntimeSessionState, reason: string): Promise<void> {
    if (!this.onSessionEnd) {
      return;
    }

    try {
      await Promise.resolve(this.onSessionEnd(toSessionSnapshot(state), reason));
    } catch (error) {
      log.warn('Wyoming onSessionEnd hook failed', {
        sessionId: state.sessionId,
        connectionId: state.connectionId,
        reason,
        error: String(error),
      });
    }
  }

  private async emit(transportSession: WyomingTransportSession, frame: WyomingFrame): Promise<void> {
    await Promise.resolve(this.emitFrame(transportSession, frame));
  }

  private async safeEmitError(
    transportSession: WyomingTransportSession,
    sourceFrame: WyomingFrame,
    code: WyomingRuntimeErrorCode,
    message: string,
  ): Promise<void> {
    try {
      await this.emit(transportSession, {
        type: WYOMING_EVENT_ERROR,
        data: {
          code,
          message,
          event: sourceFrame.type,
          session_id: normalizeSessionId(sourceFrame) ?? null,
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

  private asRuntimeError(error: unknown): WyomingRuntimeError {
    if (error instanceof WyomingRuntimeError) {
      return error;
    }

    const normalized = toError(error);
    if (normalized.name === 'WyomingRuntimeError') {
      return new WyomingRuntimeError('INTERNAL_RUNTIME_ERROR', normalized.message);
    }

    return new WyomingRuntimeError('INTERNAL_RUNTIME_ERROR', normalized.message);
  }
}
