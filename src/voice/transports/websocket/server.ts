import { createComponentLogger } from '../../../logger.js';
import { VoiceWireDecodeError, parseInboundVoiceWireFrame } from './serializer.js';
import type {
  WebSocketVoiceConnection,
  WebSocketVoiceServerHooks,
  WebSocketVoiceServerOptions,
  WebSocketVoiceSession,
} from './types.js';

const log = createComponentLogger('VoiceWebSocketServer');

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
const CLOSE_CODE_MESSAGE_TOO_BIG = 1009;
const CLOSE_CODE_POLICY_VIOLATION = 1008;
const CLOSE_CODE_SESSION_TIMEOUT = 4000;
const CLOSE_CODE_SERVER_SHUTDOWN = 1012;

interface SessionState {
  connection: WebSocketVoiceConnection;
  session: WebSocketVoiceSession;
  timeout: NodeJS.Timeout;
  disposeMessageListener: () => void;
  disposeCloseListener: () => void;
  closed: boolean;
}

export class WebSocketVoiceServer {
  private readonly maxFrameBytes: number;
  private readonly sessionTimeoutMs: number;
  private readonly now: () => number;
  private readonly hooks: WebSocketVoiceServerHooks;
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    options: Partial<WebSocketVoiceServerOptions> = {},
    hooks: WebSocketVoiceServerHooks = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.hooks = hooks;
  }

  attach(connection: WebSocketVoiceConnection): () => void {
    const now = this.now();
    const session: WebSocketVoiceSession = {
      id: connection.id,
      connectionId: connection.id,
      openedAtMs: now,
      lastSeenAtMs: now,
    };

    const timeout = setTimeout(() => {
      this.closeSession(connection.id, 'timeout', CLOSE_CODE_SESSION_TIMEOUT, 'session timeout');
    }, this.sessionTimeoutMs);

    const handleMessage = (raw: string) => {
      const state = this.sessions.get(connection.id);
      if (!state || state.closed) return;

      state.session.lastSeenAtMs = this.now();
      this.resetTimeout(state);

      try {
        const frame = parseInboundVoiceWireFrame(raw, this.maxFrameBytes);
        this.fireHook('onFrame', state.session, frame);
      } catch (error) {
        if (error instanceof VoiceWireDecodeError && error.code === 'FRAME_TOO_LARGE') {
          log.warn('WebSocket frame rejected: too large', { connectionId: connection.id, error: error.message });
          this.closeSession(connection.id, 'decode_error', CLOSE_CODE_MESSAGE_TOO_BIG, 'frame too large');
          return;
        }

        log.warn('WebSocket frame rejected: invalid payload', {
          connectionId: connection.id,
          error: String(error),
        });
        this.closeSession(connection.id, 'decode_error', CLOSE_CODE_POLICY_VIOLATION, 'invalid voice frame');
      }
    };

    const handleClose = () => {
      this.closeSession(connection.id, 'client_disconnect');
    };

    const disposeMessageListener = connection.onMessage(handleMessage);
    const disposeCloseListener = connection.onClose(handleClose);

    this.sessions.set(connection.id, {
      connection,
      session,
      timeout,
      disposeMessageListener,
      disposeCloseListener,
      closed: false,
    });

    this.fireHook('onSessionOpen', session);

    return () => {
      this.closeSession(connection.id, 'shutdown', CLOSE_CODE_SERVER_SHUTDOWN, 'server detach');
    };
  }

  stop(): void {
    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId, 'shutdown', CLOSE_CODE_SERVER_SHUTDOWN, 'server shutdown');
    }
  }

  private resetTimeout(state: SessionState): void {
    clearTimeout(state.timeout);
    state.timeout = setTimeout(() => {
      this.closeSession(state.connection.id, 'timeout', CLOSE_CODE_SESSION_TIMEOUT, 'session timeout');
    }, this.sessionTimeoutMs);
  }

  private closeSession(
    connectionId: string,
    reason: 'timeout' | 'client_disconnect' | 'decode_error' | 'shutdown',
    code?: number,
    message?: string,
  ): void {
    const state = this.sessions.get(connectionId);
    if (!state || state.closed) return;
    state.closed = true;

    clearTimeout(state.timeout);
    state.disposeMessageListener();
    state.disposeCloseListener();
    this.sessions.delete(connectionId);

    if (reason !== 'client_disconnect' && (code !== undefined || message !== undefined)) {
      state.connection.close(code, message);
    }

    this.fireHook('onSessionClose', state.session, reason);
  }

  private fireHook(
    hook: 'onSessionOpen',
    session: WebSocketVoiceSession,
  ): void;
  private fireHook(
    hook: 'onSessionClose',
    session: WebSocketVoiceSession,
    reason: 'timeout' | 'client_disconnect' | 'decode_error' | 'shutdown',
  ): void;
  private fireHook(
    hook: 'onFrame',
    session: WebSocketVoiceSession,
    frame: Parameters<NonNullable<WebSocketVoiceServerHooks['onFrame']>>[1],
  ): void;
  private fireHook(
    hook: keyof WebSocketVoiceServerHooks,
    session: WebSocketVoiceSession,
    value?: unknown,
  ): void {
    const fn = this.hooks[hook];
    if (!fn) return;

    Promise.resolve(
      hook === 'onSessionOpen'
        ? (fn as NonNullable<WebSocketVoiceServerHooks['onSessionOpen']>)(session)
        : hook === 'onSessionClose'
          ? (fn as NonNullable<WebSocketVoiceServerHooks['onSessionClose']>)(
            session,
            value as 'timeout' | 'client_disconnect' | 'decode_error' | 'shutdown',
          )
          : (fn as NonNullable<WebSocketVoiceServerHooks['onFrame']>)(
            session,
            value as Parameters<NonNullable<WebSocketVoiceServerHooks['onFrame']>>[1],
          ),
    ).catch((error) => {
      log.warn('Voice websocket hook failed', { hook, error: String(error) });
    });
  }
}
