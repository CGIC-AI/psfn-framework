import { describe, expect, it, vi } from 'vitest';
import { createStaticCredentialVault, envCredential } from '../../boundary/custody/credential-vault.js';
import type { ChannelAdapterPort } from '../backplane/types.js';
import { ChannelPluginHost } from './host.js';
import { createChannelPluginRegistry } from './registry.js';
import type {
  ChannelPlugin,
  ChannelPluginCreateInput,
  ChannelPluginHostContext,
  ChannelPluginLoadedSection,
  ChannelPluginParseResult,
} from './types.js';
import { parseChannelPluginSections } from './load-sections.js';
import { createMulticaChannelPlugin } from '../multica/plugin.js';

function makeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function makeContext(): ChannelPluginHostContext {
  return {
    log: makeLogger(),
    shutdownTimeoutMs: 1_000,
    intakeScreening: null,
  };
}

function makeAdapter(
  id: string,
  behavior: {
    init?: () => Promise<void>;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
    onMessage?: ChannelAdapterPort['onMessage'];
  } = {},
): ChannelAdapterPort {
  return {
    id,
    name: id,
    meta: { label: id },
    capabilities: {
      chatTypes: ['channel'],
      media: false,
      reactions: false,
      threads: false,
      streaming: false,
    },
    config: { enabled: true },
    outbound: {
      textChunkLimit: 2_000,
      sendText: vi.fn().mockResolvedValue(undefined),
    },
    gateway: {
      start: behavior.start ?? (async () => undefined),
      stop: behavior.stop ?? (async () => undefined),
    },
    init: behavior.init ?? (async () => undefined),
    start: behavior.start ?? (async () => undefined),
    stop: behavior.stop ?? (async () => undefined),
    onMessage: behavior.onMessage ?? ((handler) => {
      void handler;
    }),
  };
}

function createProbePlugin(options: {
  onCreate?: (input: ChannelPluginCreateInput<{ token?: string }>) => void;
  init?: () => Promise<void>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
} = {}): ChannelPlugin<{ token?: string }> {
  return {
    manifest: { id: 'probe', label: 'Probe' },
    parseConfig(raw: unknown): ChannelPluginParseResult<{ token?: string }> {
      const record = raw as Record<string, unknown>;
      const enabled = record.enabled === true;
      const tokenRef = envCredential('PROBE_TOKEN');
      return {
        enabled,
        credentials: enabled
          ? [{ id: 'token', reference: tokenRef, description: 'Probe token' }]
          : [],
        config: {},
      };
    },
    create(input) {
      options.onCreate?.(input);
      return {
        adapter: makeAdapter('probe', {
          init: options.init,
          start: options.start,
          stop: options.stop,
        }),
      };
    },
  };
}

describe('createChannelPluginRegistry', () => {
  it('rejects duplicate plugin ids', () => {
    const plugin = createProbePlugin();
    expect(() => createChannelPluginRegistry([plugin, plugin])).toThrow(
      'Duplicate channel plugin registration "probe"',
    );
  });
});

describe('parseChannelPluginSections', () => {
  it('rejects unknown plugin ids', () => {
    expect(() => parseChannelPluginSections(
      { slack: { enabled: true } },
      createChannelPluginRegistry([createProbePlugin()]),
    )).toThrow('Unknown channel plugin "slack"');
  });

  it('leaves first-class channel keys to the core parser', () => {
    const loaded = parseChannelPluginSections(
      { discord: { heartbeatChannelId: '1' }, probe: { enabled: false } },
      createChannelPluginRegistry([createProbePlugin()]),
    );
    expect(loaded.discord).toBeUndefined();
    expect(loaded.probe?.enabled).toBe(false);
  });
});

