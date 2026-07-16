import { describe, expect, it } from 'vitest';
import {
  classifyLogScan,
  classifyToolConformance,
  POST_ROLLOUT_CHECK_IDS,
  PostRolloutValidationError,
  runPostRolloutValidation as runOwnedPostRolloutValidation,
  summarizePostRolloutValidationRecord,
  type PostRolloutValidationPlan,
  type PostRolloutValidationRunner,
  type RawCheckResult,
  type RunPostRolloutValidationOptions,
} from './kube-post-rollout-validation.js';
import type { ToolConformanceRunResult } from '../../core/agent/tool-conformance/types.js';
import type { RuntimeDiagnosticsSnapshot } from '../../shared/diagnostics/runtime-diagnostics.js';

const COMMIT = 'a'.repeat(40);
const IMAGE = 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa';

type TestValidationOptions = Omit<RunPostRolloutValidationOptions, 'maxLogRecords'>
  & Partial<Pick<RunPostRolloutValidationOptions, 'maxLogRecords'>>;

function runPostRolloutValidation(
  plan: PostRolloutValidationPlan,
  options: TestValidationOptions,
) {
  return runOwnedPostRolloutValidation(plan, { maxLogRecords: 10, ...options });
}

function basePlan(overrides: Partial<PostRolloutValidationPlan> = {}): PostRolloutValidationPlan {
  return {
    namespace: 'psfn',
    release: 'psfn',
    sourceCommit: COMMIT,
    imageReference: IMAGE,
    imageRevisionLabel: COMMIT,
    helmRevision: 9,
    trigger: 'deploy_pipeline',
    ...overrides,
  };
}

function passingConformance(): ToolConformanceRunResult {
  return {
    schemaVersion: 1,
    ranAt: 1000,
    trigger: 'post_rollout',
    results: [
      { toolName: 'self_status', probeKind: 'read_only', action: 'status', ok: true, durationMs: 2 },
      { toolName: 'memory', probeKind: 'rejection_check', action: 'action', ok: true, durationMs: 1 },
    ],
  };
}

function healthyDiagnostics(
  overrides: Partial<RuntimeDiagnosticsSnapshot> = {},
): RuntimeDiagnosticsSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: 2000,
    window: {
      sinceMs: 0,
      untilMs: 2000,
      windowMs: 2000,
      limit: 20,
      includeFileLogs: false,
      logsDir: '/app/logs',
    },
    sources: [],
    agentLog: { status: 'available', counts: { warn: 0, error: 0, total: 0 }, records: [] },
    fileLogs: { status: 'unavailable', reason: 'requires kube surface' },
    toolValidationFailures: { status: 'available', total: 0, byTool: [] },
    lifecycle: { status: 'available', events: [] },
    rollout: { status: 'unavailable', reason: 'requires kube surface' },
    pods: { status: 'unavailable', reason: 'requires kube surface' },
    backup: {
      status: 'available',
      counts: { success: 0, failure: 0, total: 0 },
      lastSuccess: null,
      lastFailure: null,
      recent: [],
    },
    ...overrides,
  };
}

const PASS: RawCheckResult = { verdict: 'pass' };

function fakeRunner(overrides: Partial<PostRolloutValidationRunner> = {}): PostRolloutValidationRunner {
  return {
    checkRolloutStatus: async () => PASS,
    checkGardenHealth: async () => PASS,
    checkModelRoute: async () => PASS,
    checkPgVector: async () => PASS,
    checkRedis: async () => PASS,
    checkAgentReadiness: async () => PASS,
    checkChatTurnProbe: async () => PASS,
    fetchToolConformance: async () => passingConformance(),
    fetchDiagnostics: async () => healthyDiagnostics(),
    ...overrides,
  };
}

