import { describe, expect, it } from 'vitest';
import {
  assertCompanionAdminTransportSocketPath,
  resolveCompanionAdminTransportSocketPath,
  resolveAdminTransportClientEndpoint,
  resolveAdminTransportMode,
  resolveAdminTransportServerEndpoint,
  resolveAdminTransportSocketPath,
} from './transport-paths.js';

const GARDEN_SPIFFE_URI = 'spiffe://cluster.local/psfn/garden';
const AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/test-companion';

const TLS_FILE_ENV = {
  ADMIN_TRANSPORT_TLS_CA_PATH: '/run/psfn/admin-transport/ca.crt',
  ADMIN_TRANSPORT_TLS_CERT_PATH: '/run/psfn/admin-transport/tls.crt',
  ADMIN_TRANSPORT_TLS_KEY_PATH: '/run/psfn/admin-transport/tls.key',
};

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

  it('derives and enforces the companion-bound admin socket name', () => {
    const env = {
      ADMIN_TRANSPORT_SOCKET: '/run/psfn/garden-admin-comp-a.sock',
    };
    expect(resolveCompanionAdminTransportSocketPath('comp-a', env))
      .toBe('/run/psfn/garden-admin-comp-a.sock');
    expect(assertCompanionAdminTransportSocketPath('comp-a', env))
      .toBe('/run/psfn/garden-admin-comp-a.sock');
    expect(() => assertCompanionAdminTransportSocketPath('comp-b', env))
      .toThrow(/Multi-companion admin transport mismatch/);
  });

  it('keeps socket mode cert-free and rejects network-only TLS env without network mode', () => {
    expect(resolveAdminTransportServerEndpoint({})).toEqual({
      mode: 'socket',
      socketPath: '/run/psfn/garden-admin.sock',
      timeoutMs: 15_000,
    });

    expect(() => resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_TLS_CA_PATH: '/run/psfn/admin-transport/ca.crt',
    })).toThrow('require ADMIN_TRANSPORT_MODE=network');
    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI: GARDEN_SPIFFE_URI,
    })).toThrow('require ADMIN_TRANSPORT_MODE=network');
  });

  it('requires explicit network mode before accepting a network URL', () => {
    expect(() => resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_URL: 'https://agent-admin.default.svc.cluster.local:10055',
    })).toThrow('require ADMIN_TRANSPORT_MODE=network');
  });

  it('rejects plaintext network client endpoints', () => {
    expect(() => resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_URL: 'http://agent-admin.default.svc.cluster.local:10055',
      ...TLS_FILE_ENV,
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI: AGENT_SPIFFE_URI,
    })).toThrow('ADMIN_TRANSPORT_URL must use https');
  });

  it('resolves explicit HTTPS/WSS mTLS network client endpoints', () => {
    const httpsEndpoint = resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_URL: 'https://agent-admin.default.svc.cluster.local:10055',
      ADMIN_TRANSPORT_TIMEOUT_MS: '2500',
      ADMIN_TRANSPORT_PEER_AUTH_MODE: 'mtls-spiffe',
      ...TLS_FILE_ENV,
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI: AGENT_SPIFFE_URI,
    });
    expect(httpsEndpoint.mode).toBe('network');
    if (httpsEndpoint.mode !== 'network') throw new Error('Expected network endpoint');
    expect(httpsEndpoint.httpUrl.toString()).toBe('https://agent-admin.default.svc.cluster.local:10055/');
    expect(httpsEndpoint.wsUrl.toString()).toBe('wss://agent-admin.default.svc.cluster.local:10055/');
    expect(httpsEndpoint.timeoutMs).toBe(2500);
    expect(httpsEndpoint.peerAuthMode).toBe('mtls-spiffe');
    expect(httpsEndpoint.tls).toEqual({
      caPath: TLS_FILE_ENV.ADMIN_TRANSPORT_TLS_CA_PATH,
      certPath: TLS_FILE_ENV.ADMIN_TRANSPORT_TLS_CERT_PATH,
      keyPath: TLS_FILE_ENV.ADMIN_TRANSPORT_TLS_KEY_PATH,
      expectedPeerSpiffeUri: AGENT_SPIFFE_URI,
    });
  });

  it('rejects network client URLs with unexpected path, query, or fragment', () => {
    expect(() => resolveAdminTransportClientEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_URL: 'https://agent-admin.default.svc.cluster.local:10055/admin',
      ...TLS_FILE_ENV,
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI: AGENT_SPIFFE_URI,
    })).toThrow('ADMIN_TRANSPORT_URL must not include a path, query, or fragment');
  });

  it('requires explicit host, port, and mTLS config for the agent network listener', () => {
    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
    })).toThrow('ADMIN_TRANSPORT_LISTEN_PORT is required');

    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
    })).toThrow('ADMIN_TRANSPORT_MODE=network requires ADMIN_TRANSPORT_TLS_CA_PATH');
  });

  it('resolves explicit HTTPS mTLS agent listener endpoints', () => {
    expect(resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
      ...TLS_FILE_ENV,
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI: GARDEN_SPIFFE_URI,
    })).toEqual({
      mode: 'network',
      host: '0.0.0.0',
      port: 10055,
      scheme: 'https',
      timeoutMs: 15_000,
      peerAuthMode: 'mtls-spiffe',
      tls: {
        caPath: TLS_FILE_ENV.ADMIN_TRANSPORT_TLS_CA_PATH,
        certPath: TLS_FILE_ENV.ADMIN_TRANSPORT_TLS_CERT_PATH,
        keyPath: TLS_FILE_ENV.ADMIN_TRANSPORT_TLS_KEY_PATH,
        expectedPeerSpiffeUri: GARDEN_SPIFFE_URI,
      },
    });
  });

  it('rejects incomplete TLS config, invalid SPIFFE URIs, and unsupported peer auth modes', () => {
    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
      ADMIN_TRANSPORT_TLS_CERT_PATH: '/run/psfn/admin-transport/tls.crt',
      ADMIN_TRANSPORT_TLS_KEY_PATH: '/run/psfn/admin-transport/tls.key',
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI: GARDEN_SPIFFE_URI,
    })).toThrow('ADMIN_TRANSPORT_MODE=network requires ADMIN_TRANSPORT_TLS_CA_PATH');

    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
      ...TLS_FILE_ENV,
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI: 'https://agent-admin/not-spiffe',
    })).toThrow('ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI must be a spiffe:// URI');

    expect(() => resolveAdminTransportServerEndpoint({
      ADMIN_TRANSPORT_MODE: 'network',
      ADMIN_TRANSPORT_LISTEN_HOST: '0.0.0.0',
      ADMIN_TRANSPORT_LISTEN_PORT: '10055',
      ADMIN_TRANSPORT_PEER_AUTH_MODE: 'none',
      ...TLS_FILE_ENV,
      ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI: GARDEN_SPIFFE_URI,
    })).toThrow('Unsupported ADMIN_TRANSPORT_PEER_AUTH_MODE=none; expected mtls-spiffe');
  });
});
