import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings, saveSettings, applySettings, parseSettingsForm } from './settings.js';
import type { SubstrateConfig } from './types.js';

function makeConfig(): SubstrateConfig {
  return {
    primaryModel: 'z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    discordToken: '',
    discordBotId: '123',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
  };
}

describe('settings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-settings-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadSettings', () => {
    it('returns empty object when file missing', () => {
      const result = loadSettings(tempDir);
      expect(result).toEqual({});
    });

    it('loads valid settings', () => {
      const settings = { primaryModel: 'test-model', primaryMaxTokens: 4096 };
      saveSettings(tempDir, settings);
      const result = loadSettings(tempDir);
      expect(result).toEqual(settings);
    });

    it('returns empty object for invalid JSON', () => {
      const path = join(tempDir, 'settings.json');
      require('fs').writeFileSync(path, 'not json', 'utf-8');
      const result = loadSettings(tempDir);
      expect(result).toEqual({});
    });

    it('returns empty object for array JSON', () => {
      const path = join(tempDir, 'settings.json');
      require('fs').writeFileSync(path, '[]', 'utf-8');
      const result = loadSettings(tempDir);
      expect(result).toEqual({});
    });
  });

  describe('saveSettings', () => {
    it('writes settings atomically', () => {
      const settings = { primaryModel: 'test', extractionInterval: 10 };
      saveSettings(tempDir, settings);

      const raw = readFileSync(join(tempDir, 'settings.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(settings);
    });

    it('creates data dir if missing', () => {
      const nested = join(tempDir, 'sub', 'dir');
      saveSettings(nested, { primaryMaxTokens: 1024 });
      expect(existsSync(join(nested, 'settings.json'))).toBe(true);
    });

    it('no .tmp file remains after save', () => {
      saveSettings(tempDir, { primaryModel: 'test' });
      expect(existsSync(join(tempDir, 'settings.json.tmp'))).toBe(false);
    });
  });

  describe('applySettings', () => {
    it('mutates config with defined values', () => {
      const config = makeConfig();
      applySettings(config, { primaryModel: 'new-model', primaryMaxTokens: 4096 });
      expect(config.primaryModel).toBe('new-model');
      expect(config.primaryMaxTokens).toBe(4096);
      // Unmodified values stay
      expect(config.extractionModel).toBe('deepseek/deepseek-v3.2');
    });

    it('does not modify values when settings are empty', () => {
      const config = makeConfig();
      const original = { ...config };
      applySettings(config, {});
      expect(config).toEqual(original);
    });

    it('applies all fields', () => {
      const config = makeConfig();
      applySettings(config, {
        primaryModel: 'a',
        primaryProvider: 'b',
        extractionModel: 'c',
        extractionProvider: 'd',
        primaryMaxTokens: 512,
        extractionMaxTokens: 1024,
        sessionMessageLimit: 50,
        memoryRetrievalLimit: 25,
        extractionInterval: 10,
      });
      expect(config.primaryModel).toBe('a');
      expect(config.primaryProvider).toBe('b');
      expect(config.extractionModel).toBe('c');
      expect(config.extractionProvider).toBe('d');
      expect(config.primaryMaxTokens).toBe(512);
      expect(config.extractionMaxTokens).toBe(1024);
      expect(config.sessionMessageLimit).toBe(50);
      expect(config.memoryRetrievalLimit).toBe(25);
      expect(config.extractionInterval).toBe(10);
    });
  });

  describe('round-trip', () => {
    it('save → load → apply preserves values', () => {
      const settings = { primaryModel: 'round-trip', primaryMaxTokens: 2048 };
      saveSettings(tempDir, settings);
      const loaded = loadSettings(tempDir);
      const config = makeConfig();
      applySettings(config, loaded);
      expect(config.primaryModel).toBe('round-trip');
      expect(config.primaryMaxTokens).toBe(2048);
    });
  });

  describe('parseSettingsForm', () => {
    it('parses valid form data', () => {
      const params = new URLSearchParams({
        primaryModel: 'test-model',
        primaryMaxTokens: '4096',
        sessionMessageLimit: '50',
      });
      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.primaryModel).toBe('test-model');
      expect(settings.primaryMaxTokens).toBe(4096);
      expect(settings.sessionMessageLimit).toBe(50);
    });

    it('rejects out-of-range values', () => {
      const params = new URLSearchParams({
        primaryMaxTokens: '100',  // min 256
        sessionMessageLimit: '999',  // max 200
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors.length).toBe(2);
      expect(errors[0]).toContain('primaryMaxTokens');
      expect(errors[1]).toContain('sessionMessageLimit');
    });

    it('ignores empty string fields', () => {
      const params = new URLSearchParams({
        primaryModel: '',
        primaryMaxTokens: '',
      });
      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.primaryModel).toBeUndefined();
      expect(settings.primaryMaxTokens).toBeUndefined();
    });

    it('rejects NaN values', () => {
      const params = new URLSearchParams({
        primaryMaxTokens: 'abc',
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors.length).toBe(1);
    });
  });
});
