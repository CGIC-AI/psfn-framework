import type { ConnectionOptions, PeerCertificate } from 'node:tls';

export interface MtlsPeerFileConfig {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  expectedPeerSpiffeUri?: string;
  serverName?: string;
}

export interface RequiredMtlsPeerFileConfig {
  caPath: string;
  certPath: string;
  keyPath: string;
  expectedPeerSpiffeUri: string;
  serverName?: string;
}

interface PeerCertificateWithSubjectAltName {
  subjectaltname?: string;
}

function requireNonEmptyString(value: string | undefined, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

export function normalizeSpiffeUri(value: string, fieldName = 'SPIFFE URI'): string {
  const trimmed = requireNonEmptyString(value, fieldName);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${fieldName} must be a valid spiffe:// URI`);
  }

  if (
    parsed.protocol !== 'spiffe:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${fieldName} must be a spiffe:// URI without credentials, query, or fragment`);
  }

  return trimmed;
}

export function requireMtlsPeerFileConfig(
  config: MtlsPeerFileConfig,
  context: string,
): RequiredMtlsPeerFileConfig {
  const caPath = requireNonEmptyString(config.caPath, `${context} caPath`);
  const certPath = requireNonEmptyString(config.certPath, `${context} certPath`);
  const keyPath = requireNonEmptyString(config.keyPath, `${context} keyPath`);
  const expectedPeerSpiffeUri = normalizeSpiffeUri(
    requireNonEmptyString(config.expectedPeerSpiffeUri, `${context} expected peer SPIFFE URI`),
    `${context} expected peer SPIFFE URI`,
  );
  const serverName = typeof config.serverName === 'string' && config.serverName.trim()
    ? config.serverName.trim()
    : undefined;

  return {
    caPath,
    certPath,
    keyPath,
    expectedPeerSpiffeUri,
    ...(serverName ? { serverName } : {}),
  };
}

export function extractSpiffeUriSans(subjectAltName: string | undefined): string[] {
  if (!subjectAltName) return [];

  const values: string[] = [];
  for (const entry of splitSubjectAltName(subjectAltName)) {
    const separator = entry.indexOf(':');
    if (separator < 0) continue;

    const kind = entry.slice(0, separator).trim().toLowerCase();
    if (kind !== 'uri') continue;

    const uri = decodeSubjectAltNameValue(entry.slice(separator + 1));
    if (isSpiffeUri(uri)) {
      values.push(uri);
    }
  }
  return values;
}

export function verifyPeerCertificateSpiffeUri(
  certificate: PeerCertificateWithSubjectAltName,
  expectedPeerSpiffeUri: string,
): string | null {
  const expected = normalizeSpiffeUri(expectedPeerSpiffeUri, 'expected peer SPIFFE URI');
  const spiffeUris = extractSpiffeUriSans(certificate.subjectaltname);
  if (spiffeUris.length === 0) {
    return 'peer TLS certificate is missing SPIFFE URI SAN';
  }
  if (!spiffeUris.includes(expected)) {
    return 'peer TLS certificate SPIFFE URI SAN did not match expected peer identity';
  }
  return null;
}

export function createSpiffeCheckServerIdentity(
  expectedPeerSpiffeUri: string,
): NonNullable<ConnectionOptions['checkServerIdentity']> {
  const expected = normalizeSpiffeUri(expectedPeerSpiffeUri, 'expected peer SPIFFE URI');
  return (_hostname: string, certificate: PeerCertificate): Error | undefined => {
    const rejectionReason = verifyPeerCertificateSpiffeUri(certificate, expected);
    return rejectionReason ? new Error(rejectionReason) : undefined;
  };
}

function splitSubjectAltName(subjectAltName: string): string[] {
  const entries: string[] = [];
  let current = '';
  let inQuotes = false;
  let escaped = false;

  for (const char of subjectAltName) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      current += char;
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed) entries.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) entries.push(trimmed);
  return entries;
}

function decodeSubjectAltNameValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(trimmed);
      if (typeof decoded === 'string') {
        return decoded;
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function isSpiffeUri(value: string): boolean {
  try {
    normalizeSpiffeUri(value, 'certificate URI SAN');
    return true;
  } catch {
    return false;
  }
}
