import { EventEmitter } from 'node:events';
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

import { spawn } from 'node:child_process';

const mockedSpawn = vi.mocked(spawn);

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

  mockedSpawn.mockReturnValueOnce(child as any);

  process.nextTick(() => {
    if (options.emitError) {
      child.emit('error', options.emitError);
      return;
    }
    if (options.stdout) {
      child.stdout.write(options.stdout);
    }
    if (options.stderr) {
      child.stderr.write(options.stderr);
    }
    child.stdout.end();
    child.stderr.end();
    child.emit('close', options.exitCode ?? 0);
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
    target: {
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        methods.set(name, handler);
      },
    } as any,
    llmProvider: {} as any,
    embeddingService: {} as any,
    discordAdapter: {} as any,
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: keyring,
    notifyAll: vi.fn(),
    listPendingConfirmations: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'stream-1',
    recordAuditEvent,
    audited: (_method, handler) => handler,
    gated: (method, handler) => async (params) => {
      const decision = evaluatePolicy(
        { method, params: params as Record<string, unknown> },
        policyConfig,
      );
      if (decision === 'DENY') {
        throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
      }
      return handler(params);
    },
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
      ['ready', '--json'],
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
});
