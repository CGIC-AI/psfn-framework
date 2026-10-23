import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import type { GatewayRpcTlsFileConfig } from '../transport.js';

const GATEWAY_SPIFFE_URI = 'spiffe://cluster.local/psfn/gateway';
const AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/test-companion';
const OTHER_AGENT_SPIFFE_URI = 'spiffe://cluster.local/psfn/agent/other-companion';

export interface GatewayRpcTlsFixture {
  serverTls: GatewayRpcTlsFileConfig;
  serverWithoutSpiffeTls: GatewayRpcTlsFileConfig;
  serverUntrustedTls: GatewayRpcTlsFileConfig;
  clientTls: GatewayRpcTlsFileConfig;
  clientWithoutSpiffeTls: GatewayRpcTlsFileConfig;
  clientWrongSpiffeTls: GatewayRpcTlsFileConfig;
  clientUntrustedTls: GatewayRpcTlsFileConfig;
  cleanup(): void;
}

function runOpenSsl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'ignore' });
}

function createCertificateAuthority(dir: string, prefix: string, commonName: string): void {
  runOpenSsl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-days',
    '3650',
    '-nodes',
    '-subj',
    `/CN=${commonName}`,
    '-keyout',
    `${prefix}.key`,
    '-out',
    `${prefix}.crt`,
  ], dir);
}

function createSignedCertificate(input: {
  dir: string;
  prefix: string;
  commonName: string;
  caPrefix: string;
  subjectAltName?: string;
  extendedKeyUsage: 'serverAuth' | 'clientAuth';
}): void {
  runOpenSsl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${input.commonName}`,
    '-keyout',
    `${input.prefix}.key`,
    '-out',
    `${input.prefix}.csr`,
  ], input.dir);
  const extLines = [
    ...(input.subjectAltName ? [`subjectAltName=${input.subjectAltName}`] : []),
    `extendedKeyUsage=${input.extendedKeyUsage}`,
  ];
  writeFileSync(join(input.dir, `${input.prefix}.ext`), `${extLines.join('\n')}\n`, 'utf8');
  runOpenSsl([
    'x509',
    '-req',
    '-in',
    `${input.prefix}.csr`,
    '-CA',
    `${input.caPrefix}.crt`,
    '-CAkey',
    `${input.caPrefix}.key`,
    '-CAcreateserial',
    '-days',
    '3650',
    '-out',
    `${input.prefix}.crt`,
    '-extfile',
    `${input.prefix}.ext`,
  ], input.dir);
}

function buildTlsConfig(input: {
  dir: string;
  caPrefix?: string;
  certPrefix: string;
  expectedPeerSpiffeUri: string;
}): GatewayRpcTlsFileConfig {
  return {
    caPath: join(input.dir, `${input.caPrefix ?? 'ca'}.crt`),
    certPath: join(input.dir, `${input.certPrefix}.crt`),
    keyPath: join(input.dir, `${input.certPrefix}.key`),
    expectedPeerSpiffeUri: input.expectedPeerSpiffeUri,
  };
}

export function createGatewayRpcTlsFixture(): GatewayRpcTlsFixture {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-gateway-rpc-wss-'));
  try {
    createCertificateAuthority(dir, 'ca', 'PSFN Test CA');
    createCertificateAuthority(dir, 'other-ca', 'PSFN Other Test CA');
    createSignedCertificate({
      dir,
      prefix: 'server',
      commonName: 'localhost',
      caPrefix: 'ca',
      subjectAltName: `DNS:localhost,IP:127.0.0.1,URI:${GATEWAY_SPIFFE_URI}`,
      extendedKeyUsage: 'serverAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'server-no-spiffe',
      commonName: 'localhost',
      caPrefix: 'ca',
      subjectAltName: 'DNS:localhost,IP:127.0.0.1',
      extendedKeyUsage: 'serverAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'server-untrusted',
      commonName: 'localhost',
      caPrefix: 'other-ca',
      subjectAltName: `DNS:localhost,IP:127.0.0.1,URI:${GATEWAY_SPIFFE_URI}`,
      extendedKeyUsage: 'serverAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'client',
      commonName: 'psfn-agent-test',
      caPrefix: 'ca',
      subjectAltName: `URI:${AGENT_SPIFFE_URI}`,
      extendedKeyUsage: 'clientAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'client-no-spiffe',
      commonName: 'psfn-agent-test',
      caPrefix: 'ca',
      extendedKeyUsage: 'clientAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'client-wrong-spiffe',
      commonName: 'psfn-agent-test',
      caPrefix: 'ca',
      subjectAltName: `URI:${OTHER_AGENT_SPIFFE_URI}`,
      extendedKeyUsage: 'clientAuth',
    });
    createSignedCertificate({
      dir,
      prefix: 'client-untrusted',
      commonName: 'psfn-agent-test',
      caPrefix: 'other-ca',
      subjectAltName: `URI:${AGENT_SPIFFE_URI}`,
      extendedKeyUsage: 'clientAuth',
    });

    return {
      serverTls: buildTlsConfig({ dir, certPrefix: 'server', expectedPeerSpiffeUri: AGENT_SPIFFE_URI }),
      serverWithoutSpiffeTls: buildTlsConfig({
        dir,
        certPrefix: 'server-no-spiffe',
        expectedPeerSpiffeUri: AGENT_SPIFFE_URI,
      }),
      serverUntrustedTls: buildTlsConfig({
        dir,
        certPrefix: 'server-untrusted',
        expectedPeerSpiffeUri: AGENT_SPIFFE_URI,
      }),
      clientTls: buildTlsConfig({ dir, certPrefix: 'client', expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI }),
      clientWithoutSpiffeTls: buildTlsConfig({
        dir,
        certPrefix: 'client-no-spiffe',
        expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI,
      }),
      clientWrongSpiffeTls: buildTlsConfig({
        dir,
        certPrefix: 'client-wrong-spiffe',
        expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI,
      }),
      clientUntrustedTls: buildTlsConfig({
        dir,
        certPrefix: 'client-untrusted',
        expectedPeerSpiffeUri: GATEWAY_SPIFFE_URI,
      }),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function loadRawWebSocketTlsOptions(tls: GatewayRpcTlsFileConfig): WebSocket.ClientOptions {
  return {
    ca: readFileSync(tls.caPath),
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
    rejectUnauthorized: true,
  };
}
