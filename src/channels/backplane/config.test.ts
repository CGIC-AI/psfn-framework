import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildExternalChannelProfiles,
  loadRuntimeChannelsConfig,
  loadChannelsOwnerFile,
  saveChannelsOwnerFile,
} from './config.js';

describe('loadRuntimeChannelsConfig', () => {
  it('returns defaults when data/channels.json is missing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.discord.heartbeatChannelId).toBe('');
      expect(config.discord.allowedBotUserIds).toEqual([]);
      expect(config.discord.groupMemory).toEqual({ channelOverrides: {} });
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
      expect(config.psfnAmica).toEqual({ enabled: false });
      expect(buildExternalChannelProfiles(config)).toEqual({});
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('throws when channels.json is malformed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), '{"telegram":');

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow('Failed to load channels config');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps literal owner-file placeholders unchanged', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          heartbeatChannelId: '${DISCORD_HEARTBEAT_CHANNEL_ID}',
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        DISCORD_HEARTBEAT_CHANNEL_ID: 'resolved-channel-id',
      });

      expect(config.discord.heartbeatChannelId).toBe('${DISCORD_HEARTBEAT_CHANNEL_ID}');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads telegram config from file and resolves explicit secret refs only', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: true,
          tokenRef: {
            kind: 'env',
            envName: 'TELEGRAM_BOT_TOKEN',
          },
          allowedUsers: ['42', '@trusted_friend'],
          mode: 'polling',
          pollIntervalMs: 2500,
          webhook: {
            url: 'https://example.com/hooks/telegram',
            secretRef: {
              kind: 'env',
              envName: 'TELEGRAM_WEBHOOK_SECRET',
            },
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

  it('round-trips raw channels owner-file saves without materializing secrets', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-save-'));
    try {
      const payload = {
        discord: {
          heartbeatChannelId: 'heartbeat-123',
        },
        telegram: {
          enabled: false,
          tokenRef: {
            kind: 'env',
            envName: 'TELEGRAM_BOT_TOKEN',
          },
          allowedUsers: [],
          mode: 'polling',
          pollIntervalMs: 1_000,
          webhook: {
            url: 'https://example.test/telegram/webhook',
            secretRef: {
              kind: 'env',
              envName: 'TELEGRAM_WEBHOOK_SECRET',
            },
            host: '0.0.0.0',
            port: 8_080,
            path: '/telegram/webhook',
          },
        },
      };

      expect(saveChannelsOwnerFile(dataDir, payload)).toEqual(payload);
      expect(loadChannelsOwnerFile(dataDir)).toEqual(payload);
      expect(buildExternalChannelProfiles(loadRuntimeChannelsConfig(dataDir, {}))).toEqual({});
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('requires explicit telegram wiring when telegram is enabled', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: true,
          mode: 'webhook',
          pollIntervalMs: 2500,
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.telegram.tokenRef must be configured when telegram is enabled',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects legacy inline telegram secrets in channels.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: false,
          token: 'legacy-inline-token',
          mode: 'polling',
          pollIntervalMs: 2500,
          webhook: {
            secret: 'legacy-inline-secret',
          },
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.telegram.tokenRef must be used instead of channels.json.telegram.token',
      );
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

  it('loads discord allowlisted bot user ids from file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          heartbeatChannelId: '1312460007211536394',
          allowedBotUserIds: ['1050938702622375987', ' 1467253459387678963 '],
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.discord).toEqual({
        heartbeatChannelId: '1312460007211536394',
        allowedBotUserIds: ['1050938702622375987', '1467253459387678963'],
        groupMemory: { channelOverrides: {} },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads discord group memory mode and channel overrides from channels.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          groupMemory: {
            memoryMode: 'auto',
            channelOverrides: {
              '1486443955561299979': {
                memoryMode: 'group',
                autoDetection: {
                  recentParticipantWindowMessages: 60,
                  minDistinctHumanContacts: 3,
                },
                onlineExtraction: {
                  observedMessageTriggerCount: 40,
                  maxMessagesPerChunk: 60,
                  chunkOverlapMessages: 4,
                },
                salience: {
                  maxCandidateSpansPerChunk: 10,
                  neighboringContextMessages: 3,
                  reasonWeights: {
                    companionMention: 0.9,
                  },
                  lowSignalRules: {
                    shortMessageMaxChars: 12,
                  },
                },
                writeCaps: {
                  maxWritesPerRun: 6,
                  maxWritesPerContact: 2,
                  maxWritesPerSubject: 1,
                  maxWritesPerTimeWindow: 18,
                  timeWindowMs: 1_800_000,
                  rankingWeights: {
                    addressMode: 0.6,
                    perContactCoverage: 0.9,
                  },
                  addressModeWeights: {
                    overheardRoomContext: 0.25,
                  },
                },
              },
              'dm-channel': {
                memoryMode: 'direct',
              },
            },
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.discord.groupMemory).toEqual({
        memoryMode: 'auto',
        channelOverrides: {
          '1486443955561299979': {
            memoryMode: 'group',
            autoDetection: {
              recentParticipantWindowMessages: 60,
              minDistinctHumanContacts: 3,
            },
            onlineExtraction: {
              observedMessageTriggerCount: 40,
              maxMessagesPerChunk: 60,
              chunkOverlapMessages: 4,
            },
            salience: {
              maxCandidateSpansPerChunk: 10,
              neighboringContextMessages: 3,
              reasonWeights: {
                companionMention: 0.9,
              },
              lowSignalRules: {
                shortMessageMaxChars: 12,
              },
            },
            writeCaps: {
              maxWritesPerRun: 6,
              maxWritesPerContact: 2,
              maxWritesPerSubject: 1,
              maxWritesPerTimeWindow: 18,
              timeWindowMs: 1_800_000,
              rankingWeights: {
                addressMode: 0.6,
                perContactCoverage: 0.9,
              },
              addressModeWeights: {
                overheardRoomContext: 0.25,
              },
            },
          },
          'dm-channel': {
            memoryMode: 'direct',
          },
        },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed discord group memory overrides', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          groupMemory: {
            memoryMode: 'guild',
          },
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.discord.groupMemory.memoryMode',
      );

      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          groupMemory: {
            channelOverrides: {
              room: {
                onlineExtraction: {
                  maxMessagesPerChunk: 0,
                },
              },
            },
          },
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.discord.groupMemory.channelOverrides.room.onlineExtraction.maxMessagesPerChunk',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed discord allowlisted bot user ids', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          allowedBotUserIds: ['1050938702622375987', 42],
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.discord.allowedBotUserIds must contain only strings',
      );
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
            authorId: 'primary-user',
            authorName: 'Primary User',
            canonicalContactId: 'contact-primary-user',
            channelPrivacy: 'semi_private',
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.psfnAmica).toEqual({
        enabled: true,
        defaultIdentity: {
          authorId: 'primary-user',
          authorName: 'Primary User',
          canonicalContactId: 'contact-primary-user',
          channelPrivacy: 'semi_private',
        },
      });
      expect(buildExternalChannelProfiles(config)).toEqual({
        'psfn-amica': {
          authorId: 'primary-user',
          authorName: 'Primary User',
          canonicalContactId: 'contact-primary-user',
          channelPrivacy: 'semi_private',
        },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not expose psfn-amica external profiles when disabled', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        psfnAmica: {
          enabled: false,
          defaultIdentity: {
            authorId: 'primary-user',
            authorName: 'Primary User',
            canonicalContactId: 'contact-primary-user',
            channelPrivacy: 'semi_private',
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.psfnAmica.enabled).toBe(false);
      expect(buildExternalChannelProfiles(config)).toEqual({});
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps telegram behavior in file/override ownership while allowing secret refs to resolve from env', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: true,
          tokenRef: {
            kind: 'env',
            envName: 'TELEGRAM_BOT_TOKEN',
          },
          allowedUsers: ['1'],
          mode: 'webhook',
          pollIntervalMs: 1200,
          webhook: {
            url: 'https://example.com/from-file',
            secretRef: {
              kind: 'env',
              envName: 'TELEGRAM_WEBHOOK_SECRET',
            },
            host: '127.0.0.1',
            port: 1234,
            path: '/from-file',
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: 'token-from-env',
        TELEGRAM_WEBHOOK_SECRET: 'env-secret',
        TELEGRAM_WEBHOOK_URL: 'https://ignored.example.net/telegram/live',
        TELEGRAM_WEBHOOK_HOST: '0.0.0.0',
        TELEGRAM_WEBHOOK_PORT: '8181',
        TELEGRAM_WEBHOOK_PATH: '/telegram/live',
      });

      expect(config.telegram.enabled).toBe(true);
      expect(config.telegram.token).toBe('token-from-env');
      expect(config.telegram.allowedUsers).toEqual(['1']);
      expect(config.telegram.mode).toBe('webhook');
      expect(config.telegram.pollIntervalMs).toBe(1200);
      expect(config.telegram.webhook).toEqual({
        url: 'https://example.com/from-file',
        secret: 'env-secret',
        host: '127.0.0.1',
        port: 1234,
        path: '/from-file',
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
          tokenRef: {
            kind: 'env',
            envName: 'TELEGRAM_BOT_TOKEN',
          },
          allowedUsers: ['from-file'],
          mode: 'polling',
          pollIntervalMs: 1200,
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: 'token-from-env',
      }, {
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
          tokenRef: {
            kind: 'env',
            envName: 'TELEGRAM_BOT_TOKEN',
          },
          allowedUsers: ['from-file'],
          mode: 'polling',
          pollIntervalMs: 1200,
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: 'token-from-env',
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
          tokenRef: {
            kind: 'env',
            envName: 'TELEGRAM_BOT_TOKEN',
          },
          allowedUsers: ['from-file'],
          mode: 'polling',
          pollIntervalMs: 1200,
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: 'token-from-env',
        TELEGRAM_AUTHORIZED_USERS: '5635268079,@primary-user',
      });

      expect(config.telegram.allowedUsers).toEqual(['from-file']);
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
          tokenRef: {
            kind: 'env',
            envName: 'TELEGRAM_BOT_TOKEN',
          },
          mode: 'polling',
          pollIntervalMs: 500,
        },
      }));

      const truthyConfig = loadRuntimeChannelsConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: 'token-from-env',
      });
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
