import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { loadGatewayOperatorAlerting } from './operator-alerting.js';

afterEach(() => vi.unstubAllEnvs());

describe('gateway-owned operator alert configuration', () => {
  it('uses configured gateway sinks when the agent has no notification credentials', async () => {
    vi.stubEnv('NTFY_BASE_URL', '');
    vi.stubEnv('NTFY_TOPIC', '');
    const operatorAlerting = {
      configuredSinks: ['ntfy' as const],
      status: 'configured' as const,
      warning: null,
    };
    const gateway = {
      runtimeHealth: vi.fn(async () => ({ checkedAt: 1, services: [], operatorAlerting })),
    };
    await expect(loadGatewayOperatorAlerting(gateway)).resolves.toEqual(operatorAlerting);
    expect(gateway.runtimeHealth).toHaveBeenCalledOnce();
  });

  it('preserves genuinely unconfigured gateway status even if agent-local env claims a sink', async () => {
    vi.stubEnv('NTFY_BASE_URL', 'https://alerts.example.test');
    vi.stubEnv('NTFY_TOPIC', 'local-only');
    const operatorAlerting = {
      configuredSinks: [],
      status: 'unconfigured' as const,
      warning: 'Operator alerting has zero configured sinks; alerts cannot leave the runtime.',
    };
    await expect(loadGatewayOperatorAlerting({
      runtimeHealth: async () => ({ checkedAt: 1, services: [], operatorAlerting }),
    })).resolves.toEqual(operatorAlerting);
  });

  it('rejects missing authoritative configuration instead of fabricating sink status', async () => {
    await expect(loadGatewayOperatorAlerting({
      runtimeHealth: async () => fromAny({ checkedAt: 1, services: [] }),
    })).rejects.toThrow('Gateway runtime.health did not provide its operator alert sink configuration');
  });

  it('propagates a failed gateway read', async () => {
    await expect(loadGatewayOperatorAlerting({
      runtimeHealth: async () => { throw new Error('gateway unavailable'); },
    })).rejects.toThrow('gateway unavailable');
  });
});
