import { describe, expect, it } from 'vitest';
import { createBuiltinChannelPluginRegistry } from '../plugins/builtin.js';
import { createBuzzChannelPlugin } from './plugin.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const AUTHOR_PUBKEY = 'a'.repeat(64);
const RELAY_PUBKEY = 'b'.repeat(64);
const MACHINE_PUBKEY = 'c'.repeat(64);

const LOOP_POLICY = {
  maxAutonomousReplyHops: 6,
  noInformationAcknowledgements: ['acknowledged', 'noted'],
};

const RECOVERY_POLICY = {
  replayWindowSeconds: 120,
  reconnectBaseDelayMs: 250,
  reconnectMaxDelayMs: 4_000,
  maxReconnectAttempts: 5,
  maxFutureEventSkewSeconds: 30,
};

describe('Buzz channel plugin config', () => {
  it('normalizes an enabled loopback relay and declares only an env credential', () => {
    const parsed = createBuzzChannelPlugin().parseConfig({
      enabled: true,
      relayUrl: 'ws://127.0.0.1:3100/',
      relayPubkey: RELAY_PUBKEY,
      companionId: COMPANION_ID,
      privateKeyRef: { kind: 'env', envName: 'BUZZ_V_UNIT_00_NSEC' },
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY, MACHINE_PUBKEY],
      machineAuthorPubkeys: [MACHINE_PUBKEY],
      loopPolicy: LOOP_POLICY,
      recoveryPolicy: RECOVERY_POLICY,
    });

    expect(parsed).toEqual({
      enabled: true,
      companionId: COMPANION_ID,
      credentials: [{
        id: 'privateKey',
        reference: { kind: 'env', envName: 'BUZZ_V_UNIT_00_NSEC' },
        description: 'Buzz Nostr private key',
      }],
      config: {
        enabled: true,
        relayUrl: 'ws://127.0.0.1:3100',
        relayPubkey: RELAY_PUBKEY,
        companionId: COMPANION_ID,
        privateKeyRef: { kind: 'env', envName: 'BUZZ_V_UNIT_00_NSEC' },
        channelIds: [CHANNEL_ID],
        allowedAuthorPubkeys: [AUTHOR_PUBKEY, MACHINE_PUBKEY],
        machineAuthorPubkeys: [MACHINE_PUBKEY],
        loopPolicy: LOOP_POLICY,
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

  it('rejects machine authors outside the author allowlist and inverted reconnect bounds', () => {
    const base = {
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      relayPubkey: RELAY_PUBKEY,
      companionId: COMPANION_ID,
      privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' },
      channelIds: [],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
      machineAuthorPubkeys: [MACHINE_PUBKEY],
      loopPolicy: LOOP_POLICY,
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
      companionId: COMPANION_ID,
      privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' },
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'must use wss:// unless it is loopback'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test/community',
      companionId: COMPANION_ID,
      privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' },
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'must not include a path'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      companionId: COMPANION_ID,
      privateKey: 'do-not-accept-inline-secrets',
      privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' },
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'privateKeyRef must be used instead of privateKey'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      companionId: COMPANION_ID,
      privateKeyRef: {
        kind: 'env',
        envName: 'BUZZ_NSEC',
        privateKey: 'do-not-accept-nested-inline-secrets',
      },
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'privateKeyRef has unsupported keys: privateKey'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      companionId: COMPANION_ID,
      privateKeyRef: { kind: 'env', envName: 'buzz_nsec' },
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'envName must be an uppercase env var name'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      companionId: COMPANION_ID,
      privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' },
      channelIds: ['not-a-channel'],
      allowedAuthorPubkeys: [AUTHOR_PUBKEY],
    }, 'channelIds[0] must be a lowercase RFC-4122 UUID'],
    [{
      enabled: true,
      relayUrl: 'wss://relay.example.test',
      companionId: COMPANION_ID,
      privateKeyRef: { kind: 'env', envName: 'BUZZ_NSEC' },
      channelIds: [CHANNEL_ID],
      allowedAuthorPubkeys: ['ABC'],
    }, 'allowedAuthorPubkeys[0] must be a 64-character lowercase hex pubkey'],
  ])('rejects unsafe or ambiguous configuration', (raw, message) => {
    expect(() => createBuzzChannelPlugin().parseConfig(raw)).toThrow(message);
  });
});
