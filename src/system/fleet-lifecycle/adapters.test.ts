import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CompanionFleetEntry, CompanionsFleetConfig } from '../config/companions-config.js';
import {
  chartFleetAgentDeploymentName,
  createKubernetesFleetWorkloadPort,
  parseKubernetesFleetWorkloadBinding,
  type KubernetesReadExecutor,
} from './kubernetes-adapter.js';
import { createFileFleetTopologyPort, createLocalFleetPrerequisitePort } from './local-adapter.js';

const PRIMARY = '11111111-1111-4111-8111-111111111111';
const NOVA = '33333333-3333-4333-8333-333333333333';

const NOVA_ENTRY: CompanionFleetEntry = {
  companionId: NOVA as CompanionFleetEntry['companionId'],
  companionDataDir: 'companions/nova',
  characterCardPath: 'companions/nova/character-card.json',
  postgresSchema: 'companion_nova',
  postgresRole: 'companion_nova_runtime',
  postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_NOVA_DATABASE_URL' },
};

const TOPOLOGY: CompanionsFleetConfig = {
  postgres: {
    sharedMigrationRole: 'shared_schema_migration',
    sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL' },
  },
  companions: [{
    ...NOVA_ENTRY,
    companionId: PRIMARY as CompanionFleetEntry['companionId'],
    companionDataDir: 'companions/flagship',
    characterCardPath: 'companions/flagship/character-card.json',
    postgresSchema: 'companion_flagship',
    postgresRole: 'companion_flagship_runtime',
    postgresDatabaseUrlRef: { kind: 'env', envName: 'COMPANION_FLAGSHIP_DATABASE_URL' },
  }],
};

const BINDING = {
  companionId: NOVA,
  postgresSchema: 'companion_nova',
  databaseUrlSecretKey: 'companion-nova-url',
  companionDataClaim: 'companion-nova-data',
  workspaceClaim: 'companion-nova-workspace',
  authSecret: {
    name: 'companion-nova-auth',
    sessionIntegrityKey: 'session-integrity-token',
    companionAuthKey: 'companion-auth-token',
  },
};