describe('ChannelPluginHost', () => {
  it('resolves only declared credentials and never shares them across plugins', async () => {
    const seen: Record<string, Readonly<Record<string, string>>> = {};
    const alpha: ChannelPlugin = {
      manifest: { id: 'alpha', label: 'Alpha' },
      parseConfig: () => ({
        enabled: true,
        credentials: [{
          id: 'token',
          reference: envCredential('ALPHA_TOKEN'),
          description: 'Alpha token',
        }],
        config: {},
      }),
      create(input) {
        seen.alpha = input.secrets;
        return { adapter: makeAdapter('alpha') };
      },
    };
    const beta: ChannelPlugin = {
      manifest: { id: 'beta', label: 'Beta' },
      parseConfig: () => ({
        enabled: true,
        credentials: [{
          id: 'token',
          reference: envCredential('BETA_TOKEN'),
          description: 'Beta token',
        }],
        config: {},
      }),
      create(input) {
        seen.beta = input.secrets;
        return { adapter: makeAdapter('beta') };
      },
    };
    const registry = createChannelPluginRegistry([alpha, beta]);
    const sections = parseChannelPluginSections(
      { alpha: { enabled: true }, beta: { enabled: true } },
      registry,
    );
    await ChannelPluginHost.load({
      registry,
      sections,
      vault: createStaticCredentialVault({
        ALPHA_TOKEN: 'alpha-secret',
        BETA_TOKEN: 'beta-secret',
      }),
      contextFor: () => makeContext(),
    });
    expect(seen.alpha).toEqual({ token: 'alpha-secret' });
    expect(seen.beta).toEqual({ token: 'beta-secret' });
    expect(Object.keys(seen.alpha)).toEqual(['token']);
  });

  it('rejects missing credentials without constructing the plugin', async () => {
    const created = vi.fn();
    const plugin = createProbePlugin({ onCreate: created });
    const registry = createChannelPluginRegistry([plugin]);
    const sections = parseChannelPluginSections({ probe: { enabled: true } }, registry);
    await expect(ChannelPluginHost.load({
      registry,
      sections,
      vault: createStaticCredentialVault({}),
      contextFor: () => makeContext(),
    })).rejects.toThrow('Probe token is not configured');
    expect(created).not.toHaveBeenCalled();
  });

  it('starts plugins in registration order and stops them in reverse after a later failure', async () => {
    const events: string[] = [];
    const first: ChannelPlugin = {
      manifest: { id: 'first', label: 'First' },
      parseConfig: () => ({ enabled: true, credentials: [], config: {} }),
      create: () => ({
        adapter: makeAdapter('first', {
          start: async () => {
            events.push('start:first');
          },
          stop: async () => {
            events.push('stop:first');
          },
        }),
      }),
    };
    const second: ChannelPlugin = {
      manifest: { id: 'second', label: 'Second' },
      parseConfig: () => ({ enabled: true, credentials: [], config: {} }),
      create: () => ({
        adapter: makeAdapter('second', {
          start: async () => {
            events.push('start:second');
            throw new Error('second exploded');
          },
          stop: async () => {
            events.push('stop:second');
          },
        }),
      }),
    };
    const host = await ChannelPluginHost.load({
      registry: createChannelPluginRegistry([first, second]),
      sections: {
        first: { id: 'first', enabled: true, credentials: [], config: {} },
        second: { id: 'second', enabled: true, credentials: [], config: {} },
      },
      vault: createStaticCredentialVault({}),
      contextFor: () => makeContext(),
    });
    await expect(host.start()).rejects.toThrow('Channel plugin "second" failed to start');
    expect(events).toEqual(['start:first', 'start:second', 'stop:second', 'stop:first']);
  });

  it('loads Multica through the same host as a probe plugin', async () => {
    const created: string[] = [];
    const probe = createProbePlugin({
      onCreate: () => {
        created.push('probe');
      },
    });
    const registry = createChannelPluginRegistry([
      createMulticaChannelPlugin({
        runtimeLease: {
          tryAcquire: async () => null,
          acquire: async () => {
            throw new Error('unused');
          },
        },
      }),
      probe,
    ]);
    const sections: Record<string, ChannelPluginLoadedSection> = {
      ...parseChannelPluginSections({
        probe: { enabled: true },
        multica: {
          enabled: true,
          baseUrl: 'http://127.0.0.1:8080',
          workspaceId: '11111111-1111-4111-8111-111111111111',
          companionId: '22222222-2222-4222-8222-222222222222',
          tokenRef: { kind: 'env', envName: 'MULTICA_GATEWAY_TOKEN' },
          pollIntervalMs: 1000,
        },
      }, registry),
    };
    const host = await ChannelPluginHost.load({
      registry,
      sections,
      vault: createStaticCredentialVault({
        MULTICA_GATEWAY_TOKEN: 'owner-token',
        PROBE_TOKEN: 'probe-token',
      }),
      contextFor: () => makeContext(),
    });
    expect(host.list().map(entry => entry.id)).toEqual(['multica', 'probe']);
    expect(created).toEqual(['probe']);
    expect(host.get('multica')?.adapter.id).toBe('multica');
  });
});
