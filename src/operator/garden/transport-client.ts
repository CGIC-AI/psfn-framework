import { readFileSync } from 'node:fs';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions as HttpRequestOptions,
} from 'node:http';
import {
  request as httpsRequest,
  type RequestOptions as HttpsRequestOptions,
} from 'node:https';
import { createConnection } from 'node:net';
import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type ClientOptions } from 'ws';
import { createComponentLogger } from '../../shared/logger.js';
import { sendText } from '../../channels/backplane/http/primitives.js';
import type {
  GardenAdminTransportClientEndpoint,
  GardenAdminTransportNetworkClientEndpoint,
} from './transport-paths.js';

const log = createComponentLogger('GardenAdminTransportProxy');
const HEALTH_PROBE_TIMEOUT_MS = 1_500;
export const HEALTH_PROBE_PATH = '/api/admin/__transport_probe__';

export interface GardenAdminTransportHealth {
  mode: GardenAdminTransportClientEndpoint['mode'];
  reachable: boolean;
  status: 'ok' | 'degraded';
  httpStatus?: number;
  error?: string;
}

interface TransportProbePayload {
  status?: unknown;
  error?: unknown;
}

interface TlsRequestOptions {
  ca?: Buffer;
}

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

function parseTransportProbePayload(body: string): { status?: string; error?: string } | null {
  if (!body.trim()) return null;

  try {
    const payload = JSON.parse(body) as TransportProbePayload;
    return {
      status: typeof payload.status === 'string' ? payload.status : undefined,
      error: typeof payload.error === 'string' ? payload.error : undefined,
    };
  } catch {
    return null;
  }
}

function normalizeRequestPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function buildNetworkUrl(endpointUrl: URL, requestPath: string): URL {
  const url = new URL(endpointUrl.toString());
  const parsedPath = new URL(normalizeRequestPath(requestPath), 'http://localhost');
  url.pathname = parsedPath.pathname;
  url.search = parsedPath.search;
  url.hash = '';
  return url;
}

function buildNetworkRequestOptions(
  endpoint: GardenAdminTransportNetworkClientEndpoint,
  requestPath: string,
  method: string | undefined,
  headers: IncomingHttpHeaders | undefined,
  tlsOptions: TlsRequestOptions | undefined,
): HttpRequestOptions | HttpsRequestOptions {
  const url = buildNetworkUrl(endpoint.httpUrl, requestPath);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    ...(url.protocol === 'https:' ? tlsOptions : {}),
  };
}

function buildTlsRequestOptions(
  endpoint: GardenAdminTransportClientEndpoint,
): TlsRequestOptions | undefined {
  if (endpoint.mode !== 'network' || !endpoint.tls?.caPath) {
    return undefined;
  }

  return {
    ca: readFileSync(endpoint.tls.caPath),
  };
}

export class GardenAdminTransportProxy {
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly tlsRequestOptions: TlsRequestOptions | undefined;

  constructor(private readonly endpoint: GardenAdminTransportClientEndpoint) {
    this.tlsRequestOptions = buildTlsRequestOptions(endpoint);
  }

  close(callback: () => void): void {
    this.webSocketServer.close(callback);
  }

  probeHealth(): Promise<GardenAdminTransportHealth> {
    return new Promise((resolve) => {
      let timedOut = false;
      const proxyRequest = this.createRequest(
        HEALTH_PROBE_PATH,
        'GET',
        undefined,
        (proxyResponse) => {
          let body = '';
          proxyResponse.setEncoding('utf8');
          proxyResponse.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > 4096) {
              proxyRequest.destroy(new Error('Transport health probe response exceeded 4096 bytes'));
            }
          });
          proxyResponse.on('end', () => {
            const httpStatus = proxyResponse.statusCode ?? 502;
            const payload = parseTransportProbePayload(body);
            if (httpStatus < 200 || httpStatus >= 300) {
              resolve({
                mode: this.endpoint.mode,
                reachable: true,
                status: 'degraded',
                httpStatus,
                error: payload?.error ?? payload?.status ?? `Transport health probe returned HTTP ${httpStatus}`,
              });
              return;
            }

            if (payload?.status !== 'ok') {
              resolve({
                mode: this.endpoint.mode,
                reachable: true,
                status: 'degraded',
                httpStatus,
                error: payload?.error ?? payload?.status ?? 'Transport health probe did not report ok',
              });
              return;
            }

            resolve({
              mode: this.endpoint.mode,
              reachable: true,
              status: 'ok',
              httpStatus,
            });
          });
          proxyResponse.on('error', (error) => {
            resolve({
              mode: this.endpoint.mode,
              reachable: true,
              status: 'degraded',
              httpStatus: proxyResponse.statusCode,
              error: String(error),
            });
          });
        },
      );