function executor(overrides: Partial<KubernetesReadExecutor> = {}): KubernetesReadExecutor {
  return {
    secretKeys: vi.fn(async (name: string) => (
      name === 'app-secret'
        ? ['companion-nova-url']
        : ['session-integrity-token', 'companion-auth-token']
    )),
    pvcExists: vi.fn(async () => true),
    deploymentExists: vi.fn(async () => false),
    ...overrides,
  };
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('kubernetes fleet workload adapter', () => {
  it('verifies Secret keys and claims read-only and reports the Helm upgrade', async () => {
    const reads = executor();
    const port = createKubernetesFleetWorkloadPort({
      executor: reads,
      chartFullname: 'release-a',
      appSecretName: 'app-secret',
      binding: parseKubernetesFleetWorkloadBinding(BINDING),
    });
    await expect(port.verifyPrerequisites(NOVA_ENTRY)).resolves.toBe('helm_upgrade_required');
    expect(reads.pvcExists).toHaveBeenCalledWith('companion-nova-data');
    expect(reads.pvcExists).toHaveBeenCalledWith('companion-nova-workspace');

    const missing = createKubernetesFleetWorkloadPort({
      executor: executor({ pvcExists: async name => name !== 'companion-nova-workspace' }),
      chartFullname: 'release-a',
      appSecretName: 'app-secret',
      binding: parseKubernetesFleetWorkloadBinding(BINDING),
    });
    await expect(missing.verifyPrerequisites(NOVA_ENTRY))
      .rejects.toMatchObject({ code: 'workload_prerequisite_missing' });
    const unbound = createKubernetesFleetWorkloadPort({
      executor: executor({ secretKeys: async () => null }),
      chartFullname: 'release-a',
      appSecretName: 'app-secret',
      binding: parseKubernetesFleetWorkloadBinding(BINDING),
    });
    await expect(unbound.verifyPrerequisites(NOVA_ENTRY))
      .rejects.toMatchObject({ code: 'workload_prerequisite_missing' });
    await expect(createKubernetesFleetWorkloadPort({
      executor: executor(), chartFullname: 'release-a', appSecretName: 'app-secret',
    }).verifyPrerequisites(NOVA_ENTRY)).rejects.toMatchObject({ code: 'workload_prerequisite_missing' });
  });

  it('drains only after the chart removed the agent deployment', async () => {
    const running = createKubernetesFleetWorkloadPort({
      executor: executor({ deploymentExists: async () => true }),
      chartFullname: 'release-a',
      appSecretName: 'app-secret',
    });
    await expect(running.drain(NOVA)).rejects.toMatchObject({ code: 'workload_still_running' });
    const gone = executor();
    await expect(createKubernetesFleetWorkloadPort({
      executor: gone, chartFullname: 'release-a', appSecretName: 'app-secret',
    }).drain(NOVA)).resolves.toBe('already_satisfied');
    expect(gone.deploymentExists).toHaveBeenCalledWith(`release-a-agent-${NOVA}`);
  });

  it('mirrors the chart deployment-name truncation and rejects malformed bindings', () => {
    expect(chartFleetAgentDeploymentName('a-very-long-release-name-x', NOVA))
      .toBe(`a-very-long-release-name-x-${NOVA}`);
    expect(chartFleetAgentDeploymentName('a-very-long-release-name-xy', NOVA))
      .toBe(`a-very-long-release-name-x-${NOVA}`);
    expect(() => parseKubernetesFleetWorkloadBinding({ ...BINDING, workspaceClaim: 'Bad_Name' }))
      .toThrow(/Kubernetes object name/u);
    expect(() => parseKubernetesFleetWorkloadBinding({ ...BINDING, authSecret: 'x' }))
      .toThrow(/malformed/u);
  });
});

describe('local fleet adapters', () => {
  it('publishes the roster by compare-and-swap and refuses a held lock', () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-topology-'));
    const path = join(dir, 'companions.json');
    writeFileSync(path, `${JSON.stringify(TOPOLOGY, null, 2)}\n`);
    const topology = createFileFleetTopologyPort(dir);
    const { revision } = topology.read();
    const next = { ...TOPOLOGY, companions: [...TOPOLOGY.companions, NOVA_ENTRY] };
    expect(() => topology.publish(next, 'f'.repeat(64))).toThrow(/changed before publication/u);
    writeFileSync(`${path}.lifecycle.lock`, '');
    expect(() => topology.publish(next, revision)).toThrow(/Roster lock/u);
    rmSync(`${path}.lifecycle.lock`);
    const published = topology.publish(next, revision);
    expect(published).toBe(topology.revisionOf(next));
    expect(topology.read().revision).toBe(published);
    expect(readFileSync(path, 'utf8')).toContain(NOVA);
  });

  it('checks credential references for presence without reading them into results', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-prereq-'));
    const verifyTenantSchema = vi.fn(async () => undefined);
    const port = createLocalFleetPrerequisitePort({
      persistenceRoot: dir,
      env: { SHARED_SCHEMA_MIGRATION_DATABASE_URL: 'postgres://shared' },
      verifyTenantSchema,
    });
    await expect(port.verifySecretRefs(NOVA_ENTRY, TOPOLOGY))
      .rejects.toMatchObject({ code: 'secret_ref_missing' });
    await expect(port.verifyTenant(NOVA_ENTRY, TOPOLOGY))
      .rejects.toMatchObject({ code: 'secret_ref_missing' });
    await expect(port.verifyOwnerRoots(NOVA_ENTRY)).rejects.toMatchObject({ code: 'owner_roots_missing' });
    expect(verifyTenantSchema).not.toHaveBeenCalled();

    const failingTenant = createLocalFleetPrerequisitePort({
      persistenceRoot: dir,
      env: { COMPANION_NOVA_DATABASE_URL: 'postgres://tenant' },
      verifyTenantSchema: async () => { throw new Error('schema not owned'); },
    });
    await expect(failingTenant.verifyTenant(NOVA_ENTRY, TOPOLOGY))
      .rejects.toMatchObject({ code: 'tenant_unverified' });
  });
});
