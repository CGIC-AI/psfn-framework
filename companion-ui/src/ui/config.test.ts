import { describe, expect, it } from 'vitest';
import { readCompanionUiRuntimeConfig, resolveCompanionUiWebSocketUrl } from './config.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

describe('companion UI runtime config', () => {
  it('derives fleet endpoints only from the current canonical origin', () => {
    expect(readCompanionUiRuntimeConfig({
      hostname: 'fleet.example.test',
      origin: 'https://fleet.example.test',
      pathname: '/companion-ui/',
      protocol: 'https:',
    })).toEqual({
      origin: 'https://fleet.example.test',
      sessionStatusPath: '/v1/fleet-auth/session/status',
      loginPath: '/v1/fleet-auth/login?return_to=%2Fcompanion-ui%2F',
    });
  });

  it('rejects off-subpath and insecure non-local execution', () => {
    expect(() => readCompanionUiRuntimeConfig({
      hostname: 'fleet.example.test', origin: 'https://fleet.example.test', pathname: '/fleet', protocol: 'https:',
    })).toThrow(/canonical/u);
    expect(() => readCompanionUiRuntimeConfig({
      hostname: 'fleet.example.test', origin: 'http://fleet.example.test', pathname: '/companion-ui/', protocol: 'http:',
    })).toThrow(/canonical/u);
  });

  it('accepts only an exact server-issued same-origin WebSocket path', () => {
    expect(resolveCompanionUiWebSocketUrl(
      `/companion-ui/companions/${COMPANION_ID}/ws`,
      { host: 'fleet.example.test', hostname: 'fleet.example.test', protocol: 'https:' },
    )).toBe(`wss://fleet.example.test/companion-ui/companions/${COMPANION_ID}/ws`);
    for (const path of [
      `/companion-ui/companions/${COMPANION_ID}/ws?token=secret`,
      `/companion-ui/companions/${COMPANION_ID}/ws/extra`,
      '/companion-ui/companions/not-a-companion/ws',
      'wss://hub.example.test/ws',
    ]) {
      expect(() => resolveCompanionUiWebSocketUrl(path, {
        host: 'fleet.example.test', hostname: 'fleet.example.test', protocol: 'https:',
      })).toThrow(/server-issued/u);
    }
  });
});
