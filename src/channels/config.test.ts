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
      expect(config.telegram.webhook).toEqual({
        url: '',
        secret: '',
        host: '0.0.0.0',
        port: 8080,
        path: '/telegram/webhook',
      });
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
          webhook: {
            url: 'https://example.com/hooks/telegram',
            secret: '${TELEGRAM_WEBHOOK_SECRET}',
            host: '127.0.0.1',
            port: 9091,
            path: '/hooks/telegram',
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: 'token-from-env',
        TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      });

      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.token).toBe('token-from-env');
      expect(config.telegram.allowedUsers).toEqual(['42', '@trusted_friend']);
      expect(config.telegram.mode).toBe('polling');
      expect(config.telegram.pollIntervalMs).toBe(2500);
      expect(config.telegram.webhook).toEqual({
        url: 'https://example.com/hooks/telegram',
        secret: 'webhook-secret',
        host: '127.0.0.1',
        port: 9091,
        path: '/hooks/telegram',
      });
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
          webhook: {
            url: 'https://example.com/from-file',
            secret: 'file-secret',
            host: '127.0.0.1',
            port: 1234,
            path: '/from-file',
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: 'token-from-env',
        TELEGRAM_ALLOWED_USERS: '99,@alpha',
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_POLL_INTERVAL_MS: '5000',
        TELEGRAM_WEBHOOK_URL: 'https://api.example.net/telegram/live',
        TELEGRAM_WEBHOOK_SECRET: 'env-secret',
        TELEGRAM_WEBHOOK_HOST: '0.0.0.0',
        TELEGRAM_WEBHOOK_PORT: '8181',
        TELEGRAM_WEBHOOK_PATH: '/telegram/live',
      });

      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.token).toBe('token-from-env');
      expect(config.telegram.allowedUsers).toEqual(['99', '@alpha']);
      expect(config.telegram.mode).toBe('webhook');
      expect(config.telegram.pollIntervalMs).toBe(5000);
      expect(config.telegram.webhook).toEqual({
        url: 'https://api.example.net/telegram/live',
        secret: 'env-secret',
        host: '0.0.0.0',
        port: 8181,
        path: '/telegram/live',
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('applies telegram settings overrides ahead of channels.json values', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: false,
          allowedUsers: ['from-file'],
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {}, {
        telegram: {
          enabled: true,
          allowedUsers: ['111', ' 222 ', '', '111'],
        },
      });

      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.allowedUsers).toEqual(['111', '222', '111']);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('prioritizes explicit env telegram values over settings overrides', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: true,
          allowedUsers: ['from-file'],
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_ENABLED: 'false',
        TELEGRAM_ALLOWED_USERS: 'env-1, @env-two',
      }, {
        telegram: {
          enabled: true,
          allowedUsers: ['from-settings'],
        },
      });

      expect(config.telegram.enabled).toBe(false);
      expect(config.telegram.allowedUsers).toEqual(['env-1', '@env-two']);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('accepts TELEGRAM_AUTHORIZED_USERS as allowlist env alias', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: true,
          allowedUsers: ['from-file'],
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_AUTHORIZED_USERS: '5635268079,@operator',
      });

      expect(config.telegram.allowedUsers).toEqual(['5635268079', '@operator']);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('derives webhook path from webhook URL when explicit path is omitted', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          mode: 'webhook',
          webhook: {
            url: 'https://public.example.com/telegram/callback',
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.telegram.webhook.path).toBe('/telegram/callback');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
