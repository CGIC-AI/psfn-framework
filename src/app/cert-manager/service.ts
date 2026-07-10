// ── Cert-manager service ──
//
// Owns the private CA state directory and every operation the HTTP API and
// renewal loop expose. Filesystem contract (all under the sidecar state dir,
// default `<system-data>/cert-manager/`):
//
//   cert-manager.json     sidecar config (created by `init`)
//   ca/ca.key             CA private key, mode 0600 — NEVER served
//   ca/ca.crt             CA certificate (public)
//   issued-certs.json     issued-cert metadata for renewal tracking (no keys)
//   live/<id>/            default output dir for managed cert+key bundles

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CertManagerConfig } from './config.js';
import {
  assertValidIdentityId,
  generateCaMaterial,
  issueCertificate,
  loadCa,
  type IssuedCertificate,
  type IssuedCertKind,
  type LoadedCa,
} from './pki.js';
import {
  IssuedCertStore,
  issuedCertRecordId,
  type IssuedCertRecord,
  type ManagedOutputPaths,
} from './store.js';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface CertManagerLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function caDir(stateDir: string): string {
  return join(stateDir, 'ca');
}

export function caKeyPath(stateDir: string): string {
  return join(caDir(stateDir), 'ca.key');
}

export function caCertPath(stateDir: string): string {
  return join(caDir(stateDir), 'ca.crt');
}

export function defaultManagedOutputs(stateDir: string, kind: IssuedCertKind, identityId: string): ManagedOutputPaths {
  const dir = join(stateDir, 'live', issuedCertRecordId(kind, identityId).replace(':', '-'));
  return { certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem') };
}

/** Write a secret file with 0600 permissions atomically (write tmp, chmod, rename). */
function writeSecretFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(tmpPath, 0o600); // mode option is masked by umask; enforce explicitly
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort tmp cleanup; the original error is what matters.
    }
    throw error;
  }
}

function writePublicFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: 0o644 });
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort tmp cleanup; the original error is what matters.
    }
    throw error;
  }
}

export interface InitCaResult {
  caCertPath: string;
  caKeyPath: string;
}

/**
 * Generate the root CA into the state dir. Refuses to overwrite existing CA
 * material — replacing a CA is a deliberate, documented rotation procedure
 * (see docs/certificates.md), never an accidental re-init.
 */
export async function initCertificateAuthority(
  stateDir: string,
  config: CertManagerConfig,
): Promise<InitCaResult> {
  const keyPath = caKeyPath(stateDir);
  const certPath = caCertPath(stateDir);
  if (existsSync(keyPath) || existsSync(certPath)) {
    throw new Error(
      `CA material already exists under ${caDir(stateDir)}; refusing to overwrite. ` +
      'To rotate the CA, move the old material aside explicitly and re-run init.',
    );
  }
  const material = await generateCaMaterial({
    commonName: config.ca.commonName,
    validityDays: config.ca.validityDays,
  });
  mkdirSync(caDir(stateDir), { recursive: true, mode: 0o700 });
  writeSecretFileAtomic(keyPath, material.keyPem);
  writePublicFileAtomic(certPath, material.certPem);
  return { caCertPath: certPath, caKeyPath: keyPath };
}

export interface IssueRequest {
  kind: IssuedCertKind;
  identityId: string;
  sans?: string[];
  validityDays?: number;
  /**
   * Opt this identity into sidecar-managed renewal. `true` uses the default
   * `live/<kind>-<id>/` paths inside the state dir; explicit paths let
   * API_TLS_* / satellite configs point wherever they already look.
   */
  manage?: boolean | ManagedOutputPaths;
}

export interface IssueResult {
  record: IssuedCertRecord;
  bundle: IssuedCertificate;
  caCertPem: string;
  managed: boolean;
}

export interface RenewalSweepResult {
  checked: number;
  renewed: IssuedCertRecord[];
  /** Expiring records without managed outputs: cannot be auto-renewed. */
  expiringUnmanaged: IssuedCertRecord[];
  failures: { record: IssuedCertRecord; error: string }[];
}

export class CertManagerService {
  private constructor(
    readonly stateDir: string,
    readonly config: CertManagerConfig,
    private readonly ca: LoadedCa,
    private readonly store: IssuedCertStore,
    private readonly logger: CertManagerLogger,
  ) {}

