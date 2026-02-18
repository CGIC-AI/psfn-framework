import type { IncomingMessage } from 'node:http';

export function getBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export function hasBearerToken(req: IncomingMessage, expected: string): boolean {
  const token = getBearerToken(req);
  return token === expected;
}

export function getCookieValue(req: IncomingMessage, cookieName: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const splitAt = trimmed.indexOf('=');
    if (splitAt < 0) continue;
    const name = trimmed.slice(0, splitAt);
    if (name !== cookieName) continue;
    return trimmed.slice(splitAt + 1);
  }

  return null;
}

export function hasCookieValue(
  req: IncomingMessage,
  cookieName: string,
  expected: string,
): boolean {
  return getCookieValue(req, cookieName) === expected;
}

export function isHtmxRequest(req: IncomingMessage): boolean {
  return req.headers['hx-request'] === 'true';
}

export function acceptsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html');
}
