import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import type { PolicyConfig } from '../policy.js';
import { registerShellMethods, resetShellCircuitBreakersForTests } from './shell.js';
import { GatewayErrors } from '../protocol.js';
import { ShellExecPolicyError } from '../../sandbox/execution/shell-runner.js';
import {
  createIntakeEnvelope,
  transitionIntakeEnvelope,
  type IntakeEnvelope,
} from '../../../shared/contracts/intake-envelope.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../../core/cogsec/intake-firewall-notice-templates.js';
import { createIntakeQuarantineStore } from '../../../core/cogsec/intake/quarantine-store.js';
import {
  createQuarantinedArtifactAccessGuard,
  type QuarantinedArtifactAccessGuard,
} from '../../../core/cogsec/intake/quarantined-artifact-guard.js';

type ShellExecutor = (typeof import('../../sandbox/execution/shell-runner.js'))[
  'executeShellCommandWithPolicy'
];

const shellRunnerMock = vi.hoisted(() => ({
  actualExecute: undefined as ShellExecutor | undefined,
  execute: vi.fn<ShellExecutor>(),
}));

vi.mock('../../sandbox/execution/shell-runner.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../sandbox/execution/shell-runner.js')>();
  shellRunnerMock.actualExecute = original.executeShellCommandWithPolicy;
  shellRunnerMock.execute.mockImplementation(original.executeShellCommandWithPolicy);
  return {
    ...original,
    executeShellCommandWithPolicy: shellRunnerMock.execute,
  };
});

function createHarness(
  policyConfig: PolicyConfig,
  options: { quarantinedArtifactGuard?: QuarantinedArtifactAccessGuard; workspacePath?: string } = {},
): { invoke(params: Record<string, unknown>): Promise<any> } {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<any>>();
  const runtime: GatewayMethodRuntime = {
    ...(options.quarantinedArtifactGuard
      ? { quarantinedArtifactGuard: options.quarantinedArtifactGuard }
      : {}),
    target: {
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<any>) {
        methods.set(name, handler);
      },
    } as any,
    llmProvider: {} as any,
    embeddingService: {} as any,
    discordAdapter: {} as any,
    policyConfig,
    workspacePath: options.workspacePath ?? process.cwd(),
    sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test-shell-secret' } },
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop', status: 'not_found', message: 'noop', executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'stream-1',
    audited: (_method, handler) => handler,
    approvalBoundary: { gate: options => async params => options.handler(params) } as any,
  };
  registerShellMethods(runtime);
  const method = methods.get('shell.exec');
  if (!method) throw new Error('shell.exec method was not registered');
  return { invoke: params => method(params) };
}

