import type { HubStreamEventLogEntry, HubStreamState } from './stream/hub-stream.js';
import type { HubToClientMessage } from './protocol/events.js';

export type OperationalTraceStatus = 'info' | 'active' | 'done' | 'failed';

export interface OperationalTrace {
  id: string;
  sequence: number;
  receivedAt: string;
  type: HubToClientMessage['type'];
  operationClass: string;
  status: OperationalTraceStatus;
  summary: string;
  metadata: Record<string, string | number | boolean>;
}

export function deriveOperationalTraces(stream: HubStreamState): OperationalTrace[] {
  return stream.events.map((event) => eventToTrace(event));
}

function eventToTrace(event: HubStreamEventLogEntry): OperationalTrace {
  const { message } = event;
  const common = {
    id: `${event.sequence}:${message.type}`,
    sequence: event.sequence,
    receivedAt: event.receivedAt,
    type: message.type,
  };

  switch (message.type) {
    case 'session.ready':
      return {
        ...common,
        operationClass: 'hub_session',
        status: 'done',
        summary: 'Session ready',
        metadata: {
          sessionId: message.sessionId,
          channelId: message.channelId,
          satelliteId: message.satelliteId,
        },
      };
    case 'hello.ack':
      return {
        ...common,
        operationClass: 'hub_handshake',
        status: 'done',
        summary: 'Satellite accepted',
        metadata: {
          sessionId: message.sessionId,
          channelId: message.channelId,
          satelliteId: message.satelliteId,
          inputCapabilities: message.capabilities.input?.length ?? 0,
          outputCapabilities: message.capabilities.output?.length ?? 0,
        },
      };
    case 'status':
      return {
        ...common,
        operationClass: 'hub_status',
        status: 'info',
        summary: message.data,
        metadata: {},
      };
    case 'message':
      return {
        ...common,
        operationClass: `${message.data.role}_message`,
        status: message.data.final ? 'done' : 'active',
        summary: `${message.data.role} message`,
        metadata: {
          role: message.data.role,
          live: message.data.live ?? false,
          final: message.data.final ?? false,
          contentChars: message.data.content.length,
        },
      };
    case 'text':
      return {
        ...common,
        operationClass: 'text_signal',
        status: 'info',
        summary: message.data,
        metadata: {},
      };
    case 'audio':
      return {
        ...common,
        operationClass: 'audio_output',
        status: 'active',
        summary: 'Audio chunk',
        metadata: {
          encodedChars: message.data.length,
        },
      };
    case 'action':
      return {
        ...common,
        operationClass: 'hub_action',
        status: message.data === 'interrupt' ? 'failed' : 'info',
        summary: message.data,
        metadata: {},
      };
    case 'error-event':
      return {
        ...common,
        operationClass: 'hub_error',
        status: 'failed',
        summary: message.data.message,
        metadata: {},
      };
    case 'relay.stt.result':
      return {
        ...common,
        operationClass: 'relay_stt',
        status: 'done',
        summary: 'Speech transcript returned',
        metadata: {
          requestId: message.requestId,
          provider: message.provider,
          transcriptChars: message.text.length,
          latencyMs: message.latencyMs ?? 0,
        },
      };
    case 'relay.tts.chunk':
      return {
        ...common,
        operationClass: 'relay_tts',
        status: 'active',
        summary: 'TTS audio chunk',
        metadata: {
          requestId: message.requestId,
          encodedChars: message.audio.length,
        },
      };
    case 'relay.tts.done':
      return {
        ...common,
        operationClass: 'relay_tts',
        status: 'done',
        summary: 'TTS complete',
        metadata: {
          requestId: message.requestId,
          mimeType: message.mimeType,
        },
      };
    case 'relay.error':
      return {
        ...common,
        operationClass: `relay_${message.operation}`,
        status: 'failed',
        summary: message.message,
        metadata: {
          requestId: message.requestId,
          operation: message.operation,
        },
      };
    case 'pong':
      return {
        ...common,
        operationClass: 'heartbeat',
        status: 'done',
        summary: 'Pong',
        metadata: {
          sentAt: message.sentAt,
        },
      };
    case 'assistant.interrupted':
      return {
        ...common,
        operationClass: 'assistant_interrupt',
        status: 'failed',
        summary: 'Assistant interrupted',
        metadata: {
          sessionId: message.sessionId,
        },
      };
  }
}
