import { describe, expect, it, vi } from 'vitest';
import type { HomeAssistantOperations } from '../../gateway/gateway-ops-port.js';
import { GatewayWorldOps } from './gateway-ops.js';

function createHomeAssistantOps(): HomeAssistantOperations {
  return {
    getStates: vi.fn(async () => ({ states: [], count: 0 })),
    callService: vi.fn(async () => ({ domain: 'light', service: 'turn_off', response: {} })),
  };
}

describe('GatewayWorldOps', () => {
  it('forwards getStates to the home_assistant gateway operations', async () => {
    const ha = createHomeAssistantOps();
    const ops = new GatewayWorldOps({ homeAssistant: ha });

    await ops.getStates({ entityId: 'light.living_room' });

    expect(ha.getStates).toHaveBeenCalledWith({ entityId: 'light.living_room' });
  });

  it('forwards callService to the home_assistant gateway operations', async () => {
    const ha = createHomeAssistantOps();
    const ops = new GatewayWorldOps({ homeAssistant: ha });

    await ops.callService({ domain: 'light', service: 'turn_off', entityId: 'light.living_room' });

    expect(ha.callService).toHaveBeenCalledWith({
      domain: 'light',
      service: 'turn_off',
      entityId: 'light.living_room',
    });
  });

  it('accepts a bare HomeAssistantOperations instance', async () => {
    const ha = createHomeAssistantOps();
    const ops = new GatewayWorldOps(ha);

    await ops.getStates();

    expect(ha.getStates).toHaveBeenCalledWith({});
  });
});
