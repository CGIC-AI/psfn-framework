import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../shared/event-bus.js';
import { logger } from '../../shared/logger.js';
import { startIcpRuntimeAvailability } from './icp-runtime-availability.js';

describe('agent ICP runtime availability wiring', () => {
  it('publishes at startup and refreshes on the existing scheduler heartbeat', async () => {
    const eventBus = new EventBus();
    const refreshRuntimeAvailability = vi.fn(async () => ({
      eligible: true,
      control: 'runtime' as const,
      mutableByCompanion: true,
    }));
    const runtime = await startIcpRuntimeAvailability({
      eventBus,
      lane: {
        gateway: {
          refreshRuntimeAvailability,
          clearRuntimeAvailability: vi.fn(),
        },
        isEnabled: () => true,
        readFatigueState: () => 'clear',
      },
      now: () => 1_000,
    });

    expect(refreshRuntimeAvailability).toHaveBeenCalledOnce();
    await eventBus.emit('schedule.healthcheck', { timestamp: 2_000, taskCount: 1 });
    expect(refreshRuntimeAvailability).toHaveBeenCalledTimes(2);

    runtime.stop();
    await eventBus.emit('schedule.healthcheck', { timestamp: 3_000, taskCount: 1 });
    expect(refreshRuntimeAvailability).toHaveBeenCalledTimes(2);
  });

  it('closes the runtime fence immediately when the companion capability is withdrawn', async () => {
    const eventBus = new EventBus();
    let enabled = true;
    const refreshRuntimeAvailability = vi.fn(async () => ({
      eligible: true,
      control: 'runtime' as const,
      mutableByCompanion: true,
    }));
    const clearRuntimeAvailability = vi.fn(async () => ({
      eligible: false,
      reasonCode: 'policy_denied' as const,
      control: 'companion' as const,
      mutableByCompanion: true,
    }));
    const runtime = await startIcpRuntimeAvailability({
      eventBus,
      lane: {
        gateway: { refreshRuntimeAvailability, clearRuntimeAvailability },
        isEnabled: () => enabled,
        readFatigueState: () => 'clear',
      },
      now: () => 1_000,
    });

    enabled = false;
    await eventBus.emitRequired('capability.tier.changed', {
      companionId: '11111111-1111-4111-8111-111111111111',
      previousTier: 'autonomous',
      currentTier: 'interactive',
      currentGrantedTokens: [],
      grantedTokens: [],
      withdrawnTokens: ['external.companion'],
      delivery: 'pending',
      timestamp: 2_000,
    });

    expect(clearRuntimeAvailability).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('propagates a failed required withdrawal fence to the capability owner', async () => {
    const eventBus = new EventBus();
    let enabled = true;
    const runtime = await startIcpRuntimeAvailability({
      eventBus,
      lane: {
        gateway: {
          refreshRuntimeAvailability: vi.fn(async () => ({
            eligible: true,
            control: 'runtime' as const,
            mutableByCompanion: true,
          })),
          clearRuntimeAvailability: vi.fn(async () => {
            throw new Error('gateway clear unavailable');
          }),
        },
        isEnabled: () => enabled,
        readFatigueState: () => 'clear',
      },
      now: () => 1_000,
    });

    enabled = false;
    await expect(eventBus.emitRequired('capability.tier.changed', {
      companionId: '11111111-1111-4111-8111-111111111111',
      previousTier: 'autonomous',
      currentTier: 'interactive',
      currentGrantedTokens: [],
      grantedTokens: [],
      withdrawnTokens: ['external.companion'],
      delivery: 'pending',
      timestamp: 2_000,
    })).rejects.toThrow('gateway clear unavailable');

    runtime.stop();
  });

  // psfn-framework-n97hp: the single-companion release shape (kube-test) —
  // `config.multiCompanion === false`, so the agent composition has no ICP lane
  // and the gateway carries no ICP autonomy broker. The consumer must still be
  // registered, because the owner capability mutation delivers the withdrawal
  // with `emitRequired`.
  describe('single-companion composition (no ICP lane)', () => {
    const withdrawal = {
      companionId: '11111111-1111-4111-8111-111111111111',
      previousTier: 'autonomous',
      currentTier: 'apprentice',
      currentGrantedTokens: [],
      grantedTokens: [],
      withdrawnTokens: ['external.companion'],
      delivery: 'pending' as const,
      timestamp: 2_000,
    };

    it('keeps a registered consumer so the required withdrawal fence resolves', async () => {
      const eventBus = new EventBus();
      const runtime = await startIcpRuntimeAvailability({ eventBus, lane: null });

      await expect(eventBus.emitRequired('capability.tier.changed', withdrawal))
        .resolves.toBeUndefined();

      runtime.stop();
    });

    it('proves it ran by recording the withdrawal it had no lane to fence', async () => {
      const eventBus = new EventBus();
      const info = vi.spyOn(logger, 'info').mockReturnValue(logger);
      const runtime = await startIcpRuntimeAvailability({ eventBus, lane: null });

      try {
        await eventBus.emitRequired('capability.tier.changed', withdrawal);
        expect(info).toHaveBeenCalledWith(
          'Capability tier changed with no ICP runtime-availability lane to fence',
          {
            previousTier: 'autonomous',
            currentTier: 'apprentice',
            externalCompanionWithdrawn: true,
          },
        );
      } finally {
        info.mockRestore();
        runtime.stop();
      }
    });

    it('is the registration that holds the required contract: stop() restores the failure', async () => {
      const eventBus = new EventBus();
      const runtime = await startIcpRuntimeAvailability({ eventBus, lane: null });
      runtime.stop();

      await expect(eventBus.emitRequired('capability.tier.changed', withdrawal))
        .rejects.toThrow('Required event "capability.tier.changed" has no registered consumers');
    });
  });
});
