import type {
  SatelliteHubClientEventMap,
  SatelliteHubConnectionState,
  SatelliteHubErrorEvent,
  SatelliteHubInboundEvent,
  SatelliteHubSession,
  SatelliteHubSnapshot,
  SatelliteHubStateEvent,
} from '../api/client.js';
import type {
  ApprovalResolvedStatus,
  HubToClientMessage,
  ToolActivityPhase,
} from '../protocol/events.js';

export type HubStreamConnection =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'ready'
  | 'disconnected'
  | 'failed';

export type HubStreamPhase = 'idle' | 'listening' | 'responding' | 'interrupted' | 'failed';

export interface HubStreamMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  live: boolean;
  final: boolean;
  sequence: number;
  receivedAt: string;
  sessionId?: string;
  channelId?: string;
}

export interface HubStreamEventLogEntry {
  sequence: number;
  receivedAt: string;
  type: HubToClientMessage['type'];
  sessionId?: string;
  channelId?: string;
  message: HubToClientMessage;
}

export interface HubStreamFailure {
  message: string;
  recoverable: boolean;
  at: string;
  cause?: unknown;
}

export type ApprovalEntryStatus = 'pending' | ApprovalResolvedStatus;

/** Raw accumulated approval request/resolution, keyed by id. */
export interface ApprovalStreamEntry {
  id: string;
  title: string;
  requestedAt: string;
  expiresAt?: string;
  redactedContext: string;
  status: ApprovalEntryStatus;
  resolvedAt?: string;
}

/** Raw accumulated artifact-shelf item from `artifact.created`. */
export interface ArtifactStreamItem {
  id: string;
  label: string;
  mediaType: string;
  provenance: string;
  createdAt: string;
  previewable: boolean;
}

export type ArtifactPreviewStatus = 'loading' | 'ready' | 'denied' | 'expired' | 'error';

/** Correlated preview-fetch state for one artifact, keyed by artifactId. */
export interface ArtifactPreviewStreamState {
  status: ArtifactPreviewStatus;
  requestId: string;
  mediaType?: string;
  /** base64-encoded preview payload, present only when status is 'ready' */
  data?: string;
  message?: string;
}

/** One tool-activity lifecycle event, grouped downstream by `id`. */
export interface ToolActivityStreamEntry {
  id: string;
  tool: string;
  phase: ToolActivityPhase;
  detail?: string;
  timestamp: string;
  sequence: number;
  receivedAt: string;
}

export interface HubStreamState {
  connection: HubStreamConnection;
  phase: HubStreamPhase;
  status: string | null;
  session: SatelliteHubSession | null;
  messages: HubStreamMessage[];
  liveAssistant: HubStreamMessage | null;
  events: HubStreamEventLogEntry[];
  failure: HubStreamFailure | null;
  approvals: ApprovalStreamEntry[];
  artifacts: ArtifactStreamItem[];
  artifactPreviews: Record<string, ArtifactPreviewStreamState>;
  toolActivity: ToolActivityStreamEntry[];
  sequence: number;
  updatedAt: string;
}

export type HubStreamReducerEvent =
  | { type: 'client.state'; event: SatelliteHubStateEvent; at: string }
  | { type: 'client.session'; session: SatelliteHubSession; at: string }
  | { type: 'client.error'; event: SatelliteHubErrorEvent; at: string }
  | { type: 'hub.inbound'; event: SatelliteHubInboundEvent; at: string }
  | { type: 'artifact.preview.request'; requestId: string; artifactId: string; at: string }
  | { type: 'artifact.preview.timeout'; requestId: string; artifactId: string; at: string };

export interface HubStreamClientLike {
  on<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    listener: (event: SatelliteHubClientEventMap[K]) => void,
  ): () => void;
  connect(): Promise<void>;
  disconnect(): void;
  sendUserText(text: string, options?: { interrupt?: boolean }): void;
  interrupt(): void;
  sendApprovalDecision(id: string, decision: 'approve' | 'deny'): void;
  sendArtifactPreviewRequest(requestId: string, artifactId: string): void;
  snapshot(): SatelliteHubSnapshot;
}

