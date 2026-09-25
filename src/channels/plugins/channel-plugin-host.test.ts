import { describe, expect, it, vi } from 'vitest';
import { createStaticCredentialVault, envCredential } from '../../boundary/custody/credential-vault.js';
import type { ChannelAdapterPort, MessageHandler } from '../backplane/types.js';
import { ChannelPluginHost } from './host.js';
import { createChannelPluginRegistry } from './registry.js';
import type {
  ChannelPlugin,
  ChannelPluginInstance,
  ChannelPluginCreateInput,
  ChannelPluginHostContext,
  ChannelPluginParseResult,
} from './types.js';
import { parseChannelPluginSections } from './load-sections.js';
import {
  ChannelSurfaceSupervisor,
  type ChannelSurfaceFailure,
} from '../backplane/channel-isolation.js';

function makeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function makeSupervisor(isRetryable: (error: Error) => boolean = () => false) {
  const failures: ChannelSurfaceFailure[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const supervisor = new ChannelSurfaceSupervisor({
    log,
    retry: { baseDelayMs: 10, maxDelayMs: 40, maxAttempts: 0 },
    isRetryable,
    report: (failure) => {
      failures.push(failure);
    },
  });
  return { supervisor, failures, log };
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
  it('wires each plugin account with its host-derived gateway route', async () => {
    const firstCompanionId = '11111111-1111-4111-8111-111111111111';
    const secondCompanionId = '22222222-2222-4222-8222-222222222222';
    const handlers: MessageHandler[] = [];
    const plugin: ChannelPlugin = {
      manifest: { id: 'probe', label: 'Probe' },
      parseConfig: () => ({
        enabled: true,
        credentials: [],
        config: {},
        instances: [firstCompanionId, secondCompanionId].map(companionId => ({
          id: companionId,
          companionId,
          credentials: [],
          config: {},
        })),
      }),
      create: () => ({
        adapter: makeAdapter('probe', {
          onMessage: handler => handlers.push(handler),
        }),
      }),
    };
    const registry = createChannelPluginRegistry([plugin]);
    const host = await ChannelPluginHost.load({
      registry,
      sections: parseChannelPluginSections({ probe: { enabled: true } }, registry),
      vault: createStaticCredentialVault({}),
      contextFor: () => makeContext(),
      supervisor: makeSupervisor().supervisor,
    });
    const requestAgentVoiceStream = vi.fn(async () => ({
      content: 'ok',
      channelId: 'probe:room',
      model: 'test',
      durationMs: 1,
    }));
    host.wireMessages({
      requestAgentVoiceStream,
      notifyOperator: vi.fn(async () => undefined),
    });

    const message = {
      id: 'event-1',
      channelId: 'probe:room',
      channelType: 'api' as const,
      authorId: 'author',
      authorName: 'Author',
      content: 'hello',
      timestamp: new Date(0),
    };
    await handlers[0]!(message);
    await handlers[1]!(message);

    expect(requestAgentVoiceStream).toHaveBeenNthCalledWith(1, message, {
      channelAccountRoute: { pluginId: 'probe', accountId: firstCompanionId },
    });
    expect(requestAgentVoiceStream).toHaveBeenNthCalledWith(2, message, {
      channelAccountRoute: { pluginId: 'probe', accountId: secondCompanionId },
    });
  });

  it('instantiates one isolated lifecycle entry per declared plugin account', async () => {
    const firstCompanionId = '11111111-1111-4111-8111-111111111111';
    const secondCompanionId = '22222222-2222-4222-8222-222222222222';
    const seen: Array<{ name: unknown; token: string | undefined; companionId: string | undefined }> = [];
    const lifecycle: string[] = [];
    const plugin: ChannelPlugin<{ name?: string }> = {
      manifest: { id: 'probe', label: 'Probe' },
      parseConfig: () => ({
        enabled: true,
        credentials: [],
        config: {},
        instances: [
          {
            id: firstCompanionId,
            companionId: firstCompanionId,
            credentials: [{
              id: 'token',
              reference: envCredential('ALPHA_TOKEN'),
              description: 'Alpha token',
            }],
            config: { name: 'alpha' },
          },
          {
            id: secondCompanionId,
            companionId: secondCompanionId,
            credentials: [{
              id: 'token',
              reference: envCredential('BETA_TOKEN'),
              description: 'Beta token',
            }],
            config: { name: 'beta' },
          },
        ],
      }),
      create(input) {
        seen.push({
          name: input.config.name,
          token: input.secrets.token,
          companionId: input.context.intakeScreening === null
            ? undefined
            : 'unexpected',
        });
        const accountName = String(input.config.name);
        return {
          adapter: makeAdapter('probe', {
            init: async () => {
              lifecycle.push(`init:${accountName}`);
            },
            start: async () => {
              lifecycle.push(`start:${accountName}`);
            },
            stop: async () => {
              lifecycle.push(`stop:${accountName}`);
            },
          }),
        };
      },
    };
    const registry = createChannelPluginRegistry([plugin]);
    const sections = parseChannelPluginSections({ probe: { enabled: true } }, registry);
    const contextCompanions: Array<string | undefined> = [];
    const host = await ChannelPluginHost.load({
      registry,
      sections,
      vault: createStaticCredentialVault({
        ALPHA_TOKEN: 'alpha-secret',
        BETA_TOKEN: 'beta-secret',
      }),
      supervisor: makeSupervisor().supervisor,
      contextFor: (_pluginId, section) => {
        contextCompanions.push(section.companionId);
        return makeContext();
      },
    });

    expect(host.list().map(entry => entry.id)).toEqual([
      `probe:${firstCompanionId}`,
      `probe:${secondCompanionId}`,
    ]);
    expect(seen.map(entry => ({ name: entry.name, token: entry.token }))).toEqual([
      { name: 'alpha', token: 'alpha-secret' },
      { name: 'beta', token: 'beta-secret' },
    ]);
    expect(contextCompanions).toEqual([firstCompanionId, secondCompanionId]);

    await host.initialize();
    await host.start();
    await host.stop();
    expect(lifecycle).toEqual([
      'init:alpha',
      'init:beta',
      'start:alpha',
      'start:beta',
      'stop:beta',
      'stop:alpha',
    ]);
  });

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
      supervisor: makeSupervisor().supervisor,
    });
    expect(seen.alpha).toEqual({ token: 'alpha-secret' });
    expect(seen.beta).toEqual({ token: 'beta-secret' });
    expect(Object.keys(seen.alpha)).toEqual(['token']);
  });

  it('disables only the plugin whose credential is missing, without constructing it', async () => {
    const created = vi.fn();
    const plugin = createProbePlugin({ onCreate: created });
    const sibling: ChannelPlugin = {
      manifest: { id: 'sibling', label: 'Sibling' },
      parseConfig: () => ({ enabled: true, credentials: [], config: {} }),
      create: () => ({ adapter: makeAdapter('sibling') }),
    };
    const registry = createChannelPluginRegistry([plugin, sibling]);
    const sections = parseChannelPluginSections(
      { probe: { enabled: true }, sibling: { enabled: true } },
      registry,
    );
    const { supervisor, failures } = makeSupervisor();
    const host = await ChannelPluginHost.load({
      registry,
      sections,
      vault: createStaticCredentialVault({}),
      contextFor: () => makeContext(),
      supervisor,
    });
    expect(created).not.toHaveBeenCalled();
    expect(host.list().map(entry => entry.id)).toEqual(['sibling']);
    expect(supervisor.stateOf('probe')).toBe('disabled');
    expect(failures).toEqual([expect.objectContaining({
      surfaceId: 'probe',
      phase: 'load',
      terminal: true,
      error: expect.objectContaining({ message: expect.stringContaining('Probe token is not configured') }),
    })]);
    await host.initialize();
    await host.start();
    expect(host.listRunning().map(entry => entry.id)).toEqual(['sibling']);
  });

  it('isolates a start failure: earlier and later plugins keep running', async () => {
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
    const third: ChannelPlugin = {
      manifest: { id: 'third', label: 'Third' },
      parseConfig: () => ({ enabled: true, credentials: [], config: {} }),
      create: () => ({
        adapter: makeAdapter('third', {
          start: async () => {
            events.push('start:third');
          },
          stop: async () => {
            events.push('stop:third');
          },
        }),
      }),
    };
    const { supervisor, failures } = makeSupervisor();
    const host = await ChannelPluginHost.load({
      registry: createChannelPluginRegistry([first, second, third]),
      sections: {
        first: { id: 'first', enabled: true, credentials: [], config: {} },
        second: { id: 'second', enabled: true, credentials: [], config: {} },
        third: { id: 'third', enabled: true, credentials: [], config: {} },
      },
      vault: createStaticCredentialVault({}),
      contextFor: () => makeContext(),
      supervisor,
    });
    await expect(host.start()).resolves.toBeUndefined();
    // Only the failing plugin is released; the third still starts.
    expect(events).toEqual(['start:first', 'start:second', 'stop:second', 'start:third']);
    expect(host.listRunning().map(entry => entry.id)).toEqual(['first', 'third']);
    expect(supervisor.stateOf('second')).toBe('disabled');
    expect(failures).toEqual([expect.objectContaining({
      surfaceId: 'second',
      phase: 'start',
      terminal: true,
    })]);

    await host.stop();
    // Stop runs in reverse and never re-stops the already-released plugin.
    expect(events.slice(4)).toEqual(['stop:third', 'stop:first']);
  });

  it('keeps earlier accounts running when a later account of the same plugin fails', async () => {
    const firstCompanionId = '11111111-1111-4111-8111-111111111111';
    const secondCompanionId = '22222222-2222-4222-8222-222222222222';
    const events: string[] = [];
    const plugin: ChannelPlugin<{ account: string }> = {
      manifest: { id: 'probe', label: 'Probe' },
      parseConfig: () => ({
        enabled: true,
        credentials: [],
        config: { account: 'unused' },
        instances: [firstCompanionId, secondCompanionId].map(companionId => ({
          id: companionId,
          companionId,
          credentials: [],
          config: { account: companionId },
        })),
      }),
      create({ config }) {
        return {
          adapter: makeAdapter('probe', {
            start: async () => {
              events.push(`start:${config.account}`);
              if (config.account === secondCompanionId) throw new Error('second account exploded');
            },
            stop: async () => {
              events.push(`stop:${config.account}`);
            },
          }),
        };
      },
    };
    const registry = createChannelPluginRegistry([plugin]);
    const { supervisor, failures } = makeSupervisor();
    const host = await ChannelPluginHost.load({
      registry,
      sections: parseChannelPluginSections({ probe: { enabled: true } }, registry),
      vault: createStaticCredentialVault({}),
      contextFor: () => makeContext(),
      supervisor,
    });

    await expect(host.start()).resolves.toBeUndefined();
    expect(events).toEqual([
      `start:${firstCompanionId}`,
      `start:${secondCompanionId}`,
      `stop:${secondCompanionId}`,
    ]);
    expect(host.listRunning().map(entry => entry.id)).toEqual([`probe:${firstCompanionId}`]);
    expect(failures).toEqual([expect.objectContaining({
      surfaceId: `probe:${secondCompanionId}`,
      companionId: secondCompanionId,
      phase: 'start',
    })]);
  });

  it('isolates init, wiring, and stop failures to the failing plugin', async () => {
    const events: string[] = [];
    const plugin = (id: string, behavior: Parameters<typeof makeAdapter>[1] = {}): ChannelPlugin => ({
      manifest: { id, label: id },
      parseConfig: () => ({ enabled: true, credentials: [], config: {} }),
      create: () => ({
        adapter: makeAdapter(id, {
          start: async () => {
            events.push(`start:${id}`);
          },
          stop: async () => {
            events.push(`stop:${id}`);
          },
          ...behavior,
        }),
      }),
    });
    const noHook = plugin('nohook');
    const noHookCreate = noHook.create;
    noHook.create = (input) => {
      const instance = noHookCreate(input) as ChannelPluginInstance;
      return { adapter: { ...instance.adapter, onMessage: undefined } as unknown as ChannelAdapterPort };
    };
    const registry = createChannelPluginRegistry([
      plugin('badinit', { init: async () => { throw new Error('init exploded'); } }),
      noHook,
      plugin('badstop', {
        stop: async () => {
          events.push('stop:badstop');
          throw new Error('stop exploded');
        },
      }),
      plugin('healthy'),
    ]);
    const { supervisor, failures } = makeSupervisor();
    const host = await ChannelPluginHost.load({
      registry,
      sections: Object.fromEntries(['badinit', 'nohook', 'badstop', 'healthy'].map(id => [
        id,
        { id, enabled: true, credentials: [], config: {} },
      ])),
      vault: createStaticCredentialVault({}),
      contextFor: () => makeContext(),
      supervisor,
    });
    host.wireMessages({
      requestAgentVoiceStream: vi.fn(),
      notifyOperator: vi.fn(),
    });
    await host.initialize();
    await host.start();

    expect(events).toEqual(['start:badstop', 'start:healthy']);
    expect(host.listRunning().map(entry => entry.id)).toEqual(['badstop', 'healthy']);
    expect(supervisor.stateOf('badinit')).toBe('disabled');
    expect(supervisor.stateOf('nohook')).toBe('disabled');

    await expect(host.stop()).resolves.toBeUndefined();
    // Reverse order; badstop's failure does not stop badinit (registered
    // before it) from releasing its partial init. The never-initialized
    // nohook plugin has nothing to release.
    expect(events.slice(2)).toEqual(['stop:healthy', 'stop:badstop', 'stop:badinit']);
    expect(failures.map(failure => [failure.surfaceId, failure.phase, failure.terminal])).toEqual([
      ['nohook', 'load', true],
      ['badinit', 'init', true],
      ['badstop', 'stop', false],
    ]);
  });

  it('records a runtime handler failure against that plugin alone and rethrows it', async () => {
    const handlers = new Map<string, MessageHandler>();
    const plugin = (id: string): ChannelPlugin => ({
      manifest: { id, label: id },
      parseConfig: () => ({ enabled: true, credentials: [], config: {} }),
      create: () => ({
        adapter: makeAdapter(id, {
          onMessage: (handler) => {
            handlers.set(id, handler);
          },
        }),
      }),
    });
    const { supervisor, failures } = makeSupervisor();
    const host = await ChannelPluginHost.load({
      registry: createChannelPluginRegistry([plugin('alpha'), plugin('beta')]),
      sections: {
        alpha: { id: 'alpha', enabled: true, credentials: [], config: {} },
        beta: { id: 'beta', enabled: true, credentials: [], config: {} },
      },
      vault: createStaticCredentialVault({}),
      contextFor: () => makeContext(),
      supervisor,
    });
    const requestAgentVoiceStream = vi.fn()
      .mockRejectedValueOnce(new Error('alpha handler exploded'))
      .mockResolvedValue({ content: 'ok', channelId: 'beta-channel', model: 'm', durationMs: 1 });
    host.wireMessages({ requestAgentVoiceStream, notifyOperator: vi.fn() });
    await host.initialize();
    await host.start();

    const message = { channelId: 'c', content: 'hi' } as unknown as Parameters<MessageHandler>[0];
    await expect(handlers.get('alpha')!(message)).rejects.toThrow('alpha handler exploded');
    await expect(handlers.get('beta')!(message)).resolves.toMatchObject({ content: 'ok' });

    expect(failures).toEqual([expect.objectContaining({
      surfaceId: 'alpha',
      phase: 'runtime',
      terminal: false,
    })]);
    expect(host.listRunning().map(entry => entry.id)).toEqual(['alpha', 'beta']);
  });

});