describe('runPostRolloutValidation', () => {
  it('reports healthy only when every required check passes', async () => {
    const record = await runPostRolloutValidation(basePlan(), { runner: fakeRunner() });
    expect(record.overall).toBe('passed');
    expect(record.healthy).toBe(true);
    expect(record.recommendedAction).toBe('none');
    expect(record.failedChecks).toEqual([]);
    expect(record.checks.map(check => check.id)).toEqual([...POST_ROLLOUT_CHECK_IDS]);
    expect(record.checks.every(check => check.verdict === 'pass')).toBe(true);
    expect(record.trigger).toBe('deploy_pipeline');
  });

  it('fails closed when a live check returns fail and recommends rollback', async () => {
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        checkModelRoute: async () => ({ verdict: 'fail', detail: 'expected model route missing' }),
      }),
    });
    expect(record.healthy).toBe(false);
    expect(record.overall).toBe('failed');
    expect(record.recommendedAction).toBe('rollback');
    expect(record.failedChecks).toContain('model_route');
    const check = record.checks.find(entry => entry.id === 'model_route');
    expect(check?.verdict).toBe('fail');
    expect(check?.detail).toBe('expected model route missing');
  });

  it('treats a thrown probe as inconclusive → fail (fail-closed, no swallowed error)', async () => {
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        checkRedis: async () => {
          throw new Error('redis connection refused');
        },
      }),
    });
    expect(record.healthy).toBe(false);
    expect(record.failedChecks).toContain('redis_ping');
    const check = record.checks.find(entry => entry.id === 'redis_ping');
    expect(check?.verdict).toBe('inconclusive');
    expect(check?.detail).toBe('redis connection refused');
  });

  it('treats an inconclusive verdict as a non-pass and still runs every check', async () => {
    let ran = 0;
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        checkRolloutStatus: async () => {
          ran += 1;
          return { verdict: 'inconclusive', detail: 'rollout status unknown' };
        },
        checkChatTurnProbe: async () => {
          ran += 1;
          return PASS;
        },
      }),
    });
    // Both the failing and the later check ran — no short-circuit.
    expect(ran).toBe(2);
    expect(record.healthy).toBe(false);
    expect(record.failedChecks).toContain('rollout_status');
    expect(record.failedChecks).not.toContain('chat_turn_probe');
  });

  it('fails closed when tool conformance has a failing probe', async () => {
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        fetchToolConformance: async () => ({
          schemaVersion: 1,
          ranAt: 1000,
          trigger: 'post_rollout',
          results: [
            { toolName: 'memory', probeKind: 'rejection_check', action: 'action', ok: false, durationMs: 1, classification: 'accepted_empty_args' },
          ],
        }),
      }),
    });
    expect(record.healthy).toBe(false);
    expect(record.failedChecks).toContain('tool_conformance');
    const check = record.checks.find(entry => entry.id === 'tool_conformance');
    expect(check?.evidence).toMatchObject({ failed: 1 });
  });

  it('allows tool conformance to be explicitly skipped with a reason without failing the gate', async () => {
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        fetchToolConformance: async () => ({ skippedReason: 'harness unavailable in operator-job mode' }),
      }),
    });
    expect(record.healthy).toBe(true);
    const check = record.checks.find(entry => entry.id === 'tool_conformance');
    expect(check?.verdict).toBe('skipped');
    expect(check?.required).toBe(false);
    expect(check?.detail).toBe('harness unavailable in operator-job mode');
  });

  it('fails a conformance skip without a recorded reason (fail-closed)', () => {
    const check = classifyToolConformance({ skippedReason: '   ' }, 1);
    expect(check.verdict).toBe('fail');
    expect(check.required).toBe(true);
  });

  it('fails the log scan on a CrashLoopBackOff error signature', async () => {
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        fetchDiagnostics: async () => healthyDiagnostics({
          agentLog: {
            status: 'available',
            counts: { warn: 0, error: 1, total: 1 },
            records: [
              { observedAt: 1500, level: 'error', message: 'pod agent in CrashLoopBackOff', source: 'kube' },
            ],
          },
        }),
      }),
    });
    expect(record.healthy).toBe(false);
    expect(record.failedChecks).toContain('log_scan');
    const check = record.checks.find(entry => entry.id === 'log_scan');
    expect(check?.evidence).toMatchObject({ matchedSignatures: ['crash_loop_backoff'] });
  });

  it('fails the log scan when the diagnostics fetch throws and marks context unavailable', async () => {
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        fetchDiagnostics: async () => {
          throw new Error('admin transport down');
        },
      }),
    });
    expect(record.healthy).toBe(false);
    expect(record.failedChecks).toContain('log_scan');
    expect(record.logContext?.status).toBe('unavailable');
    expect(record.logContext?.reason).toBe('admin transport down');
  });

  it('fails the log scan when post-rollout tool-validation failures are present', async () => {
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        fetchDiagnostics: async () => healthyDiagnostics({
          toolValidationFailures: {
            status: 'available',
            total: 3,
            byTool: [{ toolName: 'memory', count: 3, firstSeenAt: 1, lastSeenAt: 2 }],
          },
        }),
      }),
    });
    expect(record.healthy).toBe(false);
    expect(record.failedChecks).toContain('log_scan');
  });

  it('attaches bounded sanitized log context for rollback debugging', async () => {
    const record = await runPostRolloutValidation(basePlan(), {
      runner: fakeRunner({
        fetchDiagnostics: async () => healthyDiagnostics({
          agentLog: {
            status: 'available',
            counts: { warn: 1, error: 0, total: 1 },
            records: [{ observedAt: 1500, level: 'warn', component: 'gateway', message: 'slow provider', source: 'app' }],
          },
        }),
      }),
    });
    expect(record.logContext?.status).toBe('available');
    expect(record.logContext?.counts).toEqual({ warn: 1, error: 0 });
    expect(record.logContext?.records?.[0]).toMatchObject({ level: 'warn', component: 'gateway', message: 'slow provider' });
  });

  it('honors an approved emergency waiver without running checks', async () => {
    let called = false;
    const record = await runPostRolloutValidation(
      basePlan({ emergencyWaiver: { justification: 'live outage; validated by hand' } }),
      {
        runner: fakeRunner({
          checkRolloutStatus: async () => {
            called = true;
            return PASS;
          },
        }),
      },
    );
    expect(called).toBe(false);
    expect(record.overall).toBe('waived');
    expect(record.healthy).toBe(true);
    expect(record.recommendedAction).toBe('none');
    expect(record.emergencyWaiver?.justification).toBe('live outage; validated by hand');
    expect(record.checks.every(check => check.verdict === 'skipped')).toBe(true);
  });

  it('rejects an emergency waiver with an empty justification (fail-closed)', async () => {
    await expect(runPostRolloutValidation(
      basePlan({ emergencyWaiver: { justification: '   ' } }),
      { runner: fakeRunner() },
    )).rejects.toBeInstanceOf(PostRolloutValidationError);
  });

  it('rejects a floating image tag, a short commit, and a non-DNS namespace', async () => {
    await expect(runPostRolloutValidation(
      basePlan({ imageReference: 'localhost/psfn-framework:latest' }), { runner: fakeRunner() },
    )).rejects.toThrow('non-floating pinned tag');
    await expect(runPostRolloutValidation(
      basePlan({ sourceCommit: 'abc' }), { runner: fakeRunner() },
    )).rejects.toThrow('40-character Git revisions');
    await expect(runPostRolloutValidation(
      basePlan({ namespace: 'Not_A_Label' }), { runner: fakeRunner() },
    )).rejects.toThrow('must be DNS labels');
    await expect(runPostRolloutValidation(
      basePlan({ helmRevision: 0 }), { runner: fakeRunner() },
    )).rejects.toThrow('positive Helm release revision');
  });

  it('summarizes the verdict without leaking evidence internals', async () => {
    const record = await runPostRolloutValidation(basePlan(), { runner: fakeRunner() });
    const summary = summarizePostRolloutValidationRecord(record);
    expect(summary).toMatchObject({
      healthy: true,
      overall: 'passed',
      recommendedAction: 'none',
      failedChecks: [],
    });
    expect(summary.checkVerdicts).toHaveLength(POST_ROLLOUT_CHECK_IDS.length);
  });
});

describe('classifyToolConformance', () => {
  it('fails when the harness reported zero probes', () => {
    const check = classifyToolConformance(
      { schemaVersion: 1, ranAt: 1, trigger: 'post_rollout', results: [] },
      1,
    );
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('zero probes');
  });
});

describe('classifyLogScan', () => {
  it('passes a clean snapshot and reports counts as evidence', () => {
    const check = classifyLogScan(healthyDiagnostics(), 1, {
      toolValidationFailureThreshold: 1,
      maxLogRecords: 10,
    });
    expect(check.verdict).toBe('pass');
    expect(check.evidence).toMatchObject({ errorCount: 0, warnCount: 0, toolValidationFailures: 0 });
  });

  it('ignores non-error records for critical signatures', () => {
    const check = classifyLogScan(
      healthyDiagnostics({
        agentLog: {
          status: 'available',
          counts: { warn: 1, error: 0, total: 1 },
          records: [{ observedAt: 1, level: 'warn', message: 'ENOENT while probing optional path', source: 'app' }],
        },
      }),
      1,
      { toolValidationFailureThreshold: 1, maxLogRecords: 10 },
    );
    // A WARN-level ENOENT is not a critical rollout failure.
    expect(check.verdict).toBe('pass');
  });
});
