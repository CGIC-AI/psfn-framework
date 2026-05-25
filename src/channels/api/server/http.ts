import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { sendJson } from '../../backplane/http/primitives.js';
import {
  corsAllowlistIsEmpty,
  evaluateCorsPolicy,
  type CorsAllowedOrigins,
} from '../http-policy.js';
import { buildApiErrorEnvelope } from '../response-format.js';

export const MAX_BODY_SIZE = 1_048_576; // 1MB
export const SATELLITE_HUB_BODY_SIZE = MAX_BODY_SIZE * 2;
export const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 90_000;
export const DEFAULT_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS = 65 * 60_000;

export interface ApiServerLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ApiHttpServerHandlers {
  handleRequest(req: IncomingMessage, res: ServerResponse): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export interface ListenApiHttpServerOptions {
  server: Server;
  host: string;
  port: number;
  apiKey?: string;
  corsAllowedOrigins: CorsAllowedOrigins;
  logger: ApiServerLogger;
}

export function createApiHttpServer(handlers: ApiHttpServerHandlers): Server {
  const server = createServer((req, res) => handlers.handleRequest(req, res));
  server.on('upgrade', (req, socket, head) => handlers.handleUpgrade(req, socket, head));
  return server;
}

export function parseChatRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CHAT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_CHAT_REQUEST_TIMEOUT_MS;
  }
  return Math.floor(value);
}

export function parseSchedulerHealthcheckStaleAfterMs(value: number | undefined): number {
  if (value !== undefined && Number.isFinite(value) && value >= 1_000) {
    return Math.floor(value);
  }

  const envValue = process.env.API_HEALTH_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS;
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed >= 1_000) {
      return parsed;
    }
  }

  return DEFAULT_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS;
}

export function applyApiCorsPolicy(
  req: IncomingMessage,
  res: ServerResponse,
  corsAllowedOrigins: CorsAllowedOrigins,
): boolean {
  const policy = evaluateCorsPolicy(req, corsAllowedOrigins, res.getHeader('Vary'));
  if (!policy.ok) {
    sendApiError(res, policy.error.status, policy.error.type, policy.error.message);
    return false;
  }

  if (!policy.headers) return true;
  for (const [key, value] of Object.entries(policy.headers)) {
    res.setHeader(key, value);
  }
  return true;
}

export function listenApiHttpServer(options: ListenApiHttpServerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      options.logger.error('API server failed to start', {
        host: options.host,
        port: options.port,
        code: err.code,
        errno: err.errno,
        syscall: err.syscall,
        error: err.message,
      });
      reject(err);
    };

    options.server.once('error', onError);
    options.server.listen(options.port, options.host, () => {
      options.server.off('error', onError);
      options.logger.info(`Listening on ${options.host}:${options.port}`);
      if (!options.apiKey) {
        options.logger.warn('API authentication disabled by explicit ALLOW_INSECURE_LOCAL_API=true');
      }
      if (corsAllowlistIsEmpty(options.corsAllowedOrigins)) {
        options.logger.warn('API CORS allowlist is empty; cross-origin browser requests are denied by default');
      }
      resolve();
    });
  });
}

export function stopApiHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function canWriteResponse(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

export function sendApiError(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, buildApiErrorEnvelope(type, message, details));
}
