import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { getCookieValue, hasCookieValue } from './auth.js';

function requestWithCookie(cookie: string): IncomingMessage {
  return {
    headers: { cookie },
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
