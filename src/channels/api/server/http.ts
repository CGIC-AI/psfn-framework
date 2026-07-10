import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
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

export type ApiHttpServer = Server | HttpsServer;

/**
 * Optional direct-TLS termination for the API listener. When configured, the
 * server requests (but does not require) a client certificate so satellite
 * mTLS bindings can be verified against the REAL peer certificate.
 * `rejectUnauthorized` stays false because non-satellite API clients present
 * no client certificate; identity is enforced by fail-closed binding
 * matching: fingerprint/SPKI pins are self-authenticating, and subject/SAN
 * attributes are only honored when the chain validates against `caPath`.
 */
export interface ApiHttpServerTlsConfig {
  certPath: string;
  keyPath: string;
  caPath?: string;
}

export interface ListenApiHttpServerOptions {
  server: ApiHttpServer;
  host: string;
  port: number;
  apiKey?: string;
  corsAllowedOrigins: CorsAllowedOrigins;
  logger: ApiServerLogger;
}

export function createApiHttpServer(
  handlers: ApiHttpServerHandlers,
  tls?: ApiHttpServerTlsConfig,
): ApiHttpServer {
  const server = tls
    ? createHttpsServer(
      {
        cert: readFileSync(tls.certPath),
        key: readFileSync(tls.keyPath),
        ...(tls.caPath ? { ca: readFileSync(tls.caPath) } : {}),
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
      },
      (req, res) => handlers.handleRequest(req, res),
    )
    : createServer((req, res) => handlers.handleRequest(req, res));
  server.on('upgrade', (req, socket, head) => handlers.handleUpgrade(req, socket, head));
  return server;
}

/**
 * Parse API TLS listener config from env. Partial configuration is a startup
 * error: cert and key must be configured together, and a client CA without a
 * cert/key pair is meaningless.
 */
export function resolveApiHttpServerTlsConfig(env: NodeJS.ProcessEnv): ApiHttpServerTlsConfig | undefined {
  const certPath = env.API_TLS_CERT_PATH?.trim() || undefined;
  const keyPath = env.API_TLS_KEY_PATH?.trim() || undefined;
  const caPath = env.API_TLS_CLIENT_CA_PATH?.trim() || undefined;
  if (!certPath && !keyPath) {
    if (caPath) {
      throw new Error('API_TLS_CLIENT_CA_PATH requires API_TLS_CERT_PATH and API_TLS_KEY_PATH');
    }
    return undefined;
  }
  if (!certPath || !keyPath) {
    throw new Error('API_TLS_CERT_PATH and API_TLS_KEY_PATH must be configured together');
  }
  return {
    certPath,
    keyPath,
    ...(caPath ? { caPath } : {}),
  };
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

export function stopApiHttpServer(server: ApiHttpServer): Promise<void> {
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
