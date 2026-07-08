import type {
  SatelliteHubClientEventMap,
  SatelliteHubConnectionState,
  SatelliteHubErrorEvent,
  SatelliteHubInboundEvent,
  SatelliteHubSession,
  SatelliteHubSnapshot,
  SatelliteHubStateEvent,
} from '../api/client.js';
import type { HubToClientMessage } from '../protocol/events.js';

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

export interface HubStreamState {
  connection: HubStreamConnection;
  phase: HubStreamPhase;
  status: string | null;
  session: SatelliteHubSession | null;
  messages: HubStreamMessage[];
  liveAssistant: HubStreamMessage | null;
  events: HubStreamEventLogEntry[];
  failure: HubStreamFailure | null;
  sequence: number;
  updatedAt: string;
}

export type HubStreamReducerEvent =
  | { type: 'client.state'; event: SatelliteHubStateEvent; at: string }
  | { type: 'client.session'; session: SatelliteHubSession; at: string }
  | { type: 'client.error'; event: SatelliteHubErrorEvent; at: string }
  | { type: 'hub.inbound'; event: SatelliteHubInboundEvent; at: string };

export interface HubStreamClientLike {
  on<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    listener: (event: SatelliteHubClientEventMap[K]) => void,
  ): () => void;
  connect(): Promise<void>;
  disconnect(): void;
  sendUserText(text: string, options?: { interrupt?: boolean }): void;
  interrupt(): void;
  snapshot(): SatelliteHubSnapshot;
}

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
  }
}

export class HubStreamStore {
  private state: HubStreamState;
  private readonly listeners = new Set<(state: HubStreamState) => void>();
  private readonly unsubscribeClient: Array<() => void>;

  constructor(
    private readonly client: HubStreamClientLike,
    initialState: HubStreamState = createInitialHubStreamState(),
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.state = {
      ...initialState,
      session: cloneSession(client.snapshot().session) ?? null,
      connection: mapClientConnection(client.snapshot().state),
    };
    this.unsubscribeClient = [
      client.on('state', (event) => this.dispatch({ type: 'client.state', event, at: this.now() })),
      client.on('session', (session) => this.dispatch({ type: 'client.session', session, at: this.now() })),
      client.on('error', (event) => this.dispatch({ type: 'client.error', event, at: this.now() })),
      client.on('inbound', (event) => this.dispatch({ type: 'hub.inbound', event, at: this.now() })),
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

  destroy(): void {
    for (const unsubscribe of this.unsubscribeClient) {
      unsubscribe();
    }
    this.listeners.clear();
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
