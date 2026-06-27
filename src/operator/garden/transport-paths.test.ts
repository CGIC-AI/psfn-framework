import { describe, expect, it } from 'vitest';
import {
  resolveAdminTransportClientEndpoint,
  resolveAdminTransportMode,
  resolveAdminTransportServerEndpoint,
  resolveAdminTransportSocketPath,
} from './transport-paths.js';

describe('Garden admin transport endpoint resolution', () => {
  it('keeps Unix socket mode as the default', () => {
    expect(resolveAdminTransportMode({})).toBe('socket');
    expect(resolveAdminTransportSocketPath({
      GATEWAY_SOCKET: '/run/psfn/gateway.sock',
    })).toBe('/run/psfn/garden-admin.sock');
    expect(resolveAdminTransportClientEndpoint({
      GATEWAY_SOCKET: '/run/psfn/gateway.sock',
    })).toEqual({
      mode: 'socket',
      socketPath: '/run/psfn/garden-admin.sock',
      timeoutMs: 15_000,
    });
  });

  it('requires explicit network mode before accepting a network URL', () => {
    expect(() => resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_URL: 'https://agent-admin.default.svc.cluster.local:10055',
    })).toThrow('require ADMIN_TRANSPORT_MODE=network');
  });

  it('resolves explicit HTTP and HTTPS network client endpoints', () => {
    const httpEndpoint = resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_URL: 'http://agent-admin.default.svc.cluster.local:10055',
      ADMIN_TRANSPORT_TIMEOUT_MS: '2500',
    });
    expect(httpEndpoint.mode).toBe('network');
    if (httpEndpoint.mode !== 'network') throw new Error('Expected network endpoint');
    expect(httpEndpoint.httpUrl.toString()).toBe('http://agent-admin.default.svc.cluster.local:10055/');
    expect(httpEndpoint.wsUrl.toString()).toBe('ws://agent-admin.default.svc.cluster.local:10055/');
    expect(httpEndpoint.timeoutMs).toBe(2500);

    const httpsEndpoint = resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_URL: 'https://agent-admin.default.svc.cluster.local:10055',
      ADMIN_TRANSPORT_TLS_CA_PATH: '/run/psfn/admin-transport/ca.crt',
    });
    expect(httpsEndpoint.mode).toBe('network');
    if (httpsEndpoint.mode !== 'network') throw new Error('Expected network endpoint');
    expect(httpsEndpoint.wsUrl.toString()).toBe('wss://agent-admin.default.svc.cluster.local:10055/');
    expect(httpsEndpoint.tls).toEqual({ caPath: '/run/psfn/admin-transport/ca.crt' });
  });

  it('rejects network client URLs with unexpected path, query, or fragment', () => {
    expect(() => resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_URL: 'https://agent-admin.default.svc.cluster.local:10055/admin',
    })).toThrow('ADMIN_TRANSPORT_URL must not include a path, query, or fragment');
  });

  it('requires explicit host and port for the agent network listener', () => {
    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
    })).toThrow('ADMIN_TRANSPORT_LISTEN_PORT is required');

    expect(resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
    })).toEqual({
      mode: 'network',
      host: '0.0.0.0',
      port: 10055,
      scheme: 'http',
      timeoutMs: 15_000,
      peerAuthMode: 'none',
    });
  });

  it('requires TLS key and cert paths together and preserves the peer-auth seam', () => {
    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
      ADMIN_TRANSPORT_TLS_CERT_PATH: '/run/psfn/admin-transport/tls.crt',
    })).toThrow('ADMIN_TRANSPORT_TLS_CERT_PATH and ADMIN_TRANSPORT_TLS_KEY_PATH must be set together');

    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
      ADMIN_TRANSPORT_PEER_AUTH_MODE: 'spiffe',
    })).toThrow('psfn-framework-z49b owns mTLS/SPIFFE peer authorization');

    expect(resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
      ADMIN_TRANSPORT_TLS_CERT_PATH: '/run/psfn/admin-transport/tls.crt',
      ADMIN_TRANSPORT_TLS_KEY_PATH: '/run/psfn/admin-transport/tls.key',
    })).toEqual({
      mode: 'network',
      host: '0.0.0.0',
      port: 10055,
      scheme: 'https',
      timeoutMs: 15_000,
      peerAuthMode: 'none',
      tls: {
        certPath: '/run/psfn/admin-transport/tls.crt',
        keyPath: '/run/psfn/admin-transport/tls.key',
      },
    });
  });
});
