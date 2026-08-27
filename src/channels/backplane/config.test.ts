import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertDiscordAccountTokensConfigured,
  buildExternalChannelProfiles,
  loadRuntimeChannelsConfig,
  loadChannelsOwnerFile,
  loadTestingHarnessGardenAdminConfig,
  resolveTestingHarnessGardenVerifierConfig,
  resolveDiscordCompanionView,
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
      expect(config.telegram.operatorChatId).toBe('');
      expect(config.telegram.mode).toBe('polling');
      expect(config.telegram.pollIntervalMs).toBe(1000);
      expect(config.telegram.webhook).toEqual({
        url: '',
        secret: '',
        host: '0.0.0.0',
        port: 8080,
        path: '/telegram/webhook',
      });
      expect(config.plugins).toEqual({});
      expect(config.psfnAmica).toEqual({ enabled: false });
      expect(config.companionUi).toEqual({ channelPrivacy: 'private' });
      expect(buildExternalChannelProfiles(config)).toEqual({
        'companion-ui': { channelPrivacy: 'private' },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads fail-closed Multica gateway channel config from the owner file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        multica: {
          enabled: true,
          baseUrl: 'http://127.0.0.1:8080/',
          workspaceId: '11111111-1111-4111-8111-111111111111',
          companionId: '22222222-2222-4222-8222-222222222222',
          tokenRef: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
          pollIntervalMs: 2500,
          runtimeName: 'V Unit 00',
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        MULTICA_GATEWAY_TOKEN: ' owner-token ',
      });

      expect(config.plugins.multica).toEqual({
        id: 'multica',
        enabled: true,
        companionId: '22222222-2222-4222-8222-222222222222',
        credentials: [{
          id: 'token',
          reference: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
          description: 'Multica gateway token',
        }],
        config: {
          enabled: true,
          baseUrl: 'http://127.0.0.1:8080',
          workspaceId: '11111111-1111-4111-8111-111111111111',
          companionId: '22222222-2222-4222-8222-222222222222',
          tokenRef: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
          pollIntervalMs: 2500,
          runtimeName: 'V Unit 00',
        },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps Multica credential references unresolved at config load', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        multica: {
          enabled: true,
          baseUrl: 'http://127.0.0.1:8080',
          workspaceId: '11111111-1111-4111-8111-111111111111',
          companionId: '22222222-2222-4222-8222-222222222222',
          tokenRef: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
          pollIntervalMs: 1000,
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.plugins.multica?.credentials).toEqual([{
        id: 'token',
        reference: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
        description: 'Multica gateway token',
      }]);
      expect(config.plugins.multica?.config).not.toHaveProperty('token');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown channel plugin ids', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        slack: { enabled: true },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'Unknown channel plugin "slack"',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe or incomplete Multica channel config', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      const writeMultica = (multica: Record<string, unknown>): void => {
        writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({ multica }));
      };

      writeMultica({ enabled: true, token: 'inline-secret' });
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.multica.tokenRef must be used instead',
      );

      writeMultica({ enabled: true, unknown: true });
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.multica has unsupported keys: unknown',
      );

      writeMultica({
        enabled: true,
        baseUrl: 'http://user:pass@127.0.0.1:8080/path',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        companionId: '22222222-2222-4222-8222-222222222222',
        tokenRef: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
        pollIntervalMs: 1000,
      });
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.multica.baseUrl must not contain credentials, a path, query, or fragment',
      );

      writeMultica({
        enabled: true,
        baseUrl: 'http://multica.example.test',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        companionId: '22222222-2222-4222-8222-222222222222',
        tokenRef: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
        pollIntervalMs: 1000,
      });
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.multica.baseUrl must use HTTPS unless the host is loopback',
      );

      writeMultica({
        enabled: true,
        baseUrl: 'http://127.0.0.1:8080',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        companionId: '22222222-2222-4222-8222-222222222222',
        tokenRef: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
        pollIntervalMs: 100,
      });
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.multica.pollIntervalMs must be between 250 and 60000',
      );
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
          operatorChatId: '-100123',
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
      expect(config.telegram.operatorChatId).toBe('-100123');
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
      expect(buildExternalChannelProfiles(loadRuntimeChannelsConfig(dataDir, {}))).toEqual({
        'companion-ui': { channelPrivacy: 'private' },
      });
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

  it('rejects a malformed Telegram operator chat id', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        telegram: {
          enabled: false,
          operatorChatId: '@operator',
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.telegram.operatorChatId must be a numeric Telegram chat id',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads an explicitly named testing-harness API principal from channels.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: {
          testingHarness: {
            principalId: 'testing-harness',
            tokenRef: { kind: 'env', envName: 'TESTING_HARNESS_API_KEY' },
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TESTING_HARNESS_API_KEY: 'dedicated-testing-harness-key',
      });

      expect(config.api.testingHarness).toEqual({
        principalId: 'testing-harness',
        apiKey: 'dedicated-testing-harness-key',
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads the bounded testing-harness Garden admin policy only when complete', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: {
          testingHarness: {
            principalId: 'testing-harness',
            tokenRef: { kind: 'env', envName: 'TESTING_HARNESS_API_KEY' },
            gardenAdmin: {
              enabled: true,
              principalId: 'testing-harness',
              operatorGrantId: 'testing-harness-garden-grant',
              role: 'admin',
              allowedActions: [
                'action_pipe.read',
                'action_pipe.manage',
                'autonomy.read',
                'autonomy.manage',
                'cogsec.read',
                'cogsec.manage',
                'confirmations.read',
                'confirmations.manage',
                'devices.manage',
                'models.read',
                'prompts.read',
                'sessions.read',
                'settings.read',
                'settings.write',
              ],
            },
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {
        TESTING_HARNESS_API_KEY: 'dedicated-testing-harness-key',
      });

      expect(config.api.testingHarness?.gardenAdmin).toEqual({
        enabled: true,
        principalId: 'testing-harness',
        operatorGrantId: 'testing-harness-garden-grant',
        role: 'admin',
        allowedActions: [
          'action_pipe.read',
          'action_pipe.manage',
          'autonomy.read',
          'autonomy.manage',
          'cogsec.read',
          'cogsec.manage',
          'confirmations.read',
          'confirmations.manage',
          'devices.manage',
          'models.read',
          'prompts.read',
          'sessions.read',
          'settings.read',
          'settings.write',
        ],
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed on partial, over-broad, or under-privileged Garden admin policy', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    const writeHarness = (gardenAdmin: unknown) => writeFileSync(
      join(dataDir, 'channels.json'),
      JSON.stringify({
        api: {
          testingHarness: {
            principalId: 'testing-harness',
            tokenRef: { kind: 'env', envName: 'TESTING_HARNESS_API_KEY' },
            gardenAdmin,
          },
        },
      }),
    );
    try {
      writeHarness({ enabled: true });
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.api.testingHarness.gardenAdmin.principalId must be configured',
      );

      writeHarness({
        enabled: true,
        principalId: 'testing-harness',
        operatorGrantId: 'testing-harness-garden-grant',
        role: 'admin',
        allowedActions: ['privacy.break_glass'],
      });
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.api.testingHarness.gardenAdmin.allowedActions contains unsupported action privacy.break_glass',
      );

      writeHarness({
        enabled: true,
        principalId: 'testing-harness',
        operatorGrantId: 'testing-harness-garden-grant',
        role: 'member',
        allowedActions: ['settings.write'],
      });
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.api.testingHarness.gardenAdmin.role does not authorize settings.write',
      );

      writeHarness({ enabled: false });
      expect(loadRuntimeChannelsConfig(dataDir, {}).api.testingHarness?.gardenAdmin).toBeUndefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('requires gateway-side Garden config before enabling the independent verifier key', () => {
    expect(resolveTestingHarnessGardenVerifierConfig(undefined, {})).toBeUndefined();
    expect(() => resolveTestingHarnessGardenVerifierConfig(undefined, {
      PSFN_TESTING_HARNESS_GARDEN_VERIFIER: 'true',
    })).toThrow(
      'PSFN_TESTING_HARNESS_GARDEN_VERIFIER requires complete gateway-side gardenAdmin config',
    );
    expect(resolveTestingHarnessGardenVerifierConfig({
      enabled: true,
      principalId: 'testing-harness',
      operatorGrantId: 'testing-harness-garden-grant',
      role: 'admin',
      allowedActions: ['settings.read'],
    }, {
      PSFN_TESTING_HARNESS_GARDEN_VERIFIER: 'true',
    })).toEqual({ enabled: true });
    expect(resolveTestingHarnessGardenVerifierConfig({
      enabled: true,
      principalId: 'testing-harness',
      operatorGrantId: 'testing-harness-garden-grant',
      role: 'admin',
      allowedActions: ['settings.read'],
    }, {})).toBeUndefined();
  });

  it('loads the Garden verifier policy without resolving the gateway bearer secret', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: {
          testingHarness: {
            principalId: 'testing-harness',
            tokenRef: { kind: 'env', envName: 'TESTING_HARNESS_API_KEY' },
            gardenAdmin: {
              enabled: true,
              principalId: 'testing-harness',
              operatorGrantId: 'testing-harness-garden-grant',
              role: 'admin',
              allowedActions: ['settings.read'],
            },
          },
        },
      }));

      expect(loadTestingHarnessGardenAdminConfig(dataDir)).toMatchObject({
        principalId: 'testing-harness',
        allowedActions: ['settings.read'],
      });
      expect(loadRuntimeChannelsConfig(dataDir, {}).api.testingHarness?.apiKey).toBe('');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed on partial or inline testing-harness API principal config', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: { testingHarness: { principalId: 'testing-harness' } },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.api.testingHarness.tokenRef must be configured',
      );

      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: {
          testingHarness: {
            principalId: 'testing-harness',
            token: 'inline-secret-is-forbidden',
            tokenRef: { kind: 'env', envName: 'TESTING_HARNESS_API_KEY' },
          },
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.api.testingHarness has unsupported keys: token',
      );

      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: {
          testingHarness: {
            principalId: 'another-harness',
            tokenRef: { kind: 'env', envName: 'TESTING_HARNESS_API_KEY' },
          },
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {
        TESTING_HARNESS_API_KEY: 'dedicated-testing-harness-key',
      })).toThrow(
        'Testing-harness API principal id must be "testing-harness"',
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

  it('loads per-guild custom emoji meanings from channels.json (jp36.3.1.2)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          heartbeatChannelId: '111',
          customEmojiMeanings: {
            '900000000000000001': { blobwave: '  the house greeting meme  ' },
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.discord.customEmojiMeanings).toEqual({
        '900000000000000001': { blobwave: 'the house greeting meme' },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed custom emoji meaning (fail closed) (jp36.3.1.2)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          heartbeatChannelId: '111',
          customEmojiMeanings: { '900000000000000001': { blobwave: '   ' } },
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(/must not be blank/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads multi-companion companionId routing fields from channels.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          heartbeatChannelId: '1312460007211536394',
          companionId: ' 11111111-1111-4111-8111-111111111111 ',
        },
        telegram: {
          enabled: false,
          companionId: '22222222-2222-4222-8222-222222222222',
        },
        api: {
          companionId: '22222222-2222-4222-8222-222222222222',
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.discord.companionId).toBe('11111111-1111-4111-8111-111111111111');
      expect(config.telegram.companionId).toBe('22222222-2222-4222-8222-222222222222');
      expect(config.api).toEqual({ companionId: '22222222-2222-4222-8222-222222222222' });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads the Bearer companion selector allowlist from channels.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: {
          companionId: '11111111-1111-4111-8111-111111111111',
          selectableCompanionIds: [
            ' 11111111-1111-4111-8111-111111111111 ',
            '22222222-2222-4222-8222-222222222222',
          ],
        },
      }));

      expect(loadRuntimeChannelsConfig(dataDir, {}).api).toEqual({
        companionId: '11111111-1111-4111-8111-111111111111',
        selectableCompanionIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate Bearer companion selector allowlist entries', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: {
          companionId: '11111111-1111-4111-8111-111111111111',
          selectableCompanionIds: [
            '22222222-2222-4222-8222-222222222222',
            '22222222-2222-4222-8222-222222222222',
          ],
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.api.selectableCompanionIds must not contain duplicates',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a Bearer companion selector allowlist without pinned routing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: {
          selectableCompanionIds: ['22222222-2222-4222-8222-222222222222'],
        },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.api.selectableCompanionIds requires channels.json.api.companionId',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('omits companionId routing fields when channels.json does not declare them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.discord.companionId).toBeUndefined();
      expect(config.telegram.companionId).toBeUndefined();
      expect(config.api).toEqual({});
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects empty or non-string companionId routing values fail-closed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: { companionId: '   ' },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('channels.json.discord.companionId must not be empty');

      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: { companionId: 42 },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('channels.json.api.companionId must be a string');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported keys in the channels.json api section', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        api: { companionId: '11111111-1111-4111-8111-111111111111', token: 'nope' },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('channels.json.api has unsupported keys: token');
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
                telemetry: {
                  maxDiagnosticMemoryScan: 700,
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
            telemetry: {
              maxDiagnosticMemoryScan: 700,
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
            channelPrivacy: 'invite_only',
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
          channelPrivacy: 'invite_only',
        },
      });
      expect(buildExternalChannelProfiles(config)).toEqual({
        'psfn-amica': {
          authorId: 'primary-user',
          authorName: 'Primary User',
          canonicalContactId: 'contact-primary-user',
          channelPrivacy: 'invite_only',
        },
        'companion-ui': { channelPrivacy: 'private' },
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
            channelPrivacy: 'invite_only',
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.psfnAmica.enabled).toBe(false);
      expect(buildExternalChannelProfiles(config)).toEqual({
        'companion-ui': { channelPrivacy: 'private' },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loads companionUi channel defaults and overrides from channels.json (8ora)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        companionUi: {
          channelPrivacy: 'invite_only',
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});

      expect(config.companionUi).toEqual({
        channelPrivacy: 'invite_only',
      });
      expect(buildExternalChannelProfiles(config)).toEqual({
        'companion-ui': {
          channelPrivacy: 'invite_only',
        },
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects inert companionUi canonicalContactId config (8ora)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        companionUi: { channelPrivacy: 'private', canonicalContactId: 'contact-fleet-human' },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.companionUi has unsupported keys: canonicalContactId',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid companionUi.channelPrivacy value (8ora)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        companionUi: { channelPrivacy: 'broadcast' },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.companionUi.channelPrivacy must be one of: private, invite_only, public',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown companionUi keys fail-closed (8ora)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        companionUi: { channelPrivacy: 'private', enabled: true },
      }));

      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(
        'channels.json.companionUi has unsupported keys: enabled',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown companionUi key on save fail-closed (8ora)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      expect(() => saveChannelsOwnerFile(dataDir, {
        companionUi: { channelPrivacy: 'private', foo: 'bar' },
      })).toThrow('channels.json.companionUi has unsupported keys: foo');
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

  it('defaults contextEnvelope to an empty channel-label map', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.contextEnvelope).toEqual({ channels: {}, classificationEpochs: [] });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('parses and validates classificationEpochs, gating operator_confirmed labels (jp36.6.2)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      // A confirmed public label WITHOUT a matching epoch is rejected fail-closed
      // (write-gate: the operator_confirmed marker must be backed by an epoch).
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: { 'room:x': { privacy: 'public', classificationSource: 'operator_confirmed' } },
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow(/matching classificationEpochs record/);

      // With the matching operator-signed epoch it loads and carries both.
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: { 'room:x': { privacy: 'public', classificationSource: 'operator_confirmed' } },
          classificationEpochs: [{
            channelId: 'room:x',
            from: 'invite_only',
            to: 'public',
            at: '2026-07-19T12:00:00.000Z',
            acceptedBy: 'operator',
            noticeVersion: '2026-07-19.1',
          }],
        },
      }));
      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.contextEnvelope.classificationEpochs).toHaveLength(1);
      expect(config.contextEnvelope.channels['room:x'].classificationSource).toBe('operator_confirmed');

      // A malformed epoch (public -> invite_only is not a valid epoch) fails closed.
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: {},
          classificationEpochs: [{
            channelId: 'room:x',
            from: 'public',
            to: 'invite_only',
            at: '2026-07-19T12:00:00.000Z',
            acceptedBy: 'operator',
            noticeVersion: '2026-07-19.1',
          }],
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(/from must be 'invite_only'/);

      // An unknown notice version fails closed.
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: {},
          classificationEpochs: [{
            channelId: 'room:x',
            from: 'invite_only',
            to: 'public',
            at: '2026-07-19T12:00:00.000Z',
            acceptedBy: 'operator',
            noticeVersion: 'bogus',
          }],
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(/noticeVersion/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('parses per-channel contextEnvelope labels from channels.json', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: {
            'discord:friends-room': {
              privacy: 'invite_only',
              broadcast: false,
              contactTracking: 'auto',
            },
            'twitter:main': {
              privacy: 'public',
              broadcast: true,
            },
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.contextEnvelope.channels['discord:friends-room']).toEqual({
        privacy: 'invite_only',
        broadcast: false,
        contactTracking: 'auto',
      });
      expect(config.contextEnvelope.channels['twitter:main']).toEqual({
        privacy: 'public',
        broadcast: true,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('accepts the reserved role_gated contactTracking mode as config', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: {
            'discord:big-room': { contactTracking: 'role_gated' },
          },
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.contextEnvelope.channels['discord:big-room']).toEqual({
        contactTracking: 'role_gated',
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed on retired or invalid contextEnvelope vocabulary', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: {
            'discord:room': { privacy: 'semi_private' },
          },
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(/privacy/);

      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: {
            'discord:room': { privacy: 'broadcast' },
          },
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(/privacy/);

      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          channels: {
            'discord:room': {},
          },
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(/at least one field/);

      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        contextEnvelope: {
          thresholds: { fewMax: 10 },
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, {})).toThrow(/unsupported keys/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('discord multi-account config (multi-companion W1-P2)', () => {
  function withDataDir(run: (dataDir: string) => void): void {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-channel-config-'));
    try {
      run(dataDir);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  function writeAccounts(dataDir: string, accounts: unknown): void {
    writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
      discord: { accounts },
    }));
  }

  const accountA = {
    accountId: 'acct-a',
    companionId: '11111111-1111-4111-8111-111111111111',
    tokenRef: { kind: 'env', envName: 'DISCORD_TOKEN_A' },
  };
  const accountB = {
    accountId: 'acct-b',
    companionId: '22222222-2222-4222-8222-222222222222',
    tokenRef: { kind: 'env', envName: 'DISCORD_TOKEN_B' },
    heartbeatChannelId: '222',
    allowedBotUserIds: [' 999 '],
  };

  it('loads per-companion bot accounts and resolves tokens from named env vars', () => {
    withDataDir((dataDir) => {
      writeAccounts(dataDir, [accountA, accountB]);

      const config = loadRuntimeChannelsConfig(dataDir, {
        DISCORD_TOKEN_A: ' token-a ',
        DISCORD_TOKEN_B: 'token-b',
      });

      expect(config.discord.accounts).toEqual([
        {
          accountId: 'acct-a',
          companionId: '11111111-1111-4111-8111-111111111111',
          tokenEnvVar: 'DISCORD_TOKEN_A',
          token: 'token-a',
          heartbeatChannelId: '',
          allowedBotUserIds: [],
          groupMemory: { channelOverrides: {} },
        },
        {
          accountId: 'acct-b',
          companionId: '22222222-2222-4222-8222-222222222222',
          tokenEnvVar: 'DISCORD_TOKEN_B',
          token: 'token-b',
          heartbeatChannelId: '222',
          allowedBotUserIds: ['999'],
          groupMemory: { channelOverrides: {} },
        },
      ]);
      expect(() => assertDiscordAccountTokensConfigured(config.discord)).not.toThrow();
    });
  });

  it('keeps the single-account shape byte-identical when accounts are absent', () => {
    withDataDir((dataDir) => {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          heartbeatChannelId: '111',
          allowedBotUserIds: ['555'],
        },
      }));

      const config = loadRuntimeChannelsConfig(dataDir, {});
      expect(config.discord).toEqual({
        heartbeatChannelId: '111',
        allowedBotUserIds: ['555'],
        groupMemory: { channelOverrides: {} },
      });
      expect(config.discord.accounts).toBeUndefined();
    });
  });

  it('rejects combining accounts with any single-account discord key', () => {
    withDataDir((dataDir) => {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: {
          companionId: '11111111-1111-4111-8111-111111111111',
          heartbeatChannelId: '111',
          accounts: [accountA],
        },
      }));
      expect(() => loadRuntimeChannelsConfig(dataDir, { DISCORD_TOKEN_A: 'token-a' }))
        .toThrow(/must not combine "accounts" with single-account keys \[companionId, heartbeatChannelId\]/);
    });
  });

  it('rejects an empty accounts array', () => {
    withDataDir((dataDir) => {
      writeAccounts(dataDir, []);
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('channels.json.discord.accounts must be a non-empty array');
    });
  });

  it('rejects an account without a tokenRef', () => {
    withDataDir((dataDir) => {
      writeAccounts(dataDir, [{ accountId: 'acct-a', companionId: '11111111-1111-4111-8111-111111111111' }]);
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('channels.json.discord.accounts[0].tokenRef must be configured');
    });
  });

  it('rejects inline account tokens — secrets stay in env', () => {
    withDataDir((dataDir) => {
      writeAccounts(dataDir, [{ ...accountA, token: 'inline-secret' }]);
      expect(() => loadRuntimeChannelsConfig(dataDir, { DISCORD_TOKEN_A: 'token-a' }))
        .toThrow('channels.json.discord.accounts[0].tokenRef must be used instead');
    });
  });

  it('rejects duplicate accountIds, companionIds, and token env vars', () => {
    withDataDir((dataDir) => {
      writeAccounts(dataDir, [accountA, { ...accountB, accountId: 'acct-a' }]);
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('duplicate accountId "acct-a"');

      writeAccounts(dataDir, [accountA, { ...accountB, companionId: '11111111-1111-4111-8111-111111111111' }]);
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('maps companion "11111111-1111-4111-8111-111111111111" to more than one bot account');

      writeAccounts(dataDir, [
        accountA,
        { ...accountB, tokenRef: { kind: 'env', envName: 'DISCORD_TOKEN_A' } },
      ]);
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('reuses token env var DISCORD_TOKEN_A');
    });
  });

  it('rejects malformed accountIds and unknown account keys', () => {
    withDataDir((dataDir) => {
      writeAccounts(dataDir, [{ ...accountA, accountId: 'bad id!' }]);
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow(/accounts\[0\]\.accountId must match/);

      writeAccounts(dataDir, [{ ...accountA, botToken: 'x' }]);
      expect(() => loadRuntimeChannelsConfig(dataDir, {}))
        .toThrow('channels.json.discord.accounts[0] has unsupported keys: botToken');
    });
  });

  it('parses accounts without secrets present but fails the gateway token assertion', () => {
    withDataDir((dataDir) => {
      writeAccounts(dataDir, [accountA, accountB]);

      // Agent-side load: no gateway secrets in env — structural parse succeeds.
      const config = loadRuntimeChannelsConfig(dataDir, { DISCORD_TOKEN_B: 'token-b' });
      expect(config.discord.accounts?.[0]?.token).toBe('');

      // Gateway-side startup assertion fails closed on the missing env var.
      expect(() => assertDiscordAccountTokensConfigured(config.discord))
        .toThrow('account "acct-a" requires env var DISCORD_TOKEN_A');
    });
  });

  it('validates accounts structurally on owner-file save', () => {
    withDataDir((dataDir) => {
      expect(() => saveChannelsOwnerFile(dataDir, {
        discord: { accounts: [{ accountId: 'acct-a', companionId: '11111111-1111-4111-8111-111111111111' }] },
      })).toThrow('channels.json.discord.accounts[0].tokenRef must be configured');

      expect(() => saveChannelsOwnerFile(dataDir, {
        discord: { accounts: [accountA] },
      })).not.toThrow();
    });
  });

  it('projects per-companion discord views from accounts and single-account config', () => {
    withDataDir((dataDir) => {
      writeAccounts(dataDir, [accountA, accountB]);
      const config = loadRuntimeChannelsConfig(dataDir, {
        DISCORD_TOKEN_A: 'token-a',
        DISCORD_TOKEN_B: 'token-b',
      });

      expect(resolveDiscordCompanionView(config.discord, '22222222-2222-4222-8222-222222222222')).toEqual({
        accountId: 'acct-b',
        heartbeatChannel: { channelId: '222', channelType: 'discord' },
        allowedBotUserIds: ['999'],
        groupMemory: { channelOverrides: {} },
      });
      // Companion without a bot account: inert defaults, not an error.
      expect(resolveDiscordCompanionView(config.discord, '33333333-3333-4333-8333-333333333333')).toEqual({
        heartbeatChannel: null,
        allowedBotUserIds: [],
        groupMemory: { channelOverrides: {} },
      });
    });

    withDataDir((dataDir) => {
      writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
        discord: { heartbeatChannelId: '111', allowedBotUserIds: ['555'] },
      }));
      const config = loadRuntimeChannelsConfig(dataDir, {});
      // Single-account shape: identical projection regardless of companionId.
      expect(resolveDiscordCompanionView(config.discord, undefined)).toEqual({
        heartbeatChannel: { channelId: '111', channelType: 'discord' },
        allowedBotUserIds: ['555'],
        groupMemory: { channelOverrides: {} },
      });
    });
  });
});
