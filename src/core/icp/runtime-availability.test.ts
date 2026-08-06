import { describe, expect, it, vi } from 'vitest';

import { MAX_ICP_AVAILABILITY_LEASE_TTL_MS } from '../../shared/contracts/icp-autonomy.js';
import { createIcpRuntimeAvailabilityController } from './runtime-availability.js';

const NOW = Date.parse('2027-01-15T12:00:00.000Z');

describe('ICP runtime availability controller', () => {
  it('publishes healthy enabled availability at startup with the bounded protocol lease', async () => {
    const refreshRuntimeAvailability = vi.fn(async () => ({
      eligible: true,
      control: 'runtime' as const,
      mutableByCompanion: true,
      lease: {
        companionId: '11111111-1111-4111-8111-111111111111',
        state: 'available' as const,
        issuedAtMs: NOW,
        expiresAtMs: NOW + MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
        source: 'runtime' as const,
        revision: 1,
      },
    }));
    const clearRuntimeAvailability = vi.fn();
    const controller = createIcpRuntimeAvailabilityController({
      gateway: { refreshRuntimeAvailability, clearRuntimeAvailability },
      isEnabled: () => true,
      readFatigueState: () => 'clear',
      now: () => NOW,
    });

    await controller.refresh();

    expect(refreshRuntimeAvailability).toHaveBeenCalledOnce();
    expect(refreshRuntimeAvailability).toHaveBeenCalledWith({
      state: 'available',
      expiresAtMs: NOW + MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
    });
    expect(clearRuntimeAvailability).not.toHaveBeenCalled();
  });

  it('publishes resting instead of available at maximum fatigue', async () => {
    const refreshRuntimeAvailability = vi.fn(async () => ({
      eligible: false,
      reasonCode: 'peer_resting' as const,
      control: 'runtime' as const,
      mutableByCompanion: true,
    }));
    const controller = createIcpRuntimeAvailabilityController({
      gateway: {
        refreshRuntimeAvailability,
        clearRuntimeAvailability: vi.fn(),
      },
      isEnabled: () => true,
      readFatigueState: () => 'exhausted',
      now: () => NOW,
    });

    await controller.refresh();

    expect(refreshRuntimeAvailability).toHaveBeenCalledWith({
      state: 'resting',
      expiresAtMs: NOW + MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
    });
  });

  it('clears only the runtime default when ICP is turned off', async () => {
    const clearRuntimeAvailability = vi.fn(async () => ({
      eligible: false,
      reasonCode: 'availability_missing' as const,
      control: 'missing' as const,
      mutableByCompanion: true,
    }));
    const refreshRuntimeAvailability = vi.fn();
    const controller = createIcpRuntimeAvailabilityController({
      gateway: { refreshRuntimeAvailability, clearRuntimeAvailability },
      isEnabled: () => false,
      readFatigueState: () => 'clear',
      now: () => NOW,
    });

    await controller.refresh();

    expect(clearRuntimeAvailability).toHaveBeenCalledOnce();
    expect(refreshRuntimeAvailability).not.toHaveBeenCalled();
  });
});
