import { isObjectRecord as isRecord } from '../../../../src/shared/utils/types.js';
/**
 * Wire framing for the Companion Cockpit <-> PSFN-Satellite-Hub transport.
 *
 * Real transport (hub/src/ts/hub/server.ts, pi-client/client.ts): plain
 * WebSocket, ONE JSON-serialized message per text frame, both directions:
 *   socket.send(JSON.stringify(message))
 *   JSON.parse(raw) as <Direction>Message
 *
 * This module implements that codec. Unknown message types are REJECTED
 * (fail closed, charter §8.5 / §12.6) — the hub's own server.ts does the
 * same on its side (it replies with an `error-event` for unknown types).
 *
 ///////////////////////////////////////////////////////////////////////////////////////////////////
 *
 * An SSE parsing primitive is also provided because a future/alternate
 * hub transport may stream the same message union over Server-Sent Events.
 * It parses the SSE wire format into data strings; the caller then runs
 * `parseHubToClientMessage` on each data frame. It is a transport parser,
 * NOT an invented hub endpoint.
 */

import type {
  ClientToHubMessage,
  HubToClientMessage,
} from './events.js';

export class HubFramingError extends Error {
  public override readonly name = 'HubFramingError';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

const HUB_TO_CLIENT_TYPES: ReadonlySet<HubToClientMessage['type']> = new Set([
  'session.ready',
  'hello.ack',
  'status',
  'text',
  'audio',
  'message',
  'action',
  'error-event',
  'relay.stt.result',
  'relay.tts.chunk',
  'relay.tts.done',
  'relay.error',
  'pong',
  'assistant.interrupted',
  'approval.requested',
  'approval.resolved',
  'artifact.created',
  'artifact.preview.result',
  'artifact.preview.error',
  'tool.activity',
]);

const CLIENT_TO_HUB_TYPES: ReadonlySet<ClientToHubMessage['type']> = new Set([
  'hello',
  'audio',
  'user.text',
  'text',
  'ping',
  'interrupt',
  'relay.stt',
  'relay.tts',
  'turn.start',
  'turn.end',
  'approval.decision',
  'artifact.preview',
  'touch.interaction',
]);


function readType(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  return payload['type'];
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!isRecord(value) || required.some(key => !Object.hasOwn(value, key))) return null;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every(key => allowed.has(key)) ? value : null;
}

function boundedString(value: unknown, maximum = 65_536): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