  static async open(
    stateDir: string,
    config: CertManagerConfig,
    logger: CertManagerLogger,
  ): Promise<CertManagerService> {
    const keyPath = caKeyPath(stateDir);
    const certPath = caCertPath(stateDir);
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      throw new Error(
        `CA material not found under ${caDir(stateDir)}; run \`npm run cert-manager -- init\` first`,
      );
    }
    const keyMode = statSync(keyPath).mode & 0o777;
    if ((keyMode & 0o077) !== 0) {
      throw new Error(
        `CA private key ${keyPath} has mode ${keyMode.toString(8)}; ` +
        'refusing to start until it is 0600 (chmod 600)',
      );
    }
    const ca = await loadCa(readFileSync(certPath, 'utf-8'), readFileSync(keyPath, 'utf-8'));
    const store = new IssuedCertStore(stateDir);
    return new CertManagerService(stateDir, config, ca, store, logger);
  }

  caCertPem(): string {
    return this.ca.certPem;
  }

  listIssued(): IssuedCertRecord[] {
    return this.store.list();
  }

  private resolveOutputs(request: IssueRequest): ManagedOutputPaths | undefined {
    if (request.manage === undefined || request.manage === false) return undefined;
    const outputs = request.manage === true
      ? defaultManagedOutputs(this.stateDir, request.kind, request.identityId)
      : request.manage;
    if (!isAbsolute(outputs.certPath) || !isAbsolute(outputs.keyPath)) {
      // Relative managed paths silently depend on the sidecar's cwd and would
      // scatter key material; require absolute paths.
      throw new Error('Managed output certPath/keyPath must be absolute paths');
    }
    if (resolve(outputs.certPath) === resolve(outputs.keyPath)) {
      throw new Error('Managed output certPath and keyPath must differ');
    }
    return { certPath: resolve(outputs.certPath), keyPath: resolve(outputs.keyPath) };
  }

  async issue(request: IssueRequest, now = new Date()): Promise<IssueResult> {
    assertValidIdentityId(request.identityId);
    const validityDays = request.validityDays
      ?? (request.kind === 'server' ? this.config.defaults.serverCertDays : this.config.defaults.clientCertDays);
    const outputs = this.resolveOutputs(request);
    const previous = this.store.get(issuedCertRecordId(request.kind, request.identityId));

    const bundle = await issueCertificate({
      kind: request.kind,
      identityId: request.identityId,
      sans: request.sans ?? [],
      validityDays,
      ca: this.ca,
      now,
    });

    const record: IssuedCertRecord = {
      id: issuedCertRecordId(request.kind, request.identityId),
      identityId: request.identityId,
      kind: request.kind,
      serialNumber: bundle.serialNumber,
      subject: bundle.subject,
      sans: bundle.sans,
      notBefore: bundle.notBefore,
      notAfter: bundle.notAfter,
      fingerprintSha256: bundle.fingerprintSha256,
      spkiSha256: bundle.spkiSha256,
      validityDays,
      issuedAt: previous?.issuedAt ?? now.toISOString(),
      ...(previous ? { renewedAt: now.toISOString() } : {}),
      ...(outputs ? { outputs } : {}),
    };

    if (outputs) {
      writeSecretFileAtomic(outputs.keyPath, bundle.keyPem);
      writePublicFileAtomic(outputs.certPath, bundle.certPem);
    }
    this.store.upsert(record);

    this.logger.info('Issued certificate', {
      id: record.id,
      kind: record.kind,
      serialNumber: record.serialNumber,
      notAfter: record.notAfter,
      managed: Boolean(outputs),
      ...(outputs ? { certPath: outputs.certPath } : {}),
    });

    return { record, bundle, caCertPem: this.ca.certPem, managed: Boolean(outputs) };
  }

  /**
   * Re-issue an existing identity's certificate with a fresh keypair. For
   * managed records the renewed bundle is also written to the configured
   * output paths; for unmanaged records the response is the only copy.
   */
  async renew(kind: IssuedCertKind, identityId: string, now = new Date()): Promise<IssueResult> {
    const record = this.store.get(issuedCertRecordId(kind, identityId));
    if (!record) {
      throw new Error(`No issued certificate tracked for ${issuedCertRecordId(kind, identityId)}`);
    }
    return this.issue(
      {
        kind: record.kind,
        identityId: record.identityId,
        sans: record.sans,
        validityDays: record.validityDays,
        ...(record.outputs ? { manage: record.outputs } : {}),
      },
      now,
    );
  }

  /**
   * One pass of the background renewal loop. Managed certificates inside the
   * renewal window are re-issued and rewritten in place; unmanaged expiring
   * certificates are surfaced as ERRORS because nobody else will renew them.
   * Individual failures never abort the sweep — every due certificate gets
   * its attempt, and every failure is logged at error level.
   */
  async runRenewalSweep(now = new Date()): Promise<RenewalSweepResult> {
    const threshold = this.config.defaults.renewBeforeDays * MS_PER_DAY;
    const result: RenewalSweepResult = { checked: 0, renewed: [], expiringUnmanaged: [], failures: [] };

    for (const record of this.store.list()) {
      result.checked += 1;
      const msLeft = Date.parse(record.notAfter) - now.getTime();
      if (msLeft > threshold) continue;

      if (!record.outputs) {
        result.expiringUnmanaged.push(record);
        this.logger.error('Certificate expiring and NOT auto-renewable (no managed output paths)', {
          id: record.id,
          notAfter: record.notAfter,
          daysLeft: Math.floor(msLeft / MS_PER_DAY),
          action: 'renew via POST /v1/certs/renew and redeploy the bundle to the satellite',
        });
        continue;
      }

      try {
        const renewed = await this.renew(record.kind, record.identityId, now);
        result.renewed.push(renewed.record);
        this.logger.info('RENEWED certificate before expiry', {
          id: record.id,
          previousSerial: record.serialNumber,
          newSerial: renewed.record.serialNumber,
          previousNotAfter: record.notAfter,
          newNotAfter: renewed.record.notAfter,
          certPath: record.outputs.certPath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failures.push({ record, error: message });
        this.logger.error('Certificate renewal FAILED', {
          id: record.id,
          notAfter: record.notAfter,
          error: message,
        });
      }
    }

    return result;
  }
}
