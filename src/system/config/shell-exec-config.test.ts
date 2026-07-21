import { describe, expect, it } from 'vitest';
import {
  createDefaultShellExecSettings,
  normalizeShellExecSettings,
} from './shell-exec-config.js';

describe('shell exec owner settings', () => {
  it('normalizes the complete disabled default', () => {
    const defaults = createDefaultShellExecSettings();
    expect(normalizeShellExecSettings(defaults)).toEqual(defaults);
  });

  it('accepts an explicitly enabled bounded Bash policy', () => {
    expect(normalizeShellExecSettings({
      ...createDefaultShellExecSettings(),
      enabled: true,
      allowlist: ['bash', 'rg'],
    })).toMatchObject({
      enabled: true,
      allowlist: ['bash', 'rg'],
      defaultTimeoutMs: 600_000,
      maxTimeoutMs: 3_600_000,
      maxProcesses: 64,
      maxAddressSpaceBytes: 2_147_483_648,
    });
  });

  it('defaults the repository mount off and requires a real boolean when present', () => {
    expect(createDefaultShellExecSettings().mountRepositoryReadOnly).toBe(false);
    const { mountRepositoryReadOnly: _omitted, ...legacyBlock } = createDefaultShellExecSettings();
    expect(normalizeShellExecSettings(legacyBlock)).toMatchObject({
      mountRepositoryReadOnly: false,
    });
    expect(normalizeShellExecSettings({
      ...createDefaultShellExecSettings(),
      enabled: true,
      allowlist: ['bash'],
      mountRepositoryReadOnly: true,
    })).toMatchObject({ mountRepositoryReadOnly: true });
    expect(() => normalizeShellExecSettings({
      ...createDefaultShellExecSettings(),
      mountRepositoryReadOnly: 'yes',
    })).toThrow('shellExec.mountRepositoryReadOnly');
  });

  it('fails closed for empty enabled allowlists, unknown keys, and out-of-range limits', () => {
    expect(() => normalizeShellExecSettings({
      ...createDefaultShellExecSettings(),
      enabled: true,
    })).toThrow('enabled shell requires at least one command');
    expect(() => normalizeShellExecSettings({
      ...createDefaultShellExecSettings(),
      path: '/tmp/bin',
    })).toThrow('contains unknown keys: path');
    expect(() => normalizeShellExecSettings({
      ...createDefaultShellExecSettings(),
      maxProcesses: 16,
      maxAddressSpaceBytes: 8 * 1024 * 1024 * 1024,
    })).toThrow('shellExec.maxAddressSpaceBytes');
    expect(() => normalizeShellExecSettings({
      ...createDefaultShellExecSettings(),
      maxTimeoutMs: 3_600_001,
    })).toThrow('shellExec.maxTimeoutMs');
  });
});