function optionalBoundedString(value: unknown, maximum = 65_536): boolean {
  return value === undefined || boundedString(value, maximum);
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function nonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function base64(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1_048_576
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

const CAPABILITIES = Object.freeze({
  input: ['text', 'microphone_pcm', 'final_transcript', 'vision_upload', 'wake_event'],
  output: [
    'text', 'subtitle', 'streamed_audio', 'local_file_audio', 'animation', 'action',
    'expression', 'gaze', 'servo', 'artifact', 'tool_activity',
  ],
  control: ['interrupt', 'mute', 'sleep_wake', 'presence', 'session_attach', 'approvals', 'touch'],
  safety: ['action_allowlist', 'confirmation_required', 'local_only'],
});

function capabilities(value: unknown): boolean {
  const record = exactRecord(value, [], ['input', 'output', 'control', 'safety']);
  if (!record) return false;
  return (Object.keys(CAPABILITIES) as Array<keyof typeof CAPABILITIES>).every((key) => {
    const entries = record[key];
    return entries === undefined || (Array.isArray(entries) && entries.length <= 32
      && new Set(entries).size === entries.length
      && entries.every(entry => oneOf(entry, CAPABILITIES[key])));
  });
}

function participant(value: unknown, user = false): boolean {
  const record = exactRecord(value, [], user ? ['id', 'name', 'canonicalContactId'] : ['id', 'name']);
  return record !== null
    && optionalBoundedString(record.id, 256)
    && optionalBoundedString(record.name, 256)
    && (!user || optionalBoundedString(record.canonicalContactId, 256));
}

function identity(value: unknown): boolean {
  if (value === undefined) return true;
  const record = exactRecord(value, ['source'], ['companion', 'user']);
  return record !== null
    && oneOf(record.source, ['framework', 'configured'])
    && (record.companion === undefined || participant(record.companion))
    && (record.user === undefined || participant(record.user, true));
}

function place(value: unknown): boolean {
  if (value === undefined) return true;
  const record = exactRecord(value, ['id', 'name']);
  return record !== null && boundedString(record.id, 256) && boundedString(record.name, 256);
}

function dataRecord(payload: unknown, required: readonly string[], optional: readonly string[] = []) {
  const outer = exactRecord(payload, ['type', 'data']);
  return outer ? exactRecord(outer.data, required, optional) : null;
}

const STRICT_HUB_VALIDATORS: Record<HubToClientMessage['type'], (payload: unknown) => boolean> = {
  'session.ready': (payload) => {
    const record = exactRecord(payload, [
      'type', 'sessionId', 'channelId', 'deviceId', 'deviceName', 'satelliteId', 'audioFormat',
    ], ['identity', 'place']);
    return record !== null
      && ['sessionId', 'channelId', 'deviceId', 'deviceName', 'satelliteId', 'audioFormat']
        .every(key => boundedString(record[key], 256))
      && identity(record.identity) && place(record.place);
  },
  'hello.ack': (payload) => {
    const record = exactRecord(payload, [
      'type', 'sessionId', 'channelId', 'deviceId', 'deviceName', 'satelliteId',
      'satelliteName', 'capabilities',
    ], ['identity', 'place']);
    return record !== null
      && ['sessionId', 'channelId', 'deviceId', 'deviceName', 'satelliteId', 'satelliteName']
        .every(key => boundedString(record[key], 256))
      && capabilities(record.capabilities) && identity(record.identity) && place(record.place);
  },
  status: payload => {
    const record = exactRecord(payload, ['type', 'data']);
    return record !== null && boundedString(record.data, 256);
  },
  text: payload => {
    const record = exactRecord(payload, ['type', 'data']);
    return record !== null && boundedString(record.data);
  },
  audio: payload => {
    const record = exactRecord(payload, ['type', 'data']);
    return record !== null && base64(record.data);
  },
  message: payload => {
    const data = dataRecord(payload, ['role', 'content'], ['live', 'final']);
    return data !== null && oneOf(data.role, ['user', 'assistant'])
      && boundedString(data.content)
      && (data.live === undefined || typeof data.live === 'boolean')
      && (data.final === undefined || typeof data.final === 'boolean');
  },
  action: payload => {
    const record = exactRecord(payload, ['type', 'data']);
    return record !== null && oneOf(record.data, ['interrupt', 'pause-audio', 'play-audio']);
  },
  'error-event': payload => {
    const data = dataRecord(payload, ['message']);
    return data !== null && boundedString(data.message, 1024);
  },
  'relay.stt.result': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'text', 'provider'], ['latencyMs']);
    return record !== null && boundedString(record.requestId, 256) && boundedString(record.text)
      && boundedString(record.provider, 256)
      && (record.latencyMs === undefined || nonNegativeInteger(record.latencyMs, 3_600_000));
  },
  'relay.tts.chunk': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'audio']);
    return record !== null && boundedString(record.requestId, 256) && base64(record.audio);
  },
  'relay.tts.done': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'mimeType']);
    return record !== null && boundedString(record.requestId, 256) && boundedString(record.mimeType, 256);
  },
  'relay.error': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'operation', 'message']);
    return record !== null && boundedString(record.requestId, 256)
      && oneOf(record.operation, ['stt', 'tts']) && boundedString(record.message, 1024);
  },
  pong: payload => {
    const record = exactRecord(payload, ['type', 'sentAt']);
    return record !== null && nonNegativeInteger(record.sentAt);
  },
  'assistant.interrupted': payload => {
    const record = exactRecord(payload, ['type', 'sessionId']);
    return record !== null && boundedString(record.sessionId, 256);
  },
  'approval.requested': payload => {
    const data = dataRecord(payload, [
      'id', 'title', 'requestedAt', 'redactedContext', 'status',
    ], ['expiresAt']);
    return data !== null && boundedString(data.id, 256) && boundedString(data.title, 512)
      && isoTimestamp(data.requestedAt) && optionalBoundedString(data.expiresAt, 32)
      && (data.expiresAt === undefined || isoTimestamp(data.expiresAt))
      && boundedString(data.redactedContext, 4096) && data.status === 'pending';
  },
  'approval.resolved': payload => {
    const data = dataRecord(payload, ['id', 'status', 'resolvedAt']);
    return data !== null && boundedString(data.id, 256)
      && oneOf(data.status, ['approved', 'denied', 'expired', 'blocked'])
      && isoTimestamp(data.resolvedAt);
  },
  'artifact.created': payload => {
    const data = dataRecord(payload, [
      'id', 'label', 'mediaType', 'provenance', 'createdAt', 'previewable',
    ]);
    return data !== null && boundedString(data.id, 256) && boundedString(data.label, 512)
      && boundedString(data.mediaType, 256) && boundedString(data.provenance, 1024)
      && isoTimestamp(data.createdAt) && typeof data.previewable === 'boolean';
  },
  'artifact.preview.result': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'artifactId', 'mediaType', 'data']);
    return record !== null && boundedString(record.requestId, 256)
      && boundedString(record.artifactId, 256) && boundedString(record.mediaType, 256)
      && base64(record.data);
  },
  'artifact.preview.error': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'artifactId', 'message']);
    return record !== null && boundedString(record.requestId, 256)
      && boundedString(record.artifactId, 256) && boundedString(record.message, 1024);
  },
  'tool.activity': payload => {
    const data = dataRecord(payload, ['id', 'tool', 'phase', 'timestamp'], ['detail']);
    return data !== null && boundedString(data.id, 256) && boundedString(data.tool, 256)
      && oneOf(data.phase, ['started', 'progress', 'completed', 'failed'])
      && optionalBoundedString(data.detail, 4096) && isoTimestamp(data.timestamp);
  },
};

