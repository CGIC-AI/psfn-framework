import type { HubStreamState } from './stream/hub-stream.js';

export type PresenceConnection = 'offline' | 'connecting' | 'connected' | 'disconnected' | 'failed';
export type PresencePhase = 'offline' | 'connecting' | 'listening' | 'responding' | 'interrupted' | 'failed';
export type PresenceOperationClass =
  | 'none'
  | 'hub_handshake'
  | 'idle'
  | 'assistant_response'
  | 'interrupted'
  | 'failure';
export type PresenceInputExpected = 'yes' | 'no' | 'unknown';
export type PresenceEmanation = 'reported' | 'unreported';
export type PresenceSilence = 'none' | 'waiting_for_first_delta' | 'connected_no_recent_delta';

export interface PresenceState {
  connection: PresenceConnection;
  phase: PresencePhase;
  operationClass: PresenceOperationClass;
  inputExpected: PresenceInputExpected;
  failed: boolean;
  failureMessage: string | null;
  elapsedMs: number;
  silence: PresenceSilence;
  emanation: PresenceEmanation;
  satelliteId: string | null;
}

const RECENT_DELTA_WINDOW_MS = 15_000;

export function derivePresenceState(stream: HubStreamState, nowMs = Date.now()): PresenceState {
  const connection = deriveConnection(stream.connection);
  const phase = derivePhase(stream, connection);
  const operationClass = deriveOperationClass(stream, phase);
  const operationStartedAt = deriveOperationStartedAt(stream);
  const elapsedMs = operationStartedAt ? Math.max(0, nowMs - Date.parse(operationStartedAt)) : 0;
  const failed = connection === 'failed' || stream.phase === 'failed' || Boolean(stream.failure);
  const satelliteId = stream.session?.satelliteId ?? null;

  return {
    connection,
    phase,
    operationClass,
    inputExpected: deriveInputExpected(connection, phase),
    failed,
    failureMessage: stream.failure?.message ?? null,
    elapsedMs,
    silence: deriveSilence(stream, phase, nowMs),
    emanation: satelliteId ? 'reported' : 'unreported',
    satelliteId,
  };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function deriveConnection(connection: HubStreamState['connection']): PresenceConnection {
  switch (connection) {
    case 'idle':
      return 'offline';
    case 'connecting':
      return 'connecting';
    case 'connected':
    case 'ready':
      return 'connected';
    case 'disconnected':
      return 'disconnected';
    case 'failed':
      return 'failed';
  }
}

function derivePhase(stream: HubStreamState, connection: PresenceConnection): PresencePhase {
  if (connection === 'failed' || stream.failure) {
    return 'failed';
  }
  if (connection === 'offline' || connection === 'disconnected') {
    return 'offline';
  }
  if (connection === 'connecting') {
    return 'connecting';
  }
  if (stream.phase === 'responding' || stream.liveAssistant) {
    return 'responding';
  }
  if (stream.phase === 'interrupted') {
    return 'interrupted';
  }
  return 'listening';
}

function deriveOperationClass(
  stream: HubStreamState,
  phase: PresencePhase,
): PresenceOperationClass {
  if (phase === 'failed') return 'failure';
  if (phase === 'connecting') return 'hub_handshake';
  if (phase === 'responding') return 'assistant_response';
  if (phase === 'interrupted') return 'interrupted';
  if (stream.status && stream.status !== 'call_initialized') return 'hub_handshake';
  return phase === 'listening' ? 'idle' : 'none';
}

function deriveInputExpected(
  connection: PresenceConnection,
  phase: PresencePhase,
): PresenceInputExpected {
  if (connection === 'offline' || connection === 'disconnected' || connection === 'failed') {
    return 'no';
  }
  if (phase === 'responding' || phase === 'connecting') {
    return 'no';
  }
  return phase === 'listening' || phase === 'interrupted' ? 'yes' : 'unknown';
}

function deriveOperationStartedAt(stream: HubStreamState): string | null {
  if (stream.liveAssistant) {
    return stream.liveAssistant.receivedAt;
  }
  const latest = stream.events.at(-1);
  return latest?.receivedAt ?? stream.updatedAt;
}

function deriveSilence(
  stream: HubStreamState,
  phase: PresencePhase,
  nowMs: number,
): PresenceSilence {
  if (phase !== 'responding') {
    return 'none';
  }
  if (!stream.liveAssistant) {
    return 'waiting_for_first_delta';
  }
  const latestDeltaAt = Date.parse(stream.liveAssistant.receivedAt);
  return nowMs - latestDeltaAt > RECENT_DELTA_WINDOW_MS ? 'connected_no_recent_delta' : 'none';
}