export interface HubStreamStoreOptions {
  clock?: () => Date;
  requestIdFactory?: () => string;
  scheduleTimeout?: (callback: () => void, ms: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  previewTimeoutMs?: number;
}

const DEFAULT_PREVIEW_TIMEOUT_MS = 15_000;

export function createInitialHubStreamState(at = new Date().toISOString()): HubStreamState {
  return {
    connection: 'idle',
    phase: 'idle',
    status: null,
    session: null,
    messages: [],
    liveAssistant: null,
    events: [],
    failure: null,
    approvals: [],
    artifacts: [],
    artifactPreviews: {},
    toolActivity: [],
    sequence: 0,
    updatedAt: at,
  };
}

export function reduceHubStreamState(
  state: HubStreamState,
  event: HubStreamReducerEvent,
): HubStreamState {
  switch (event.type) {
    case 'client.state':
      return applyConnectionState(state, event.event.current, event.at);
    case 'client.session':
      return {
        ...state,
        session: cloneSession(event.session) ?? null,
        updatedAt: event.at,
      };
    case 'client.error':
      return {
        ...state,
        connection: event.event.recoverable ? state.connection : 'failed',
        phase: event.event.recoverable ? state.phase : 'failed',
        failure: {
          message: event.event.message,
          recoverable: event.event.recoverable,
          cause: event.event.cause,
          at: event.at,
        },
        updatedAt: event.at,
      };
    case 'hub.inbound':
      return applyInboundMessage(state, event.event.message, event.at);
    case 'artifact.preview.request':
      return {
        ...state,
        artifactPreviews: {
          ...state.artifactPreviews,
          [event.artifactId]: { status: 'loading', requestId: event.requestId },
        },
        updatedAt: event.at,
      };
    case 'artifact.preview.timeout': {
      const pending = state.artifactPreviews[event.artifactId];
      if (!pending || pending.requestId !== event.requestId || pending.status !== 'loading') {
        return state;
      }
      return {
        ...state,
        artifactPreviews: {
          ...state.artifactPreviews,
          [event.artifactId]: {
            status: 'error',
            requestId: event.requestId,
            message: 'Preview timed out',
          },
        },
        updatedAt: event.at,
      };
    }
  }
}

export class HubStreamStore {
  private state: HubStreamState;
  private readonly listeners = new Set<(state: HubStreamState) => void>();
  private readonly unsubscribeClient: Array<() => void>;
  private readonly clock: () => Date;
  private readonly requestIdFactory: () => string;
  private readonly scheduleTimeout: (callback: () => void, ms: number) => unknown;
  private readonly cancelTimeout: (handle: unknown) => void;
  private readonly previewTimeoutMs: number;
  private readonly previewTimers = new Map<string, unknown>();

  constructor(
    private readonly client: HubStreamClientLike,
    initialState: HubStreamState = createInitialHubStreamState(),
    options: (() => Date) | HubStreamStoreOptions = {},
  ) {
    const resolved: HubStreamStoreOptions = typeof options === 'function' ? { clock: options } : options;
    this.clock = resolved.clock ?? (() => new Date());
    this.requestIdFactory = resolved.requestIdFactory ?? defaultRequestIdFactory;
    this.scheduleTimeout = resolved.scheduleTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.cancelTimeout = resolved.cancelTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.previewTimeoutMs = resolved.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
    this.state = {
      ...initialState,
      session: cloneSession(client.snapshot().session) ?? null,
      connection: mapClientConnection(client.snapshot().state),
    };
    this.unsubscribeClient = [
      client.on('state', (event) => this.dispatch({ type: 'client.state', event, at: this.now() })),
      client.on('session', (session) => this.dispatch({ type: 'client.session', session, at: this.now() })),
      client.on('error', (event) => this.dispatch({ type: 'client.error', event, at: this.now() })),
      client.on('inbound', (event) => this.handleInbound(event.message)),
    ];
  }