const STRICT_CLIENT_VALIDATORS: Record<ClientToHubMessage['type'], (payload: unknown) => boolean> = {
  hello: payload => {
    const record = exactRecord(payload, ['type', 'capabilities']);
    return record !== null && capabilities(record.capabilities);
  },
  audio: payload => {
    const record = exactRecord(payload, ['type', 'audio']);
    return record !== null && base64(record.audio);
  },
  'user.text': payload => {
    const record = exactRecord(payload, ['type', 'text'], ['interrupt']);
    return record !== null && boundedString(record.text)
      && (record.interrupt === undefined || typeof record.interrupt === 'boolean');
  },
  text: payload => {
    const record = exactRecord(payload, ['type', 'data']);
    return record !== null && boundedString(record.data);
  },
  ping: payload => {
    const record = exactRecord(payload, ['type', 'sentAt']);
    return record !== null && nonNegativeInteger(record.sentAt);
  },
  interrupt: payload => exactRecord(payload, ['type']) !== null,
  'relay.stt': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'audio'], ['mimeType', 'prompt', 'language']);
    return record !== null && boundedString(record.requestId, 256) && base64(record.audio)
      && optionalBoundedString(record.mimeType, 256) && optionalBoundedString(record.prompt, 4096)
      && optionalBoundedString(record.language, 64);
  },
  'relay.tts': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'text'], ['voice', 'model']);
    return record !== null && boundedString(record.requestId, 256) && boundedString(record.text)
      && optionalBoundedString(record.voice, 256) && optionalBoundedString(record.model, 256);
  },
  'turn.start': payload => {
    const record = exactRecord(payload, ['type'], ['interrupt']);
    return record !== null && (record.interrupt === undefined || typeof record.interrupt === 'boolean');
  },
  'turn.end': payload => {
    const record = exactRecord(payload, ['type', 'reason']);
    return record !== null && boundedString(record.reason, 256);
  },
  'approval.decision': payload => {
    const record = exactRecord(payload, ['type', 'id', 'decision']);
    return record !== null && boundedString(record.id, 256) && oneOf(record.decision, ['approve', 'deny']);
  },
  'artifact.preview': payload => {
    const record = exactRecord(payload, ['type', 'requestId', 'artifactId']);
    return record !== null && boundedString(record.requestId, 256) && boundedString(record.artifactId, 256);
  },
  'touch.interaction': payload => {
    const record = exactRecord(payload, ['type', 'kind', 'region', 'count', 'durationMs']);
    return record !== null && oneOf(record.kind, ['headpat', 'petting', 'hug', 'kiss'])
      && oneOf(record.region, ['head', 'cheek', 'body'])
      && nonNegativeInteger(record.count, 20) && Number(record.count) >= 1
      && nonNegativeInteger(record.durationMs, 60_000);
  },
};

