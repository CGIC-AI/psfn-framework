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
]);


function readType(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  return payload['type'];
}

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
