import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  deriveApiKeyPrincipalId,
  getBearerPrincipal,
  getCookieValue,
  hasBearerToken,
  hasCookieValue,
  parseSatelliteApiKeys,
  principalFromSatelliteApiKeyToken,
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

describe('parseSatelliteApiKeys (Sprint-10 H4)', () => {
  it('parses distinct keys into distinct satellite-scoped principals', () => {
    const keys = parseSatelliteApiKeys('satellite-key-alpha-0001, satellite-key-beta-0002');
    expect(keys).toEqual(['satellite-key-alpha-0001', 'satellite-key-beta-0002']);
    const principalA = principalFromSatelliteApiKeyToken(keys[0]!);
    const principalB = principalFromSatelliteApiKeyToken(keys[1]!);
    expect(principalA.scope).toBe('satellite');
    expect(principalB.scope).toBe('satellite');
    expect(principalA.id).not.toBe(principalB.id);
  });

  it('returns empty for unset config', () => {
    expect(parseSatelliteApiKeys(undefined)).toEqual([]);
    expect(parseSatelliteApiKeys('  ')).toEqual([]);
  });

  it('fails closed on weak, duplicate, or shared-credential-colliding keys', () => {
    expect(() => parseSatelliteApiKeys('short')).toThrow('at least 16 characters');
    expect(() => parseSatelliteApiKeys('satellite-key-alpha-0001,satellite-key-alpha-0001')).toThrow('distinct');
    expect(() => parseSatelliteApiKeys('satellite-key-alpha-0001', {
      reservedTokens: ['satellite-key-alpha-0001'],
    })).toThrow('must not reuse API_KEY or ADMIN_TOKEN');
  });
});
