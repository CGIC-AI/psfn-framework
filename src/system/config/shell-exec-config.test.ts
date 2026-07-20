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
      maxProcesses: 8,
      maxAddressSpaceBytes: 134_217_728,
    });
  });

  it('fails closed for empty enabled allowlists, unknown keys, and unsafe aggregate memory', () => {
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
      maxAddressSpaceBytes: 512 * 1024 * 1024,
    })).toThrow('maxProcesses * maxAddressSpaceBytes');
  });
});
