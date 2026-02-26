import { describe, expect, it, vi } from 'vitest';
import { ConfirmationQueue } from '../../capabilities/confirmation-queue.js';
import type { ModuleRecord } from '../../modules/types.js';
import { createModuleCapabilities } from './modules.js';

function registryHarness(initial = '[]') {
  let stored = initial;
  return {
    caps: {
      fsRead: vi.fn(async () => stored),
      fsWrite: vi.fn(async (_path: string, content: string) => {
        stored = content;
      }),
    },
    getRecords: (): ModuleRecord[] => JSON.parse(stored) as ModuleRecord[],
  };
}

describe('createModuleCapabilities', () => {
  it('denies module_install in nursery tier', async () => {
    const harness = registryHarness();
    const modules = createModuleCapabilities({
      gatewayCaps: harness.caps,
      pushEvidence: vi.fn(),
      getCapabilityTier: () => 'nursery',
    });

    const result = await modules.module_install('planner', 'export default {};', true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nursery tier');
    expect(harness.caps.fsWrite).not.toHaveBeenCalled();
  });

  it('queues module_install in apprentice tier until approval', async () => {
    const harness = registryHarness();
    const queue = new ConfirmationQueue({
      idFactory: () => 'confirm-module-install',
    });
    const onModuleRegistryMutation = vi.fn();
    const modules = createModuleCapabilities({
      gatewayCaps: harness.caps,
      pushEvidence: vi.fn(),
      getCapabilityTier: () => 'apprentice',
      confirmationQueue: queue,
      onModuleRegistryMutation,
    });

    const queued = await modules.module_install('planner', 'export default {};', true);
    expect(queued).toMatchObject({
      ok: true,
      queued: true,
      confirmationId: 'confirm-module-install',
    });
    expect(harness.caps.fsWrite).not.toHaveBeenCalled();
    expect(queue.listPending()).toHaveLength(1);

    const resolved = await queue.resolve({
      id: 'confirm-module-install',
      decision: 'approve',
    });
    expect(resolved.executed).toBe(true);
    expect(harness.caps.fsWrite).toHaveBeenCalledTimes(1);
    expect(harness.getRecords()).toHaveLength(1);
    expect(harness.getRecords()[0].name).toBe('planner');
    expect(onModuleRegistryMutation).toHaveBeenCalledTimes(1);
  });

  it('installs immediately in autonomous tier and emits registry mutation', async () => {
    const harness = registryHarness();
    const onModuleRegistryMutation = vi.fn();
    const modules = createModuleCapabilities({
      gatewayCaps: harness.caps,
      pushEvidence: vi.fn(),
      getCapabilityTier: () => 'autonomous',
      onModuleRegistryMutation,
    });

    const result = await modules.module_install('planner', 'export default {};', true);
    expect(result.ok).toBe(true);
    expect(result.queued).toBeUndefined();
    expect(harness.caps.fsWrite).toHaveBeenCalledTimes(1);
    expect(harness.getRecords()).toHaveLength(1);
    expect(onModuleRegistryMutation).toHaveBeenCalledTimes(1);
  });
});
