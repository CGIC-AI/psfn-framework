import { request, type IncomingHttpHeaders } from 'node:http';
import { createConnection } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { createComponentLogger } from '../../shared/logger.js';
import { sendText } from '../../channels/backplane/http/primitives.js';

const log = createComponentLogger('GardenAdminTransportProxy');

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildProxyHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwardedHeaders: IncomingHttpHeaders = { ...headers };
  delete forwardedHeaders.connection;
  delete forwardedHeaders.upgrade;
  delete forwardedHeaders['proxy-connection'];

  const forwardedHost = firstHeader(headers['x-forwarded-host']) ?? firstHeader(headers.host);
  if (forwardedHost) {
    forwardedHeaders['x-forwarded-host'] = forwardedHost;
  }

  const forwardedProto = firstHeader(headers['x-forwarded-proto']) ?? 'http';
  forwardedHeaders['x-forwarded-proto'] = forwardedProto;
  forwardedHeaders.host = forwardedHost ?? 'localhost';
  return forwardedHeaders;
}

export class GardenAdminTransportProxy {
  private readonly webSocketServer = new WebSocketServer({ noServer: true });

  constructor(private readonly socketPath: string) {}

  close(callback: () => void): void {
    this.webSocketServer.close(callback);
  }

  proxyApiRequest(req: IncomingMessage, res: ServerResponse): void {
    const proxyRequest = request({
      socketPath: this.socketPath,
      path: req.url ?? '/',
      method: req.method,
      headers: buildProxyHeaders(req.headers),
    }, (proxyResponse) => {
      res.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
      proxyResponse.pipe(res);
    });

    proxyRequest.on('error', (error) => {
      log.warn('Garden admin proxy request failed', {
        path: req.url ?? '/',
        error: String(error),
      });
      if (res.writableEnded || res.destroyed) return;
      sendText(res, 502, 'Bad Gateway');
    });

    req.on('aborted', () => {
      proxyRequest.destroy(new Error('Client request aborted'));
    });

    req.pipe(proxyRequest);
  }

  handleTelemetryUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const upstreamSocket = new WebSocket('ws://localhost/api/admin/events', {
      createConnection: () => createConnection(this.socketPath),
      headers: buildProxyHeaders(req.headers),
    });
    let upgraded = false;

    const failBeforeUpgrade = (reason: string): void => {
      if (upgraded) return;
      log.warn('Garden telemetry upstream websocket failed before upgrade', { reason });
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
      upstreamSocket.terminate();
    };

    socket.once('error', () => {
      if (upgraded) return;
      upstreamSocket.terminate();
    });
    socket.once('close', () => {
      if (upgraded) return;
      upstreamSocket.terminate();
    });

    upstreamSocket.once('open', () => {
      upgraded = true;
      this.webSocketServer.handleUpgrade(req, socket, head, (clientSocket) => {
        this.attachTelemetryBridge(clientSocket, upstreamSocket);
      });
    });
    upstreamSocket.once('error', (error) => {
      failBeforeUpgrade(String(error));
    });
  }

  private attachTelemetryBridge(
    clientSocket: WebSocket,
    upstreamSocket: WebSocket,
  ): void {
    const closeWithReason = (target: WebSocket, code: number, reason: string): void => {
      if (
        target.readyState === WebSocket.CLOSING
        || target.readyState === WebSocket.CLOSED
      ) {
        return;
      }
      target.close(code, reason);
    };

    clientSocket.on('message', (data, isBinary) => {
      if (upstreamSocket.readyState !== WebSocket.OPEN) return;
      upstreamSocket.send(data, { binary: isBinary });
    });
    upstreamSocket.on('message', (data, isBinary) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      clientSocket.send(data, { binary: isBinary });
    });

    clientSocket.on('close', () => {
      closeWithReason(upstreamSocket, 1000, 'client_closed');
    });
    upstreamSocket.on('close', (code, reason) => {
      const normalizedReason = reason.toString() || 'upstream_closed';
      closeWithReason(clientSocket, code || 1000, normalizedReason);
    });

    clientSocket.on('error', (error) => {
      log.warn('Garden telemetry client websocket failed', {
        error: String(error),
      });
      closeWithReason(upstreamSocket, 1011, 'client_error');
    });
    upstreamSocket.on('error', (error) => {
      log.warn('Garden telemetry upstream websocket failed', {
        error: String(error),
      });
      closeWithReason(clientSocket, 1011, 'upstream_error');
    });
  }
}
