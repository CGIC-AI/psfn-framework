import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '../../../channels/types.js';
import {
  createEligibilityGate,
  EligibilityDeniedError,
  type EligibilityDecision,
} from '../../../system/capabilities/eligibility.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
  registerChannelAdapter,
  startChannelAdapters,
  stopChannelAdapters,
} from './channel-lifecycle.js';

function makeAdapter(
  id: string,
  behavior: {
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
    sendText?: () => Promise<void>;
    sendTyping?: () => Promise<void>;
  } = {},
): ChannelAdapter {
  return {
    id,
    outbound: {
      textChunkLimit: 2_000,
      sendText: behavior.sendText ?? vi.fn().mockResolvedValue(undefined),
    },
    gateway: {
      start: behavior.start ?? vi.fn().mockResolvedValue(undefined),
      stop: behavior.stop ?? vi.fn().mockResolvedValue(undefined),
    },
    streaming: {
      sendTyping: behavior.sendTyping ?? vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ChannelAdapter;
}

function makeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function makeEligibilityGate(
  isAllowed: () => boolean,
  decisions: EligibilityDecision[] = [],
) {
  return createEligibilityGate(
    () => ({
      getTier: () => 'autonomous',
      getGrantedTokens: () => new Set(isAllowed() ? ['external.web'] : []),
      has: () => isAllowed(),
    }),
    (decision) => decisions.push(decision),
  );
}

describe('registerChannelAdapter', () => {
  it('registers the adapter and synchronizes the registry', () => {
    const channelRegistry = new Map<string, ChannelAdapter>();
    const adapter = makeAdapter('discord');
    const syncChannelRegistry = vi.fn();

    registerChannelAdapter(channelRegistry, adapter, syncChannelRegistry);

    expect(channelRegistry.get('discord')).toBe(adapter);
    expect(syncChannelRegistry).toHaveBeenCalledTimes(1);
    expect(syncChannelRegistry).toHaveBeenCalledWith(channelRegistry);
  });
});

describe('buildChannelAdapterFactoryManifest', () => {
  it('normalizes and validates manifest ids', () => {
    const manifest = buildChannelAdapterFactoryManifest([{
      manifest: {
        id: ' discord ',
        enabled: true,
        eligibility: {},
      },
      create: async () => makeAdapter('discord'),
    }]);

    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.manifest.id).toBe('discord');
  });

  it('rejects duplicate manifest ids', () => {
    expect(() => buildChannelAdapterFactoryManifest([
      {
        manifest: { id: 'discord', enabled: true, eligibility: {} },
        create: async () => makeAdapter('discord'),
      },
      {
        manifest: { id: 'discord', enabled: true, eligibility: {} },
        create: async () => makeAdapter('discord'),
      },
    ])).toThrow('Duplicate channel adapter manifest entry "discord"');
  });
});

describe('loadChannelAdaptersFromManifest', () => {
  it('loads enabled adapters and skips disabled manifest entries', async () => {
    const channelRegistry = new Map<string, ChannelAdapter>();
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();
    const factories = buildChannelAdapterFactoryManifest([
      {
        manifest: { id: 'discord', enabled: true, required: true, eligibility: {} },
        create: async () => makeAdapter('discord'),
      },
      {
        manifest: { id: 'telegram', enabled: false, eligibility: {} },
        create: async () => makeAdapter('telegram'),
      },
    ]);

    await loadChannelAdaptersFromManifest(channelRegistry, factories, syncChannelRegistry, log);

    expect(channelRegistry.has('discord')).toBe(true);
    expect(channelRegistry.has('telegram')).toBe(false);
    expect(syncChannelRegistry).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Skipping disabled channel adapter manifest entry',
      expect.objectContaining({ adapterId: 'telegram' }),
    );
  });

  it('throws when a required adapter fails to initialize', async () => {
    const channelRegistry = new Map<string, ChannelAdapter>();
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();
    const factories = buildChannelAdapterFactoryManifest([{
      manifest: { id: 'discord', enabled: true, required: true, eligibility: {} },
      create: async () => {
        throw new Error('init failed');
      },
    }]);

    await expect(
      loadChannelAdaptersFromManifest(channelRegistry, factories, syncChannelRegistry, log),
    ).rejects.toThrow('Required channel adapter "discord" failed to initialize');
  });

  it('throws when a required adapter is disabled in the manifest', async () => {
    const channelRegistry = new Map<string, ChannelAdapter>();
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();
    const factories = buildChannelAdapterFactoryManifest([{
      manifest: { id: 'discord', enabled: false, required: true, eligibility: {} },
      create: async () => makeAdapter('discord'),
    }]);

    await expect(
      loadChannelAdaptersFromManifest(channelRegistry, factories, syncChannelRegistry, log),
    ).rejects.toThrow('Required channel adapter "discord" is disabled in manifest');

    expect(syncChannelRegistry).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('continues when optional adapter fails and at least one loads', async () => {
    const channelRegistry = new Map<string, ChannelAdapter>();
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();
    const factories = buildChannelAdapterFactoryManifest([
      {
        manifest: { id: 'discord', enabled: true, required: true, eligibility: {} },
        create: async () => makeAdapter('discord'),
      },
      {
        manifest: { id: 'telegram', enabled: true, eligibility: {} },
        create: async () => {
          throw new Error('telegram offline');
        },
      },
    ]);

    await expect(
      loadChannelAdaptersFromManifest(channelRegistry, factories, syncChannelRegistry, log),
    ).resolves.toBeUndefined();

    expect(channelRegistry.has('discord')).toBe(true);
    expect(channelRegistry.has('telegram')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'Optional channel adapter failed to initialize',
      expect.objectContaining({ adapterId: 'telegram' }),
    );
  });

  it('fails closed when a channel manifest omits eligibility requirements', async () => {
    const channelRegistry = new Map<string, ChannelAdapter>();
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();
    const factories = buildChannelAdapterFactoryManifest([{
      manifest: { id: 'discord', enabled: true, required: true },
      create: async () => makeAdapter('discord'),
    }]);

    await expect(
      loadChannelAdaptersFromManifest(channelRegistry, factories, syncChannelRegistry, log),
    ).rejects.toThrow('Required channel adapter "discord" failed to initialize');
  });

  it('skips optional channel adapters when eligibility denies activation', async () => {
    const decisions: EligibilityDecision[] = [];
    const channelRegistry = new Map<string, ChannelAdapter>();
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();
    const factories = buildChannelAdapterFactoryManifest([
      {
        manifest: { id: 'discord', enabled: true, required: true, eligibility: {} },
        create: async () => makeAdapter('discord'),
      },
      {
        manifest: {
          id: 'plugin-channel',
          enabled: true,
          required: false,
          eligibility: { requiredTokens: ['external.web'] },
        },
        create: async () => makeAdapter('plugin-channel'),
      },
    ]);

    await loadChannelAdaptersFromManifest(
      channelRegistry,
      factories,
      syncChannelRegistry,
      log,
      makeEligibilityGate(() => false, decisions),
    );

    expect(channelRegistry.has('discord')).toBe(true);
    expect(channelRegistry.has('plugin-channel')).toBe(false);
    expect(decisions).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Skipping channel adapter denied by eligibility gate',
      expect.objectContaining({
        adapterId: 'plugin-channel',
        missingTokens: ['external.web'],
      }),
    );
  });

  it('fails required channel adapters closed when eligibility denies activation', async () => {
    const channelRegistry = new Map<string, ChannelAdapter>();
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();
    const factories = buildChannelAdapterFactoryManifest([{
      manifest: {
        id: 'plugin-channel',
        enabled: true,
        required: true,
        eligibility: { requiredTokens: ['external.web'] },
      },
      create: async () => makeAdapter('plugin-channel'),
    }]);

    await expect(
      loadChannelAdaptersFromManifest(
        channelRegistry,
        factories,
        syncChannelRegistry,
        log,
        makeEligibilityGate(() => false),
      ),
    ).rejects.toThrow('Required channel adapter "plugin-channel" denied by eligibility gate');
  });

  it('gates wrapped channel runtime actions through the eligibility gate', async () => {
    const decisions: EligibilityDecision[] = [];
    let allowed = true;
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const channelRegistry = new Map<string, ChannelAdapter>();
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();
    const factories = buildChannelAdapterFactoryManifest([{
      manifest: {
        id: 'plugin-channel',
        enabled: true,
        required: true,
        eligibility: { requiredTokens: ['external.web'] },
      },
      create: async () => makeAdapter('plugin-channel', { sendText, sendTyping }),
    }]);

    await loadChannelAdaptersFromManifest(
      channelRegistry,
      factories,
      syncChannelRegistry,
      log,
      makeEligibilityGate(() => allowed, decisions),
    );

    const adapter = channelRegistry.get('plugin-channel');
    expect(adapter).toBeDefined();

    allowed = false;
    await expect(
      adapter!.outbound.sendText({ channelId: 'plugin-channel:1' }, 'hello'),
    ).rejects.toBeInstanceOf(EligibilityDeniedError);
    await expect(
      adapter!.streaming!.sendTyping('plugin-channel:1'),
    ).rejects.toBeInstanceOf(EligibilityDeniedError);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
    expect(decisions.at(-1)?.operation.kind).toBe('plugin.action');
  });
});

describe('startChannelAdapters', () => {
  it('starts all adapters, removes failed adapters, and keeps healthy ones', async () => {
    const startHealthy = vi.fn().mockResolvedValue(undefined);
    const startFailing = vi.fn().mockRejectedValue(new Error('failed to connect'));
    const channelRegistry = new Map<string, ChannelAdapter>([
      ['healthy', makeAdapter('healthy', { start: startHealthy })],
      ['failing', makeAdapter('failing', { start: startFailing })],
    ]);
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();

    await expect(
      startChannelAdapters(channelRegistry, syncChannelRegistry, log),
    ).resolves.toBeUndefined();

    expect(startHealthy).toHaveBeenCalledTimes(1);
    expect(startFailing).toHaveBeenCalledTimes(1);
    expect(channelRegistry.has('healthy')).toBe(true);
    expect(channelRegistry.has('failing')).toBe(false);
    expect(syncChannelRegistry).toHaveBeenCalledTimes(1);
    expect(syncChannelRegistry).toHaveBeenCalledWith(channelRegistry);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('throws when no channel adapters start successfully', async () => {
    const channelRegistry = new Map<string, ChannelAdapter>([
      ['failing-a', makeAdapter('failing-a', { start: vi.fn().mockRejectedValue(new Error('down')) })],
      ['failing-b', makeAdapter('failing-b', { start: vi.fn().mockRejectedValue(new Error('down')) })],
    ]);
    const syncChannelRegistry = vi.fn();
    const log = makeLogger();

    await expect(
      startChannelAdapters(channelRegistry, syncChannelRegistry, log),
    ).rejects.toThrow('No channel adapters started successfully');

    expect(syncChannelRegistry).toHaveBeenCalledTimes(1);
    expect(channelRegistry.size).toBe(0);
  });
});

describe('stopChannelAdapters', () => {
  it('stops channel adapters in reverse registration order', async () => {
    const stoppedOrder: string[] = [];
    const channelRegistry = new Map<string, ChannelAdapter>([
      ['first', makeAdapter('first', { stop: vi.fn(async () => { stoppedOrder.push('first'); }) })],
      ['second', makeAdapter('second', { stop: vi.fn(async () => { stoppedOrder.push('second'); }) })],
      ['third', makeAdapter('third', { stop: vi.fn(async () => { stoppedOrder.push('third'); }) })],
    ]);

    await stopChannelAdapters(channelRegistry);

    expect(stoppedOrder).toEqual(['third', 'second', 'first']);
  });
});
