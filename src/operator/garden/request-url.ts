import type { IncomingMessage } from 'node:http';

export function parseRequestUrl(req: IncomingMessage, fallbackPath: string = '/'): URL {
  return new URL(req.url ?? fallbackPath, `http://${req.headers.host ?? 'localhost'}`);
}

export function resolveRequestOrigin(req: IncomingMessage): string | undefined {
  const forwardedHost = req.headers['x-forwarded-host'];
  const rawHost = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
    ?? req.headers.host;
  const host = rawHost?.split(',')[0]?.trim();
  if (!host) {
    return undefined;
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  const rawProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protoToken = rawProto?.split(',')[0]?.trim().toLowerCase();
  const protocol = protoToken === 'https' ? 'https' : 'http';

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}
