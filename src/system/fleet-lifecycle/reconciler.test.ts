import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanionFleetEntry, CompanionsFleetConfig } from '../config/companions-config.js';
import { FleetLifecycleError } from './contracts.js';
import { createFileFleetTopologyPort, createLocalFleetWorkloadPort } from './local-adapter.js';
import { planFleetLifecycle } from './plan.js';
import { FleetLifecyclePlanStore } from './plan-store.js';
import type { FleetLifecyclePorts, IcpLifecycleFencePort } from './ports.js';
import { applyFleetLifecyclePlan } from './reconciler.js';

const PRIMARY = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-24T12:00:00.000Z');

function entry(companionId: string, name: string): CompanionFleetEntry {
  return {
    companionId: companionId as CompanionFleetEntry['companionId'],
    companionDataDir: `companions/${name}`,
    characterCardPath: `companions/${name}/character-card.json`,
    postgresSchema: `companion_${name}`,
    postgresRole: `companion_${name}_runtime`,
    postgresDatabaseUrlRef: { kind: 'env', envName: `COMPANION_${name.toUpperCase()}_DATABASE_URL` },
    displayName: name,
  };
}

const TOPOLOGY: CompanionsFleetConfig = {
  postgres: {
    sharedMigrationRole: 'shared_schema_migration',
    sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL' },
  },
  companions: [entry(PRIMARY, 'flagship'), entry(SECOND, 'aria')],
};

class FakeFence implements IcpLifecycleFencePort {
  readonly fenced = new Set<string>();
  readonly calls: string[] = [];
  async isFenced(companionId: string) {
    return this.fenced.has(companionId);
  }
  async fence(companionId: string) {
    this.calls.push(`fence:${companionId}`);
    const transitioned = !this.fenced.has(companionId);
    this.fenced.add(companionId);
    return { transitioned };
  }
  async clear(companionId: string) {
    this.calls.push(`clear:${companionId}`);
    const transitioned = this.fenced.delete(companionId);
    return { transitioned };
  }
}

