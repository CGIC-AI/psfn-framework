import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  deriveApiKeyPrincipalId,
  getBearerPrincipal,
  getCookieValue,
  hasBearerToken,
  hasCookieValue,
} from './auth.js';

function requestWithCookie(cookie: string): IncomingMessage {
  return {
    headers: { cookie },
  } as IncomingMessage;
}

function requestWithAuthorization(authorization: string): IncomingMessage {
  return {
    headers: { authorization },
  } as IncomingMessage;
}

describe('getCookieValue', () => {
  it('returns decoded cookie value when url-encoded', () => {
    const req = requestWithCookie('psfn_token=test-admin-secret%2Bphase4');
    expect(getCookieValue(req, 'psfn_token')).toBe('test-admin-secret+phase4');
  });

  it('falls back to raw value when decode fails', () => {
    const req = requestWithCookie('psfn_token=%E0%A4%A');
    expect(getCookieValue(req, 'psfn_token')).toBe('%E0%A4%A');
  });
});

describe('hasCookieValue', () => {
  it('matches decoded cookie value against expected token', () => {
    const req = requestWithCookie('psfn_token=test-admin-secret%3Aphase4');
    expect(hasCookieValue(req, 'psfn_token', 'test-admin-secret:phase4')).toBe(true);
  });
});

describe('bearer auth helpers', () => {
  it('matches bearer token using normalized values', () => {
    const req = requestWithAuthorization('Bearer test-secret-key   ');
    expect(hasBearerToken(req, 'test-secret-key')).toBe(true);
  });

  it('returns a stable principal derived from api key', () => {
    const req = requestWithAuthorization('Bearer test-secret-key');
    const principal = getBearerPrincipal(req, 'test-secret-key');
    expect(principal).not.toBeNull();
    expect(principal?.id).toBe(deriveApiKeyPrincipalId('test-secret-key'));
    expect(principal?.mode).toBe('api_key');
  });

  it('rejects mismatched bearer tokens', () => {
    const req = requestWithAuthorization('Bearer wrong-key');
    expect(getBearerPrincipal(req, 'test-secret-key')).toBeNull();
    expect(hasBearerToken(req, 'test-secret-key')).toBe(false);
  });
});
