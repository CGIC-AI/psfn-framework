// ── Issued-certificate registry ──
//
// Tracks metadata (never private keys) for every certificate the sidecar has
// issued, so the renewal loop knows what exists and when it expires.
//
// Key-handling contract:
// - Certificates issued over the API are returned ONCE in the HTTP response;
//   the sidecar persists only this metadata.
// - "Managed" certificates additionally record output paths; for those (and
//   only those) the renewal loop re-issues and writes cert+key to the
//   configured paths, so API_TLS_* / satellite cert paths can point there.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import type { IssuedCertKind } from './pki.js';

export const ISSUED_REGISTRY_FILENAME = 'issued-certs.json';

export interface ManagedOutputPaths {
  certPath: string;
  keyPath: string;
}

export interface IssuedCertRecord {
  /** `${kind}:${identityId}` — one active certificate per identity per kind. */
  id: string;
  identityId: string;
  kind: IssuedCertKind;
  serialNumber: string;
  subject: string;
  sans: string[];
  notBefore: string;
  notAfter: string;
  fingerprintSha256: string;
  spkiSha256: string;
  validityDays: number;
  issuedAt: string;
  renewedAt?: string;
  /** Present only for managed (auto-renewed) certificates. */
  outputs?: ManagedOutputPaths;
}

interface IssuedRegistryFile {
  version: 1;
  certificates: IssuedCertRecord[];
}

export function issuedRegistryPath(stateDir: string): string {
  return join(stateDir, ISSUED_REGISTRY_FILENAME);
}

export function issuedCertRecordId(kind: IssuedCertKind, identityId: string): string {
  return `${kind}:${identityId}`;
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown key(s): ${unknown.join(', ')}`);
  }
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseIsoDate(value: unknown, label: string): string {
  const raw = parseNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(raw))) {
    throw new Error(`${label} must be an ISO-8601 timestamp (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

const RECORD_KEYS = [
  'id', 'identityId', 'kind', 'serialNumber', 'subject', 'sans', 'notBefore', 'notAfter',
  'fingerprintSha256', 'spkiSha256', 'validityDays', 'issuedAt', 'renewedAt', 'outputs',
] as const;

function parseIssuedCertRecord(raw: unknown, label: string): IssuedCertRecord {
  const record = assertPlainObject(raw, label);
  assertKnownKeys(record, RECORD_KEYS, label);

  const kind = record.kind;
  if (kind !== 'server' && kind !== 'client') {
    throw new Error(`${label}.kind must be "server" or "client"`);
  }
  if (!Array.isArray(record.sans) || record.sans.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label}.sans must be an array of strings`);
  }
  if (typeof record.validityDays !== 'number' || !Number.isInteger(record.validityDays) || record.validityDays <= 0) {
    throw new Error(`${label}.validityDays must be a positive integer`);
  }

  const identityId = parseNonEmptyString(record.identityId, `${label}.identityId`);
  const id = parseNonEmptyString(record.id, `${label}.id`);
  if (id !== issuedCertRecordId(kind, identityId)) {
    throw new Error(`${label}.id must equal "${issuedCertRecordId(kind, identityId)}" (got ${JSON.stringify(id)})`);
  }

  let outputs: ManagedOutputPaths | undefined;
  if (record.outputs !== undefined) {
    const outputsRaw = assertPlainObject(record.outputs, `${label}.outputs`);
    assertKnownKeys(outputsRaw, ['certPath', 'keyPath'], `${label}.outputs`);
    outputs = {
      certPath: parseNonEmptyString(outputsRaw.certPath, `${label}.outputs.certPath`),
      keyPath: parseNonEmptyString(outputsRaw.keyPath, `${label}.outputs.keyPath`),
    };
  }

  return {
    id,
    identityId,
    kind,
    serialNumber: parseNonEmptyString(record.serialNumber, `${label}.serialNumber`),
    subject: parseNonEmptyString(record.subject, `${label}.subject`),
    sans: record.sans as string[],
    notBefore: parseIsoDate(record.notBefore, `${label}.notBefore`),
    notAfter: parseIsoDate(record.notAfter, `${label}.notAfter`),
    fingerprintSha256: parseNonEmptyString(record.fingerprintSha256, `${label}.fingerprintSha256`),
    spkiSha256: parseNonEmptyString(record.spkiSha256, `${label}.spkiSha256`),
    validityDays: record.validityDays,
    issuedAt: parseIsoDate(record.issuedAt, `${label}.issuedAt`),
    ...(record.renewedAt !== undefined ? { renewedAt: parseIsoDate(record.renewedAt, `${label}.renewedAt`) } : {}),
    ...(outputs ? { outputs } : {}),
  };
}

export class IssuedCertStore {
  private readonly path: string;
  private records = new Map<string, IssuedCertRecord>();

  constructor(stateDir: string) {
    this.path = issuedRegistryPath(stateDir);
    if (!existsSync(this.path)) {
      return; // Fresh state dir: registry starts empty and is created on first write.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch (error) {
      throw new Error(`Issued-cert registry at ${this.path} is not valid JSON: ${String(error)}`);
    }
    const root = assertPlainObject(parsed, this.path);
    assertKnownKeys(root, ['version', 'certificates'], this.path);
    if (root.version !== 1) {
      throw new Error(`${this.path}: version must be 1`);
    }
    if (!Array.isArray(root.certificates)) {
      throw new Error(`${this.path}: certificates must be an array`);
    }
    root.certificates.forEach((entry, index) => {
      const record = parseIssuedCertRecord(entry, `${this.path}.certificates[${index}]`);
      if (this.records.has(record.id)) {
        throw new Error(`${this.path}: duplicate certificate id ${record.id}`);
      }
      this.records.set(record.id, record);
    });
  }

  list(): IssuedCertRecord[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): IssuedCertRecord | undefined {
    return this.records.get(id);
  }

  upsert(record: IssuedCertRecord): void {
    // Round-trip through the parser so a programming error can never persist
    // a malformed record that would brick the next startup.
    const validated = parseIssuedCertRecord(record, `issued-cert record ${record.id}`);
    this.records.set(validated.id, validated);
    this.flush();
  }

  private flush(): void {
    const payload: IssuedRegistryFile = { version: 1, certificates: this.list() };
    writeJsonAtomic(this.path, payload);
  }
}