let dir: string;
let fence: FakeFence;
let store: FleetLifecyclePlanStore;
let ports: FleetLifecyclePorts;
let manifestPath: string;
let calls: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-lifecycle-'));
  manifestPath = join(dir, 'companions.json');
  writeFileSync(manifestPath, `${JSON.stringify(TOPOLOGY, null, 2)}\n`);
  fence = new FakeFence();
  store = new FleetLifecyclePlanStore(dir);
  calls = [];
  const record = (name: string) => async () => { calls.push(name); };
  ports = {
    topology: createFileFleetTopologyPort(dir),
    prerequisites: {
      verifyTenant: vi.fn(record('tenant')),
      verifySecretRefs: vi.fn(record('secrets')),
      verifyOwnerRoots: vi.fn(record('owners')),
      verifyWorkspace: vi.fn(record('workspace')),
    },
    workload: createLocalFleetWorkloadPort(),
    icpFence: fence,
    fleetAuth: {
      disabled: false,
      readCompanion: async () => ({ state: 'present', lifecycle: 'active', restoreState: 'live' }),
    },
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function plan(request: unknown) {
  const planned = await planFleetLifecycle({
    request,
    topology: ports.topology,
    icpFence: fence,
    now: () => NOW,
  });
  store.savePlan(planned);
  return planned;
}

function roster(): string[] {
  return (JSON.parse(readFileSync(manifestPath, 'utf8')) as CompanionsFleetConfig)
    .companions.map(companion => companion.companionId);
}

describe('fleet lifecycle plan/apply', () => {
  it('plans without side effects and publishes membership last on apply', async () => {
    const before = readFileSync(manifestPath);
    const planned = await plan({ operation: 'add', companion: entry(THIRD, 'nova') });
    expect(planned.stages).toEqual([
      'verify_tenant', 'verify_secret_refs', 'verify_owner_roots', 'verify_workspace',
      'verify_fleet_auth', 'verify_workload', 'publish_membership',
    ]);
    expect(readFileSync(manifestPath).equals(before)).toBe(true);
    expect(JSON.stringify(planned)).not.toMatch(/postgres(ql)?:\/\//u);

    const progress = await applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports, now: () => NOW,
    });
    expect(progress.status).toBe('applied');
    expect(calls).toEqual(['tenant', 'secrets', 'owners', 'workspace']);
    expect(roster()).toEqual([PRIMARY, SECOND, THIRD]);
    expect(progress.receipts.at(-1)).toMatchObject({ stageId: 'publish_membership', outcome: 'restart_required' });

    // Idempotent: a second apply of the completed plan changes nothing.
    const after = readFileSync(manifestPath);
    const again = await applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports, now: () => NOW,
    });
    expect(again.status).toBe('applied');
    expect(readFileSync(manifestPath).equals(after)).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('refuses an unapproved digest and a stale topology before any side effect', async () => {
    const planned = await plan({ operation: 'add', companion: entry(THIRD, 'nova') });
    await expect(applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: 'f'.repeat(64) }, store, ports,
    })).rejects.toMatchObject({ code: 'approval_mismatch' });

    const drifted = { ...TOPOLOGY, companions: [...TOPOLOGY.companions].map(c => ({ ...c, displayName: `${c.displayName}!` })) };
    writeFileSync(manifestPath, `${JSON.stringify(drifted, null, 2)}\n`);
    const before = readFileSync(manifestPath);
    await expect(applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports,
    })).rejects.toMatchObject({ code: 'stale_topology' });
    expect(calls).toEqual([]);
    expect(readFileSync(manifestPath).equals(before)).toBe(true);
  });

  it('preserves the old topology on a mid-add failure and resumes only explicitly', async () => {
    const planned = await plan({ operation: 'add', companion: entry(THIRD, 'nova') });
    const before = readFileSync(manifestPath);
    vi.mocked(ports.prerequisites.verifyOwnerRoots).mockRejectedValueOnce(
      new FleetLifecycleError('owner_roots_missing', 'card missing'),
    );
    await expect(applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports,
    })).rejects.toMatchObject({ code: 'owner_roots_missing', stageId: 'verify_owner_roots' });
    expect(readFileSync(manifestPath).equals(before)).toBe(true);
    expect(store.progress(planned.planId)).toMatchObject({
      status: 'failed',
      failure: { stageId: 'verify_owner_roots', code: 'owner_roots_missing' },
    });

    await expect(applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports,
    })).rejects.toMatchObject({ code: 'resume_required' });
    const resumed = await applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, resume: true, store, ports,
    });
    expect(resumed.status).toBe('applied');
    // Completed stages are not replayed on resume.
    expect(calls).toEqual(['tenant', 'secrets', 'owners', 'workspace']);
  });

  it('admits a never-registered fleet-auth companion and refuses a retired one', async () => {
    ports = { ...ports, fleetAuth: { disabled: false, readCompanion: async () => ({ state: 'absent' }) } };
    const fresh = await plan({ operation: 'add', companion: entry(THIRD, 'nova') });
    await expect(applyFleetLifecyclePlan({
      planId: fresh.planId, approval: { planDigest: fresh.digest }, store, ports,
    })).resolves.toMatchObject({ status: 'applied' });
  });

  it('refuses a fleet-auth companion that has not been reapproved', async () => {
    ports = { ...ports, fleetAuth: {
      disabled: false,
      readCompanion: async () => ({ state: 'present', lifecycle: 'quarantined', restoreState: 'live' }),
    } };
    const planned = await plan({ operation: 'add', companion: entry(THIRD, 'nova') });
    await expect(applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports,
    })).rejects.toMatchObject({ code: 'fleet_auth_not_admitted' });
    expect(roster()).toEqual([PRIMARY, SECOND]);
  });

  it('removes by fencing ICP first, retains data, and withdraws membership last', async () => {
    await expect(plan({ operation: 'remove', companionId: SECOND, confirmCompanionId: THIRD }))
      .rejects.toMatchObject({ code: 'confirmation_mismatch' });
    await expect(plan({ operation: 'remove', companionId: PRIMARY, confirmCompanionId: PRIMARY }))
      .rejects.toMatchObject({ code: 'primary_removal_unsupported' });
    const planned = await plan({ operation: 'remove', companionId: SECOND, confirmCompanionId: SECOND });
    expect(planned.stages).toEqual([
      'fence_icp', 'verify_fleet_auth_retired', 'drain_workload', 'withdraw_membership',
    ]);
    const before = readFileSync(manifestPath);
    await expect(applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports,
    })).rejects.toMatchObject({ code: 'fleet_auth_not_retired' });
    expect(readFileSync(manifestPath).equals(before)).toBe(true);
    ports = { ...ports, fleetAuth: {
      disabled: false,
      readCompanion: async () => ({ state: 'present', lifecycle: 'removed', restoreState: 'live' }),
    } };
    expect(planned.retention).toEqual({
      postgresSchema: 'companion_aria',
      companionDataDir: 'companions/aria',
      personalWorkspace: true,
      backups: true,
    });
    expect(JSON.stringify(planned)).not.toMatch(/purge|drop|delete/iu);
    const progress = await applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, resume: true, store, ports,
    });
    expect(progress.status).toBe('applied');
    // The fence ran once; resume did not replay it.
    expect(fence.calls).toEqual([`fence:${SECOND}`]);
    expect(roster()).toEqual([PRIMARY]);
  });

  it('requires reapproval and an explicit readmit to re-add a removed companion', async () => {
    fence.fenced.add(THIRD);
    await expect(plan({ operation: 'add', companion: entry(THIRD, 'nova') }))
      .rejects.toMatchObject({ code: 'readmission_requires_reapproval' });
    await expect(plan({ operation: 'add', companion: entry(SECOND, 'twin') }))
      .rejects.toMatchObject({ code: 'companion_exists' });
    const planned = await plan({
      operation: 'add', companion: entry(THIRD, 'nova'), readmit: { confirmCompanionId: THIRD },
    });
    expect(planned.stages.slice(-2)).toEqual(['readmit_icp', 'publish_membership']);
    await applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports,
    });
    expect(fence.calls).toEqual([`clear:${THIRD}`]);
    expect(roster()).toEqual([PRIMARY, SECOND, THIRD]);
    await applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports,
    });
    expect(fence.calls).toEqual([`clear:${THIRD}`]);
  });

  it('detects a tampered stored plan and rejects secret-valued or colliding requests', async () => {
    const planned = await plan({ operation: 'add', companion: entry(THIRD, 'nova') });
    const planPath = join(dir, 'fleet-lifecycle', 'plans', planned.planId, 'plan.json');
    const tampered = JSON.parse(readFileSync(planPath, 'utf8')) as { companionId: string };
    tampered.companionId = SECOND;
    writeFileSync(planPath, JSON.stringify(tampered));
    await expect(applyFleetLifecyclePlan({
      planId: planned.planId, approval: { planDigest: planned.digest }, store, ports,
    })).rejects.toMatchObject({ code: 'plan_integrity_failed' });

    await expect(plan({
      operation: 'add',
      companion: { ...entry(THIRD, 'nova'), postgresDatabaseUrlRef: 'postgres://user:secret@host/db' },
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(plan({ operation: 'add', companion: { ...entry(THIRD, 'nova'), postgresSchema: 'companion_aria' } }))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });
});