describe('registerShellMethods', () => {
  afterEach(() => {
    resetShellCircuitBreakersForTests();
    shellRunnerMock.execute.mockReset();
    shellRunnerMock.execute.mockImplementation(shellRunnerMock.actualExecute!);
  });

  it('maps an execution-policy rejection to a policy denial', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: true, allowlist: ['printf'], allowedCwd: [process.cwd()] },
    });
    await expect(harness.invoke({ command: 'bash', args: ['-c', 'printf never'] })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('command not allowlisted'),
    });
  });

  it('retains the explicit disabled-policy denial', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: false, allowlist: ['printf'], allowedCwd: [process.cwd()] },
    });
    await expect(harness.invoke({ command: 'printf', args: ['never'] })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('policy is disabled'),
    });
  });

  it('denies non-blacklisted evaluators and never turns policy denials into a circuit failure', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: true, allowlist: ['awk'], allowedCwd: [process.cwd()] },
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(harness.invoke({ command: 'awk', args: ['BEGIN { print 1 }'] }))
        .rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    }
  });

  it.each([
    ['non-zero exits', { exitCode: 1, timedOut: false }],
    ['timeouts', { exitCode: null, timedOut: true }],
  ])('does not open the circuit for repeated %s', async (_caseName, result) => {
    shellRunnerMock.execute.mockResolvedValue({
      ...result,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 1,
    });
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: true, allowlist: ['bash'], allowedCwd: [process.cwd()] },
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(harness.invoke({ command: 'bash', args: ['-lc', 'exit 1'] }))
        .resolves.toMatchObject(result);
    }
  });

  it('opens the circuit after repeated sandbox spawn failures', async () => {
    shellRunnerMock.execute.mockRejectedValue(
      new ShellExecPolicyError('shell.exec sandbox failed: spawn EACCES'),
    );
    const harness = createHarness({
      workspacePath: process.cwd(),
      shellExec: { enabled: true, allowlist: ['bash'], allowedCwd: [process.cwd()] },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(harness.invoke({ command: 'bash', args: ['-lc', 'true'] }))
        .rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    }
    await expect(harness.invoke({ command: 'bash', args: ['-lc', 'true'] }))
      .rejects.toMatchObject({
        code: GatewayErrors.PROVIDER_ERROR,
        data: expect.objectContaining({ code: 'circuit_open' }),
      });
  });

  // hrmrq.54 B2: the shell seam must not serve quarantined-artifact bytes.
  describe('quarantined-artifact guard (hrmrq.54)', () => {
    const MARKER = 'MARKER-a6932606e2a7';
    const tempDirs: string[] = [];

    afterEach(() => {
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function quarantinedEnvelope(): IntakeEnvelope {
      const sha256 = 'c'.repeat(64);
      const atMs = Date.now();
      let envelope = createIntakeEnvelope({
        sourceClass: 'document',
        sourceRiskTier: 'untrusted',
        contentRef: { store: 'intake-quarantine', ref: `sha256:${sha256}`, sha256 },
        origin: { ref: 'api:chan-1:msg-1:doc.md' },
        atMs,
      });
      envelope = transitionIntakeEnvelope(envelope, {
        to: 'screened',
        actor: 'test:screening',
        reason: 'l1:injection/override_attempt',
        atMs,
        decision: {
          action: 'quarantine',
          reason: 'l1:injection/override_attempt',
          decidedBy: 'screening',
          decidedAtMs: atMs,
        },
        riskLabels: ['injection/override_attempt'],
        scores: { 'l1-rule-engine': 1 },
        extractedFields: {},
      });
      return transitionIntakeEnvelope(envelope, {
        to: 'quarantined',
        actor: 'test:screening',
        reason: "routed per screening decision 'quarantine'",
        atMs,
      });
    }

    function quarantineFixture(mode: 'shadow' | 'enforce'): {
      workspace: string;
      artifactPath: string;
      guard: QuarantinedArtifactAccessGuard;
      store: ReturnType<typeof createIntakeQuarantineStore>;
      envelopeId: string;
    } {
      const workspace = mkdtempSync(join(tmpdir(), 'psfn-shell-guard-'));
      tempDirs.push(workspace);
      mkdirSync(join(workspace, 'files'));
      const artifactPath = join(workspace, 'files', 'doc.md');
      writeFileSync(artifactPath, MARKER);
      const store = createIntakeQuarantineStore(join(workspace, 'intake-quarantine.json'), {
        itemTtlHours: 168,
        maxHeldItems: 100,
      });
      const envelope = quarantinedEnvelope();
      store.hold({
        envelope,
        mode,
        rawText: MARKER,
        artifactPaths: [artifactPath, `${artifactPath}.parsed.txt`],
      });
      const guard = createQuarantinedArtifactAccessGuard({ store, mode });
      return { workspace, artifactPath, guard, store, envelopeId: envelope.id };
    }

    it('withholds `cat <registered artifact>` with the quarantine notice, never executes, and records the attempt', async () => {
      const fixture = quarantineFixture('enforce');
      shellRunnerMock.execute.mockResolvedValue({
        command: 'cat',
        args: [fixture.artifactPath],
        cwd: fixture.workspace,
        exitCode: 0,
        stdout: MARKER,
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 1,
      });
      const harness = createHarness(
        {
          workspacePath: fixture.workspace,
          shellExec: { enabled: true, allowlist: ['cat'], allowedCwd: [fixture.workspace] },
        },
        { quarantinedArtifactGuard: fixture.guard, workspacePath: fixture.workspace },
      );

      const result = await harness.invoke({ command: 'cat', args: [fixture.artifactPath] });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain(MARKER);
      expect(result.stderr).toBe(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent);
      // The sandbox never launched: the withhold happened at the descriptor.
      expect(shellRunnerMock.execute).not.toHaveBeenCalled();
      // The attempt is operator-visible on the Garden queue entry.
      const entry = fixture.store.getById(fixture.envelopeId);
      expect(entry?.accessAttempts?.some((attempt) => attempt.via === 'gateway:shell.exec'))
        .toBe(true);
    });

    it('withholds a relative artifact path named inside a bash -lc string, resolved against the requested cwd', async () => {
      const fixture = quarantineFixture('enforce');
      shellRunnerMock.execute.mockResolvedValue({
        command: 'bash', args: [], cwd: fixture.workspace, exitCode: 0,
        stdout: MARKER, stderr: '', timedOut: false, truncated: false, durationMs: 1,
      });
      const harness = createHarness(
        {
          workspacePath: fixture.workspace,
          shellExec: { enabled: true, allowlist: ['bash'], allowedCwd: [fixture.workspace] },
        },
        { quarantinedArtifactGuard: fixture.guard, workspacePath: fixture.workspace },
      );

      const result = await harness.invoke({
        command: 'bash',
        args: ['-lc', 'cat ./doc.md'],
        cwd: join(fixture.workspace, 'files'),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent);
      expect(shellRunnerMock.execute).not.toHaveBeenCalled();
    });

    it('threads the enforce-mode physical deny set into the sandbox execution for commands that name no artifact', async () => {
      const fixture = quarantineFixture('enforce');
      shellRunnerMock.execute.mockResolvedValue({
        command: 'bash', args: ['-lc', 'true'], cwd: fixture.workspace, exitCode: 0,
        stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1,
      });
      const harness = createHarness(
        {
          workspacePath: fixture.workspace,
          shellExec: { enabled: true, allowlist: ['bash'], allowedCwd: [fixture.workspace] },
        },
        { quarantinedArtifactGuard: fixture.guard, workspacePath: fixture.workspace },
      );

      await harness.invoke({ command: 'bash', args: ['-lc', 'true'] });

      expect(shellRunnerMock.execute).toHaveBeenCalledTimes(1);
      const options = shellRunnerMock.execute.mock.calls[0][1] as {
        quarantinedArtifactPaths?: readonly string[];
      };
      expect(options.quarantinedArtifactPaths).toEqual(expect.arrayContaining([
        fixture.artifactPath,
      ]));
    });

    it('shadow mode records the attempt but executes with no physical deny set (observe-only)', async () => {
      const fixture = quarantineFixture('shadow');
      shellRunnerMock.execute.mockResolvedValue({
        command: 'cat', args: [fixture.artifactPath], cwd: fixture.workspace, exitCode: 0,
        stdout: MARKER, stderr: '', timedOut: false, truncated: false, durationMs: 1,
      });
      const harness = createHarness(
        {
          workspacePath: fixture.workspace,
          shellExec: { enabled: true, allowlist: ['cat'], allowedCwd: [fixture.workspace] },
        },
        { quarantinedArtifactGuard: fixture.guard, workspacePath: fixture.workspace },
      );

      const result = await harness.invoke({ command: 'cat', args: [fixture.artifactPath] });

      expect(result.exitCode).toBe(0);
      expect(shellRunnerMock.execute).toHaveBeenCalledTimes(1);
      const options = shellRunnerMock.execute.mock.calls[0][1] as {
        quarantinedArtifactPaths?: readonly string[];
      };
      expect(options.quarantinedArtifactPaths).toBeUndefined();
      expect(fixture.store.getById(fixture.envelopeId)?.accessAttempts?.some(
        (attempt) => attempt.via === 'gateway:shell.exec',
      )).toBe(true);
    });

    it('fails the exec closed when the enforce-mode deny set cannot be enumerated', async () => {
      const fixture = quarantineFixture('enforce');
      const brokenGuard: QuarantinedArtifactAccessGuard = {
        check: () => ({ withheld: false }),
        listEnforcedArtifactPaths: () => {
          throw new Error('corrupt quarantine file');
        },
      };
      const harness = createHarness(
        {
          workspacePath: fixture.workspace,
          shellExec: { enabled: true, allowlist: ['bash'], allowedCwd: [fixture.workspace] },
        },
        { quarantinedArtifactGuard: brokenGuard, workspacePath: fixture.workspace },
      );

      await expect(harness.invoke({ command: 'bash', args: ['-lc', 'true'] }))
        .rejects.toMatchObject({
          code: GatewayErrors.PROVIDER_ERROR,
          message: expect.stringContaining('corrupt quarantine file'),
        });
      expect(shellRunnerMock.execute).not.toHaveBeenCalled();
    });
  });
});