  subscribe(listener: (state: HubStreamState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): HubStreamState {
    return {
      ...this.state,
      session: cloneSession(this.state.session ?? undefined) ?? null,
      messages: this.state.messages.map((message) => ({ ...message })),
      liveAssistant: this.state.liveAssistant ? { ...this.state.liveAssistant } : null,
      events: this.state.events.map((entry) => ({ ...entry })),
      failure: this.state.failure ? { ...this.state.failure } : null,
      approvals: this.state.approvals.map((entry) => ({ ...entry })),
      artifacts: this.state.artifacts.map((item) => ({ ...item })),
      artifactPreviews: cloneArtifactPreviews(this.state.artifactPreviews),
      toolActivity: this.state.toolActivity.map((entry) => ({ ...entry })),
    };
  }

  connect(): Promise<void> {
    return this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  sendUserText(text: string, options?: { interrupt?: boolean }): void {
    this.client.sendUserText(text, options);
  }

  interrupt(): void {
    this.client.interrupt();
  }

  /**
   * Send an approve/deny decision for a hub approval request. The transport
   * (framing + client) fails closed if the socket is not connected.
   */
  submitApprovalDecision(id: string, decision: 'approve' | 'deny'): void {
    this.client.sendApprovalDecision(id, decision);
  }

  /**
   * Request a scoped artifact preview. Correlates the reply by a freshly
   * minted requestId and arms a timeout so a silent hub ages the preview out
   * as a failure instead of hanging in the loading state.
   */
  requestArtifactPreview(artifactId: string): void {
    const requestId = this.requestIdFactory();
    this.clearPreviewTimer(artifactId);
    this.dispatch({ type: 'artifact.preview.request', requestId, artifactId, at: this.now() });
    this.client.sendArtifactPreviewRequest(requestId, artifactId);
    const handle = this.scheduleTimeout(() => {
      this.previewTimers.delete(artifactId);
      this.dispatch({ type: 'artifact.preview.timeout', requestId, artifactId, at: this.now() });
    }, this.previewTimeoutMs);
    this.previewTimers.set(artifactId, handle);
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribeClient) {
      unsubscribe();
    }
    for (const artifactId of [...this.previewTimers.keys()]) {
      this.clearPreviewTimer(artifactId);
    }
    this.listeners.clear();
  }

  private handleInbound(message: HubToClientMessage): void {
    // A correlated preview reply settles the pending timeout.
    if (
      (message.type === 'artifact.preview.result' || message.type === 'artifact.preview.error') &&
      this.state.artifactPreviews[message.artifactId]?.requestId === message.requestId
    ) {
      this.clearPreviewTimer(message.artifactId);
    }
    this.dispatch({ type: 'hub.inbound', event: { message }, at: this.now() });
  }

  private clearPreviewTimer(artifactId: string): void {
    const handle = this.previewTimers.get(artifactId);
    if (handle !== undefined) {
      this.cancelTimeout(handle);
      this.previewTimers.delete(artifactId);
    }
  }

  private dispatch(event: HubStreamReducerEvent): void {
    this.state = reduceHubStreamState(this.state, event);
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function applyConnectionState(
  state: HubStreamState,
  connectionState: SatelliteHubConnectionState,
  at: string,
): HubStreamState {
  const connection = mapClientConnection(connectionState);
  const healthy = connection === 'connecting' || connection === 'connected' || connection === 'ready';
  return {
    ...state,
    connection,
    phase: connection === 'failed' ? 'failed' : state.phase,
    failure: healthy ? null : state.failure,
    updatedAt: at,
  };
}

function applyInboundMessage(
  state: HubStreamState,
  message: HubToClientMessage,
  at: string,
): HubStreamState {
  const sequence = state.sequence + 1;
  const eventLog: HubStreamEventLogEntry = {
    sequence,
    receivedAt: at,
    type: message.type,
    sessionId: state.session?.sessionId,
    channelId: state.session?.channelId,
    message,
  };
  const base: HubStreamState = {
    ...state,
    sequence,
    events: [...state.events, eventLog],
    updatedAt: at,
  };

  switch (message.type) {
    case 'session.ready':
      return {
        ...base,
        connection: 'ready',
        phase: 'listening',
        session: {
          deviceId: message.deviceId,
          deviceName: message.deviceName,
          satelliteId: message.satelliteId,
          satelliteName: state.session?.satelliteName ?? message.deviceName,
          sessionId: message.sessionId,
          channelId: message.channelId,
          audioFormat: message.audioFormat,
          identity: message.identity,
        },
      };
    case 'hello.ack':
      return {
        ...base,
        connection: 'ready',
        phase: 'listening',
        session: {
          deviceId: message.deviceId,
          deviceName: message.deviceName,
          satelliteId: message.satelliteId,
          satelliteName: message.satelliteName,
          sessionId: message.sessionId,
          channelId: message.channelId,
          capabilities: cloneCapabilities(message.capabilities),
          identity: message.identity,
        },
      };
    case 'status':
      return {
        ...base,
        status: message.data,
        phase: message.data === 'call_initialized' ? 'listening' : base.phase,
      };
    case 'message':
      return applyConversationMessage(base, message, at, sequence);
    case 'assistant.interrupted':
      return {
        ...base,
        phase: 'interrupted',
        liveAssistant: null,
      };
    case 'error-event':
      return {
        ...base,
        connection: 'failed',
        phase: 'failed',
        failure: {
          message: message.data.message,
          recoverable: true,
          at,
        },
      };
    case 'approval.requested': {
      const entry: ApprovalStreamEntry = {
        id: message.data.id,
        title: message.data.title,
        requestedAt: message.data.requestedAt,
        expiresAt: message.data.expiresAt,
        redactedContext: message.data.redactedContext,
        status: 'pending',
      };
      return { ...base, approvals: upsertById(base.approvals, entry) };
    }
    case 'approval.resolved': {
      const approvals = base.approvals.map((entry) =>
        entry.id === message.data.id
          ? { ...entry, status: message.data.status, resolvedAt: message.data.resolvedAt }
          : entry,
      );
      return { ...base, approvals };
    }
    case 'artifact.created': {
      const item: ArtifactStreamItem = {
        id: message.data.id,
        label: message.data.label,
        mediaType: message.data.mediaType,
        provenance: message.data.provenance,
        createdAt: message.data.createdAt,
        previewable: message.data.previewable,
      };
      return { ...base, artifacts: upsertById(base.artifacts, item) };
    }
    case 'artifact.preview.result': {
      const pending = base.artifactPreviews[message.artifactId];
      // Fail closed: only accept a result that correlates to an in-flight
      // request. Unsolicited or stale (superseded requestId) results are dropped.
      if (!pending || pending.requestId !== message.requestId || pending.status !== 'loading') {
        return base;
      }
      return {
        ...base,
        artifactPreviews: {
          ...base.artifactPreviews,
          [message.artifactId]: {
            status: 'ready',
            requestId: message.requestId,
            mediaType: message.mediaType,
            data: message.data,
          },
        },
      };
    }
    case 'artifact.preview.error': {
      const pending = base.artifactPreviews[message.artifactId];
      if (!pending || pending.requestId !== message.requestId || pending.status !== 'loading') {
        return base;
      }
      return {
        ...base,
        artifactPreviews: {
          ...base.artifactPreviews,
          [message.artifactId]: {
            status: classifyPreviewError(message.message),
            requestId: message.requestId,
            message: message.message,
          },
        },
      };
    }
    case 'tool.activity': {
      const entry: ToolActivityStreamEntry = {
        id: message.data.id,
        tool: message.data.tool,
        phase: message.data.phase,
        detail: message.data.detail,
        timestamp: message.data.timestamp,
        sequence,
        receivedAt: at,
      };
      return { ...base, toolActivity: [...base.toolActivity, entry] };
    }
    case 'text':
    case 'audio':
    case 'action':
    case 'pong':
    case 'relay.stt.result':
    case 'relay.tts.chunk':
    case 'relay.tts.done':
    case 'relay.error':
      return base;
  }
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [...items, next];
  }
  const copy = [...items];
  copy[index] = next;
  return copy;
}

/**
 * Classify a hub `artifact.preview.error` message into a rendered preview
 * status. The v1 artifact contract carries no dedicated denial/expiry event,
 * so denial and expiry are surfaced from the error message text (hub is the
 * source of that wording). Anything else is a generic error.
 */
function classifyPreviewError(message: string): ArtifactPreviewStatus {
  const normalized = message.toLowerCase();
  if (/(denied|deny|forbidden|not authorized|unauthorized|access)/.test(normalized)) {
    return 'denied';
  }
  if (/expir/.test(normalized)) {
    return 'expired';
  }
  return 'error';
}

function applyConversationMessage(
  state: HubStreamState,
  message: Extract<HubToClientMessage, { type: 'message' }>,
  at: string,
  sequence: number,
): HubStreamState {
  const streamMessage: HubStreamMessage = {
    id: `${state.session?.sessionId ?? 'session'}:${sequence}:${message.data.role}`,
    role: message.data.role,
    content: message.data.content,
    live: message.data.live ?? false,
    final: message.data.final ?? false,
    sequence,
    receivedAt: at,
    sessionId: state.session?.sessionId,
    channelId: state.session?.channelId,
  };

  if (message.data.role === 'assistant' && streamMessage.live && !streamMessage.final) {
    const previous = state.liveAssistant;
    return {
      ...state,
      phase: 'responding',
      liveAssistant: {
        ...streamMessage,
        id: previous?.id ?? streamMessage.id,
        content: `${previous?.content ?? ''}${streamMessage.content}`,
        sequence: previous?.sequence ?? streamMessage.sequence,
        receivedAt: previous?.receivedAt ?? streamMessage.receivedAt,
      },
    };
  }

  const messages = [...state.messages, { ...streamMessage, live: false, final: true }];
  return {
    ...state,
    phase: message.data.role === 'assistant' ? 'listening' : 'responding',
    liveAssistant: message.data.role === 'assistant' ? null : state.liveAssistant,
    messages,
  };
}

function mapClientConnection(state: SatelliteHubConnectionState): HubStreamConnection {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'ready':
      return 'ready';
    case 'closing':
    case 'closed':
      return 'disconnected';
    case 'error':
      return 'failed';
  }
}

function cloneSession(session: SatelliteHubSession | undefined): SatelliteHubSession | undefined {
  if (!session) {
    return undefined;
  }
  return {
    ...session,
    capabilities: cloneCapabilities(session.capabilities),
    identity: session.identity
      ? {
          source: session.identity.source,
          companion: session.identity.companion ? { ...session.identity.companion } : undefined,
          user: session.identity.user ? { ...session.identity.user } : undefined,
        }
      : undefined,
  };
}

function cloneArtifactPreviews(
  previews: Record<string, ArtifactPreviewStreamState>,
): Record<string, ArtifactPreviewStreamState> {
  const clone: Record<string, ArtifactPreviewStreamState> = {};
  for (const [key, value] of Object.entries(previews)) {
    clone[key] = { ...value };
  }
  return clone;
}

let requestIdCounter = 0;

function defaultRequestIdFactory(): string {
  requestIdCounter += 1;
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto?.randomUUID) {
    return `preview-${globalCrypto.randomUUID()}`;
  }
  return `preview-${Date.now().toString(36)}-${requestIdCounter}`;
}

function cloneCapabilities(capabilities: SatelliteHubSession['capabilities']): SatelliteHubSession['capabilities'] {
  if (!capabilities) {
    return undefined;
  }
  return {
    input: capabilities.input ? [...capabilities.input] : undefined,
    output: capabilities.output ? [...capabilities.output] : undefined,
    control: capabilities.control ? [...capabilities.control] : undefined,
    safety: capabilities.safety ? [...capabilities.safety] : undefined,
  };
}
