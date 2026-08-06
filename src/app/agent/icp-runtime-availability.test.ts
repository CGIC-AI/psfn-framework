import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../shared/event-bus.js';
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
      gateway: {
        refreshRuntimeAvailability,
        clearRuntimeAvailability: vi.fn(),
      },
      isEnabled: () => true,
      readFatigueState: () => 'clear',
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
      gateway: { refreshRuntimeAvailability, clearRuntimeAvailability },
      isEnabled: () => enabled,
      readFatigueState: () => 'clear',
      now: () => 1_000,
    });

    enabled = false;
    await eventBus.emit('capability.tier.changed', {
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
});
