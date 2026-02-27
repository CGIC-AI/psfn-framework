import { describe, expect, it } from 'vitest';
import {
  buildAbsoluteAdminChatApiUrl,
  resolveAdminChatApiBaseUrl,
} from './api-base-url.js';

describe('resolveAdminChatApiBaseUrl', () => {
  it('uses explicit absolute API base URL when provided', () => {
    const value = resolveAdminChatApiBaseUrl({
      explicitApiBaseUrl: 'https://api.example.com/v1/',
      apiHost: '0.0.0.0',
      apiPort: 3000,
    });

    expect(value).toBe('https://api.example.com/v1/');
  });

  it('defaults to localhost API host when no options are provided', () => {
    const value = resolveAdminChatApiBaseUrl();
    expect(value).toBe('http://127.0.0.1:3000');
  });

  it('maps IPv4 wildcard bind host to browser origin hostname', () => {
    const value = resolveAdminChatApiBaseUrl({
      apiHost: '0.0.0.0',
      apiPort: 4100,
      browserOrigin: 'https://admin.example.test:3001',
    });

    expect(value).toBe('https://admin.example.test:4100');
  });

  it('maps IPv6 wildcard bind host to browser origin hostname', () => {
    const value = resolveAdminChatApiBaseUrl({
      apiHost: '::',
      apiPort: 4100,
      browserOrigin: 'http://[2001:db8::42]:3001',
    });

    expect(value).toBe('http://[2001:db8::42]:4100');
  });

  it('falls back to localhost when wildcard bind host has no browser origin', () => {
    const value = resolveAdminChatApiBaseUrl({
      apiHost: '[::]',
      apiPort: 4100,
    });

    expect(value).toBe('http://127.0.0.1:4100');
  });

  it('preserves explicitly routable API hosts', () => {
    const value = resolveAdminChatApiBaseUrl({
      apiHost: 'api.internal.example',
      apiPort: 8080,
      browserOrigin: 'https://admin.example.test',
    });

    expect(value).toBe('http://api.internal.example:8080');
  });
});

describe('buildAbsoluteAdminChatApiUrl', () => {
  it('builds absolute endpoint URLs from base URL', () => {
    const value = buildAbsoluteAdminChatApiUrl('/v1/chat/completions', 'http://127.0.0.1:3000');
    expect(value).toBe('http://127.0.0.1:3000/v1/chat/completions');
  });
});
