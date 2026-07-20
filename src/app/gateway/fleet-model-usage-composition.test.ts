import { describe, expect, it, vi } from 'vitest';
import { createGatewayFleetModelUsageProjection } from './fleet-model-usage-composition.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_TOKEN = 'S'.repeat(43);

describe('gateway API fleet model-usage composition', () => {
  it('is absent outside Fleet Auth and fails Fleet Auth startup closed on partial wiring', () => {
    expect(createGatewayFleetModelUsageProjection({
      fleetAuthEnabled: false,
    })).toBeUndefined();
    expect(() => createGatewayFleetModelUsageProjection({
      fleetAuthEnabled: true,
      portalAuthorization: { resolve: async () => ({ companions: [] }) },
    })).toThrow(/complete fleet model-usage projection wiring/u);
  });

  it('composes portal roster, exact model authorization, and the fleet accounting port', async () => {
    const resolveAuthorizationContext = vi.fn(async () => ({
      companionId: COMPANION_ID,
      authorization: { action: 'models.read' as const, decision: 'allow' as const },
    }));
    const getFleetModelUsageSummary = vi.fn(async () => ({
      resolvedRange: {
        range: 'today' as const,
        timezone: 'UTC',
        sinceMs: 1_752_710_400_000,
        untilMs: 1_752_796_800_000,
        bucket: 'hour' as const,
        boundary: '[sinceMs, untilMs)' as const,
        calendarWeekStartsOn: 'monday' as const,
      },
      combined: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      companions: [{
        companionId: COMPANION_ID,
        usage: {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
      }],
    }));
    const projection = createGatewayFleetModelUsageProjection({
      fleetAuthEnabled: true,
      portalAuthorization: {
        resolve: async () => ({
          companions: [{ companionId: COMPANION_ID, gardenLinkEligible: true }],
        }),
      },
      modelAuthorization: { resolveAuthorizationContext },
      usage: { getFleetModelUsageSummary },
    });

    await expect(projection?.resolve({
      sessionToken: SESSION_TOKEN,
      query: { range: 'today', timezone: 'UTC' },
    })).resolves.toMatchObject({
      schemaVersion: 1,
      combined: { totalTokens: 0 },
      companions: [{ companionId: COMPANION_ID }],
    });
    expect(resolveAuthorizationContext).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      action: 'models.read',
    }));
    expect(getFleetModelUsageSummary).toHaveBeenCalledWith(
      { range: 'today', timezone: 'UTC' },
      [COMPANION_ID],
      expect.any(Number),
    );
  });
});
