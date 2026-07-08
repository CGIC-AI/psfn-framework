import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';

export interface HttpLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ReadBodyWithLimitOptions {
  maxBytes: number;
  logger?: HttpLogger;
  logMeta?: Record<string, unknown>;
}

export interface ParseJsonBodySuccess<T> {
  ok: true;
  value: T;
}

export interface ParseJsonBodyFailure {
  ok: false;
  errorCode: 'invalid_json';
  error: Error;
}

export type ParseJsonBodyResult<T> =
  | ParseJsonBodySuccess<T>
  | ParseJsonBodyFailure;

export interface ReadJsonBodySuccess<T> {
  ok: true;
  value: T;
  rawBody: string;
}

export interface ReadJsonBodyPayloadTooLarge {
  ok: false;
  errorCode: 'payload_too_large';
}

export interface ReadJsonBodyReadFailure {
  ok: false;
  errorCode: 'read_error';
  error: Error;
}

export interface ReadJsonBodyParseFailure {
  ok: false;
  errorCode: 'invalid_json';
  error: Error;
  rawBody: string;
}

export type ReadJsonBodyResult<T> =
  | ReadJsonBodySuccess<T>
  | ReadJsonBodyPayloadTooLarge
  | ReadJsonBodyReadFailure
  | ReadJsonBodyParseFailure;

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function readBodyWithLimit(
  req: IncomingMessage,
  res: ServerResponse,
  options: ReadBodyWithLimitOptions,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    let body = '';
    let bodySize = 0;
    let settled = false;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer): void => {
      bodySize += chunk.length;
      if (bodySize > options.maxBytes) {
        options.logger?.warn('Request body too large', {
          size: bodySize,
          limit: options.maxBytes,
          ...(options.logMeta ?? {}),
        });
        sendText(res, 413, 'Payload Too Large');
        req.destroy();
        finish(null);
        return;
      }
      body += chunk.toString();
    };

    const onEnd = (): void => {
      if (bodySize > options.maxBytes) {
        finish(null);
        return;
      }
      finish(body);
    };

    const onError = (err: Error): void => fail(err);

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export function parseJsonBody<T = unknown>(rawBody: string): ParseJsonBodyResult<T> {
  try {
    return {
      ok: true,
      value: JSON.parse(rawBody) as T,
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: 'invalid_json',
      error: normalizeError(error),
    };
  }
}

export async function readJsonBodyWithLimit<T = unknown>(
  req: IncomingMessage,
  res: ServerResponse,
  options: ReadBodyWithLimitOptions,
): Promise<ReadJsonBodyResult<T>> {
  let rawBody: string | null;
  try {
    rawBody = await readBodyWithLimit(req, res, options);
  } catch (error) {
    return {
      ok: false,
      errorCode: 'read_error',
      error: normalizeError(error),
    };
  }

  if (rawBody === null) {
    return {
      ok: false,
      errorCode: 'payload_too_large',
    };
  }

  const parsed = parseJsonBody<T>(rawBody);
  if (!parsed.ok) {
    return {
      ok: false,
      errorCode: 'invalid_json',
      error: parsed.error,
      rawBody,
    };
  }

  return {
    ok: true,
    value: parsed.value,
    rawBody,
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...(headers ?? {}) });
  res.end(JSON.stringify(body));
}

type JsonCompressionEncoding = 'br' | 'gzip';

const MIN_COMPRESSED_JSON_BYTES = 1024;

function selectJsonCompressionEncoding(req: IncomingMessage): JsonCompressionEncoding | null {
  const rawHeader = req.headers['accept-encoding'];
  const header = Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader;
  if (!header) return null;

  const accepted = new Map<string, number>();
  for (const part of header.split(',')) {
    const [rawEncoding, ...rawParams] = part.trim().split(';');
    const encoding = rawEncoding.trim().toLowerCase();
    if (!encoding) continue;
    const qParam = rawParams
      .map(param => param.trim())
      .find(param => param.toLowerCase().startsWith('q='));
    const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q < 0) continue;
    accepted.set(encoding, q);
  }

  const brotliQ = accepted.has('br') ? accepted.get('br')! : (accepted.get('*') ?? 0);
  const gzipQ = accepted.has('gzip') ? accepted.get('gzip')! : (accepted.get('*') ?? 0);
  if (brotliQ <= 0 && gzipQ <= 0) return null;
  return brotliQ >= gzipQ ? 'br' : 'gzip';
}

export function sendCompressedJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  const responseHeaders = {
    'Content-Type': 'application/json',
    Vary: 'Accept-Encoding',
    ...(headers ?? {}),
  };
  const encoding = Buffer.byteLength(payload) >= MIN_COMPRESSED_JSON_BYTES
    ? selectJsonCompressionEncoding(req)
    : null;

  if (!encoding) {
    res.writeHead(status, responseHeaders);
    res.end(payload);
    return;
  }

  const compressed = encoding === 'br'
    ? brotliCompressSync(Buffer.from(payload))
    : gzipSync(Buffer.from(payload));
  res.writeHead(status, {
    ...responseHeaders,
    'Content-Encoding': encoding,
    'Content-Length': String(compressed.length),
  });
  res.end(compressed);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...(headers ?? {}) });
  res.end(body);
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...(headers ?? {}) });
  res.end(html);
}

export function sendRedirect(
  res: ServerResponse,
  location: string,
  status = 302,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { Location: location, ...(headers ?? {}) });
  res.end();
}

export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, headers ?? {});
  res.end();
}
