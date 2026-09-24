import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import {
  initGatewayChannelSurfaces,
  startGatewayChannelSurfaces,
  stopGatewayChannelSurfaces,
  type GatewayChannelSurfaces,
} from './channel-surfaces.js';
import { createChannelSurfaceHealthReporter } from './channel-surface-health.js';
import { isRetryableDiscordStartError } from './discord-startup.js';
import { ChannelSurfaceSupervisor } from '../../channels/backplane/channel-isolation.js';
import { ChannelPluginHost } from '../../channels/plugins/host.js';
import { createChannelPluginRegistry } from '../../channels/plugins/registry.js';
import type { ChannelAdapterPort } from '../../channels/backplane/types.js';
import type { ChannelPlugin } from '../../channels/plugins/types.js';
import { createStaticCredentialVault } from '../custody/credential-vault.js';
import {
  hashHealthEventSubject,
  stableHealthConditionCorrelationId,
  type HealthEvent,
} from '../../shared/contracts/health-event.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');

interface Behavior {
  init?: () => Promise<void>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
}

function fakeSurface(id: string, events: string[], behavior: Behavior = {}) {
  return {
    init: vi.fn(async () => {
      events.push(`init:${id}`);
      await behavior.init?.();
    }),
    start: vi.fn(async () => {
      events.push(`start:${id}`);
      await behavior.start?.();
    }),
    stop: vi.fn(async () => {
      events.push(`stop:${id}`);
      await behavior.stop?.();
    }),
    getBotUserId: () => undefined,
    onMessage: vi.fn(),
  };
}

function probePlugin(id: string, events: string[], behavior: Behavior = {}): ChannelPlugin {
  return {
    manifest: { id, label: id },
    parseConfig: () => ({ enabled: true, credentials: [], config: {} }),
    create: () => ({ adapter: { ...fakeSurface(id, events, behavior), id } as unknown as ChannelAdapterPort }),
  };
}

