import { EventEmitter } from 'node:events';
import { fromAny, fromPartial } from '@total-typescript/shoehorn';
import { PassThrough } from 'node:stream';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PolicyConfig } from '../policy.js';
import { evaluatePolicy } from '../policy.js';
import { GatewayErrors } from '../protocol.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerBeadsMethods } from './beads.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('./beads-github-project-sync.js', () => ({
  syncMutatedBeadToGitHubProject: vi.fn(),
  syncAllBeadsToGitHubProject: vi.fn(),
}));

import { spawn } from 'node:child_process';
import {
  syncAllBeadsToGitHubProject,
  syncMutatedBeadToGitHubProject,
} from './beads-github-project-sync.js';

const mockedSpawn = vi.mocked(spawn);
const mockedSyncMutatedBeadToGitHubProject = vi.mocked(syncMutatedBeadToGitHubProject);
const mockedSyncAllBeadsToGitHubProject = vi.mocked(syncAllBeadsToGitHubProject);

function makePolicy(allowActions: Array<'ready' | 'show' | 'create' | 'update' | 'close' | 'sync'>): PolicyConfig {
  return {
    workspacePath: process.cwd(),
    beads: {
      enabled: true,
      allowActions,
    },
  };
}

function queueSpawnResult(options: { stdout?: string; stderr?: string; exitCode?: number; emitError?: Error }): void {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();

  mockedSpawn.mockImplementationOnce(() => {
    process.nextTick(() => {
      if (options.emitError) {
        child.emit('error', options.emitError);
        return;
      }
      if (options.stdout) child.stdout.write(options.stdout);
      if (options.stderr) child.stderr.write(options.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', options.exitCode ?? 0);
    });
    return fromAny(child);
  });
}

function createHarness(policyConfig: PolicyConfig): {
  invoke(method: string, params: Record<string, unknown>): Promise<unknown>;
  recordAuditEvent: ReturnType<typeof vi.fn>;
} {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const recordAuditEvent = vi.fn();
  const keyring = {
    activeVersion: 'v1',
    keys: { v1: 'test-beads-secret' },
  };

  const runtime: GatewayMethodRuntime = {
    target: fromAny({
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        methods.set(name, handler);
      },
    }),
    llmProvider: fromPartial<Record<string, unknown>>({}),
    embeddingService: fromPartial<Record<string, unknown>>({}),
    discordAdapter: fromPartial<Record<string, unknown>>({}),
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: keyring,
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'stream-1',
    recordAuditEvent,
    resolveShardWorkloadForChannel: (channelId) => channelId === 'shard:shard-1'
      ? {
          workload: fromAny({ workloadId: 'workload-1', workloadGeneration: 'generation-1' }),
          identity: {
            parentCompanionId: 'companion-1',
            shardId: 'shard-1',
            workloadGeneration: 'generation-1',
            ownerVersion: 'owner-v1',
            grantDigest: 'digest-1',
          },
        }
      : undefined,
    audited: (_method, handler) => handler,
    approvalBoundary: fromAny({
      gate: ({ method, handler }) => async (params) => {
        const shard = runtime.resolveShardWorkloadForChannel?.(
          (params as Record<string, unknown>).channelId as string | undefined,
        );
        const decision = evaluatePolicy(
          {
            method,
            params: params as Record<string, unknown>,
            callerClass: shard ? 'shard' : 'companion',
          },
          policyConfig,
        );
        if (decision === 'DENY') {
          throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
        }
        return handler(params);
      },
    }),
  };

  registerBeadsMethods(runtime);

  return {
    invoke(method: string, params: Record<string, unknown>) {
      const handler = methods.get(method);
      if (!handler) {
        throw new Error(`Method not registered: ${method}`);
      }
      return handler(params);
    },
    recordAuditEvent,
  };
}

