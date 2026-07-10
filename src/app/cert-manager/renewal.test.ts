import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { X509Certificate as NodeX509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCertManagerConfig, type CertManagerConfig } from './config.js';
import { CertManagerService, initCertificateAuthority, type CertManagerLogger } from './service.js';

function testLogger(): CertManagerLogger & {
  errors: { message: string; meta?: Record<string, unknown> }[];
  infos: { message: string; meta?: Record<string, unknown> }[];
} {
  const errors: { message: string; meta?: Record<string, unknown> }[] = [];
  const infos: { message: string; meta?: Record<string, unknown> }[] = [];
  return {
    errors,
    infos,
    debug: () => {},
    info: (message, meta) => { infos.push({ message, ...(meta ? { meta } : {}) }); },
    warn: () => {},
    error: (message, meta) => { errors.push({ message, ...(meta ? { meta } : {}) }); },
  };
}

describe('cert-manager renewal loop', () => {
  let stateDir: string;
  let config: CertManagerConfig;
  let service: CertManagerService;
  let logger: ReturnType<typeof testLogger>;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'psfn-cert-renewal-'));
    config = defaultCertManagerConfig(); // renewBeforeDays = 30
    logger = testLogger();
    await initCertificateAuthority(stateDir, config);
    service = await CertManagerService.open(stateDir, config, logger);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('re-issues an expiring managed cert in place and leaves fresh certs alone', async () => {
    const certPath = join(stateDir, 'out', 'gateway-cert.pem');
    const keyPath = join(stateDir, 'out', 'gateway-key.pem');

    // Inject a short-lived managed cert: 5 days left, renewal threshold 30 days.
    const expiring = await service.issue({
      kind: 'server',
      identityId: 'gateway',
      sans: ['127.0.0.1'],
      validityDays: 5,
      manage: { certPath, keyPath },
    });
    // And a fresh managed cert that must NOT be touched.
    const fresh = await service.issue({ kind: 'client', identityId: 'sat-fresh', validityDays: 90, manage: true });

    const staleCertOnDisk = readFileSync(certPath, 'utf-8');

    const sweep = await service.runRenewalSweep();
    expect(sweep.checked).toBe(2);
    expect(sweep.failures).toHaveLength(0);
    expect(sweep.expiringUnmanaged).toHaveLength(0);
    expect(sweep.renewed.map((record) => record.id)).toEqual(['server:gateway']);

    const renewed = service.listIssued().find((record) => record.id === 'server:gateway')!;
    expect(renewed.serialNumber).not.toBe(expiring.record.serialNumber);
    expect(Date.parse(renewed.notAfter)).toBeGreaterThan(Date.parse(expiring.record.notAfter));
    expect(renewed.renewedAt).toBeTruthy();
    expect(renewed.sans).toEqual(['127.0.0.1']); // renewal preserves the SAN set

    // The renewed bundle was rewritten at the configured output paths.
    const renewedCertOnDisk = readFileSync(certPath, 'utf-8');
    expect(renewedCertOnDisk).not.toBe(staleCertOnDisk);
    const nodeCert = new NodeX509Certificate(renewedCertOnDisk);
    expect(nodeCert.serialNumber.toLowerCase()).toBe(renewed.serialNumber.toLowerCase());
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // Renewal is logged loudly.
    expect(logger.infos.some((entry) => entry.message.includes('RENEWED'))).toBe(true);

    const untouched = service.listIssued().find((record) => record.id === 'client:sat-fresh')!;
    expect(untouched.serialNumber).toBe(fresh.record.serialNumber);
  });

  it('reports expiring unmanaged certs as errors instead of silently skipping', async () => {
    await service.issue({ kind: 'client', identityId: 'sat-unmanaged', validityDays: 5 });

    const sweep = await service.runRenewalSweep();
    expect(sweep.renewed).toHaveLength(0);
    expect(sweep.expiringUnmanaged.map((record) => record.id)).toEqual(['client:sat-unmanaged']);
    expect(logger.errors.some((entry) => entry.message.includes('NOT auto-renewable'))).toBe(true);
  });

  it('renewal state survives a sidecar restart (registry reload)', async () => {
    await service.issue({ kind: 'client', identityId: 'sat-a', validityDays: 5, manage: true });

    const reopened = await CertManagerService.open(stateDir, config, logger);
    const sweep = await reopened.runRenewalSweep();
    expect(sweep.renewed.map((record) => record.id)).toEqual(['client:sat-a']);
  });
});
