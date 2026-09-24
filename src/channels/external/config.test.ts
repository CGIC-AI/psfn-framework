import { describe, expect, it } from 'vitest';
import { createBuiltinChannelPluginRegistry } from '../plugins/builtin.js';
import { parseChannelPluginSections } from '../plugins/load-sections.js';
import { EXTERNAL_CHANNEL_TEST_LIMITS } from '../../test-support/external-channel-conformance.js';
import { parseExternalChannelSection } from './config.js';

const companionId = '11111111-1111-4111-8111-111111111111';

function section(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    limits: { ...EXTERNAL_CHANNEL_TEST_LIMITS },
    adapters: [{
      id: 'sms',
      label: 'SMS bridge',
      companionId,
      tokenRef: { kind: 'env', envName: 'EXTERNAL_CHANNEL_SMS_TOKEN' },
    }],
    ...overrides,
  };
}

describe('channels.json.external owner-file contract', () => {
  it('parses each adapter into a companion-routed instance with an env credential need', () => {
    const parsed = parseExternalChannelSection(section());
    expect(parsed.enabled).toBe(true);
    expect(parsed.config).toBeNull();
    expect(parsed.instances).toEqual([{
      id: 'sms',
      companionId,
      config: { instanceId: 'sms', label: 'SMS bridge', companionId, limits: EXTERNAL_CHANNEL_TEST_LIMITS },
      credentials: [{
        id: 'token',
        reference: { kind: 'env', envName: 'EXTERNAL_CHANNEL_SMS_TOKEN' },
        description: 'external channel adapter "sms" bearer token',
      }],
    }]);
  });

  it('is admitted by the builtin plugin registry under the "external" key', () => {
    const loaded = parseChannelPluginSections({ external: section() }, createBuiltinChannelPluginRegistry());
    expect(loaded.external?.id).toBe('external');
    expect(loaded.external?.instances).toHaveLength(1);
  });

  it.each([
    ['a missing limit', section({ limits: { ...EXTERNAL_CHANNEL_TEST_LIMITS, turnTimeoutMs: undefined } })],
    ['a zero limit', section({ limits: { ...EXTERNAL_CHANNEL_TEST_LIMITS, maxInFlightTurns: 0 } })],
    ['an unknown limit', section({ limits: { ...EXTERNAL_CHANNEL_TEST_LIMITS, retries: 3 } })],
    ['an unknown section key', section({ transport: 'websocket' })],
    ['an inline secret', section({ adapters: [{ id: 'sms', label: 'SMS', companionId, token: 'secret' }] })],
    ['a non-env token reference', section({
      adapters: [{ id: 'sms', label: 'SMS', companionId, tokenRef: { kind: 'file', envName: 'X' } }],
    })],
    ['an invalid adapter id', section({
      adapters: [{ id: 'SMS Bridge', label: 'SMS', companionId, tokenRef: { kind: 'env', envName: 'X_TOKEN' } }],
    })],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseExternalChannelSection(raw)).toThrow('Invalid channels.json.external');
  });

  it('rejects an enabled section without adapters', () => {
    expect(() => parseExternalChannelSection(section({ adapters: [] }))).toThrow('declares no adapters');
    expect(parseExternalChannelSection(section({ enabled: false, adapters: [] })).instances).toEqual([]);
  });

  it('validates a disabled section fully so no latent error is persisted', () => {
    expect(() => parseExternalChannelSection(section({ enabled: false, limits: {} })))
      .toThrow('Invalid channels.json.external');
  });

  it('rejects duplicate adapter ids, shared token envs, and non-UUID companions', () => {
    const adapter = { id: 'sms', label: 'SMS', companionId, tokenRef: { kind: 'env', envName: 'A_TOKEN' } };
    expect(() => parseExternalChannelSection(section({
      adapters: [adapter, { ...adapter, tokenRef: { kind: 'env', envName: 'B_TOKEN' } }],
    }))).toThrow('declares adapter "sms" twice');
    expect(() => parseExternalChannelSection(section({ adapters: [adapter, { ...adapter, id: 'whatsapp' }] })))
      .toThrow('must not share token env "A_TOKEN"');
    expect(() => parseExternalChannelSection(section({ adapters: [{ ...adapter, companionId: 'companion-a' }] })))
      .toThrow('companionId must be a lowercase RFC-4122 UUID');
  });
});
