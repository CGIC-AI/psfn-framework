import type { IncomingMessage } from 'node:http';

export const FLEET_AUTH_SESSION_COOKIE_NAME = '__Host-psfn_session';
const OPAQUE_SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * WebSocket upgrades accept one Cookie pair total, and it must be the
 * gateway-issued __Host session cookie. HttpOnly is a Set-Cookie property and
 * cannot be reflected by a browser request, so the __Host name plus the
 * gateway's only issuance path is the server-verifiable boundary.
 */
export function readExclusiveFleetSessionCookie(request: IncomingMessage): string | undefined {
  const raw = request.headers.cookie;
  if (typeof raw !== 'string') return undefined;
  const parts = raw.split(';');
  if (parts.length !== 1) return undefined;
  const separator = raw.indexOf('=');
  if (separator <= 0 || raw.indexOf('=', separator + 1) !== -1) return undefined;
  if (raw.slice(0, separator) !== FLEET_AUTH_SESSION_COOKIE_NAME) return undefined;
  const token = raw.slice(separator + 1);
  return OPAQUE_SESSION_PATTERN.test(token) ? token : undefined;
}
