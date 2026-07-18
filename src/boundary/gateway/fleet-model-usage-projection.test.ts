import { describe, expect, it, vi } from 'vitest';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import { GatewayFleetModelUsageProjection } from './fleet-model-usage-projection.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_C = '33333333-3333-4333-8333-333333333333';
const SESSION_TOKEN = 'S'.repeat(43);
const NOW = new Date('2026-07-18T16:00:00.000Z');

const zeroUsage = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

describe('gateway fleet model-usage projection', () => {
  it('queries one aggregate allowlist containing only companions authorized for models.read', async () => {
    const authorizeModelRead = vi.fn(async (input: { companionId: string }) => {
      if (input.companionId === COMPANION_B) {
        throw new FleetAuthorizationDeniedError('role_action_denied');
      }
      return {
        companionId: input.companionId,
        authorization: { action: 'models.read' as const, decision: 'allow' as const },
      };
    });
    const getFleetModelUsageSummary = vi.fn(async () => ({
      resolvedRange: {
        range: 'month' as const,
        timezone: 'UTC',
        sinceMs: 1_751_328_000_000,
        untilMs: 1_753_987_200_000,
        bucket: 'day' as const,
        boundary: '[sinceMs, untilMs)' as const,
        calendarWeekStartsOn: 'monday' as const,
      },
      combined: {
        calls: 2,
        inputTokens: 90,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        totalTokens: 120,
      },
      companions: [
        {
          companionId: COMPANION_A,
          usage: {
            calls: 2,
            inputTokens: 90,
            outputTokens: 10,
            cacheReadTokens: 20,
            cacheWriteTokens: 0,
            totalTokens: 120,
          },
        },
        { companionId: COMPANION_C, usage: zeroUsage },
      ],
    }));
    const projection = new GatewayFleetModelUsageProjection({
      portalAuthorizer: {
        resolve: async () => ({
          companions: [
            { companionId: COMPANION_C, gardenLinkEligible: false },
            { companionId: COMPANION_B, gardenLinkEligible: true },
            { companionId: COMPANION_A, gardenLinkEligible: true },
          ],
        }),
      },
      modelAuthorizer: { resolveAuthorizationContext: authorizeModelRead },
      usage: { getFleetModelUsageSummary },
      now: () => NOW,
    });

    await expect(projection.resolve({
      sessionToken: SESSION_TOKEN,
      query: { range: 'month', timezone: 'UTC' },
    })).resolves.toMatchObject({
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      combined: { totalTokens: 120 },
      companions: [
        { companionId: COMPANION_A, usage: { totalTokens: 120 } },
        { companionId: COMPANION_C, usage: { totalTokens: 0 } },
      ],
    });

    expect(authorizeModelRead).toHaveBeenCalledTimes(3);
    for (const companionId of [COMPANION_A, COMPANION_B, COMPANION_C]) {
      expect(authorizeModelRead).toHaveBeenCalledWith(expect.objectContaining({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId,
        action: 'models.read',
      }));
    }
    expect(getFleetModelUsageSummary).toHaveBeenCalledWith(
      { range: 'month', timezone: 'UTC' },
      [COMPANION_A, COMPANION_C],
      NOW.getTime(),
    );
  });

  it('fails closed if an authorization adapter returns an explicit deny decision', async () => {
    const getFleetModelUsageSummary = vi.fn();
    const projection = new GatewayFleetModelUsageProjection({
      portalAuthorizer: {
        resolve: async () => ({
          companions: [{ companionId: COMPANION_A, gardenLinkEligible: true }],
        }),
      },
      modelAuthorizer: {
        resolveAuthorizationContext: async () => ({
          companionId: COMPANION_A,
          authorization: {
            action: 'models.read',
            decision: 'deny',
          },
        }),
      },
      usage: { getFleetModelUsageSummary },
      now: () => NOW,
    });

    await expect(projection.resolve({
      sessionToken: SESSION_TOKEN,
      query: { range: 'today', timezone: 'UTC' },
    })).rejects.toThrow(/authorization context changed target/u);
    expect(getFleetModelUsageSummary).not.toHaveBeenCalled();
  });

  it('fails closed if the aggregate port widens or changes the authorized companion set', async () => {
    const projection = new GatewayFleetModelUsageProjection({
      portalAuthorizer: {
        resolve: async () => ({
          companions: [{ companionId: COMPANION_A, gardenLinkEligible: true }],
        }),
      },
      modelAuthorizer: {
        resolveAuthorizationContext: async () => ({
          companionId: COMPANION_A,
          authorization: { action: 'models.read', decision: 'allow' },
        }),
      },
      usage: {
        getFleetModelUsageSummary: async () => ({
          resolvedRange: {
            range: 'today',
            timezone: 'UTC',
            sinceMs: 1,
            untilMs: 2,
            bucket: 'hour',
            boundary: '[sinceMs, untilMs)',
            calendarWeekStartsOn: 'monday',
          },
          combined: zeroUsage,
          companions: [
            { companionId: COMPANION_A, usage: zeroUsage },
            { companionId: COMPANION_B, usage: zeroUsage },
          ],
        }),
      },
      now: () => NOW,
    });

    await expect(projection.resolve({
      sessionToken: SESSION_TOKEN,
      query: { range: 'today', timezone: 'UTC' },
    })).rejects.toThrow(/authorized companion set/u);
  });
});
