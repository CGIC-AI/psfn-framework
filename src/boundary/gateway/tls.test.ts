import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyGatewayTlsConfig } from './tls.js';

const ORIGINAL_ENV = { ...process.env };

let tempDir: string;
let tempCaPath: string;

beforeEach(() => {
  // Create a temp CA file for testing
  tempDir = join(tmpdir(), `psfn-tls-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  tempCaPath = join(tempDir, 'test-ca.pem');
  writeFileSync(tempCaPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  try {
    unlinkSync(tempCaPath);
  } catch {
    // ignore cleanup errors
  }
});

describe('applyGatewayTlsConfig', () => {
  it('does nothing when no TLS config is provided', () => {
    const status = applyGatewayTlsConfig({});

    expect(status.customCaApplied).toBe(false);
    expect(status.verificationDisabled).toBe(false);
    expect(status.caPath).toBeUndefined();
  });

  it('sets NODE_EXTRA_CA_CERTS when caPath points to an existing file', () => {
    const status = applyGatewayTlsConfig({ caPath: tempCaPath });

    expect(status.customCaApplied).toBe(true);
    expect(status.caPath).toBe(tempCaPath);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(tempCaPath);
    expect(status.verificationDisabled).toBe(false);
  });

  it('does not set NODE_EXTRA_CA_CERTS when caPath file does not exist', () => {
    delete process.env.NODE_EXTRA_CA_CERTS;

    const status = applyGatewayTlsConfig({ caPath: '/definitely/missing/ca.pem' });

    expect(status.customCaApplied).toBe(false);
    expect(status.caPath).toBeUndefined();
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('reports verification disabled when rejectUnauthorized is false without mutating NODE_TLS_REJECT_UNAUTHORIZED', () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const status = applyGatewayTlsConfig({ rejectUnauthorized: false });

    expect(status.verificationDisabled).toBe(true);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('preserves existing NODE_TLS_REJECT_UNAUTHORIZED when rejectUnauthorized is false', () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';

    const status = applyGatewayTlsConfig({ rejectUnauthorized: false });

    expect(status.verificationDisabled).toBe(true);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
  });

  it('does not set NODE_TLS_REJECT_UNAUTHORIZED when rejectUnauthorized is true', () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const status = applyGatewayTlsConfig({ rejectUnauthorized: true });

    expect(status.verificationDisabled).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('does not set NODE_TLS_REJECT_UNAUTHORIZED when rejectUnauthorized is undefined', () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const status = applyGatewayTlsConfig({});

    expect(status.verificationDisabled).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('applies both CA path and reject-unauthorized together', () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const status = applyGatewayTlsConfig({
      caPath: tempCaPath,
      rejectUnauthorized: false,
    });

    expect(status.customCaApplied).toBe(true);
    expect(status.verificationDisabled).toBe(true);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(tempCaPath);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});
