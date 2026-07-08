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

  it('does not append token-like query parameters', () => {
    const url = buildAdminWebSocketUrl('/api/admin/events', {
      protocol: 'https:',
      host: 'garden.example.test',
    });

    expect(url).not.toContain('token=');
    expect(url).not.toContain('?');
  });
});
