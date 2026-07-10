import { describe, expect, it } from 'vitest';
import { X509Certificate as NodeX509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import {
  generateCaMaterial,
  issueCertificate,
  loadCa,
} from './pki.js';

const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2';
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';

async function makeCa(validityDays = 3650) {
  const material = await generateCaMaterial({ commonName: 'PSFN Test CA', validityDays });
  return { material, ca: await loadCa(material.certPem, material.keyPem) };
}

describe('cert-manager pki', () => {
  it('generates a self-signed CA with CA basic constraints and ~10y validity', async () => {
    const { material } = await makeCa();
    const nodeCert = new NodeX509Certificate(material.certPem);
    expect(nodeCert.ca).toBe(true);
    expect(nodeCert.subject).toContain('CN=PSFN Test CA');
    expect(nodeCert.issuer).toBe(nodeCert.subject);
    // Self-signature verifies with its own public key.
    expect(nodeCert.verify(nodeCert.publicKey)).toBe(true);
    const years = (Date.parse(nodeCert.validTo) - Date.parse(nodeCert.validFrom)) / (365 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(9.5);
  });

  it('issues client certs that chain to the CA with a critical clientAuth EKU', async () => {
    const { material, ca } = await makeCa();
    const issued = await issueCertificate({
      kind: 'client',
      identityId: 'satellite-kitchen-pi',
      sans: [],
      validityDays: 90,
      ca,
    });

    const nodeCert = new NodeX509Certificate(issued.certPem);
    const caNodeCert = new NodeX509Certificate(material.certPem);
    expect(nodeCert.verify(caNodeCert.publicKey)).toBe(true); // signature chains to the CA
    expect(nodeCert.checkIssued(new NodeX509Certificate(material.certPem))).toBe(true);
    expect(nodeCert.subject).toBe('CN=satellite-kitchen-pi');
    expect(nodeCert.ca).toBe(false);

    const parsed = new x509.X509Certificate(issued.certPem);
    const eku = parsed.getExtension(x509.ExtendedKeyUsageExtension);
    expect(eku).toBeTruthy();
    expect(eku!.usages).toContain(CLIENT_AUTH_OID);
    expect(eku!.usages).not.toContain(SERVER_AUTH_OID);

    // Fingerprint matches sha256 over DER (the pin format client-cert.ts normalizes to).
    expect(issued.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(nodeCert.fingerprint256.toLowerCase().replace(/:/gu, '')).toBe(issued.fingerprintSha256);
  });

  it('issues server certs with serverAuth EKU and the requested SANs', async () => {
    const { ca } = await makeCa();
    const issued = await issueCertificate({
      kind: 'server',
      identityId: 'gateway',
      sans: ['gateway.internal', '127.0.0.1'],
      validityDays: 90,
      ca,
    });

    const nodeCert = new NodeX509Certificate(issued.certPem);
    expect(nodeCert.subjectAltName).toContain('DNS:gateway.internal');
    expect(nodeCert.subjectAltName).toContain('IP Address:127.0.0.1');

    const parsed = new x509.X509Certificate(issued.certPem);
    const eku = parsed.getExtension(x509.ExtendedKeyUsageExtension);
    expect(eku!.usages).toContain(SERVER_AUTH_OID);
    expect(eku!.usages).not.toContain(CLIENT_AUTH_OID);
  });

  it('rejects server certs without SANs', async () => {
    const { ca } = await makeCa();
    await expect(
      issueCertificate({ kind: 'server', identityId: 'gateway', sans: [], validityDays: 90, ca }),
    ).rejects.toThrow(/at least one SAN/u);
  });

  it('rejects DN-unsafe identity ids', async () => {
    const { ca } = await makeCa();
    await expect(
      issueCertificate({ kind: 'client', identityId: 'evil,O=Injected', sans: [], validityDays: 90, ca }),
    ).rejects.toThrow(/identityId/u);
  });

  it('refuses to issue past the CA expiry', async () => {
    const { ca } = await makeCa(10);
    await expect(
      issueCertificate({ kind: 'client', identityId: 'sat', sans: [], validityDays: 90, ca }),
    ).rejects.toThrow(/after the CA expires/u);
  });

  it('fails closed when the CA key does not match the CA certificate', async () => {
    const [first, second] = await Promise.all([makeCa(), makeCa()]);
    await expect(loadCa(first.material.certPem, second.material.keyPem))
      .rejects.toThrow(/does not match/u);
  });
});