async function buildSurfaces(input: {
  events: string[];
  discord?: Behavior;
  telegram?: Behavior;
  multica?: Behavior;
  buzz?: Behavior;
}) {
  const healthEvents: HealthEvent[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const isolation = new ChannelSurfaceSupervisor({
    log,
    retry: { baseDelayMs: 50, maxDelayMs: 50, maxAttempts: 0 },
    isRetryable: isRetryableDiscordStartError,
    report: createChannelSurfaceHealthReporter({
      emit: async (_name, data) => {
        healthEvents.push(data.event);
      },
    }),
  });
  const plugins = await ChannelPluginHost.load({
    registry: createChannelPluginRegistry([
      probePlugin('multica', input.events, input.multica),
      probePlugin('buzz', input.events, input.buzz),
    ]),
    sections: {
      multica: { id: 'multica', enabled: true, credentials: [], config: {} },
      buzz: { id: 'buzz', enabled: true, credentials: [], config: {} },
    },
    vault: createStaticCredentialVault({}),
    contextFor: () => ({ log, shutdownTimeoutMs: 1_000, intakeScreening: null }),
    supervisor: isolation,
  });
  const surfaces: GatewayChannelSurfaces = {
    discord: fromAny(fakeSurface('discord', input.events, input.discord)),
    telegram: fromAny(fakeSurface('telegram', input.events, input.telegram)),
    plugins,
    isolation,
    discordSurfaces: [{ surfaceId: 'discord', companionId: COMPANION_ID }],
    telegramSurface: { surfaceId: 'telegram' },
  };
  const bootstrap = fromAny({
    channelsConfig: { telegram: { mode: 'polling', allowedUsers: [] } },
  });
  return { surfaces, bootstrap, log, isolation, healthEvents };
}

describe('gateway channel surface isolation (psfn-framework-6cs5j)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps every other channel running when Multica cannot start', async () => {
    const events: string[] = [];
    const { surfaces, bootstrap, log, isolation } = await buildSurfaces({
      events,
      multica: {
        start: async () => {
          throw new Error('invalid authority');
        },
      },
    });

    await initGatewayChannelSurfaces(surfaces);
    await expect(startGatewayChannelSurfaces(surfaces, bootstrap, log)).resolves.toBeUndefined();

    expect(surfaces.plugins.listRunning().map(entry => entry.id)).toEqual(['buzz']);
    expect(isolation.stateOf('discord')).toBe('running');
    expect(isolation.stateOf('telegram')).toBe('running');
    expect(isolation.stateOf('multica')).toBe('disabled');
    expect(log.info).toHaveBeenCalledWith('Channel plugin started', { pluginId: 'buzz' });
  });

  it('refuses a non-retryable Discord start alone and raises a per-surface incident', async () => {
    const events: string[] = [];
    const { surfaces, bootstrap, log, isolation, healthEvents } = await buildSurfaces({
      events,
      discord: {
        start: async () => {
          throw Object.assign(new Error('401 Unauthorized'), { status: 401 });
        },
      },
    });

    await initGatewayChannelSurfaces(surfaces);
    await expect(startGatewayChannelSurfaces(surfaces, bootstrap, log)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([
      'init:telegram', 'init:multica', 'init:buzz', 'init:discord',
      // Only the failed Discord surface is released; everything else starts.
      'start:discord', 'stop:discord', 'start:telegram', 'start:multica', 'start:buzz',
    ]);
    expect(isolation.stateOf('discord')).toBe('disabled');
    expect(surfaces.plugins.listRunning().map(entry => entry.id)).toEqual(['multica', 'buzz']);

    const owner = { kind: 'companion' as const, companionId: COMPANION_ID };
    const subjectHash = hashHealthEventSubject('channel:discord');
    expect(healthEvents).toEqual([expect.objectContaining({
      code: 'channel_surface_disabled',
      severity: 'critical',
      owner,
      correlationId: stableHealthConditionCorrelationId('channel_surface_disabled', owner, subjectHash),
      provenance: expect.objectContaining({ process: 'gateway', component: 'channels', subjectHash }),
      evidence: { attemptCount: 1, terminal: true },
    })]);
  });

  it('retries a network-failed Discord start in the background without blocking other channels', async () => {
    const events: string[] = [];
    let discordFailures = 1;
    const { surfaces, bootstrap, log, isolation, healthEvents } = await buildSurfaces({
      events,
      discord: {
        start: async () => {
          if (discordFailures-- > 0) {
            throw Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
          }
        },
      },
    });

    await initGatewayChannelSurfaces(surfaces);
    await startGatewayChannelSurfaces(surfaces, bootstrap, log);
    expect(isolation.stateOf('discord')).toBe('degraded');
    expect(isolation.stateOf('telegram')).toBe('running');
    expect(surfaces.plugins.listRunning().map(entry => entry.id)).toEqual(['multica', 'buzz']);

    await vi.advanceTimersByTimeAsync(50);
    expect(isolation.stateOf('discord')).toBe('running');
    expect(healthEvents.map(event => [event.code, event.severity, event.owner.kind])).toEqual([
      // System-owned so the gateway's system-owned detector cycle counts it.
      ['channel_surface_failed', 'degraded', 'system'],
    ]);
  });

  it('isolates an init failure: the channel is not started, the rest are', async () => {
    const events: string[] = [];
    const { surfaces, bootstrap, log, isolation } = await buildSurfaces({
      events,
      telegram: {
        init: async () => {
          throw new Error('telegram init exploded');
        },
      },
    });

    await expect(initGatewayChannelSurfaces(surfaces)).resolves.toBeUndefined();
    await startGatewayChannelSurfaces(surfaces, bootstrap, log);

    expect(events).not.toContain('start:telegram');
    expect(isolation.stateOf('telegram')).toBe('disabled');
    expect(isolation.stateOf('discord')).toBe('running');
    expect(surfaces.plugins.listRunning().map(entry => entry.id)).toEqual(['multica', 'buzz']);
  });

  it('stops every channel even when one channel fails to stop', async () => {
    const events: string[] = [];
    const { surfaces, bootstrap, log, healthEvents } = await buildSurfaces({
      events,
      buzz: {
        stop: async () => {
          throw new Error('buzz stop exploded');
        },
      },
      telegram: {
        stop: async () => {
          throw new Error('telegram stop exploded');
        },
      },
    });
    await initGatewayChannelSurfaces(surfaces);
    await startGatewayChannelSurfaces(surfaces, bootstrap, log);
    events.length = 0;

    await expect(stopGatewayChannelSurfaces(surfaces)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual(['stop:buzz', 'stop:multica', 'stop:telegram', 'stop:discord']);
    expect(healthEvents.map(event => event.code)).toEqual([
      'channel_surface_failed',
      'channel_surface_failed',
    ]);
    expect(log.error).toHaveBeenCalledWith(
      'Channel surface failed; other channels continue',
      expect.objectContaining({ surfaceId: 'buzz', phase: 'stop', error: 'buzz stop exploded' }),
    );
  });
});
