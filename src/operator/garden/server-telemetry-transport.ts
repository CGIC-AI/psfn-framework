import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { EventBus, EventMap, EventName, ExternalTelemetryEvent } from '../../shared/event-bus.js';
import {
  sanitizeTurnRetrievalTelemetry,
  sanitizeTurnSnapshot,
  sanitizeTurnStageTelemetry,
} from '../../core/turns/observability.js';
import { resolveTelemetryCorrelation } from './telemetry-correlation.js';
import { parseRequestUrl } from './request-url.js';

const TELEMETRY_WEBSOCKET_PATH = '/api/admin/events';

// ── Sprint-10 H5 (defense-in-depth): external telemetry projection ──
// The ingest boundary (channels/api/server.ts) already fails closed on raw
// biometrics. This is the second wall: even if a raw blob somehow reached the
// event bus, the Garden admin WebSocket must never forward it verbatim. We
// project `external.telemetry.ingested` to an allowlisted, size-bounded field
// set and reduce `payload` to bounded SCALAR fields only — any object, array,
// oversized string, or biometric-shaped key is dropped before it can be sent.
const ADMIN_TELEMETRY_STRING_MAX = 256;
const ADMIN_TELEMETRY_PAYLOAD_MAX_FIELDS = 32;
const ADMIN_TELEMETRY_BIOMETRIC_KEY_PATTERNS: readonly RegExp[] = [
  /vector/i,
  /embedding/i,
  /descriptor/i,
  /template/i,
  /biometric/i,
  /faceprint/i,
  /faceid/i,
  /landmark/i,
  /iris/i,
  /retina/i,
  /fingerprint/i,
  /minutiae/i,
  /^image$/i,
  /image[_-]?bytes/i,
  /^frame$/i,
  /^photo$/i,
  /photo[_-]?bytes/i,
  /raw[_-]?image/i,
  /^jpe?g$/i,
  /^png$/i,
  /^bytes$/i,
  /^blob$/i,
  /pixels/i,
];

function isBiometricShapedKey(key: string): boolean {
  return ADMIN_TELEMETRY_BIOMETRIC_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function projectAdminTelemetryScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value.length > ADMIN_TELEMETRY_STRING_MAX
      ? `${value.slice(0, ADMIN_TELEMETRY_STRING_MAX)}…`
      : value;
  }
  // Objects, arrays, and any other non-scalar are dropped: a raw biometric
  // blob (image bytes, embedding array, nested descriptor) can only ride in
  // one of those, so scalar-only projection is the hard guarantee.
  return undefined;
}

function projectAdminTelemetryPayload(payload: unknown): {
  fields: Record<string, string | number | boolean | null>;
  dropped: boolean;
} {
  const fields: Record<string, string | number | boolean | null> = {};
  let dropped = false;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { fields, dropped: payload !== undefined && payload !== null };
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (Object.keys(fields).length >= ADMIN_TELEMETRY_PAYLOAD_MAX_FIELDS) {
      dropped = true;
      break;
    }
    if (isBiometricShapedKey(key)) {
      dropped = true;
      continue;
    }
    const scalar = projectAdminTelemetryScalar(value);
    if (scalar === undefined) {
      dropped = true;
      continue;
    }
    fields[key] = scalar;
  }
  return { fields, dropped };
}

export function sanitizeExternalTelemetryIngested(
  event: ExternalTelemetryEvent,
): Record<string, unknown> {
  const { fields, dropped } = projectAdminTelemetryPayload(event.payload);
  return {
    id: event.id,
    source: event.source,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    ...(event.scope ? { scope: event.scope } : {}),
    ...(event.channelId ? { channelId: event.channelId } : {}),
    ...(event.auth
      ? {
          auth: {
            principalId: event.auth.principalId,
            principalMode: event.auth.principalMode,
            satelliteScoped: event.auth.satelliteScoped,
          },
        }
      : {}),
    payload: fields,
    ...(dropped ? { payloadTruncated: true } : {}),
  };
}

export class AdminServerTelemetryTransport {
  private webSocketServer = new WebSocketServer({ noServer: true });

  constructor(
    private readonly eventBus: EventBus,
    private readonly checkUpgradeAuth: (req: IncomingMessage) => boolean,
  ) {}

  close(cb: () => void): void {
    this.webSocketServer.close(cb);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = parseRequestUrl(req);
    if (url.pathname !== TELEMETRY_WEBSOCKET_PATH) {
      socket.write('HTTP/1.1 404 Not Found\\r\\n\\r\\n');
      socket.destroy();
      return;
    }

    if (!this.checkUpgradeAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
      socket.destroy();
      return;
    }

    this.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      this.attachTelemetryWebSocket(ws);
    });
  }

  private attachTelemetryWebSocket(ws: WebSocket): void {
    const telemetryEvents: EventName[] = [
      'agent.turn.usage',
      'agent.turn.snapshot',
      'agent.turn.stage',
      'agent.analysis_workbench.trace',
      'agent.stream.thinking',
      'agent.tool.start',
      'agent.tool.end',
      'memory.retrieval',
      'memory.extraction.end',
      'memory.near_turn.cadence',
      'memory.episode_synthesis.gate',
      'memory.episode_synthesis.segmentation',
      'reflection.guardrail',
      'message.sent',
      'broadcast.approval.required',
      'broadcast.provenance',
      'external.telemetry.ingested',
      'agent.tools.legacy_alias',
      'agent.tools.adaptive.decision',
      'agent.tools.adaptive.snapshot',
      'wyoming.session.start',
      'wyoming.session.end',
      'wyoming.policy.violation',
    ];

    const unsubscribers: Array<() => void> = [];
    for (const eventName of telemetryEvents) {
      const unsub = this.eventBus.on(eventName, (data: EventMap[typeof eventName]) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const correlation = resolveTelemetryCorrelation(eventName, data);
        const sanitized = sanitizeAdminTelemetryPayload(eventName, data);
        ws.send(JSON.stringify({
          type: eventName,
          timestamp: Date.now(),
          correlation,
          data: sanitized,
        }));
      });
      unsubscribers.push(unsub);
    }

    const cleanup = (): void => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }
}

function sanitizeAdminTelemetryPayload<E extends EventName>(
  eventName: E,
  data: EventMap[E],
): Record<string, unknown> {
  if (eventName === 'agent.turn.snapshot') {
    const payload = data as EventMap['agent.turn.snapshot'] & Record<string, unknown>;
    return {
      ...payload,
      snapshot: sanitizeTurnSnapshot(payload.snapshot),
    };
  }

  if (eventName === 'agent.turn.stage') {
    return { ...sanitizeTurnStageTelemetry(data as EventMap['agent.turn.stage']) };
  }

  if (eventName === 'memory.retrieval') {
    const sanitized = sanitizeTurnRetrievalTelemetry(data as EventMap['memory.retrieval']);
    return sanitized ? { ...sanitized } : (data as Record<string, unknown>);
  }

  if (eventName === 'external.telemetry.ingested') {
    const payload = data as EventMap['external.telemetry.ingested'];
    return sanitizeExternalTelemetryIngested(payload.event);
  }

  return data as Record<string, unknown>;
}
