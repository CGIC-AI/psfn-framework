import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const API_KEY_PRINCIPAL_DIGEST_LENGTH = 24;
export const INSECURE_LOCAL_API_PRINCIPAL_ID = 'local-insecure';

export interface ApiAuthPrincipal {
  id: string;
  mode: 'api_key' | 'insecure_local';
}

export const INSECURE_LOCAL_API_PRINCIPAL: Readonly<ApiAuthPrincipal> = Object.freeze({
  id: INSECURE_LOCAL_API_PRINCIPAL_ID,
  mode: 'insecure_local',
});

function normalizeToken(value: string): string {
  return value.trim();
}

export function isExpectedApiToken(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate) return false;

  const normalizedCandidate = normalizeToken(candidate);
  const normalizedExpected = normalizeToken(expected);
  if (!normalizedCandidate || !normalizedExpected) return false;

  const candidateBuffer = Buffer.from(normalizedCandidate);
  const expectedBuffer = Buffer.from(normalizedExpected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function deriveApiKeyPrincipalId(apiToken: string): string {
  const normalized = normalizeToken(apiToken);
  const digest = createHash('sha256')
    .update(normalized)
    .digest('hex');
  return `api-key-${digest.slice(0, API_KEY_PRINCIPAL_DIGEST_LENGTH)}`;
}

export function principalFromApiKeyToken(apiToken: string): ApiAuthPrincipal {
  return {
    id: deriveApiKeyPrincipalId(apiToken),
    mode: 'api_key',
  };
}

export function getBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export function getBearerPrincipal(req: IncomingMessage, expected: string): ApiAuthPrincipal | null {
  const token = getBearerToken(req);
  if (!isExpectedApiToken(token, expected)) return null;
  return principalFromApiKeyToken(expected);
}

export function hasBearerToken(req: IncomingMessage, expected: string): boolean {
  return getBearerPrincipal(req, expected) !== null;
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
    const rawValue = trimmed.slice(splitAt + 1);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
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