describe('registerBeadsMethods', () => {
  afterEach(() => {
    mockedSpawn.mockReset();
    mockedSyncMutatedBeadToGitHubProject.mockReset();
    mockedSyncAllBeadsToGitHubProject.mockReset();
  });

  it('executes allowlisted beads.ready and records audit telemetry', async () => {
    queueSpawnResult({
      stdout: JSON.stringify([{ id: 'PSFN-1', title: 'ready issue' }]),
    });
    const harness = createHarness(makePolicy(['ready', 'show', 'create', 'update', 'close', 'sync']));

    const result = await harness.invoke('beads.ready', { actor: 'agent-main' }) as {
      actor: string;
      action: string;
      target: string;
      result: string;
      payload: unknown;
    };

    expect(mockedSpawn).toHaveBeenCalledWith(
      'bd',
      ['ready', '-n', '20', '--json'],
      expect.objectContaining({
        cwd: process.cwd(),
        shell: false,
      }),
    );
    expect(result).toMatchObject({
      actor: 'agent-main',
      action: 'ready',
      target: 'ready',
      result: 'success',
    });
    expect(harness.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'beads.action',
        decision: 'ALLOW',
        params: expect.objectContaining({
          actor: 'agent-main',
          action: 'ready',
          target: 'ready',
          result: 'success',
        }),
      }),
    );
  });

  it('does not misreport a succeeded action as failed when the success audit write rejects', async () => {
    queueSpawnResult({
      stdout: JSON.stringify([{ id: 'PSFN-1', title: 'ready issue' }]),
    });
    const harness = createHarness(makePolicy(['ready']));
    harness.recordAuditEvent.mockRejectedValueOnce(new Error('audit store down'));

    await expect(harness.invoke('beads.ready', { actor: 'agent-main' })).rejects.toMatchObject({
      message: expect.stringContaining('succeeded but its success audit record could not be persisted'),
    });

    // The action ran exactly once and no contradictory 'error' audit was recorded.
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(harness.recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(harness.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ result: 'success' }),
      }),
    );
  });

  it('preserves the bd failure and audit failure when both the action and its error audit reject', async () => {
    queueSpawnResult({ emitError: new Error('bd exploded') });
    const harness = createHarness(makePolicy(['ready']));
    harness.recordAuditEvent.mockRejectedValueOnce(new Error('audit store down'));

    await expect(harness.invoke('beads.ready', { actor: 'agent-main' })).rejects.toMatchObject({
      message: expect.stringContaining('failed and its audit record could not be persisted'),
    });
  });

  it('denies disallowed beads action via policy gate', async () => {
    const harness = createHarness(makePolicy(['ready', 'show']));

    await expect(harness.invoke('beads.create', {
      actor: 'agent-main',
      title: 'blocked',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
    });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads before command execution', async () => {
    const harness = createHarness(makePolicy(['create']));

    await expect(harness.invoke('beads.create', {
      actor: 'agent-main',
      title: '',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('title'),
    });

    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(harness.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          action: 'create',
          result: 'error',
          target: 'new',
        }),
      }),
    );
  });

  it('passes self-contained description and acceptance text to beads.create', async () => {
    queueSpawnResult({ stdout: JSON.stringify({ id: 'wish-11' }) });
    const harness = createHarness(makePolicy(['create']));

    await harness.invoke('beads.create', {
      actor: 'garden-operator',
      title: 'Plan a quiet watercolor afternoon',
      description: 'Companion wish: protect unhurried time for watercolor practice.',
      acceptance: 'A protected afternoon is agreed and visible to the companion.',
      issueType: 'task',
      priority: 2,
    });

    expect(mockedSpawn).toHaveBeenCalledWith(
      'bd',
      [
        'create',
        'Plan a quiet watercolor afternoon',
        '--description',
        'Companion wish: protect unhurried time for watercolor practice.',
        '--acceptance',
        'A protected afternoon is agreed and visible to the companion.',
        '-t',
        'task',
        '-p',
        '2',
        '--json',
      ],
      expect.objectContaining({ cwd: process.cwd(), shell: false }),
    );
  });

  it('attributes shard-created issues to the authenticated shard', async () => {
    queueSpawnResult({ stdout: JSON.stringify({ id: 'wl-issue-1' }) });
    const harness = createHarness(makePolicy(['create']));

    await harness.invoke('beads.create', {
      channelId: 'shard:shard-1',
      actor: 'spoofed-actor',
      title: 'Shard-owned work',
    });

    expect(mockedSpawn).toHaveBeenCalledWith(
      'bd',
      ['create', 'Shard-owned work', '--assignee', 'shard-1', '--json'],
      expect.any(Object),
    );
  });

  it('allows an authenticated shard to close its own issue', async () => {
    queueSpawnResult({ stdout: JSON.stringify({ id: 'PSFN-1', assignee: 'shard-1' }) });
    queueSpawnResult({ stdout: JSON.stringify({ id: 'PSFN-1', status: 'closed' }) });
    const harness = createHarness(makePolicy(['ready']));

    await harness.invoke('beads.close', {
      channelId: 'shard:shard-1',
      id: 'PSFN-1',
      reason: 'completed',
    });

    expect(mockedSpawn).toHaveBeenNthCalledWith(1, 'bd', ['show', 'PSFN-1', '--json'], expect.any(Object));
    expect(mockedSpawn).toHaveBeenNthCalledWith(2, 'bd', ['close', 'PSFN-1', '--reason', 'completed', '--json'], expect.any(Object));
  });

  it('denies shard close for a foreign issue before mutation', async () => {
    queueSpawnResult({ stdout: JSON.stringify({ id: 'PSFN-2', assignee: 'shard-2' }) });
    const harness = createHarness(makePolicy(['ready']));

    await expect(harness.invoke('beads.close', {
      channelId: 'shard:shard-1',
      id: 'PSFN-2',
      reason: 'not mine',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('ownership denied'),
    });
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it('records error audit telemetry when bd command fails', async () => {
    queueSpawnResult({
      stderr: 'issue not found',
      exitCode: 1,
    });
    const harness = createHarness(makePolicy(['show']));

    await expect(harness.invoke('beads.show', {
      actor: 'agent-main',
      id: 'PSFN-404',
    })).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('issue not found'),
    });

    expect(harness.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'beads.action',
        decision: 'DENY',
        params: expect.objectContaining({
          actor: 'agent-main',
          action: 'show',
          target: 'PSFN-404',
          result: 'error',
        }),
      }),
    );
  });

  it('attaches GitHub Project sync status after a successful beads.create', async () => {
    queueSpawnResult({
      stdout: JSON.stringify({
        id: 'PSFN-10',
        title: 'created issue',
      }),
    });
    mockedSyncMutatedBeadToGitHubProject.mockResolvedValue({
      integration: 'github_project',
      state: 'synced',
      owner: 'example-owner',
      projectNumber: 2,
      issueId: 'PSFN-10',
      itemId: 'PVTI_test',
      created: true,
    });
    const harness = createHarness(makePolicy(['create']));

    const result = await harness.invoke('beads.create', {
      actor: 'agent-main',
      title: 'created issue',
      issueType: 'task',
    }) as {
      payload: unknown;
      sync?: unknown[];
    };

    expect(mockedSyncMutatedBeadToGitHubProject).toHaveBeenCalledWith(
      process.cwd(),
      'create',
      'new',
      expect.objectContaining({
        id: 'PSFN-10',
      }),
    );
    expect(result.sync).toEqual([
      expect.objectContaining({
        integration: 'github_project',
        state: 'synced',
        issueId: 'PSFN-10',
      }),
    ]);
  });

  it('returns the GitHub Projects reconciliation payload for beads.sync', async () => {
    mockedSyncAllBeadsToGitHubProject.mockResolvedValue({
      integration: 'github_project',
      state: 'synced',
      owner: 'example-owner',
      projectNumber: 2,
      totalIssues: 3,
      synced: 2,
      archived: 1,
      skipped: 0,
    });
    const harness = createHarness(makePolicy(['sync']));

    const result = await harness.invoke('beads.sync', {
      actor: 'agent-main',
    }) as {
      payload: unknown;
      sync?: unknown[];
    };

    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(mockedSyncAllBeadsToGitHubProject).toHaveBeenCalledWith(process.cwd());
    expect(result.payload).toMatchObject({
      integration: 'github_project',
      totalIssues: 3,
      archived: 1,
    });
    expect(result.sync).toEqual([
      expect.objectContaining({
        integration: 'github_project',
        state: 'synced',
      }),
    ]);
  });
});
