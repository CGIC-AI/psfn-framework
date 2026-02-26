import type { IncomingMessage, ServerResponse } from 'node:http';

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
