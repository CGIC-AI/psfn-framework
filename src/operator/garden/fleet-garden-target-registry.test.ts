import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  deriveFleetGardenSocketTargets,
  FleetGardenTargetRegistry,
  FleetGardenTargetRegistryError,
  type FleetGardenTargetRegistryEntryInput,
} from './fleet-garden-target-registry.js';

const COMPANION_A = createCompanionId('11111111-1111-4111-8111-111111111111');
const COMPANION_B = createCompanionId('22222222-2222-4222-8222-222222222222');

function socketEntry(
  companionId: typeof COMPANION_A,
  socketPath: string,
): FleetGardenTargetRegistryEntryInput {
  return { companionId, endpoint: { mode: 'socket', socketPath, timeoutMs: 15_000 } };
}

describe('FleetGardenTargetRegistry', () => {
  it('refuses to build an empty, duplicate, or endpoint-colliding registry', () => {
    expect(() => new FleetGardenTargetRegistry([])).toThrowError(FleetGardenTargetRegistryError);
    expect(() => new FleetGardenTargetRegistry([
      socketEntry(COMPANION_A, '/run/a.sock'),
      socketEntry(COMPANION_A, '/run/b.sock'),
    ])).toThrowError(/duplicate companion/u);
    expect(() => new FleetGardenTargetRegistry([
      socketEntry(COMPANION_A, '/run/shared.sock'),
      socketEntry(COMPANION_B, '/run/./shared.sock'),
    ])).toThrowError(/colliding endpoint/u);
    expect(() => new FleetGardenTargetRegistry([
      socketEntry(createCompanionId('legacy-companion'), '/run/a.sock'),
    ])).toThrowError(/lowercase RFC-4122/u);
    expect(() => new FleetGardenTargetRegistry([
      socketEntry(COMPANION_A, '   '),
    ])).toThrowError(/socket path/u);
  });

  it('keeps routing identity immutable and derives the expected agent audience', () => {
    const registry = new FleetGardenTargetRegistry([
      socketEntry(COMPANION_A, '/run/a.sock'),
      socketEntry(COMPANION_B, '/run/b.sock'),
    ]);
    const target = registry.resolve(COMPANION_A);
    expect(target).toMatchObject({
      companionId: COMPANION_A,
      endpoint: { mode: 'socket', socketPath: '/run/a.sock' },
      expectedAgentAudience: `agent:${COMPANION_A}`,
    });
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.endpoint)).toBe(true);
    expect(() => {
      (target as { companionId: string }).companionId = COMPANION_B;
    }).toThrowError(TypeError);
    expect(registry.resolve(COMPANION_A)).toBe(target);
  });

  it('fails closed on unknown targets instead of synthesizing or falling back', () => {
    const registry = new FleetGardenTargetRegistry([socketEntry(COMPANION_A, '/run/a.sock')]);
    expect(registry.has(COMPANION_B)).toBe(false);
    expect(() => registry.resolve(COMPANION_B)).toThrowError(FleetGardenTargetRegistryError);
    expect(() => registry.healthOf(COMPANION_B)).toThrowError(FleetGardenTargetRegistryError);
    expect(() => registry.reportHealth(COMPANION_B, { status: 'unknown' }))
      .toThrowError(FleetGardenTargetRegistryError);
  });

  it('keeps mutable health separate from immutable identity', () => {
    const registry = new FleetGardenTargetRegistry([
      socketEntry(COMPANION_A, '/run/a.sock'),
      socketEntry(COMPANION_B, '/run/b.sock'),
    ]);
    expect(registry.healthOf(COMPANION_A)).toEqual({ status: 'unknown' });
    const identityBefore = registry.resolve(COMPANION_A);

    registry.reportHealth(COMPANION_A, { status: 'ready', probedAt: '2030-01-01T00:00:00.000Z' });
    registry.reportHealth(COMPANION_B, {
      status: 'unavailable',
      probedAt: '2030-01-01T00:00:00.000Z',
      reason: 'connect refused',
    });

    expect(registry.healthOf(COMPANION_A)).toEqual({
      status: 'ready',
      probedAt: '2030-01-01T00:00:00.000Z',
    });
    expect(registry.resolve(COMPANION_A)).toBe(identityBefore);
    expect(registry.readiness()).toEqual([
      { companionId: COMPANION_A, health: { status: 'ready', probedAt: '2030-01-01T00:00:00.000Z' } },
      {
        companionId: COMPANION_B,
        health: {
          status: 'unavailable',
          probedAt: '2030-01-01T00:00:00.000Z',
          reason: 'connect refused',
        },
      },
    ]);
  });

  it('derives per-companion socket endpoints from the validated companion ID alone', () => {
    const entries = deriveFleetGardenSocketTargets(
      { companions: [{ companionId: COMPANION_A }, { companionId: COMPANION_B }] },
      { ADMIN_TRANSPORT_SOCKET: '/run/psfn/garden-admin.sock' } as NodeJS.ProcessEnv,
    );
    expect(entries).toEqual([
      {
        companionId: COMPANION_A,
        endpoint: {
          mode: 'socket',
          socketPath: `/run/psfn/garden-admin-${COMPANION_A}.sock`,
          timeoutMs: 15_000,
        },
      },
      {
        companionId: COMPANION_B,
        endpoint: {
          mode: 'socket',
          socketPath: `/run/psfn/garden-admin-${COMPANION_B}.sock`,
          timeoutMs: 15_000,
        },
      },
    ]);
    expect(() => new FleetGardenTargetRegistry(entries)).not.toThrow();
  });
});
