import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { EventBus, EventMap, EventName } from '../../shared/event-bus.js';
import {
  sanitizeTurnRetrievalTelemetry,
  sanitizeTurnSnapshot,
  sanitizeTurnStageTelemetry,
} from '../../core/turns/observability.js';
import { resolveTelemetryCorrelation } from './telemetry-correlation.js';
import { parseRequestUrl } from './request-url.js';

const TELEMETRY_WEBSOCKET_PATH = '/api/admin/events';

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
      'agent.think.trace',
      'agent.stream.thinking',
      'agent.tool.start',
      'agent.tool.end',
      'memory.retrieval',
      'memory.extraction.end',
      'message.sent',
      'broadcast.approval.required',
      'broadcast.provenance',
      'external.telemetry.ingested',
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
    return sanitizeTurnStageTelemetry(data as EventMap['agent.turn.stage']);
  }

  if (eventName === 'memory.retrieval') {
    return sanitizeTurnRetrievalTelemetry(data as EventMap['memory.retrieval'])
      ?? (data as Record<string, unknown>);
  }

  return data as Record<string, unknown>;
}
