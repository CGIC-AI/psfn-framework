import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { defaultCertManagerConfig, parseCertManagerToken, type CertManagerConfig } from './config.js';
import { CertManagerService, initCertificateAuthority, caKeyPath, type CertManagerLogger } from './service.js';
import {
  createCertManagerServer,
  listenCertManagerServer,
  stopCertManagerServer,
  validateCertManagerListenPolicy,
} from './server.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

function testLogger(): CertManagerLogger & { errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    errors,
    warns,
    debug: () => {},
    info: () => {},
    warn: (message) => { warns.push(message); },
    error: (message) => { errors.push(message); },
  };
}

describe('cert-manager auth fail-closed', () => {
  it('refuses to start without a configured token', () => {
    expect(() => parseCertManagerToken(undefined)).toThrow(/CERT_MANAGER_TOKEN is required/u);
    expect(() => parseCertManagerToken('   ')).toThrow(/CERT_MANAGER_TOKEN is required/u);
  });

  it('refuses weak tokens', () => {
    expect(() => parseCertManagerToken('short')).toThrow(/at least 32 characters/u);
  });

  it('refuses a non-loopback bind without explicit opt-in', () => {
    const config = defaultCertManagerConfig();
    config.listen.host = '0.0.0.0';
    expect(() => validateCertManagerListenPolicy(config, TOKEN)).toThrow(/not loopback/u);
    config.listen.allowNonLoopback = true;
    expect(() => validateCertManagerListenPolicy(config, TOKEN)).not.toThrow();
  });
});

describe('cert-manager HTTP API', () => {
  let stateDir: string;
  let config: CertManagerConfig;
  let service: CertManagerService;
  let server: Server;
  let baseUrl: string;
  let logger: ReturnType<typeof testLogger>;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'psfn-cert-manager-'));
    config = defaultCertManagerConfig();
    config.listen.port = 0; // ephemeral test port
    logger = testLogger();
    await initCertificateAuthority(stateDir, config);
    service = await CertManagerService.open(stateDir, config, logger);
    server = createCertManagerServer({ service, config, token: TOKEN, logger });
    await listenCertManagerServer(server, config, logger);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await stopCertManagerServer(server);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('writes the CA private key with 0600 permissions', () => {
    expect(statSync(caKeyPath(stateDir)).mode & 0o777).toBe(0o600);
  });

  it('serves the CA certificate without auth and never serves the CA key', async () => {
    const response = await fetch(`${baseUrl}/ca.pem`);
    expect(response.status).toBe(200);
    const pem = await response.text();
    expect(pem).toContain('BEGIN CERTIFICATE');
    expect(pem).not.toContain('PRIVATE KEY');

    for (const path of ['/ca.key', '/v1/ca.key', '/ca/ca.key']) {
      const denied = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(denied.status).toBe(404);
    }
  });

  it('rejects missing and wrong bearer tokens with 401', async () => {
    const missing = await fetch(`${baseUrl}/v1/certs`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/v1/certs`, {
      headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` },
    });
    expect(wrong.status).toBe(401);
    expect(logger.warns.length).toBeGreaterThan(0);
  });

  it('issues client certs, returns the key exactly once, and tracks metadata', async () => {
    const response = await fetch(`${baseUrl}/v1/certs/client`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identityId: 'satellite-pi' }),
    });
    expect(response.status).toBe(201);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.subject).toBe('CN=satellite-pi');
    expect(String(payload.certPem)).toContain('BEGIN CERTIFICATE');
    expect(String(payload.keyPem)).toContain('BEGIN PRIVATE KEY');
    expect(String(payload.fingerprintSha256)).toMatch(/^[a-f0-9]{64}$/u);
    expect(payload.managed).toBe(false);

    const list = await fetch(`${baseUrl}/v1/certs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const listed = await list.json() as { certificates: Record<string, unknown>[] };
    expect(listed.certificates).toHaveLength(1);
    expect(listed.certificates[0]!.id).toBe('client:satellite-pi');
    // Metadata only: no key (or cert) material is persisted or listed.
    expect(JSON.stringify(listed)).not.toContain('PRIVATE KEY');
  });

  it('rejects unknown request fields', async () => {
    const response = await fetch(`${baseUrl}/v1/certs/client`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ identityId: 'sat', persistKey: true }),
    });
    expect(response.status).toBe(400);
  });

  it('completes a real mutual-TLS handshake with sidecar-issued certs', async () => {
    const issueViaApi = async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      return await response.json() as { certPem: string; keyPem: string; caCertPem: string };
    };

    const serverBundle = await issueViaApi('/v1/certs/server', {
      identityId: 'gateway',
      sans: ['127.0.0.1', 'localhost'],
    });
    const clientBundle = await issueViaApi('/v1/certs/client', { identityId: 'satellite-pi' });

    let peerCn: string | undefined;
    const tlsServer = createHttpsServer(
      {
        cert: serverBundle.certPem,
        key: serverBundle.keyPem,
        ca: serverBundle.caCertPem,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      },
      (req, res) => {
        const socket = req.socket as import('node:tls').TLSSocket;
        expect(socket.authorized).toBe(true);
        peerCn = socket.getPeerCertificate().subject.CN;
        res.writeHead(200);
        res.end('ok');
      },
    );
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    const tlsPort = (tlsServer.address() as AddressInfo).port;

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpsRequest(
          {
            host: '127.0.0.1',
            port: tlsPort,
            method: 'GET',
            path: '/',
            cert: clientBundle.certPem,
            key: clientBundle.keyPem,
            ca: serverBundle.caCertPem, // trust the private CA for the server cert
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on('error', reject);
        request.end();
      });
      expect(status).toBe(200);
      expect(peerCn).toBe('satellite-pi');

      // Without a client certificate the mutual-TLS handshake must fail.
      await expect(new Promise<number>((resolve, reject) => {
        const request = httpsRequest(
          { host: '127.0.0.1', port: tlsPort, method: 'GET', path: '/', ca: serverBundle.caCertPem },
          (response) => { response.resume(); resolve(response.statusCode ?? 0); },
        );
        request.on('error', reject);
        request.end();
      })).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        tlsServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
