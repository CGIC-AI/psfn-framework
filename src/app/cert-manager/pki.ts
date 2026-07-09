// ── Cert-manager PKI core ──
//
// Pure-JS X.509 issuance for the PSFN private CA sidecar, built on
// `@peculiar/x509` over Node's WebCrypto. No openssl subprocesses, ever.
//
// Why a private CA at all: public ACME CAs (Let's Encrypt) refuse to issue
// certificates with the `clientAuth` EKU, so satellite mTLS identities
// (Sprint-10 C1, `src/channels/backplane/http/client-cert.ts`) can only be
// anchored to a deployment-owned root. This module owns that root's key
// material lifecycle: self-signed CA generation, leaf issuance for server
// (serverAuth + SANs) and client (clientAuth, CN = stable identity id)
// certificates, and the fingerprint/SPKI digests operators paste into
// `satellites.json` bindings.

import { createHash, webcrypto } from 'node:crypto';
import { isIP } from 'node:net';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as Crypto);

const subtle = webcrypto.subtle;

/** ECDSA P-256 everywhere: small keys, fast issuance, first-class Node TLS support. */
export const SIGNING_ALGORITHM: EcKeyGenParams & { hash: string } = {
  name: 'ECDSA',
  namedCurve: 'P-256',
  hash: 'SHA-256',
};

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Identity ids become the certificate CN and the registry key, so they must
 * be DN-safe (no separators/escapes) and stable. Same shape satellites use.
 */
export const IDENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type IssuedCertKind = 'server' | 'client';

export interface CaMaterial {
  certPem: string;
  keyPem: string;
}

export interface LoadedCa {
  cert: x509.X509Certificate;
  certPem: string;
  signingKey: CryptoKey;
}

export interface IssueCertificateOptions {
  kind: IssuedCertKind;
  /** Stable identity id; becomes the subject CN. */
  identityId: string;
  /** DNS names / IP literals for the SAN extension (required for server certs). */
  sans: string[];
  validityDays: number;
  ca: LoadedCa;
  now?: Date;
}

export interface IssuedCertificate {
  certPem: string;
  keyPem: string;
  serialNumber: string;
  subject: string;
  sans: string[];
  notBefore: string;
  notAfter: string;
  /** sha256 over the certificate DER, lowercase hex without colons — matches
   * the normalized `fingerprint256` pin format in client-cert.ts. */
  fingerprintSha256: string;
  /** sha256 over the SubjectPublicKeyInfo DER, lowercase hex without colons. */
  spkiSha256: string;
}

export function assertValidIdentityId(identityId: string): void {
  if (!IDENTITY_ID_PATTERN.test(identityId)) {
    throw new Error(
      `identityId must match ${IDENTITY_ID_PATTERN} (got ${JSON.stringify(identityId)})`,
    );
  }
}

function randomSerialNumber(): string {
  const bytes = webcrypto.getRandomValues(new Uint8Array(16));
  // Clear the sign bit so the DER INTEGER stays positive per RFC 5280.
  bytes[0] = bytes[0]! & 0x7f;
  // Avoid a zero leading octet being interpreted as a truncated serial.
  if (bytes[0] === 0) bytes[0] = 0x01;
  return Buffer.from(bytes).toString('hex');
}

