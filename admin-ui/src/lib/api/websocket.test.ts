import { describe, expect, it } from 'vitest';
import { buildAdminWebSocketUrl } from './websocket';

describe('buildAdminWebSocketUrl', () => {
  it('builds same-origin websocket URLs without query-string tokens', () => {
    expect(buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'https:',
      host: 'garden.example.test',
    })).toBe('wss://garden.example.test/api/admin/events');

    expect(buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'http:',
      host: '127.0.0.1:10054',
    })).toBe('ws://127.0.0.1:10054/api/admin/events');
  });

  it('binds the websocket to the canonical companion route', () => {
    const companionId = '11111111-1111-4111-8111-111111111111';
    expect(buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'https:',
      host: 'garden.example.test',
      pathname: `/companions/${companionId}/garden/telemetry`,
    })).toBe(
      `wss://garden.example.test/companions/${companionId}/garden/api/admin/events`,
    );
  });

  it('does not append token-like query parameters', () => {
    const url = buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'https:',
      host: 'garden.example.test',
    });

    expect(url).not.toContain('token=');
    expect(url).not.toContain('?');
  });
});