/**
 * Parse one inbound WS text frame into a typed hub->client message.
 * Throws HubFramingError on malformed JSON or any unknown/missing `type`.
 * Never coerces unknown shapes into the union (fail closed).
 */
export function parseHubToClientMessage(raw: string): HubToClientMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new HubFramingError('Frame is not valid JSON', error);
  }
  const type = readType(payload);
  if (typeof type !== 'string' || !HUB_TO_CLIENT_TYPES.has(type as HubToClientMessage['type'])) {
    throw new HubFramingError(`Unknown hub->client message type: ${String(type)}`);
  }
  const validate = STRICT_HUB_VALIDATORS[type as HubToClientMessage['type']];
  if (validate && !validate(payload)) {
    throw new HubFramingError(`Malformed hub->client message body for type: ${type}`);
  }
  return payload as HubToClientMessage;
}

/**
 * Serialize one outbound client->hub message to a WS text frame.
 * Rejects anything whose `type` is not a known client->hub discriminator.
 */
export function serializeClientToHubMessage(message: ClientToHubMessage): string {
  const type = readType(message);
  if (
    typeof type !== 'string' ||
    !CLIENT_TO_HUB_TYPES.has(type as ClientToHubMessage['type'])
  ) {
    throw new HubFramingError(`Unknown client->hub message type: ${String(type)}`);
  }
  const validate = STRICT_CLIENT_VALIDATORS[type as ClientToHubMessage['type']];
  if (validate && !validate(message)) {
    throw new HubFramingError(`Malformed client->hub message body for type: ${type}`);
  }
  return JSON.stringify(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE transport primitive (alternate transport; same message union applies)
// ─────────────────────────────────────────────────────────────────────────────

export interface SseEvent {
  /** SSE `event:` field, or null if omitted (default message stream). */
  event: string | null;
  /** Joined `data:` lines for this event. */
  data: string;
}

/**
 * Parse a complete SSE-formatted stream into discrete events.
 *
 * Handles the RFC-documented framing: events separated by blank lines,
 * `data:` lines joined with `\n`, one leading space after the colon trimmed,
 * `\r\n` line endings, and `:`-prefixed comments ignored. Callers feeding
 * incremental socket chunks should buffer until a blank line terminates an
 * event; this pure parser operates on an already-complete event block.
 */
export function parseSseEvents(stream: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event: string | null = null;
  const dataLines: string[] = [];
  let pending = false;

  const flush = (): void => {
    if (!pending) {
      return;
    }
    events.push({ event, data: dataLines.join('\n') });
    event = null;
    dataLines.length = 0;
    pending = false;
  };

  const lines = stream.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) {
      // SSE comment / keep-alive.
      continue;
    }
    let field: string;
    let value: string;
    const colon = line.indexOf(':');
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      // A single leading space after the colon is part of the SSE spec, not data.
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    }
    if (field === 'event') {
      event = value;
      pending = true;
    } else if (field === 'data') {
      dataLines.push(value);
      pending = true;
    }
    // All other SSE fields (id:, retry:) are ignored by this projection.
  }

  // Flush a trailing event that was not followed by a blank line.
  flush();
  return events;
}