function sha256Hex(data: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

async function generateLeafKeyPair(): Promise<CryptoKeyPair> {
  return subtle.generateKey(SIGNING_ALGORITHM, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

export async function exportPrivateKeyPem(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = await subtle.exportKey('pkcs8', privateKey);
  return x509.PemConverter.encode(pkcs8, 'PRIVATE KEY');
}

export async function importCaSigningKey(keyPem: string): Promise<CryptoKey> {
  const blocks = x509.PemConverter.decode(keyPem);
  if (blocks.length !== 1) {
    throw new Error(`CA key PEM must contain exactly one PRIVATE KEY block (found ${blocks.length})`);
  }
  return subtle.importKey('pkcs8', blocks[0]!, SIGNING_ALGORITHM, false, ['sign']);
}

export async function generateCaMaterial(options: {
  commonName: string;
  validityDays: number;
  now?: Date;
}): Promise<CaMaterial> {
  if (!options.commonName.trim()) {
    throw new Error('CA commonName must not be empty');
  }
  if (!Number.isInteger(options.validityDays) || options.validityDays <= 0) {
    throw new Error(`CA validityDays must be a positive integer (got ${options.validityDays})`);
  }
  const keys = await generateLeafKeyPair();
  const now = options.now ?? new Date();
  // Backdate 5 minutes so freshly minted certs survive small clock skew.
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(now.getTime() + options.validityDays * MS_PER_DAY);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerialNumber(),
    name: `CN=${options.commonName}`,
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  return {
    certPem: cert.toString('pem'),
    keyPem: await exportPrivateKeyPem(keys.privateKey),
  };
}

export async function loadCa(certPem: string, keyPem: string): Promise<LoadedCa> {
  const cert = new x509.X509Certificate(certPem);
  const basicConstraints = cert.getExtension(x509.BasicConstraintsExtension);
  if (!basicConstraints?.ca) {
    throw new Error('Configured CA certificate is not a CA (BasicConstraints CA=false or absent)');
  }
  const signingKey = await importCaSigningKey(keyPem);
  // Fail closed if the key on disk does not belong to the CA certificate:
  // sign a probe and verify with the certificate public key.
  const probe = webcrypto.getRandomValues(new Uint8Array(32));
  const signature = await subtle.sign(SIGNING_ALGORITHM, signingKey, probe);
  const publicKey = await cert.publicKey.export(SIGNING_ALGORITHM, ['verify']);
  const matches = await subtle.verify(SIGNING_ALGORITHM, publicKey, signature, probe);
  if (!matches) {
    throw new Error('CA private key does not match the CA certificate public key');
  }
  return { cert, certPem: cert.toString('pem'), signingKey };
}

function buildSanExtension(sans: string[]): x509.SubjectAlternativeNameExtension {
  const entries = sans.map((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error('SAN entries must not be empty');
    }
    return isIP(trimmed) !== 0
      ? { type: 'ip' as const, value: trimmed }
      : { type: 'dns' as const, value: trimmed };
  });
  return new x509.SubjectAlternativeNameExtension(entries);
}

export async function issueCertificate(options: IssueCertificateOptions): Promise<IssuedCertificate> {
  assertValidIdentityId(options.identityId);
  if (!Number.isInteger(options.validityDays) || options.validityDays <= 0) {
    throw new Error(`validityDays must be a positive integer (got ${options.validityDays})`);
  }
  const sans = options.sans.map((san) => san.trim());
  if (options.kind === 'server' && sans.length === 0) {
    throw new Error('Server certificates require at least one SAN (DNS name or IP)');
  }

  const now = options.now ?? new Date();
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(now.getTime() + options.validityDays * MS_PER_DAY);
  const caNotAfter = options.ca.cert.notAfter;
  if (notAfter.getTime() > caNotAfter.getTime()) {
    throw new Error(
      `Requested validity ends ${notAfter.toISOString()}, after the CA expires ${caNotAfter.toISOString()}; ` +
      'shorten validityDays or rotate the CA',
    );
  }

  const keys = await generateLeafKeyPair();
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(
      options.kind === 'server'
        ? x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment
        : x509.KeyUsageFlags.digitalSignature,
      true,
    ),
    new x509.ExtendedKeyUsageExtension(
      [options.kind === 'server' ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.clientAuth],
      true,
    ),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    await x509.AuthorityKeyIdentifierExtension.create(options.ca.cert),
  ];
  if (sans.length > 0) {
    extensions.push(buildSanExtension(sans));
  }

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerialNumber(),
    subject: `CN=${options.identityId}`,
    issuer: options.ca.cert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING_ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: options.ca.signingKey,
    extensions,
  });

  return {
    certPem: cert.toString('pem'),
    keyPem: await exportPrivateKeyPem(keys.privateKey),
    serialNumber: cert.serialNumber,
    subject: cert.subject,
    sans,
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fingerprintSha256: sha256Hex(cert.rawData),
    spkiSha256: sha256Hex(cert.publicKey.rawData),
  };
}