      proxyRequest.setTimeout(HEALTH_PROBE_TIMEOUT_MS, () => {
        timedOut = true;
        proxyRequest.destroy(new Error(`Timed out after ${HEALTH_PROBE_TIMEOUT_MS}ms`));
      });

      proxyRequest.on('error', (error) => {
        resolve({
          mode: this.endpoint.mode,
          reachable: false,
          status: 'degraded',
          error: timedOut
            ? `Transport health probe timed out after ${HEALTH_PROBE_TIMEOUT_MS}ms`
            : String(error),
        });
      });

      proxyRequest.end();
    });
  }

  proxyApiRequest(req: IncomingMessage, res: ServerResponse): void {
    let timedOut = false;
    const requestPath = req.url ?? '/';
    const proxyRequest = this.createRequest(
      requestPath,
      req.method,
      buildProxyHeaders(req.headers),
      (proxyResponse) => {
        res.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(res);
        proxyResponse.on('error', (error) => {
          log.warn('Garden admin proxy response stream failed', {
            path: requestPath,
            error: String(error),
          });
          if (!res.destroyed) {
            res.destroy(error);
          }
        });
      },
    );

    proxyRequest.setTimeout(this.endpoint.timeoutMs, () => {
      timedOut = true;
      proxyRequest.destroy(new Error(`Timed out after ${this.endpoint.timeoutMs}ms`));
    });

    proxyRequest.on('error', (error) => {
      log.warn('Garden admin proxy request failed', {
        path: requestPath,
        error: String(error),
      });
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      sendText(
        res,
        502,
        timedOut
          ? 'Bad Gateway: admin transport timed out'
          : 'Bad Gateway: admin transport unavailable',
      );
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
    const upstreamSocket = new WebSocket(
      this.resolveTelemetryWebSocketUrl(),
      this.buildTelemetryWebSocketOptions(req),
    );
    let upgraded = false;
    let failed = false;

    const failBeforeUpgrade = (reason: string): void => {
      if (upgraded || failed) return;
      failed = true;
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
    upstreamSocket.once('unexpected-response', (_request, response) => {
      response.resume();
      failBeforeUpgrade(`Unexpected upstream websocket response: ${response.statusCode ?? 0}`);
    });
    upstreamSocket.once('close', (code, reason) => {
      failBeforeUpgrade(`Upstream websocket closed before upgrade: ${code} ${reason.toString()}`);
    });
  }

  private createRequest(
    requestPath: string,
    method: string | undefined,
    headers: IncomingHttpHeaders | undefined,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest {
    if (this.endpoint.mode === 'socket') {
      return httpRequest({
        socketPath: this.endpoint.socketPath,
        path: normalizeRequestPath(requestPath),
        method,
        headers,
      }, callback);
    }

    const options = buildNetworkRequestOptions(
      this.endpoint,
      requestPath,
      method,
      headers,
      this.tlsRequestOptions,
    );
    return this.endpoint.httpUrl.protocol === 'https:'
      ? httpsRequest(options, callback)
      : httpRequest(options, callback);
  }

  private resolveTelemetryWebSocketUrl(): string {
    if (this.endpoint.mode === 'socket') {
      return 'ws://localhost/api/admin/events';
    }
    return buildNetworkUrl(this.endpoint.wsUrl, '/api/admin/events').toString();
  }

  private buildTelemetryWebSocketOptions(req: IncomingMessage): ClientOptions {
    const options: ClientOptions = {
      headers: buildProxyHeaders(req.headers),
      handshakeTimeout: this.endpoint.timeoutMs,
    };

    if (this.endpoint.mode === 'socket') {
      return {
        ...options,
        createConnection: () => createConnection(this.endpoint.socketPath),
      };
    }

    return {
      ...options,
      ...(this.endpoint.wsUrl.protocol === 'wss:' ? this.tlsRequestOptions : {}),
    };
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
