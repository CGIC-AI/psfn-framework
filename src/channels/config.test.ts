import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExternalChannelProfiles, loadRuntimeChannelsConfig } from './config.js';

describe('loadRuntimeChannelsConfig', () => {
  it('returns defaults when data/channels.json is missing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.discord.heartbeatChannelId).toBe('');
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
      expect(config.psfnAmica).toEqual({ enabled: true });
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

  it('loads discord heartbeat channel config from file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          heartbeatChannelId: '1312460007211536394',
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.discord.heartbeatChannelId).toBe('1312460007211536394');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads psfn-amica defaults from channels.json and exposes them as external channel profiles', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        psfnAmica: {
          enabled: true,
          defaultIdentity: {
            authorId: 'admin-user',
            authorName: 'Operator',
            canonicalContactId: 'contact-operator',
            channelPrivacy: 'semi_private',
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.psfnAmica).toEqual({
        enabled: true,
        defaultIdentity: {
          authorId: 'admin-user',
          authorName: 'Operator',
          canonicalContactId: 'contact-operator',
          channelPrivacy: 'semi_private',
        },
      });
      expect(buildExternalChannelProfiles(config)).toEqual({
        'psfn-amica': {
          authorId: 'admin-user',
          authorName: 'Operator',
          canonicalContactId: 'contact-operator',
          channelPrivacy: 'semi_private',
        },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps mutable telegram settings in file/override ownership while still allowing env secrets and webhook wiring', () => {
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

      expect(config.telegram.enabled).toBe(false);
      expect(config.telegram.token).toBe('token-from-env');
      expect(config.telegram.allowedUsers).toEqual(['1']);
      expect(config.telegram.mode).toBe('polling');
      expect(config.telegram.pollIntervalMs).toBe(1200);
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

  it('ignores legacy env telegram toggles and allowlists when settings overrides are present', () => {
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

      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.allowedUsers).toEqual(['from-settings']);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('ignores TELEGRAM_AUTHORIZED_USERS legacy env alias for mutable allowlist settings', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: true,
          allowedUsers: ['from-file'],
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_AUTHORIZED_USERS: '5635268079,@primary-user',
      });

      expect(config.telegram.allowedUsers).toEqual(['from-file']);
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

  it('accepts canonical boolean string forms for telegram enabled from channels.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: 'YES',
        },
      }));

      const truthyConfig = loadRuntimeChannelsConfig(dataDir, {});
      expect(truthyConfig.telegram.enabled).toBe(true);

      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: '0',
        },
      }));
      const falseyConfig = loadRuntimeChannelsConfig(dataDir, {});
      expect(falseyConfig.telegram.enabled).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
