import { describe, expect, it, vi } from 'vitest';
import { createStaticCredentialVault } from '../../boundary/custody/credential-vault.js';
import { ChannelPluginHost } from '../plugins/host.js';
import { parseChannelPluginSections } from '../plugins/load-sections.js';
import { createChannelPluginRegistry } from '../plugins/registry.js';
import { createBuiltinChannelPluginRegistry } from '../plugins/builtin.js';
import { createBuzzChannelPlugin } from './plugin.js';
import { InMemoryBuzzRecoveryStore } from './recovery-store.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_COMPANION_ID = '33333333-3333-4333-8333-333333333333';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const AUTHOR_PUBKEY = 'a'.repeat(64);
const RELAY_PUBKEY = 'b'.repeat(64);
const MACHINE_PUBKEY = 'c'.repeat(64);

const RECOVERY_POLICY = {
  replayWindowSeconds: 120,
  reconnectBaseDelayMs: 250,
  reconnectMaxDelayMs: 4_000,
  maxReconnectAttempts: 5,
  maxFutureEventSkewSeconds: 30,
};

describe('Buzz channel plugin config', () => {
  it('composes one Buzz adapter and recovery scope per account through the plugin host', async () => {
    const recoveryScopes: string[] = [];
    const plugin = createBuzzChannelPlugin({
      recoveryStoreFactory: ({ companionId }) => {
        recoveryScopes.push(companionId);
        return new InMemoryBuzzRecoveryStore();
      },
    });
    const registry = createChannelPluginRegistry([plugin]);
    const sections = parseChannelPluginSections({
      buzz: {
        enabled: true,
        relayUrl: 'ws://127.0.0.1:3100',
        relayPubkey: RELAY_PUBKEY,
        accounts: [
          { companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_ONE_NSEC' } },
          { companionId: SECOND_COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_TWO_NSEC' } },
        ],
        channelIds: [CHANNEL_ID],
        allowedAuthorPubkeys: [AUTHOR_PUBKEY, MACHINE_PUBKEY],
        machineAuthorPubkeys: [MACHINE_PUBKEY],
        recoveryPolicy: RECOVERY_POLICY,
      },
    }, registry);
    const host = await ChannelPluginHost.load({
      registry,
      sections,
      vault: createStaticCredentialVault({
        BUZZ_ONE_NSEC: '1'.repeat(64),
        BUZZ_TWO_NSEC: '2'.repeat(64),
      }),
      contextFor: () => ({
        log: { error: vi.fn(), warn: vi.fn() },
        shutdownTimeoutMs: 1_000,
        intakeScreening: null,
      }),
    });

    expect(host.list().map(entry => entry.id)).toEqual([
      `buzz:${COMPANION_ID}`,
      `buzz:${SECOND_COMPANION_ID}`,
    ]);
    expect(recoveryScopes).toEqual([COMPANION_ID, SECOND_COMPANION_ID]);
  });

  it('normalizes an enabled loopback relay and declares one isolated env credential per account', () => {
    const parsed = createBuzzChannelPlugin().parseConfig({
      enabled: true,
      relayUrl: 'ws://127.0.0.1:3100/',
      relayPubkey: RELAY_PUBKEY,
      accounts: [
        {
          companionId: COMPANION_ID,
          privateKeyRef: { kind: 'env', envName: 'BUZZ_V_UNIT_00_NSEC' },
        },
        {
          companionId: SECOND_COMPANION_ID,
          privateKeyRef: { kind: 'env', envName: 'BUZZ_ARTEMIS_NSEC' },
        },
      ],
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY, MACHINE_PUBKEY],
      machineAuthorPubkeys: [MACHINE_PUBKEY],
      recoveryPolicy: RECOVERY_POLICY,
    });

    expect(parsed).toEqual({
      enabled: true,
      credentials: [],
      instances: [
        {
          id: COMPANION_ID,
          companionId: COMPANION_ID,
          credentials: [{
            id: 'privateKey',
            reference: { kind: 'env', envName: 'BUZZ_V_UNIT_00_NSEC' },
            description: 'Buzz Nostr private key for companion 11111111-1111-4111-8111-111111111111',
          }],
          config: expect.objectContaining({ companionId: COMPANION_ID }),
        },
        {
          id: SECOND_COMPANION_ID,
          companionId: SECOND_COMPANION_ID,
          credentials: [{
            id: 'privateKey',
            reference: { kind: 'env', envName: 'BUZZ_ARTEMIS_NSEC' },
            description: 'Buzz Nostr private key for companion 33333333-3333-4333-8333-333333333333',
          }],
          config: expect.objectContaining({ companionId: SECOND_COMPANION_ID }),
        },
      ],
      config: {
        enabled: true,
        relayUrl: 'ws://127.0.0.1:3100',
        relayPubkey: RELAY_PUBKEY,
        accounts: [
          {
            companionId: COMPANION_ID,
            privateKeyRef: { kind: 'env', envName: 'BUZZ_V_UNIT_00_NSEC' },
          },
          {
            companionId: SECOND_COMPANION_ID,
            privateKeyRef: { kind: 'env', envName: 'BUZZ_ARTEMIS_NSEC' },
          },
        ],
        channelIds: [CHANNEL_ID],
        allowedAuthorPubkeys: [AUTHOR_PUBKEY, MACHINE_PUBKEY],
        machineAuthorPubkeys: [MACHINE_PUBKEY],
        recoveryPolicy: RECOVERY_POLICY,
      },
    });
  });

  it('registers Buzz as a built-in channel plugin', () => {
    expect(createBuiltinChannelPluginRegistry().get('buzz')?.manifest).toEqual({
      id: 'buzz',
      label: 'Buzz',
    });
  });

  it('requires accounts and rejects top-level or duplicate companion identity declarations', () => {
    const common = {
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      relayPubkey: RELAY_PUBKEY,
      channelIds: [],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY, MACHINE_PUBKEY],
      machineAuthorPubkeys: [MACHINE_PUBKEY],
      recoveryPolicy: RECOVERY_POLICY,
    };
    expect(() => createBuzzChannelPlugin().parseConfig({
      ...common,
      companionId: COMPANION_ID,
      privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' },
    })).toThrow('channels.json.buzz has unsupported keys: companionId, privateKeyRef');
    expect(() => createBuzzChannelPlugin().parseConfig({
      ...common,
      accounts: [
        { companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_ONE_NSEC' } },
        { companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_TWO_NSEC' } },
      ],
    })).toThrow('accounts must not contain duplicate companionId values');
    expect(() => createBuzzChannelPlugin().parseConfig({
      ...common,
      accounts: [],
    })).toThrow('accounts must not be empty when Buzz is enabled');
  });

  it('rejects machine authors outside the author allowlist and inverted reconnect bounds', () => {
    const base = {
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      relayPubkey: RELAY_PUBKEY,
      accounts: [{
        companionId: COMPANION_ID,
        privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' },
      }],
      channelIds: [],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
      machineAuthorPubkeys: [MACHINE_PUBKEY],
      recoveryPolicy: RECOVERY_POLICY,
    };
    expect(() => createBuzzChannelPlugin().parseConfig(base)).toThrow(
      'machineAuthorPubkeys must be a subset of allowedAuthorPubkeys',
    );
    expect(() => createBuzzChannelPlugin().parseConfig({
      ...base,
      allowedAuthorPubkeys: [AUTHOR_PUBKEY, MACHINE_PUBKEY],
      recoveryPolicy: {
        ...RECOVERY_POLICY,
        reconnectBaseDelayMs: 5_000,
      },
    })).toThrow('reconnectMaxDelayMs must be at least reconnectBaseDelayMs');
  });

  it('keeps disabled Buzz free of invented policy defaults', () => {
    expect(createBuzzChannelPlugin().parseConfig({ enabled: false })).toEqual({
      enabled: false,
      credentials: [],
      config: {
        enabled: false,
        relayUrl: '',
        relayPubkey: '',
        accounts: [],
        channelIds: [],
        allowedAuthorPubkeys: [],
        machineAuthorPubkeys: [],
      },
    });
  });

  it.each([
    [{
      enabled: true,
      relayUrl: 'ws://relay.example.test',
      accounts: [{ companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' } }],
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'must use wss:// unless it is loopback'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test/community',
      accounts: [{ companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' } }],
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'must not include a path'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      privateKey: 'do-not-accept-inline-secrets',
      accounts: [{ companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' } }],
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'privateKeyRef must be used instead of privateKey'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      accounts: [{
        companionId: COMPANION_ID,
        privateKeyRef: {
          kind: 'env',
          envName: 'BUZZ_NSEC',
          privateKey: 'do-not-accept-nested-inline-secrets',
        },
      }],
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'accounts[0].privateKeyRef has unsupported keys: privateKey'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      accounts: [{ companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'buzz_nsec' } }],
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'envName must be an uppercase env var name'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      accounts: [{ companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' } }],
      channelIds: ['not-a-channel'],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'channelIds[0] must be a lowercase RFC-4122 UUID'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      accounts: [{ companionId: COMPANION_ID, privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' } }],
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: ['ABC'],
    }, 'allowedAuthorPubkeys[0] must be a 64-character lowercase hex pubkey'],
  ])('rejects unsafe or ambiguous configuration', (raw, message) => {
    expect(() => createBuzzChannelPlugin().parseConfig(raw)).toThrow(message);
  });
});
