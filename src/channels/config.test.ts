import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntimeChannelsConfig } from './config.js';

describe('loadRuntimeChannelsConfig', () => {
  it('returns defaults when data/channels.json is missing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.telegram.enabled).toBe(false);
      expect(config.telegram.token).toBe('');
      expect(config.telegram.allowedUsers).toEqual([]);
      expect(config.telegram.mode).toBe('polling');
      expect(config.telegram.pollIntervalMs).toBe(1000);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads telegram config from file and interpolates env placeholders', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: true,
          token: '${TELEGRAM_BOT_TOKEN}',
          allowedUsers: ['42', '@trusted_friend'],
          mode: 'polling',
          pollIntervalMs: 2500,
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: 'token-from-env',
      });

      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.token).toBe('token-from-env');
      expect(config.telegram.allowedUsers).toEqual(['42', '@trusted_friend']);
      expect(config.telegram.mode).toBe('polling');
      expect(config.telegram.pollIntervalMs).toBe(2500);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('lets explicit env values override file values', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: false,
          token: 'token-from-file',
          allowedUsers: ['1'],
          mode: 'polling',
          pollIntervalMs: 1200,
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: 'token-from-env',
        TELEGRAM_ALLOWED_USERS: '99,@alpha',
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_POLL_INTERVAL_MS: '5000',
      });

      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.token).toBe('token-from-env');
      expect(config.telegram.allowedUsers).toEqual(['99', '@alpha']);
      expect(config.telegram.mode).toBe('webhook');
      expect(config.telegram.pollIntervalMs).toBe(5000);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
