// ── Cert-manager HTTP API ──
//
// Small authenticated control surface for the sidecar, loopback-bound by
// default. Every route except `GET /ca.pem` (public by construction) and
// `GET /healthz` requires the bearer token; without a configured token the
// process refuses to start (see parseCertManagerToken).
//
//   GET  /healthz            liveness probe (no state disclosed)
//   GET  /ca.pem             CA certificate PEM (public material)
//   GET  /v1/certs           issued-cert metadata + expiries
//   POST /v1/certs/server    issue server cert  {identityId, sans, validityDays?, manage?}
//   POST /v1/certs/client    issue client cert  {identityId, sans?, validityDays?, manage?}
//   POST /v1/certs/renew     re-issue           {kind, identityId}
//
// Issued private keys appear exactly once, in the issue/renew response; the
// CA private key is never reachable through any route.

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isLoopbackHost } from '../../shared/net/hosts.js';
import type { CertManagerConfig } from './config.js';
import type { CertManagerLogger, CertManagerService, IssueRequest, IssueResult } from './service.js';
import type { IssuedCertKind } from './pki.js';
import type { ManagedOutputPaths } from './store.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface CertManagerServerOptions {
  service: CertManagerService;
  config: CertManagerConfig;
  token: string;
  logger: CertManagerLogger;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Fail-closed listen policy, mirroring the Garden admin startup guard: the
 * sidecar binds loopback unless the operator explicitly opts into a wider
 * bind in cert-manager.json. There is no tokenless mode at all.
 */
export function validateCertManagerListenPolicy(config: CertManagerConfig, token: string): void {
  if (!token) {
    throw new Error('cert-manager requires a bearer token; refusing to start unauthenticated');
  }
  if (!isLoopbackHost(config.listen.host) && !config.listen.allowNonLoopback) {
    throw new Error(
      `cert-manager listen.host ${config.listen.host} is not loopback; ` +
      'set listen.allowNonLoopback=true in cert-manager.json to opt in explicitly',
    );
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { status, message } });
}

function timingSafeTokenEqual(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/u.exec(header.trim());
  if (!match) return false;
  return timingSafeTokenEqual(match[1]!.trim(), token);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

function assertBodyObject(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new HttpError(400, `Unknown request field(s): ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
  }
  return record;
}

function parseIdentityId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'identityId must be a non-empty string');
  }
  return value.trim();
}

function parseSans(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new HttpError(400, 'sans must be an array of non-empty strings');
  }
  return (value as string[]).map((entry) => entry.trim());
}

function parseValidityDays(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, 'validityDays must be a positive integer');
  }
  return value;
}

function parseManage(value: unknown): boolean | ManagedOutputPaths | undefined {
  if (value === undefined || typeof value === 'boolean') return value as boolean | undefined;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => key !== 'certPath' && key !== 'keyPath');
    if (unknown.length > 0) {
      throw new HttpError(400, `Unknown manage field(s): ${unknown.join(', ')}`);
    }
    if (typeof record.certPath !== 'string' || typeof record.keyPath !== 'string') {
      throw new HttpError(400, 'manage.certPath and manage.keyPath must be strings');
    }
    return { certPath: record.certPath, keyPath: record.keyPath };
  }
  throw new HttpError(400, 'manage must be a boolean or {certPath, keyPath}');
}

function parseKind(value: unknown): IssuedCertKind {
  if (value !== 'server' && value !== 'client') {
    throw new HttpError(400, 'kind must be "server" or "client"');
  }
  return value;
}

function issueRequestFromBody(kind: IssuedCertKind, body: unknown): IssueRequest {
  const record = assertBodyObject(body, ['identityId', 'sans', 'validityDays', 'manage']);
  const sans = parseSans(record.sans);
  const validityDays = parseValidityDays(record.validityDays);
  const manage = parseManage(record.manage);
  return {
    kind,
    identityId: parseIdentityId(record.identityId),
    ...(sans !== undefined ? { sans } : {}),
    ...(validityDays !== undefined ? { validityDays } : {}),
    ...(manage !== undefined ? { manage } : {}),
  };
}

function issueResponsePayload(result: IssueResult): Record<string, unknown> {
  return {
    identityId: result.record.identityId,
    kind: result.record.kind,
    serialNumber: result.record.serialNumber,
    subject: result.record.subject,
    sans: result.record.sans,
    notBefore: result.record.notBefore,
    notAfter: result.record.notAfter,
    // Pin material for satellites.json clientCert* bindings.
    fingerprintSha256: result.record.fingerprintSha256,
    spkiSha256: result.record.spkiSha256,
    managed: result.managed,
    ...(result.record.outputs ? { outputs: result.record.outputs } : {}),
    // The one and only delivery of the private key (unless managed outputs
    // were configured, in which case the sidecar also wrote it to disk).
    certPem: result.bundle.certPem,
    keyPem: result.bundle.keyPem,
    caCertPem: result.caCertPem,
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: CertManagerServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://cert-manager.invalid');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (method === 'GET' && path === '/ca.pem') {
    const pem = options.service.caCertPem();
    res.writeHead(200, {
      'Content-Type': 'application/x-pem-file',
      'Content-Length': Buffer.byteLength(pem),
      'Cache-Control': 'no-store',
    });
    res.end(pem);
    return;
  }

  if (!isAuthorized(req, options.token)) {
    options.logger.warn('Rejected unauthenticated cert-manager request', { method, path });
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendError(res, 401, 'Missing or invalid bearer token');
    return;
  }

  if (method === 'GET' && path === '/v1/certs') {
    sendJson(res, 200, { certificates: options.service.listIssued() });
    return;
  }

  if (method === 'POST' && (path === '/v1/certs/server' || path === '/v1/certs/client')) {
    const kind: IssuedCertKind = path.endsWith('/server') ? 'server' : 'client';
    const request = issueRequestFromBody(kind, await readJsonBody(req));
    const result = await options.service.issue(request);
    sendJson(res, 201, issueResponsePayload(result));
    return;
  }

  if (method === 'POST' && path === '/v1/certs/renew') {
    const body = assertBodyObject(await readJsonBody(req), ['kind', 'identityId']);
    const kind = parseKind(body.kind);
    const identityId = parseIdentityId(body.identityId);
    const result = await options.service.renew(kind, identityId);
    sendJson(res, 200, issueResponsePayload(result));
    return;
  }

  sendError(res, 404, `No such route: ${method} ${path}`);
}

export function createCertManagerServer(options: CertManagerServerOptions): Server {
  validateCertManagerListenPolicy(options.config, options.token);
  return createServer((req, res) => {
    void route(req, res, options).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      options.logger.error('cert-manager request failed', {
        method: req.method,
        path: req.url,
        error: message,
      });
      if (!res.writableEnded) {
        // Issuance errors are operator input problems (bad identity id, SAN,
        // validity vs CA expiry); surface the message rather than a blind 500.
        sendError(res, 400, message);
      }
    });
  });
}

export function listenCertManagerServer(
  server: Server,
  config: CertManagerConfig,
  logger: CertManagerLogger,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: NodeJS.ErrnoException) => {
      logger.error('cert-manager server failed to start', {
        host: config.listen.host,
        port: config.listen.port,
        code: error.code,
        error: error.message,
      });
      rejectPromise(error);
    };
    server.once('error', onError);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off('error', onError);
      logger.info(`cert-manager listening on ${config.listen.host}:${config.listen.port}`);
      resolvePromise();
    });
  });
}

export function stopCertManagerServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}
