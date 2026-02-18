import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HttpLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ReadBodyWithLimitOptions {
  maxBytes: number;
  logger?: HttpLogger;
  logMeta?: Record<string, unknown>;
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
